param([string]$RuntimeRoot='D:\Programs\AgentRelay',[string]$ConsoleDir='D:\Programs\RelaySystem')
$ErrorActionPreference='Stop'
$stateFile=Join-Path $RuntimeRoot 'data/workspace.private.json'
if(!(Test-Path -LiteralPath $stateFile)){throw 'Existing Relay workspace state is required; no new workspace will be created'}
$record=Get-Content -LiteralPath (Join-Path $ConsoleDir 'startup-install-record.json') -Raw -Encoding UTF8|ConvertFrom-Json
if($record.workspaceStatePath -ine $stateFile){throw 'Console and desktop adapters must use the same workspace state file'}
$temporaryPath=Join-Path 'D:\CodexTemp' ('relay-system-start-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temporaryPath -Force|Out-Null
$keys=@('TEMP','TMP','TMPDIR','ELECTRON_RUN_AS_NODE','RELAY_CONTROL_ROOM_TOKEN','RELAY_WORKSPACE_KEY','RELAY_API_KEY');$previous=@{}
foreach($key in $keys){$previous[$key]=[Environment]::GetEnvironmentVariable($key,'Process')}
$steps=@()
try{
  $env:TEMP=$temporaryPath;$env:TMP=$temporaryPath;$env:TMPDIR=$temporaryPath;$env:ELECTRON_RUN_AS_NODE=$null
  $env:RELAY_CONTROL_ROOM_TOKEN=$null;$env:RELAY_WORKSPACE_KEY=$null;$env:RELAY_API_KEY=$null
  foreach($client in @('zcode','workbuddy','factory')){
    try{
      $output=(& (Join-Path $RuntimeRoot 'Ensure-RelayClient.ps1') -Client $client -RuntimeRoot $RuntimeRoot | Out-String).Trim()
      $steps+=@{client=$client;status=$output}
    }catch{$steps+=@{client=$client;status='startup_error';error=$_.Exception.Message}}
  }
  & (Join-Path $RuntimeRoot 'Start-ControlRoomService.ps1') -Action Start -ConsoleDir $ConsoleDir
  $health=$null
  for($attempt=0;$attempt -lt 20 -and !$health;$attempt++){
    try{$health=Invoke-RestMethod -Uri 'http://127.0.0.1:4320/api/health' -TimeoutSec 1}catch{[Threading.Thread]::Sleep(500)}
  }
  $running=Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -ieq $record.installedExecutable -and $_.CommandLine -notmatch '--type='}
  $consolePid=if($running){@($running)[0].ProcessId}else{$null}
  @{startedAt=[DateTime]::UtcNow.ToString('o');backend='hosted-relaycast';workspaceStatePath=$stateFile;
    nativeWindowsBroker='unsupported_by_installed_cli';clients=$steps;consolePid=$consolePid;consoleReady=[bool]$health;url='http://127.0.0.1:4320'}|
    ConvertTo-Json -Depth 6|Set-Content -LiteralPath (Join-Path $RuntimeRoot 'data/unified-system-status.json') -Encoding utf8
  $steps | ForEach-Object {Write-Output ($_.client+': '+$_.status)}
  Write-Output 'Relay system console: http://127.0.0.1:4320'
  if(!$health){throw 'Relay console did not become ready; inspect console-service-status.json and console logs'}
}finally{
  foreach($key in $keys){[Environment]::SetEnvironmentVariable($key,$previous[$key],'Process')}
  $resolved=(Resolve-Path -LiteralPath $temporaryPath).Path
  if($resolved -eq $temporaryPath -and $resolved.StartsWith('D:\CodexTemp\relay-system-start-',[StringComparison]::OrdinalIgnoreCase) -and !((Get-Item -LiteralPath $resolved).Attributes -band [IO.FileAttributes]::ReparsePoint)){
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}
