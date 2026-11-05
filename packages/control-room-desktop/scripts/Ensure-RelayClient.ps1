param(
  [Parameter(Mandatory=$true)][ValidateSet('zcode','workbuddy','factory')][string]$Client,
  [string]$RuntimeRoot='D:\Programs\AgentRelay',
  [ValidateRange(0,60)][int]$StartupGraceSeconds=15,
  [ValidateRange(1,120)][int]$ReadyTimeoutSeconds=45
)
$ErrorActionPreference='Stop'
$report=@{client=$Client;checkedAt=[DateTime]::UtcNow.ToString('o');action='none';state='checking';validation='desktop-interface-only'}
$reportDir=Join-Path $RuntimeRoot 'reports'
New-Item -ItemType Directory -Path $reportDir -Force | Out-Null
$mutex=New-Object Threading.Mutex($false,"Local\AgentRelay.ClientRecovery.$Client")
$locked=$false
function Get-InterfaceStatus {
  (& (Join-Path $RuntimeRoot 'Configure-RelayStartup.ps1') -Action Check -Client $Client -RuntimeRoot $RuntimeRoot | Out-String).Trim()
}
function Test-ClientProcess($process) {
  if($process.SessionId -ne (Get-Process -Id $PID).SessionId){return $false}
  switch($Client){
    'zcode' {return $process.ExecutablePath -ieq 'C:\Program Files\ZCode\ZCode.exe'}
    'workbuddy' {return $process.ExecutablePath -ieq 'D:\Program Files\WorkBuddy\WorkBuddy.exe'}
    'factory' {
      $root=[regex]::Escape((Join-Path $env:LOCALAPPDATA 'Factory'))
      return $process.ExecutablePath -imatch ('^'+$root+'\\(?:app-[\d.]+\\)?factory-desktop\.exe$')
    }
  }
}
try {
  try{$locked=$mutex.WaitOne(60000)}catch [Threading.AbandonedMutexException]{$locked=$true}
  if(!$locked){throw 'Client recovery is already running; try again after it finishes'}
  $status=Get-InterfaceStatus
  $timer=[Diagnostics.Stopwatch]::StartNew()
  # Give an already-starting desktop time to expose its port before restarting it.
  while($status -match ': restart_needed' -and $timer.Elapsed.TotalSeconds -lt $StartupGraceSeconds){
    Start-Sleep -Milliseconds 500
    $status=Get-InterfaceStatus
  }
  $report.before=$status
  if($status -match ': ready on '){$report.action='reused'}else{
    if($status -notmatch ': (restart_needed|stopped)'){throw 'Unknown interface status; automatic restart cancelled'}
    $processes=@(Get-CimInstance Win32_Process)
    $targets=@($processes | Where-Object {Test-ClientProcess $_})
    # Never synchronously kill the app hosting this invocation.
    $cursor=$PID;$ancestors=@{}
    while($cursor -and !$ancestors.ContainsKey([int]$cursor)){
      $ancestors[[int]$cursor]=$true
      $parent=$processes | Where-Object ProcessId -eq $cursor | Select-Object -First 1
      if(!$parent){break};$cursor=$parent.ParentProcessId
    }
    if(@($targets | Where-Object {$ancestors.ContainsKey([int]$_.ProcessId)}).Count){
      throw 'self_restart_required: run recovery from an independent caller'
    }
    if($targets.Count){
      $report.action='restarted'
      foreach($target in $targets){
        try{[void]([Diagnostics.Process]::GetProcessById($target.ProcessId).CloseMainWindow())}catch{}
      }
      Start-Sleep -Milliseconds 1000
      foreach($target in $targets){
        $current=Get-CimInstance Win32_Process -Filter "ProcessId = $($target.ProcessId)"
        if($current -and (Test-ClientProcess $current)){Stop-Process -Id $current.ProcessId -Force}
      }
      $exitTimer=[Diagnostics.Stopwatch]::StartNew()
      while(@(Get-CimInstance Win32_Process | Where-Object {Test-ClientProcess $_}).Count){
        if($exitTimer.Elapsed.TotalSeconds -ge 10){throw 'Client did not exit; automatic restart cancelled'}
        Start-Sleep -Milliseconds 250
      }
    }else{
      if($status -match ': restart_needed'){throw 'Running client does not match the expected installation in this Windows session'}
      $report.action='started'
    }
    # One launch only. Failure is recorded, never handled by a restart loop.
    & (Join-Path $RuntimeRoot 'Configure-RelayStartup.ps1') -Action Start -Client $Client -RuntimeRoot $RuntimeRoot | Out-Null
    $timer.Restart()
    do {
      $status=Get-InterfaceStatus
      if($status -match ': ready on '){break}
      if($timer.Elapsed.TotalSeconds -ge $ReadyTimeoutSeconds){throw 'Desktop interface did not become ready after one launch'}
      Start-Sleep -Milliseconds 500
    }while($true)
  }
  $report.state='ready';$report.after=$status
  Write-Output $status
} catch {
  $report.state='failed';$report.error=$_.Exception.Message
  throw
} finally {
  $report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $reportDir "desktop-recovery-$Client.json") -Encoding UTF8
  if($locked){$mutex.ReleaseMutex()};$mutex.Dispose()
}
