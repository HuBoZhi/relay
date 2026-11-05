# Factory global skill and startup — 2026-11-03

User requested Factory be included in the shared global Relay skill and start with its native Relay interface enabled. The existing Factory native adapter commit was carried onto `codex/global-relay-skill` as `8879a9ffd`; its changelog entry and the existing global skill entry were both retained.

The shared skill now documents the exact installed Factory Markdown entrypoint, fixed dedicated workspace, result/turn correlation, native daemon authentication boundary, and the unverified status of file editing/build tasks. Factory does not acquire unsupported project/model flags from the ZCode/WorkBuddy entrypoint.

Added `Start-RelayFactory.ps1`: select the highest complete installed app version and launch it with `--remote-debugging-port=19373 --remote-debugging-address=127.0.0.1`. The selected current executable is `Factory\app-1.2.0\factory-desktop.exe`. The stable launcher is installed on D; desktop and two Start Menu shortcuts plus the per-user Factory Run entry now invoke it. Original shortcuts/settings are backed up at `D:\Programs\AgentRelay\data\startup-backup-9c2c8be20deb44fab300f1c854dc873a`. Runtime/skill installer backup: `skill-install-backup-448b731fd4e449b6aed7ff9e853faa6c`.

Validation: the combined existing tests passed (20); the new launcher test passed (1), verifying semantic ordering (1.10 above 1.9), skipping an incomplete newer version, and preserving both loopback arguments. PowerShell parsing and UTF-8 skill validation passed. The installer updated all eight shared skill locations. Read-back verified all three Factory shortcut targets and the login Run command. Existing Factory endpoint was ready; no restart was performed.

A real no-tool Markdown task through the documented installed entrypoint returned `FACTORY_GLOBAL_SKILL_READY`, `output.ok=true`, `state=completed`, and `relayStatus=completed`. Invocation: `inv_idem_4e3d1234087bb5ef56ac08d917efeea610733b58e40665dcd766cc17e8b5fe0e`. Session: `e90cad0c-fbc1-4748-b4bf-bbe79b0f9870`. No mouse/keyboard actions or file-edit/build claims.

Scope: normal launches through the configured shortcuts or sign-in Run entry carry the interface arguments. Arbitrary raw executable launches or updater-controlled restarts are not intercepted; the skill describes checking/reconfiguring those cases without terminating active sessions.
