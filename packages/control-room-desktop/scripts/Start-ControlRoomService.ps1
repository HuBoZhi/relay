param(
  [ValidateSet('Start','Watch','Stop','Status')][string]$Action='Start',
  [string]$ConsoleDir='D:\Programs\RelaySystem'
)
$ErrorActionPreference='Stop'
$ConsoleDir=(Resolve-Path -LiteralPath $ConsoleDir).Path
# Resolve junctions too: task state and process scratch must never land on C:.
$item=Get-Item -LiteralPath $ConsoleDir
if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Use a physical console directory, not a junction'}
if($ConsoleDir -imatch '^C:'){throw 'ConsoleDir must stay off C:'}
foreach($directory in @('data','logs')){
  $target=Join-Path $ConsoleDir $directory
  if((Test-Path -LiteralPath $target) -and ((Get-Item -LiteralPath $target).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'State/log directories must not be junctions'}
  New-Item -ItemType Directory -Path $target -Force | Out-Null
}
$statusFile=Join-Path $ConsoleDir 'data/console-service-status.json'
$stopFile=Join-Path $ConsoleDir 'data/console-service.stop'
$logFile=Join-Path $ConsoleDir 'logs/console-service.log'
if($Action -eq 'Status'){
  if(Test-Path -LiteralPath $statusFile){Get-Content -LiteralPath $statusFile}else{Write-Output '{"state":"not_started"}'}
  return
}
if($Action -eq 'Stop'){
  Set-Content -LiteralPath $stopFile -Value 'stop' -Encoding ascii
  return
}
if($Action -eq 'Start'){
  if(Test-Path -LiteralPath $stopFile){Remove-Item -LiteralPath $stopFile}
  # The Windows desktop shell hosts the resident process outside the invoking job.
  # Start-Process alone can leave the console subject to that job's cleanup.
  $powerShell=Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
  $arguments='-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$PSCommandPath+'" -Action Watch -ConsoleDir "'+$ConsoleDir+'"'
  $desktopShell=New-Object -ComObject Shell.Application
  try{$desktopShell.ShellExecute($powerShell,$arguments,$ConsoleDir,'open',0)}finally{[void][Runtime.InteropServices.Marshal]::ReleaseComObject($desktopShell)}
  Write-Output 'Console supervisor requested; inspect Status for runtime state'
  return
}

$hash=[Security.Cryptography.SHA256]::Create()
$identity=([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($ConsoleDir.ToLowerInvariant())))).Replace('-','')
$hash.Dispose()
$mutex=New-Object Threading.Mutex($false,('Local\RelayConsoleService-'+$identity))
$owned=$false
$scratch=$null
$child=$null
$restarts=0
function Save-State($state){
  @{state=$state;supervisorPid=$PID;consolePid=$(if($child){$child.Id}else{$null});restarts=$restarts;checkedAt=[DateTime]::UtcNow.ToString('o')} |
    ConvertTo-Json -Compress | Set-Content -LiteralPath $statusFile -Encoding utf8
}
function Write-ServiceLog($message){Add-Content -LiteralPath $logFile -Value ("$([DateTime]::UtcNow.ToString('o')) $message") -Encoding utf8}
try{
  try{$owned=$mutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$owned=$true}
  if(!$owned){return}
  $record=Get-Content -LiteralPath (Join-Path $ConsoleDir 'startup-install-record.json') -Raw -Encoding utf8 | ConvertFrom-Json
  $scratch=Join-Path 'D:\CodexTemp' ('relay-console-service-'+[guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $scratch | Out-Null
  $env:TEMP=$scratch;$env:TMP=$scratch;$env:TMPDIR=$scratch
  $env:ELECTRON_RUN_AS_NODE=$null
  $env:RELAY_CONTROL_ROOM_TOKEN=$null;$env:RELAY_WORKSPACE_KEY=$null;$env:RELAY_API_KEY=$null
  Write-ServiceLog "Supervisor started pid=$PID"
  while(!(Test-Path -LiteralPath $stopFile)){
    $existing=@(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -ieq $record.installedExecutable -and $_.CommandLine -notmatch '--type=' -and $_.CommandLine.Contains($ConsoleDir)})
    if($existing.Count){$child=Get-Process -Id $existing[0].ProcessId -ErrorAction SilentlyContinue}
    if(!$child -or $child.HasExited){
      $child=Start-Process -FilePath $record.installedExecutable -ArgumentList $record.arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $ConsoleDir 'logs/unified.stdout.log') -RedirectStandardError (Join-Path $ConsoleDir 'logs/unified.stderr.log')
      Write-ServiceLog "Console started pid=$($child.Id)"
    }
    Save-State 'running'
    while(!$child.HasExited -and !(Test-Path -LiteralPath $stopFile)){
      Start-Sleep -Seconds 1
      $child.Refresh()
      Save-State 'running'
    }
    if(Test-Path -LiteralPath $stopFile){break}
    Write-ServiceLog "Console exited pid=$($child.Id) code=$($child.ExitCode)"
    $restarts++
    Save-State 'restarting'
    # Bound restart churn without delaying an explicit stop.
    for($i=0;$i -lt [Math]::Min(30,2*$restarts) -and !(Test-Path -LiteralPath $stopFile);$i++){Start-Sleep -Seconds 1}
    $child=$null
  }
}catch{
  if($owned){Write-ServiceLog "Supervisor failed: $($_.Exception.Message)";Save-State 'failed'}
  throw
}finally{
  if($owned){
    if((Test-Path -LiteralPath $stopFile) -and $child -and !$child.HasExited){$child.Kill();$child.WaitForExit()}
    if(Test-Path -LiteralPath $stopFile){Save-State 'stopped'}
    if($scratch){
      $resolved=[IO.Path]::GetFullPath($scratch)
      if($resolved.StartsWith('D:\CodexTemp\relay-console-service-',[StringComparison]::OrdinalIgnoreCase) -and !((Get-Item -LiteralPath $resolved).Attributes -band [IO.FileAttributes]::ReparsePoint)){
        try{Remove-Item -LiteralPath $resolved -Recurse -ErrorAction Stop}catch{Write-ServiceLog "Retained scratch (in use): $resolved"}
      }
    }
    $mutex.ReleaseMutex()
  }
  $mutex.Dispose()
}
