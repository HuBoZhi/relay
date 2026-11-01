param([string]$RuntimeRoot='D:\Programs\AgentRelay')
$ErrorActionPreference='Stop'
$RuntimeRoot=(Resolve-Path -LiteralPath $RuntimeRoot).Path
if($RuntimeRoot.StartsWith('C:',[StringComparison]::OrdinalIgnoreCase)){throw 'RuntimeRoot must stay off C:'}
$apps=@(
  @{Name='WorkBuddy';Exe='D:\Program Files\WorkBuddy\WorkBuddy.exe';Port=19371;Args=@('--remote-debugging-address=127.0.0.1')},
  @{Name='ZCode';Exe='C:\Program Files\ZCode\ZCode.exe';Port=19372;Args=@('--remote-debugging-port=19372','--remote-debugging-address=127.0.0.1')}
)
foreach($app in $apps){
  $targets=$null
  try{$targets=Invoke-RestMethod -Uri "http://127.0.0.1:$($app.Port)/json/list" -TimeoutSec 3}catch{}
  if($targets){
    $pattern=if($app.Name -eq 'ZCode'){'/ZCode/resources/app\.asar/out/renderer/index\.html'}else{'/WorkBuddy/resources/app\.asar/renderer/index\.html'}
    $matches=@($targets | Where-Object {$_.type -eq 'page' -and [Uri]::UnescapeDataString($_.url) -match $pattern})
    if($matches.Count -ne 1){throw 'Port belongs to an unexpected app'}
    Write-Output "$($app.Name): native API endpoint is ready"
    continue
  }
  if(Get-Process -Name $app.Name -ErrorAction SilentlyContinue){throw "$($app.Name) is running without a verified API endpoint. Quit it before launching with API enabled; this script will not terminate your work."}
  $scratch=Join-Path 'D:\CodexTemp' ('relay-desktop-host-'+[guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $scratch | Out-Null
  $previous=@{}
  foreach($key in @('TEMP','TMP','TMPDIR','WORKBUDDY_REMOTE_DEBUGGING_PORT','ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT')){$previous[$key]=[Environment]::GetEnvironmentVariable($key,'Process')}
  try{
    $env:TEMP=$scratch;$env:TMP=$scratch;$env:TMPDIR=$scratch
    if($app.Name -eq 'WorkBuddy'){$env:WORKBUDDY_REMOTE_DEBUGGING_PORT='19371'}else{$env:ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT='1'}
    $process=Start-Process -FilePath $app.Exe -ArgumentList $app.Args -WindowStyle Hidden -PassThru
    $record=Join-Path $RuntimeRoot "data/desktop-host-$($process.Id).json"
    @{app=$app.Name;pid=$process.Id;temporaryDirectory=$scratch;cleanup='After this app and its children exit, verify and remove only this directory.'}|ConvertTo-Json|Set-Content -LiteralPath $record -Encoding utf8
    Write-Output "$($app.Name): launched with native API; runtime temporary directory recorded in $record"
  }finally{foreach($key in $previous.Keys){[Environment]::SetEnvironmentVariable($key,$previous[$key],'Process')}}
}
