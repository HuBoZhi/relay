param(
  [Parameter(Mandatory=$true)][string]$RuntimeSource,
  [Parameter(Mandatory=$true)][string]$BundleSource,
  [string]$InstallDir='D:\Programs\RelayControlRoom',
  [string]$WorkspaceState='D:\Programs\AgentRelay\data\workspace.private.json',
  [string]$SystemLauncher
)
$ErrorActionPreference='Stop'
if(!(Test-Path -LiteralPath $WorkspaceState)){throw 'Relay workspace state file not found'}
if(!(Test-Path -LiteralPath (Join-Path $RuntimeSource '协作控制中心.exe'))){throw 'Packaged Electron runtime not found'}
if(!(Test-Path -LiteralPath (Join-Path $BundleSource 'server.mjs'))){throw 'Built control room bundle not found'}
$sourceRoot=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
$resolved=(Resolve-Path -LiteralPath $InstallDir).Path
if($resolved.StartsWith('C:',[StringComparison]::OrdinalIgnoreCase)){throw 'Install to a non-C directory'}
# Reuse the existing packaged runtime; never download another Electron copy.
foreach($item in (Get-ChildItem -LiteralPath $RuntimeSource)){
  if($item.Name -ne 'resources'){Copy-Item -LiteralPath $item.FullName -Destination $InstallDir -Recurse -Force}
}
$appRoot=Join-Path $InstallDir 'resources/app'
New-Item -ItemType Directory -Path $appRoot -Force | Out-Null
if(Test-Path -LiteralPath (Join-Path $InstallDir 'resources/app.asar')){throw 'Existing app.asar would shadow the deployed app directory'}
foreach($file in @('main.cjs','preload.cjs','package.json')){Copy-Item -LiteralPath (Join-Path $sourceRoot $file) -Destination $appRoot -Force}
foreach($folder in @('lib','assets')){Copy-Item -LiteralPath (Join-Path $sourceRoot $folder) -Destination $appRoot -Recurse -Force}
$bundleTarget=Join-Path $appRoot 'dist'
New-Item -ItemType Directory -Path $bundleTarget -Force | Out-Null
Get-ChildItem -LiteralPath $BundleSource | ForEach-Object {Copy-Item -LiteralPath $_.FullName -Destination $bundleTarget -Recurse -Force}
$profile=Join-Path $InstallDir 'data'
$exe=Join-Path $InstallDir '协作控制中心.exe'
$args='--no-window --port 4320 --host 127.0.0.1 --user-data-dir "'+$profile+'" --workspace-state "'+$WorkspaceState+'"'
if($SystemLauncher){$args+=' --system-launcher "'+$SystemLauncher+'"'}
$runKey='HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$previous=(Get-ItemProperty -LiteralPath $runKey -ErrorAction SilentlyContinue).RelayControlRoom
@{previousRun=$previous;installedExecutable=$exe;arguments=$args;workspaceStatePath=$WorkspaceState;installedAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $InstallDir 'startup-install-record.json')
$startupCommand='"'+$exe+'" '+$args
if($SystemLauncher){
  $runtimeRoot=Split-Path -Parent (Split-Path -Parent $WorkspaceState)
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'start-system.ps1') -Destination $SystemLauncher -Force
  $powerShell=Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
  $systemArgs='-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$SystemLauncher+'" -RuntimeRoot "'+$runtimeRoot+'" -ConsoleDir "'+$InstallDir+'"'
  $startupCommand='"'+$powerShell+'" '+$systemArgs
  $retired=@{}
  foreach($name in @('ZCode','WorkBuddy','Factory')){
    $command=(Get-ItemProperty -LiteralPath $runKey -ErrorAction SilentlyContinue).$name
    if($command -and $command -match '(?i)(ZCode\.exe|WorkBuddy\.exe|Start-RelayFactory\.ps1|factory-desktop\.exe)'){$retired[$name]=$command}
  }
  $retired|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $InstallDir 'retired-startup-entries.json')
  foreach($name in $retired.Keys){Remove-ItemProperty -LiteralPath $runKey -Name $name}
  @{enabled=$true;launcher=$SystemLauncher;consoleDir=$InstallDir;workspaceStatePath=$WorkspaceState;backend='hosted-relaycast'}|
    ConvertTo-Json|Set-Content -LiteralPath (Join-Path $runtimeRoot 'data/unified-startup.json')
}
New-ItemProperty -LiteralPath $runKey -Name RelayControlRoom -Value $startupCommand -PropertyType String -Force | Out-Null
$shortcutPath=Join-Path ([Environment]::GetFolderPath('Programs')) 'Relay 可视化控制台.lnk'
$shell=New-Object -ComObject WScript.Shell
$shortcut=$shell.CreateShortcut($shortcutPath);$shortcut.TargetPath=$exe;$shortcut.Arguments=$args;$shortcut.WorkingDirectory=$InstallDir;$shortcut.IconLocation=Join-Path $appRoot 'assets/icon.ico';$shortcut.Save()
if($SystemLauncher){$shortcut.TargetPath=$powerShell;$shortcut.Arguments=$systemArgs;$shortcut.Save()}
Write-Output "Installed: $exe"
Write-Output 'Login startup: enabled; credentials are read from the existing file, never stored in the startup command.'
