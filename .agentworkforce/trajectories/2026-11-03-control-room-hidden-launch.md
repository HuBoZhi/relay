# Hide the lingering Relay startup terminal — 2026-11-03

The user supplied a Windows Terminal screenshot titled `Relay 可视化控制台`, displaying Factory desktop memory metrics. Native enumeration matched terminal PID 47068, HWND 1445410, with that exact title. The computer-use window inventory did not expose it, so the Windows visual automation fallback was used for the specific verified window only.

## Diagnosis and decision

- Existing Factory PID 67120 and console PID 38900 shared their now-exited launcher parent 69060. The Factory launcher started the GUI process without redirecting its console output. Its inherited terminal handles could keep the old terminal alive and display client logs after the launcher exited.
- A real console executable fixture showed that redirection alone was insufficient: the calling command remained blocked for the fixture's entire lifetime. The fixture test timed out at 30 seconds and returned after the 60-second client exit.
- Dispatch Factory through Windows Shell COM into an independent hidden PowerShell host. That host owns standard-output/error redirection and waits for the client; the initiating command can return while the client lives. Credentials are not passed on the command line. Logs stay under the D-drive runtime.
- Keep the existing Factory and Relay sessions. Hide only the verified legacy terminal via ShowWindow(SW_HIDE), without closing its tab or terminating descendants. Future Factory launches use the installed replacement script. Exploratory changes to other client launchers were reverted; the final fix targets the evidenced Factory source.

## Validation and deployment

- Added an integration test that compiles a real temporary console executable, launches it through the public Factory launcher, verifies both output files and that the child remains alive after the launch command returns, and cleans up the fixture.
- Two Node integration tests passed (hidden launch and service lifetime); 22 existing desktop tests passed. Fixed the lifecycle test's script resolution so the documented workspace npm command works from its package directory. PowerShell parser and whitespace checks passed.
- Installed `Start-RelayFactory.ps1` in `D:/Programs/AgentRelay`. No C-drive shortcut or startup entry was written.
- After hiding the terminal, visible terminal enumeration no longer returned that window; console health was `ok:true, mode:live`. Factory, console, and supervisor retained PIDs 67120, 38900, and 66468 respectively.
- Task scratch was isolated to `D:/CodexTemp/relay-hidden-launch-20261103`, with fixture child scratch under its own `relay-desktop-host-*` directories. Test children were stopped and test scratch cleaned. Existing production supervisor scratch remains in use from the prior task.
- Existing unrelated web changes and `.workbuddy/` remain untouched. Trail CLI is unavailable; this Markdown is the durable task record.
