# Global Relay agent skill and startup configuration — 2026-11-03

User requested a shared global skill for cross-agent Relay calls, startup-enabled ZCode/WorkBuddy desktop interfaces, and authorized the required C-drive writes.

Implemented a portable `relay-agent-connect` skill, a PowerShell task entry accepting project/model/session parameters, and an installer sharing one D-drive skill through eight common user skill roots. Existing Relay installation and desktop credentials are reused. No older disabled zcode-ops setup was restored. Native client constructors remain compatible with existing callers; explicit projects/models are optional additions. The runner separates per-client session stores and uses stable keys independent of PowerShell JSON property order.

Configured ZCode and WorkBuddy user sign-in Run entries, user Start Menu shortcuts, matching existing desktop/taskbar links, and WorkBuddy's per-user port environment variable. Loopback ports are 19372/19371. Protected machine shortcuts use per-user equivalents. Backup records remain under `D:\Programs\AgentRelay\data\startup-backup-*`; runtime/skill backups under `skill-install-backup-*`. Existing unrelated Factory work in another worktree was preserved.

Validation:

- 14 Node tests passed for transport, task correlation, model/project selection, model mismatch, inactive-session resume, and stable session keys. Skill validator passed in Python UTF-8 mode. PowerShell entrypoints parsed and installer ran successfully.
- Real Relay → live ZCode desktop → MediaDock → deepseek-flash round trips returned `RELAY_GLOBAL_SKILL_READY`, with `output.ok=true` and completed receipts.
- Final two calls reused `session_f845bc7ffe66c8ce95ad03d47eb70caf`; invocation IDs `inv_idem_e285fb73b76ae7a946d77dd0d9b7ab66d9d67e600d3664b728866f780c6ea915` and `inv_idem_20cff23a8ec93bb88f9c88567981d3d45bfc787f1b9c90858a874fdeb57b29df`. ZCode PID 31816 remained unchanged. Per-call receipts are retained by the installed runtime.
- ZCode endpoint is ready. WorkBuddy's already-running process lacks the interface and was left running; its next normal restart/sign-in uses the configured arguments. No fresh WorkBuddy inference claim is made for this change. Earlier desktop SDK acceptance remains separate.
- User Start Menu links for both apps and the existing pinned ZCode link contain loopback debug arguments. Read-back verified Run settings and WorkBuddy port 19371.

Limits: desktop internal APIs depend on installed versions; runtime does not provide a permanent action listener. Arbitrary parameterless ZCode.exe launches are not intercepted. WorkBuddy model overrides are not supported. Running agents may need a skill refresh/new session. Native application state may write C under this specific authorization; task scratch remains D.
