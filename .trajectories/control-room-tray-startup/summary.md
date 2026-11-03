# Relay console tray and Windows sign-in startup — 2026-11-03

User requested automatic startup, a visible system tray icon, a right-click runtime status menu, and opening the web console in the default browser.

Reused the existing Electron desktop shell, whose tray menu already exposes status and shell.openExternal. Added a workspace-state-file credential source so a Windows login process can reconnect without a parent terminal's environment. Login settings preserve the state-file path, hidden startup flag, port, host, and profile directory; no key is stored in the Run command. A missing/invalid configured state file fails explicitly. The installed profile, logs and process temporary paths live on D.

Installed to `D:\Programs\RelayControlRoom` by reusing the existing packaged Electron runtime and built backend bundle. No dependencies were downloaded. Added a reproducible local installer, backed up the previous Run value in startup-install-record.json, registered RelayControlRoom in HKCU Run, and created the Start Menu link “Relay 可视化控制台”. The original standalone web service PID 61328 was verified by command line and stopped; the desktop process now hosts the same loopback URL at port 4320.

Validation: 24 desktop tests passed, including restarting from saved login args with an empty environment and reading rotated state-file credentials. Actual installed process PID 68852 started in live mode; GET /api/health returned ok=true, mode=live, target=relaycast. Startup registry read-back and channel/message API checks were performed. The live source retains its previously observed periodic-refresh fallback when realtime subscription is unavailable.

Computer Use verification ended when the tool could not reliably determine the current Windows browser URL to enforce its policy. No alternative UI automation was attempted. Actual tray-menu clicking and default-browser launching therefore remain unverified in this run; the existing native tray/menu implementation and its unit tests provide code-level evidence. No reboot was performed.

The original checkout's unrelated .workbuddy directory was preserved. Work was isolated on codex/control-room-tray-startup.
