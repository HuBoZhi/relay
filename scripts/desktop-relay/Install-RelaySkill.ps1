param([string]$RuntimeRoot='D:\Programs\AgentRelay',[string]$SkillRoot='D:\codex\skills')
$ErrorActionPreference='Stop'
foreach($required in @('lib/relay.mjs','node_modules/@agent-relay/sdk/dist/index.js','desktop-native/cdp.mjs','desktop-native/task.mjs','data/workspace.private.json')){
  if(!(Test-Path -LiteralPath (Join-Path $RuntimeRoot $required))){throw "Missing installed dependency: $required"}
}
$sourceSkill=Join-Path $PSScriptRoot '../../.agents/skills/relay-agent-connect/SKILL.md'
$destination=Join-Path $SkillRoot 'relay-agent-connect'
$backup=Join-Path $RuntimeRoot ('data/skill-install-backup-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $backup -Force | Out-Null
foreach($file in @('global-run.mjs','global-options.mjs','native-clients.mjs','Invoke-RelayAgent.ps1','Configure-RelayStartup.ps1')){
  $target=if($file.EndsWith('.mjs')){Join-Path $RuntimeRoot "desktop-native/$file"}else{Join-Path $RuntimeRoot $file}
  if(Test-Path -LiteralPath $target){Copy-Item -LiteralPath $target -Destination (Join-Path $backup $file)}
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination $target
}
New-Item -ItemType Directory -Path $destination -Force | Out-Null
if(Test-Path -LiteralPath (Join-Path $destination 'SKILL.md')){Copy-Item -LiteralPath (Join-Path $destination 'SKILL.md') -Destination (Join-Path $backup 'SKILL.md')}
Copy-Item -LiteralPath $sourceSkill -Destination (Join-Path $destination 'SKILL.md')
foreach($relative in @('.agents/skills','.codex/skills','.claude/skills','.zcode/skills','.codebuddy/skills','.gemini/skills','.factory/skills','.config/opencode/skills')){
  $root=Join-Path $env:USERPROFILE $relative
  New-Item -ItemType Directory -Path $root -Force | Out-Null
  $link=Join-Path $root 'relay-agent-connect'
  if(Test-Path -LiteralPath $link){
    # The Codex home itself may already be a junction to SkillRoot.
    $existing=(Get-FileHash -LiteralPath (Join-Path $link 'SKILL.md')).Hash
    $wanted=(Get-FileHash -LiteralPath (Join-Path $destination 'SKILL.md')).Hash
    if($existing -ne $wanted){throw "Existing skill differs; refusing to replace $link"}
  }else{New-Item -ItemType Junction -Path $link -Target $destination | Out-Null}
  Write-Output "Skill available: $link"
}
Write-Output "Installed runtime and global skill. Backup: $backup"
