import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

test('Windows service survives its launcher and restarts a failed console', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  assert.doesNotMatch(tmpdir(), /^C:/i, 'Set TEMP/TMP/TMPDIR to a task directory on D: before running');
  const root = await mkdtemp(join(tmpdir(), 'relay-lifetime-'));
  const script = resolve('packages/control-room-desktop/scripts/Start-ControlRoomService.ps1');
  const run = (action) => execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Action', action, '-ConsoleDir', root], { encoding: 'utf8', windowsHide: true });
  const statusPath = join(root, 'data', 'console-service-status.json');
  async function waitFor(predicate) {
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      try { const state = JSON.parse((await readFile(statusPath, 'utf8')).replace(/^\uFEFF/, '')); if (predicate(state)) return state; } catch {}
      await delay(250);
    }
    throw new Error('Timed out waiting for console lifecycle state');
  }
  try {
    await mkdir(join(root, 'data'));
    const fixture = join(root, 'console.cjs');
    await writeFile(fixture, "setInterval(() => {}, 1000);\n");
    await writeFile(join(root, 'startup-install-record.json'), JSON.stringify({ installedExecutable: process.execPath, arguments: `"${fixture}"` }));
    run('Start'); // This command must return while its independently hosted service stays alive.
    const first = await waitFor(s => s.state === 'running' && s.consolePid);
    process.kill(first.consolePid);
    const restarted = await waitFor(s => s.state === 'running' && s.consolePid !== first.consolePid && s.restarts >= 1);
    assert.equal(restarted.supervisorPid, first.supervisorPid);
    run('Start');
    await delay(1500);
    assert.equal(JSON.parse((await readFile(statusPath, 'utf8')).replace(/^\uFEFF/, '')).supervisorPid, first.supervisorPid);
    run('Stop');
    await waitFor(s => s.state === 'stopped');
    assert.throws(() => process.kill(restarted.consolePid, 0));
  } finally {
    try { run('Stop'); await waitFor(s => s.state === 'stopped'); } catch {}
    await rm(root, { recursive: true, force: true });
  }
});
