import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scripts = fileURLToPath(new URL('../scripts/', import.meta.url));
const quote = value => "'" + value.replaceAll("'", "''") + "'";
async function powershell(body) {
  assert.doesNotMatch(tmpdir(), /^C:/i);
  const root = await mkdtemp(join(tmpdir(), 'relay-recovery-'));
  try {
    const script = join(root, 'test.ps1');
    await writeFile(script, "\uFEFF$ErrorActionPreference='Stop'\n" + body(root));
    return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
      encoding: 'utf8', windowsHide: true, timeout: 15000,
    });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('Windows PowerShell recognizes the ZCode interface when its file URL has a query', { skip: process.platform !== 'win32' }, async () => {
  const output = await powershell(() => `
function Invoke-RestMethod { @([pscustomobject]@{type='page';url='file:///C:/Program%20Files/ZCode/resources/app.asar/out/renderer/index.html?restoreSession=true&marks=%7B%22x%22%3A1%7D'}) }
& ${quote(join(scripts, 'Configure-RelayStartup.ps1'))} -Action Check -Client zcode
`);
  assert.match(output, /ZCode: ready/);
});
