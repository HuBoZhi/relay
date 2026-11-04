param(
  [Parameter(Mandatory=$true)][ValidateSet('register','inbox')][string]$Action,
  [string]$ThreadId=$env:CODEX_THREAD_ID,
  [string]$RuntimeRoot='D:\Programs\AgentRelay'
)
$ErrorActionPreference='Stop'
if (-not $ThreadId) { throw 'ThreadId is required outside the target Codex chat' }
$scratch=Join-Path 'D:\CodexTemp' ('relay-codex-mailbox-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch | Out-Null
$previous=@{}
foreach($key in @('TEMP','TMP','TMPDIR','NODE_COMPILE_CACHE')){$previous[$key]=[Environment]::GetEnvironmentVariable($key,'Process')}
try {
  $env:TEMP=$scratch;$env:TMP=$scratch;$env:TMPDIR=$scratch;$env:NODE_COMPILE_CACHE=Join-Path $scratch 'node-cache'
  & node (Join-Path $RuntimeRoot 'scripts\codex-mailbox.mjs') $Action $ThreadId $RuntimeRoot
  if ($LASTEXITCODE -ne 0) { throw "Codex mailbox failed (exit $LASTEXITCODE)" }
} finally {
  foreach($key in $previous.Keys){[Environment]::SetEnvironmentVariable($key,$previous[$key],'Process')}
  $actual=(Resolve-Path -LiteralPath $scratch).Path
  if($actual -eq $scratch -and $actual.StartsWith('D:\CodexTemp\relay-codex-mailbox-',[StringComparison]::OrdinalIgnoreCase)){
    Remove-Item -LiteralPath $actual -Recurse -Force
  }
}
