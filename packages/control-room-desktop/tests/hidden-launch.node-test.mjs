import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

test('Factory launch writes child output to files and returns without a terminal dependency', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  assert.doesNotMatch(tmpdir(), /^C:/i);
  const root = await mkdtemp(join(tmpdir(), 'relay-hidden-'));
  const ps = (args) => execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], { encoding: 'utf8', windowsHide: true });
  let childPid;
  let childScratch;
  try {
    const factory = join(root, 'factory');
    const version = join(factory, 'app-1.2.0');
    await mkdir(version, { recursive: true });
    await mkdir(join(root, 'data'));
    await mkdir(join(root, 'logs'));
    const fixture = join(root, 'fixture.cs');
    await writeFile(fixture, 'using System; public class Fixture { public static void Main(string[] args) { Console.WriteLine("factory stdout ready"); Console.Error.WriteLine("factory stderr ready"); System.Threading.Thread.Sleep(60000); } }');
    const compiler = join(root, 'compile.ps1');
    await writeFile(compiler, 'param($Source,$Output)\nAdd-Type -TypeDefinition (Get-Content -LiteralPath $Source -Raw) -OutputAssembly $Output -OutputType ConsoleApplication\n');
    ps(['-File', compiler, '-Source', fixture, '-Output', join(version, 'factory-desktop.exe')]);
    const script = fileURLToPath(new URL('../scripts/Start-RelayFactory.ps1', import.meta.url));
    ps(['-File', script, '-RuntimeRoot', root, '-FactoryRoot', factory]);
    const { readdir } = await import('node:fs/promises');
    let hostFile;
    const deadline = Date.now() + 10000;
    while (!hostFile && Date.now() < deadline) {
      hostFile = (await readdir(join(root, 'data'))).find(name => name.startsWith('desktop-host-'));
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
    if (childPid) { try { process.kill(childPid); } catch {} }
    await delay(500);
    if (childScratch) {
      assert.match(childScratch, /^D:\\CodexTemp\\relay-desktop-host-[a-f0-9]+$/i);
      await rm(childScratch, { recursive: true, force: true });
    }
    await rm(root, { recursive: true, force: true });
  }
});
