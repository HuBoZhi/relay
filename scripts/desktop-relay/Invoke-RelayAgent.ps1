param(
  [Parameter(Mandatory=$true)][ValidateSet('zcode','workbuddy')][string]$Client,
  [Parameter(Mandatory=$true)][string]$Project,
  [Parameter(Mandatory=$true)][string]$TaskFile,
  [string]$ProviderId,
  [string]$ModelId,
  [ValidateSet('disabled','low','high','max')][string]$ReasoningLevel='max',
  [string]$SessionId,
  [switch]$NewSession,
  [string]$RuntimeRoot='D:\Programs\AgentRelay'
)
$ErrorActionPreference='Stop'
if($SessionId -and $NewSession){throw 'Choose SessionId or NewSession'}
if($Client -eq 'zcode' -and (!$ProviderId -or !$ModelId)){throw 'ZCode requires the desktop ProviderId and ModelId'}
if($Client -eq 'workbuddy' -and ($ProviderId -or $ModelId)){throw 'WorkBuddy uses its desktop default model; model override is not implemented'}
$workspace=(Resolve-Path -LiteralPath $Project).Path
$task=(Resolve-Path -LiteralPath $TaskFile).Path
if([IO.Path]::GetExtension($task) -ne '.md'){throw 'TaskFile must be Markdown'}
$scratch=Join-Path 'D:\CodexTemp' ('relay-agent-task-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch | Out-Null
$previous=@{}
foreach($key in @('TEMP','TMP','TMPDIR','NODE_COMPILE_CACHE')){$previous[$key]=[Environment]::GetEnvironmentVariable($key,'Process')}
try {
  $env:TEMP=$scratch;$env:TMP=$scratch;$env:TMPDIR=$scratch;$env:NODE_COMPILE_CACHE=Join-Path $scratch 'node-cache'
  $config=@{workspace=$workspace;newSession=[bool]$NewSession;sessionId=$SessionId}
  if($Client -eq 'zcode'){$config.model=@{providerId=$ProviderId;modelId=$ModelId;options=@{reasoningLevel=$ReasoningLevel}}}
  $configPath=Join-Path $scratch 'request.json'
  $config | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $configPath -Encoding utf8NoBOM
  & node (Join-Path $RuntimeRoot 'desktop-native/global-run.mjs') $Client $RuntimeRoot $task $configPath
  $resultCode=$LASTEXITCODE
} finally {
  foreach($key in $previous.Keys){[Environment]::SetEnvironmentVariable($key,$previous[$key],'Process')}
  $actual=(Resolve-Path -LiteralPath $scratch).Path
  if($actual -ne $scratch -or !$actual.StartsWith('D:\CodexTemp\relay-agent-task-',[StringComparison]::OrdinalIgnoreCase)){throw 'Refusing unexpected cleanup path'}
  Remove-Item -LiteralPath $actual -Recurse -Force
}
exit $resultCode
