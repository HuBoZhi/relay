import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
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

async function recovery(mode) {
  return powershell(root => `
$runtime=${quote(root)}
New-Item -ItemType Directory -Path (Join-Path $runtime 'data') | Out-Null
$global:ready=${mode === 'ready' ? '$true' : '$false'}
$global:running=${mode === 'stopped' ? '$false' : '$true'}; $global:starts=0; $global:stops=@();$global:checks=0
$global:session=(Get-Process -Id $PID).SessionId
function Get-CimInstance {
  param($ClassName,$Filter)
  $items=@(
    [pscustomobject]@{ProcessId=${mode === 'self' ? '$PID' : '424242'};ParentProcessId=0;SessionId=$global:session;ExecutablePath='C:\\Program Files\\ZCode\\ZCode.exe'},
    [pscustomobject]@{ProcessId=424243;ParentProcessId=0;SessionId=$global:session;ExecutablePath='D:\\Other\\ZCode.exe'}
  )
  if($Filter -match 'ProcessId\\s*=\\s*(\\d+)'){ $items | Where-Object ProcessId -eq ([int]$Matches[1]); return }
  if($global:running){$items}
}
function Stop-Process { param($Id,[switch]$Force) $global:stops+=@($Id); $global:running=$false }
$stub=@'
param($Action,$Client,$RuntimeRoot)
${mode === 'conflict' ? "throw 'Port 19372 belongs to an unexpected application'" : ''}
${mode === 'warming' ? "if($Action -eq 'Check'){$global:checks++;if($global:checks -gt 1){$global:ready=$true}}" : ''}
if($Action -eq 'Start'){$global:starts++;$global:running=$true;${mode === 'fails' ? '' : '$global:ready=$true'}}
if($global:ready){'ZCode: ready on 127.0.0.1:19372'}elseif($global:running){'ZCode: restart_needed (running without interface)'}else{'ZCode: stopped'}
'@
[IO.File]::WriteAllText((Join-Path $runtime 'Configure-RelayStartup.ps1'),$stub)
try { & ${quote(join(scripts, 'Ensure-RelayClient.ps1'))} -Client zcode -RuntimeRoot $runtime -StartupGraceSeconds ${mode === 'warming' ? '1' : '0'} -ReadyTimeoutSeconds 1; $failed=$false } catch {$failed=$true}
@{starts=$global:starts;stops=@($global:stops);failed=$failed;report=(Get-Content (Join-Path $runtime 'reports/desktop-recovery-zcode.json') -Raw|ConvertFrom-Json)} | ConvertTo-Json -Depth 6 -Compress
`);
}
test('automatic recovery reuses a healthy client without stopping any process', { skip: process.platform !== 'win32' }, async () => {
  const result = JSON.parse((await recovery('ready')).trim().split(/\r?\n/).at(-1));
  assert.equal(result.failed, false);
  assert.equal(result.starts, 0);
  assert.deepEqual(result.stops, []);
  assert.equal(result.report.action, 'reused');
});

test('recovery restarts only the matching installed client and verifies its new interface', { skip: process.platform !== 'win32' }, async () => {
  const result = JSON.parse((await recovery('restart')).trim().split(/\r?\n/).at(-1));
  assert.equal(result.failed, false);
  assert.equal(result.starts, 1);
  assert.deepEqual(result.stops, [424242]);
  assert.equal(result.report.action, 'restarted');
  assert.equal(result.report.state, 'ready');
});

