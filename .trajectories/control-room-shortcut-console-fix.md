# Windows shortcut console flash — 2026-11-06

- Cause: both installed Relay系统 shortcuts targeted the console application
  `powershell.exe`; `-WindowStyle Hidden` only takes effect after process creation.
  The managed bridge already uses `windowsHide: true`.
- Fix: a GUI Script Host entry (`Start-RelayHidden.vbs`) creates PowerShell hidden
  from the outset, preserves arguments and returns the child exit code. The local
  installer and tray login-command builder use this entry, with `-Background` only
  for login startup.
- Validation: 13 Windows Node tests and 35 Vitest tests passed. A real PowerShell
  fixture reports its console invisible; spaces, Chinese, a shell metacharacter,
  foreground/background switches and failure exit codes survive the launcher.
- Deployment: installed wrapper at `D:\Programs\AgentRelay\Start-RelayHidden.vbs`
  (SHA-256 matches source), deployed main/config under `D:\Programs\RelaySystem`,
  and updated and read back both existing desktop/Start Menu shortcuts. The user
  explicitly authorized only these two C-drive shortcut writes. Backups remain in
  `D:\Programs\AgentRelay\data\shortcut-fix-20261106`.
- Automatic approval rejected the combined deployment/login Run-key update and
  later the installed-launch verification, with only "blocked by policy" as the
  reason. The existing login Run value was therefore left unchanged. The installed
  app was not relaunched; actual shortcut launch remains a user verification step.
- `trail start` could not create a new trajectory because another trajectory was
  already active (`traj_ynyux9pee7x7`). This independent record avoids changing it.
