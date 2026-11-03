param(
  [ValidateSet('Configure','Check','Start')][string]$Action='Check',
  [ValidateSet('zcode','workbuddy')][string[]]$Client=@('zcode','workbuddy'),
  [string]$RuntimeRoot='D:\Programs\AgentRelay'
)
$ErrorActionPreference='Stop'
$apps=@(
  @{Key='zcode';Name='ZCode';Exe='C:\Program Files\ZCode\ZCode.exe';Port=19372;Pattern='/ZCode/resources/app\.asar/out/renderer/index\.html$'},
  @{Key='workbuddy';Name='WorkBuddy';Exe='D:\Program Files\WorkBuddy\WorkBuddy.exe';Port=19371;Pattern='/WorkBuddy/resources/app\.asar/renderer/index\.html$'}
) | Where-Object Key -In $Client
$runKey='HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
if($Action -eq 'Configure'){
  $backup=Join-Path $RuntimeRoot ('data/startup-backup-'+[guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $backup -Force | Out-Null
  $record=@{run=@{};environment=@{};shortcuts=@()}
  $shell=New-Object -ComObject WScript.Shell
  foreach($app in $apps){
    $old=(Get-ItemProperty -LiteralPath $runKey -ErrorAction SilentlyContinue).($app.Name)
    $record.run[$app.Name]=$old
    $args="--remote-debugging-port=$($app.Port) --remote-debugging-address=127.0.0.1"
    # Keep original shortcut targets, icon, working directory, and unrelated arguments.
    $taskbar=Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Microsoft/Internet Explorer/Quick Launch/User Pinned/TaskBar'
    $roots=@([Environment]::GetFolderPath('Desktop'),[Environment]::GetFolderPath('CommonDesktopDirectory'),[Environment]::GetFolderPath('Programs'),[Environment]::GetFolderPath('CommonPrograms'),[Environment]::GetFolderPath('Startup'),$taskbar) | Where-Object {Test-Path -LiteralPath $_} | Select-Object -Unique
    foreach($link in (Get-ChildItem -LiteralPath $roots -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue)){
      $shortcut=$shell.CreateShortcut($link.FullName)
      if($shortcut.TargetPath -ine $app.Exe){continue}
      $copy=Join-Path $backup ([guid]::NewGuid().ToString('N')+'.lnk')
      Copy-Item -LiteralPath $link.FullName -Destination $copy
      $record.shortcuts+=@{path=$link.FullName;backup=$copy}
      $record | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $backup 'before.json') -Encoding utf8
      $shortcut.Arguments=($shortcut.Arguments -replace '(?i)--remote-debugging-(?:port|address)(?:=|\s+)\S+','').Trim()
      $shortcut.Arguments=($shortcut.Arguments+' '+$args).Trim()
      try {$shortcut.Save()} catch {
        # A per-user Start Menu shortcut shadows a protected machine shortcut.
        $personal=Join-Path ([Environment]::GetFolderPath('Programs')) $link.Name
        $existed=Test-Path -LiteralPath $personal
        $s=$shell.CreateShortcut($personal)
        if($existed -and $s.TargetPath -ine $app.Exe){throw 'Existing user shortcut belongs to another application'}
        $s.TargetPath=$app.Exe;$s.Arguments=$args;$s.IconLocation=$shortcut.IconLocation;$s.Save()
        if(!$existed){$record.shortcuts+=@{path=$personal;created=$true}}
      }
    }
    if($app.Key -eq 'workbuddy'){
      $record.environment.WORKBUDDY_REMOTE_DEBUGGING_PORT=[Environment]::GetEnvironmentVariable('WORKBUDDY_REMOTE_DEBUGGING_PORT','User')
      $record | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $backup 'before.json') -Encoding utf8
      [Environment]::SetEnvironmentVariable('WORKBUDDY_REMOTE_DEBUGGING_PORT','19371','User')
    }
    # Run entries start each client with its loopback interface at sign-in.
    New-ItemProperty -LiteralPath $runKey -Name $app.Name -Value ('"'+$app.Exe+'" '+$args) -PropertyType String -Force | Out-Null
  }
  $record | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $backup 'before.json') -Encoding utf8
  Write-Output "Configured shortcuts and sign-in startup. Backup: $backup"
}
foreach($app in $apps){
  $ready=$false
  try {
    $targets=Invoke-RestMethod -Uri "http://127.0.0.1:$($app.Port)/json/list" -TimeoutSec 3
    $ready=@($targets | Where-Object {$_.type -eq 'page' -and ([Uri]$_.url).Scheme -eq 'file' -and [Uri]::UnescapeDataString(([Uri]$_.url).AbsolutePath) -match $app.Pattern}).Count -eq 1
    if(!$ready){throw "Port $($app.Port) belongs to an unexpected application"}
  } catch {if($_.Exception.Message -match 'unexpected application'){throw}}
  if($ready){Write-Output "$($app.Name): ready on 127.0.0.1:$($app.Port)";continue}
  if(Get-Process -Name $app.Name -ErrorAction SilentlyContinue){Write-Output "$($app.Name): restart_needed (running without interface)";continue}
  if($Action -ne 'Start'){Write-Output "$($app.Name): stopped";continue}
  $scratch=Join-Path 'D:\CodexTemp' ('relay-desktop-host-'+[guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $scratch | Out-Null
  $keys=@('TEMP','TMP','TMPDIR','WORKBUDDY_REMOTE_DEBUGGING_PORT','ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT');$previous=@{}
  foreach($key in $keys){$previous[$key]=[Environment]::GetEnvironmentVariable($key,'Process')}
  try {
    $env:TEMP=$scratch;$env:TMP=$scratch;$env:TMPDIR=$scratch
    $env:WORKBUDDY_REMOTE_DEBUGGING_PORT='19371';$env:ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT='1'
    $p=Start-Process -FilePath $app.Exe -ArgumentList "--remote-debugging-port=$($app.Port)",'--remote-debugging-address=127.0.0.1' -WindowStyle Hidden -PassThru
    @{app=$app.Name;pid=$p.Id;temporaryDirectory=$scratch;cleanup='Remove only after this application and children exit.'} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $RuntimeRoot "data/desktop-host-$($p.Id).json")
    Write-Output "$($app.Name): started, pid=$($p.Id)"
  } finally {foreach($key in $keys){[Environment]::SetEnvironmentVariable($key,$previous[$key],'Process')}}
}
