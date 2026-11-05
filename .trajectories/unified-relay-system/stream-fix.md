# Realtime console diagnosis — 2026-11-03

Reproduced the deployed console's degraded status while REST reads succeeded in the same `codex-zcode-integration-20261025` workspace.

Causes verified: Electron uses Node 20.18.3 without global WebSocket; the desktop forwarded the workspace admin key to the observer stream; the hosted gateway returned 401 for bearer-header WebSocket auth but kept a query-authenticated read-only observer socket open; the SDK did not publish actual raw socket lifecycle and replayed historical close events as current state. Added targeted failing regression tests before fixing the credential/lifecycle paths. A Node 20 bundle import probe exposed ws CommonJS builtins requiring createRequire in the ESM bundle; this was fixed and the installed bundle rebuilt.

Separate REST and observer credentials; cache a workspace-bound, read-only token locally (no DM visibility). Add bundled ws with a gateway-specific readonly authentication adapter. Publish actual socket open/close and ignore historical connection events. Also accept both space-separated and equals-form profile args to keep the installed profile on D. Workspace state remains the existing protected file; profile ACL is restricted to current user and SYSTEM. An orphan token from the failed probe write was revoked by its own unique name/time window.

Observed verification: console `/api/bootstrap` changed to `state=live`, label `已连接 · 实时`. Real message `243248413512962048` in `ma-test-e18b8c8f24bd` arrived on the console's SSE stream; state remained live. Receipt retained at `D:\Programs\AgentRelay\reports\console-realtime-verification.json`. No model calls were made.

The installed native CLI explicitly refused broker start on Windows: lifecycle identity verification is supported only on macOS/Linux. Existing successful communication uses hosted Relaycast and desktop adapters, independently of that native broker. Unified startup must manage the supported system and must not claim a Windows native broker is running.
