param([string]$RuntimeRoot='D:\Programs\AgentRelay',[string]$ConsoleDir='D:\Programs\RelaySystem',[switch]$Background,[switch]$ClientsOnly,[switch]$SkipZCode)
$ErrorActionPreference='Stop'
$stateFile=Join-Path $RuntimeRoot 'data/workspace.private.json'
if(!(Test-Path -LiteralPath $stateFile)){throw 'Existing Relay workspace state is required; no new workspace will be created'}
$record=Get-Content -LiteralPath (Join-Path $ConsoleDir 'startup-install-record.json') -Raw -Encoding UTF8|ConvertFrom-Json
if($record.workspaceStatePath -ine $stateFile){throw 'Console and desktop adapters must use the same workspace state file'}
$temporaryPath=Join-Path $ConsoleDir 'data/temp'
New-Item -ItemType Directory -Path $temporaryPath -Force|Out-Null
$keys=@('TEMP','TMP','TMPDIR','ELECTRON_RUN_AS_NODE','RELAY_CONTROL_ROOM_TOKEN','RELAY_WORKSPACE_KEY','RELAY_API_KEY');$previous=@{}
foreach($key in $keys){$previous[$key]=[Environment]::GetEnvironmentVariable($key,'Process')}
$steps=@()
try{
  $env:TEMP=$temporaryPath;$env:TMP=$temporaryPath;$env:TMPDIR=$temporaryPath;$env:ELECTRON_RUN_AS_NODE=$null
  $env:RELAY_CONTROL_ROOM_TOKEN=$null;$env:RELAY_WORKSPACE_KEY=$null;$env:RELAY_API_KEY=$null
  foreach($client in @('zcode','workbuddy','factory')){
    if($client -eq 'zcode' -and $SkipZCode){$steps+=@{client=$client;status='mcp_managed'};continue}
    try{
      $output=(& (Join-Path $RuntimeRoot 'Configure-RelayStartup.ps1') -Action Start -Client $client -RuntimeRoot $RuntimeRoot | Out-String).Trim()
      $steps+=@{client=$client;status=$output}
    }catch{$steps+=@{client=$client;status='startup_error';error=$_.Exception.Message}}
  }
  if($ClientsOnly){return}
  $running=Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -ieq $record.installedExecutable -and $_.CommandLine -notmatch '--type='}
  # Login startup stays a silent tray resident; a manual launch (the Start menu
  # shortcut) opens the window, because that is what clicking an app icon means.
  $consoleArgs=($record.arguments -replace '(?<!\S)--no-window(?!\S)','').Trim()
  if($Background){$consoleArgs=$consoleArgs+' --no-window'}
  $consolePid=if($running){@($running)[0].ProcessId}else{$null}
  if(!$running){
    $launch=@{FilePath=$record.installedExecutable;ArgumentList=$consoleArgs;PassThru=$true;
      RedirectStandardOutput=(Join-Path $ConsoleDir 'logs/unified.stdout.log');
      RedirectStandardError=(Join-Path $ConsoleDir 'logs/unified.stderr.log')}
    # The GUI owns visibility via --no-window. Forcing SW_HIDE on the whole
    # process can make the first later BrowserWindow.show() stay invisible.
    $running=Start-Process @launch
    $consolePid=$running.Id
  }elseif(!$Background){
    # Already resident from login: a second launch is the app's own signal to
    # raise its window, so the icon never lands on a hidden console.
    Start-Process -FilePath $record.installedExecutable -ArgumentList $consoleArgs | Out-Null
  }
  $health=$null
  for($attempt=0;$attempt -lt 20 -and !$health;$attempt++){
    try{$health=Invoke-RestMethod -Uri 'http://127.0.0.1:4320/api/health' -TimeoutSec 1}catch{[Threading.Thread]::Sleep(500)}
  }
  @{startedAt=[DateTime]::UtcNow.ToString('o');backend='hosted-relaycast';workspaceStatePath=$stateFile;
    nativeWindowsBroker='unsupported_by_installed_cli';clients=$steps;consolePid=$consolePid;consoleReady=[bool]$health;url='http://127.0.0.1:4320'}|
    ConvertTo-Json -Depth 6|Set-Content -LiteralPath (Join-Path $RuntimeRoot 'data/unified-system-status.json') -Encoding utf8
  $steps | ForEach-Object {Write-Output ($_.client+': '+$_.status)}
  Write-Output 'Relay system console: http://127.0.0.1:4320'
  if(!$health){throw 'Relay console did not become ready; inspect unified-system-status.json and console logs'}
}finally{foreach($key in $keys){[Environment]::SetEnvironmentVariable($key,$previous[$key],'Process')}}
