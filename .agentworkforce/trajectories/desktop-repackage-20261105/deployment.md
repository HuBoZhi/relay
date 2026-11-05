# Relay desktop package and deployment verification

- Date: 2026-11-05 (Asia/Shanghai)
- Packaged source commit: 57aaf71f40f17adbea1a11926244d2a88bd7ff50
- Version: 14.0.0; local packaging only, no release publication.
- Tests: 60 Vitest tests and 20 native/lifecycle/recovery tests passed.
- Build: fresh control-room TypeScript compilation, server/bridge bundles, Windows x64 portable and NSIS artifacts.
- Build tools: existing Electron 33.4.11 runtime and existing winCodeSign/NSIS cache, copied read-only from C to D cache after a GitHub download EOF.
- Installed directory: D:\Programs\RelayControlRoom
- Deployment: extracted the new app.asar into the existing expanded resources\app layout and refreshed Electron runtime files.
- Retained existing data, workspace credentials, startup record, and login entries.
- Verified package SHA256 entries match installed main.cjs, preload.cjs, server.mjs, bridge.mjs, chat.js, and bridge-process.mjs.
- Main API: /api/health reports ok=true, mode=live, target=relaycast.
- /api/bootstrap succeeds; /chat.html and /chat.js return HTTP 200.
- Bridge API: port 7901 reports ok=true and adapterReady=true.
- Resident supervisor running; console profile and temporary paths remain on D.
- No new prompts were submitted during deployment verification.

## Artifacts

- G:\Coding\Github\relay\packages\control-room-desktop\release\RelayControlRoom-14.0.0-安装包.exe (74585409 bytes)
  SHA256: 0EC4A9D5C9D52AF0191EE77883C84E7A3D9EBA88529C79BE9652956F7F0AC100
- G:\Coding\Github\relay\packages\control-room-desktop\release\RelayControlRoom-14.0.0-便携版.exe (74369788 bytes)
  SHA256: 7ACADA47B9865473F9E9CD9C10FA55ED131CA4AA04E2EA054ABA2CE2104AF158