test('a stopped client is launched without killing other applications', { skip: process.platform !== 'win32' }, async () => {
  const result = JSON.parse((await recovery('stopped')).trim().split(/\r?\n/).at(-1));
  assert.equal(result.failed, false);
  assert.equal(result.starts, 1);
  assert.deepEqual(result.stops, []);
  assert.equal(result.report.action, 'started');
});
test('a port occupied by an unexpected application does not cause a restart', { skip: process.platform !== 'win32' }, async () => {
  const result = JSON.parse((await recovery('conflict')).trim().split(/\r?\n/).at(-1));
  assert.equal(result.failed, true);
  assert.equal(result.starts, 0);
  assert.deepEqual(result.stops, []);
  assert.equal(result.report.state, 'failed');
});
test('an unsuccessful recovery stops after one restart and reports failure', { skip: process.platform !== 'win32' }, async () => {
  const result = JSON.parse((await recovery('fails')).trim().split(/\r?\n/).at(-1));
  assert.equal(result.failed, true);
  assert.equal(result.starts, 1);
  assert.deepEqual(result.stops, [424242]);
  assert.equal(result.report.state, 'failed');
});
test('a desktop that is still starting gets a grace period and is not restarted', { skip: process.platform !== 'win32' }, async () => {
  const result = JSON.parse((await recovery('warming')).trim().split(/\r?\n/).at(-1));
  assert.equal(result.failed, false);
  assert.equal(result.starts, 0);
  assert.deepEqual(result.stops, []);
});
test('recovery does not terminate the desktop hosting its own synchronous caller', { skip: process.platform !== 'win32' }, async () => {
  const result = JSON.parse((await recovery('self')).trim().split(/\r?\n/).at(-1));
  assert.equal(result.failed, true);
  assert.equal(result.starts, 0);
  assert.deepEqual(result.stops, []);
  assert.match(result.report.error, /self_restart_required/);
});
test('the task entry point performs preflight before handing a BOM-free request to Node on PS 5.1', { skip: process.platform !== 'win32' }, async () => {
  const output = await powershell(root => `
$runtime=${quote(root)}
[IO.File]::WriteAllText((Join-Path $runtime 'Ensure-RelayClient.ps1'),${quote("param($Client,$RuntimeRoot)\nWrite-Output 'PREFLIGHT_OK'")})
[IO.File]::WriteAllText((Join-Path $runtime 'task.md'),'Task')
function node {
  $text=[IO.File]::ReadAllText($args[-1])
  if($text[0] -eq [char]0xfeff){throw 'Unexpected BOM'}
  $null=$text|ConvertFrom-Json
  Write-Output 'NODE_SENT'
  $global:LASTEXITCODE=0
}
& ${quote(join(scripts, 'Invoke-RelayAgent.ps1'))} -Client workbuddy -Project $runtime -TaskFile (Join-Path $runtime 'task.md') -RuntimeRoot $runtime
`);
  assert.match(output, /PREFLIGHT_OK[\s\S]*NODE_SENT/);
});
test('Windows login startup runs recovery for all three clients and records their results', { skip: process.platform !== 'win32' }, async () => {
  const output = await powershell(root => `
$runtime=${quote(root)}
New-Item -ItemType Directory -Path (Join-Path $runtime 'data') | Out-Null
[IO.File]::WriteAllText((Join-Path $runtime 'data/workspace.private.json'),'{}')
@{workspaceStatePath=(Join-Path $runtime 'data/workspace.private.json');installedExecutable='D:\\NoConsole.exe'}|ConvertTo-Json|Set-Content (Join-Path $runtime 'startup-install-record.json')
[IO.File]::WriteAllText((Join-Path $runtime 'Ensure-RelayClient.ps1'),${quote('param($Client,$RuntimeRoot)\nWrite-Output ($Client+": ready on loopback")')})
[IO.File]::WriteAllText((Join-Path $runtime 'Start-ControlRoomService.ps1'),${quote('param($Action,$ConsoleDir)')})
function Invoke-RestMethod { @{ok=$true} }
function Get-CimInstance { @() }
& ${quote(join(scripts, 'Start-RelaySystem.ps1'))} -RuntimeRoot $runtime -ConsoleDir $runtime
Get-Content (Join-Path $runtime 'data/unified-system-status.json') -Raw
`);
  const record = JSON.parse(output.slice(output.indexOf('{')));
  assert.deepEqual(record.clients.map(x => x.client), ['zcode', 'workbuddy', 'factory']);
  assert.ok(record.clients.every(x => /ready/.test(x.status)));
});
