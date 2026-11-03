# Console lifetime investigation — 2026-11-03

## Findings

- The installed deployment uses hosted Relaycast; it has no standalone Windows broker. A read through the existing workspace credential returned five channels and seven agents. No new workspace or agent was created and no messages were sent.
- Early process/port enumeration did not identify the console, but direct PID verification corrected that conclusion: console PID 38900 was still running with a 17:34:55 start time. Its health endpoint and workspace bootstrap succeeded. There is no evidence that this process or the hosted backend exited during this incident.
- The installed window close handler hides the window to the tray, and unified login startup passes `--no-window`. Window visibility is therefore separate from service lifetime. No crash attribution is justified by the available logs.
- The unified launcher previously exited after starting the console once. It provided no ongoing process supervision. Its saved `consoleReady` was a startup snapshot.

## Change

- Preserve the local unified launcher in the repository and add an independent Windows interactive-session supervisor. Windows Shell COM dispatch survives the invoking command, a named mutex prevents duplicate supervisors, and existing console processes are adopted without restarting sessions.
- Process exit is logged and retried with bounded backoff. An explicit Stop marker stops the managed console and supervisor; Start removes the marker. Under supervision, the console's Exit menu is followed by a restart. This is documented rather than silently presenting it as a stop action.
- This is process supervision, not an OS service or a backend health guarantee. User logout still ends the interactive session. It does not supervise/restart desktop adapter clients or the hosted backend.
- WMI process creation returned success without a surviving process in this environment. It was rejected as an implementation choice after a failing lifecycle test; Windows Shell COM passed the same test.
- Installed both scripts into `D:/Programs/AgentRelay`, preserving the existing login entry. Supervisor PID 66468 adopted the existing console PID 38900. Health returned `ok:true, mode:live`; bootstrap still returned five channels and seven agents.

## Validation and storage

- Added a Node lifecycle integration test (test-first red/green): launch command returns, supervisor survives, terminated fixture console is replaced, duplicate Start retains one supervisor, Stop ends both. Passed twice after switching to Shell COM.
- Existing desktop suite: 22 tests passed. PowerShell parser checks and `git diff --check` passed.
- All test scratch was created below `D:/CodexTemp/relay-console-lifetime-20261103-1801` and removed after validation. Production supervisor scratch remains necessary while it runs under its own `D:/CodexTemp/relay-console-service-*` directory and is cleaned on normal Stop; cleanup failures are logged.
- Existing uncommitted control-room web changes and `.workbuddy/` were left untouched and excluded from the commit. Trail CLI was unavailable; this Markdown is the isolated durable trajectory.
