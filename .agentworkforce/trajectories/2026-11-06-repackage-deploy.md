# Repackage and deploy Relay desktop

- Request: rebuild Windows packages and deploy the latest application locally.
- Built source commit 50482f50d with the existing Electron 33.4.11 runtime to avoid an unnecessary network download.
- Produced NSIS and portable binaries under release/20261106-mcp. Deployed the packaged ASAR and runtime to D:/Programs/RelaySystem, preserving data and MCP preferences, with a D-drive rollback backup.
- Verified archive contents, matching deployment hashes, live application health, real MCP check/model discovery, and the restored native window.
- Evidence and artifact hashes: docs/validation/repackage-deploy-20261106.md. No release published and no credentials modified.
