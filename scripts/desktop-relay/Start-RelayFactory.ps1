param(
  [string]$RuntimeRoot='D:\Programs\AgentRelay',
  [string]$FactoryRoot=(Join-Path $env:LOCALAPPDATA 'Factory'),
  [switch]$ResolveOnly
)
$ErrorActionPreference='Stop'
$version=Get-ChildItem -LiteralPath $FactoryRoot -Directory | Where-Object {
  $_.Name -match '^app-\d+(\.\d+)+$' -and (Test-Path -LiteralPath (Join-Path $_.FullName 'factory-desktop.exe'))
} | Sort-Object {[version]($_.Name.Substring(4))} -Descending | Select-Object -First 1
if(!$version){throw 'Factory installation not found'}
$exe=Join-Path $version.FullName 'factory-desktop.exe'
$launchArgs=@('--remote-debugging-port=19373','--remote-debugging-address=127.0.0.1')
if($ResolveOnly){@{executable=$exe;arguments=$launchArgs}|ConvertTo-Json -Compress;return}
$scratch=Join-Path 'D:\CodexTemp' ('relay-desktop-host-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch | Out-Null
$previous=@{}
foreach($key in @('TEMP','TMP','TMPDIR')){$previous[$key]=[Environment]::GetEnvironmentVariable($key,'Process')}
try {
  $env:TEMP=$scratch;$env:TMP=$scratch;$env:TMPDIR=$scratch
  $p=Start-Process -FilePath $exe -ArgumentList $launchArgs -WindowStyle Hidden -PassThru
  @{app='Factory';pid=$p.Id;temporaryDirectory=$scratch;executable=$exe;cleanup='Remove only after this application and children exit.'} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $RuntimeRoot "data/desktop-host-$($p.Id).json")
} finally {foreach($key in $previous.Keys){[Environment]::SetEnvironmentVariable($key,$previous[$key],'Process')}}
