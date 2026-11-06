import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { startSystemClients } from '../lib/system-startup.mjs';

test('native app bootstraps clients hidden without holding up the window',
  { skip: process.platform !== 'win32', timeout: 15000 }, async () => {
    assert.doesNotMatch(tmpdir(), /^C:/i);
    const root = await mkdtemp(join(tmpdir(), 'relay-native-'));
    try {
      const launcher = join(root, 'start.ps1');
      const result = join(root, 'ready.json');
      await writeFile(launcher, `param($RuntimeRoot,$ConsoleDir,[switch]$Background,[switch]$ClientsOnly)
Start-Sleep -Milliseconds 300
@{root=$RuntimeRoot;console=$ConsoleDir;background=[bool]$Background;clientsOnly=[bool]$ClientsOnly} | ConvertTo-Json | Set-Content -LiteralPath '${result.replaceAll("'", "''")}' -Encoding UTF8
`);
      startSystemClients({ systemLauncher: launcher, workspaceStateFile: join(root, 'data', 'workspace.json') },
        { consoleDir: root, log() {} });
      // The GUI must regain control before the bootstrap process has finished.
      await assert.rejects(readFile(result), { code: 'ENOENT' });
      let data;
      for (let attempt = 0; attempt < 100; attempt++) {
        try { data = JSON.parse((await readFile(result, 'utf8')).replace(/^\uFEFF/, '')); break; }
        catch { await delay(50); }
      }
      assert.deepEqual(data, { root, console: root, background: true, clientsOnly: true });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

test('GUI launcher runs PowerShell hidden, preserves arguments and propagates failures',
  { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
    assert.doesNotMatch(tmpdir(), /^C:/i);
    const root = await mkdtemp(join(tmpdir(), 'relay shortcut '));
    try {
      const script = join(root, 'fixture script.ps1');
      const result = join(root, 'result.json');
      await writeFile(script, `param($Output, $Value, [switch]$Background)
Add-Type 'using System; using System.Runtime.InteropServices; public class ConsoleProbe { [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h); }'
@{visible=[ConsoleProbe]::IsWindowVisible([ConsoleProbe]::GetConsoleWindow());value=$Value;background=[bool]$Background;temp=$env:TEMP} | ConvertTo-Json | Set-Content -LiteralPath $Output -Encoding UTF8
exit 7
`);
      const launcher = fileURLToPath(new URL('../scripts/Start-RelayHidden.vbs', import.meta.url));
      for (const background of [false, true]) {
        assert.throws(() => execFileSync('wscript.exe', ['//B', '//Nologo', launcher, script,
          '-Output', result, '-Value', 'a space & 中文', ...(background ? ['-Background'] : [])],
          { windowsHide: true, timeout: 10000 }), (error) => error.status === 7);
        const data = JSON.parse((await readFile(result, 'utf8')).replace(/^\uFEFF/, ''));
        assert.equal(data.visible, false);
        assert.equal(data.value, 'a space & 中文');
        assert.equal(data.background, background);
        assert.doesNotMatch(data.temp, /^C:/i);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

test(
  'Factory launch writes child output to files and returns without a terminal dependency',
  { skip: process.platform !== 'win32', timeout: 30000 },
  async () => {
    assert.doesNotMatch(tmpdir(), /^C:/i);
    const root = await mkdtemp(join(tmpdir(), 'relay-hidden-'));
    const ps = (args) =>
      execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], {
        encoding: 'utf8',
        windowsHide: true,
      });
    let childPid;
    let childScratch;
    try {
      const factory = join(root, 'factory');
      const version = join(factory, 'app-1.2.0');
      await mkdir(version, { recursive: true });
      await mkdir(join(root, 'data'));
      await mkdir(join(root, 'logs'));
      const fixture = join(root, 'fixture.cs');
      await writeFile(
        fixture,
        'using System; public class Fixture { public static void Main(string[] args) { Console.WriteLine("factory stdout ready"); Console.Error.WriteLine("factory stderr ready"); System.Threading.Thread.Sleep(60000); } }'
      );
      const compiler = join(root, 'compile.ps1');
      await writeFile(
        compiler,
        'param($Source,$Output)\nAdd-Type -TypeDefinition (Get-Content -LiteralPath $Source -Raw) -OutputAssembly $Output -OutputType ConsoleApplication\n'
      );
      ps(['-File', compiler, '-Source', fixture, '-Output', join(version, 'factory-desktop.exe')]);
      const script = fileURLToPath(new URL('../scripts/Start-RelayFactory.ps1', import.meta.url));
      ps(['-File', script, '-RuntimeRoot', root, '-FactoryRoot', factory]);
      const { readdir } = await import('node:fs/promises');
      let hostFile;
      const deadline = Date.now() + 10000;
      while (!hostFile && Date.now() < deadline) {
        hostFile = (await readdir(join(root, 'data'))).find((name) => name.startsWith('desktop-host-'));
        if (!hostFile) await delay(100);
      }
      assert.ok(hostFile, 'Hidden launch host must publish its client PID');
      const host = JSON.parse((await readFile(join(root, 'data', hostFile), 'utf8')).replace(/^\uFEFF/, ''));
      childPid = host.pid;
      childScratch = host.temporaryDirectory;
      await delay(1000);
      process.kill(childPid, 0);
      assert.match(await readFile(join(root, 'logs', 'factory.stdout.log'), 'utf8'), /factory stdout ready/);
      assert.match(await readFile(join(root, 'logs', 'factory.stderr.log'), 'utf8'), /factory stderr ready/);
    } finally {
      if (childPid) {
        try {
          process.kill(childPid);
        } catch {}
      }
      await delay(500);
      if (childScratch) {
        assert.match(childScratch, /^D:\\CodexTemp\\relay-desktop-host-[a-f0-9]+$/i);
        await rm(childScratch, { recursive: true, force: true });
      }
      await rm(root, { recursive: true, force: true });
    }
  }
);
