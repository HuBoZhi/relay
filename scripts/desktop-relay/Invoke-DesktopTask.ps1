param(
  [Parameter(Mandatory=$true)][ValidateSet('workbuddy','zcode')][string]$Client,
  [string]$TaskFile,
  [string]$RuntimeRoot='D:\Programs\AgentRelay'
)
$ErrorActionPreference='Stop'
$scratch=Join-Path 'D:\CodexTemp' ('relay-desktop-task-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch | Out-Null
$previous=@{}
foreach($key in @('TEMP','TMP','TMPDIR','NODE_COMPILE_CACHE')){$previous[$key]=[Environment]::GetEnvironmentVariable($key,'Process')}
try {
  $env:TEMP=$scratch;$env:TMP=$scratch;$env:TMPDIR=$scratch;$env:NODE_COMPILE_CACHE=Join-Path $scratch 'node-cache'
  $taskArgs=@((Join-Path $RuntimeRoot 'desktop-native\run.mjs'),$Client,$RuntimeRoot)
  if($TaskFile){
    $taskPath=(Resolve-Path -LiteralPath $TaskFile).Path
    if([IO.Path]::GetExtension($taskPath) -ne '.md'){throw 'TaskFile must be a Markdown file'}
    $taskArgs+=$taskPath
  }
  & node @taskArgs
  $taskExitCode=$LASTEXITCODE
} finally {
  foreach($key in $previous.Keys){[Environment]::SetEnvironmentVariable($key,$previous[$key],'Process')}
  $actual=(Resolve-Path -LiteralPath $scratch).Path
  if($actual -eq $scratch -and $actual.StartsWith('D:\CodexTemp\relay-desktop-task-',[StringComparison]::OrdinalIgnoreCase)){
    Remove-Item -LiteralPath $actual -Recurse -Force
  }
}
exit $taskExitCode
