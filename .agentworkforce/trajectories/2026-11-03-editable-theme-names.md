# Editable theme names — 2026-11-03

- Added a name editor beside the selected theme title, with Save, Cancel, Restore original name and Escape handling.
- Display names are stored in localStorage, scoped to the workspace identity, service target and live/demo mode. Original channel identifiers remain stable for routing. The editor states that names are stored locally.
- Sidebar, page title, breadcrumb, topology, participant memberships, recent activity and message recipient/detail labels use the chosen name. Incoming bootstrap/status frames preserve aliases; other windows on the same origin receive storage changes.
- Names must contain 1–60 characters after trimming. User text is escaped. A storage failure keeps the existing name and reports that saving failed.
- Validation: 100 tests passed in 8 files; desktop build, JavaScript syntax and diff checks passed. Regression coverage includes save, refresh persistence, workspace isolation, reset, blank input, cancel and failed persistence.
- Real browser at 390×844: Enter saves, reload preserves the name, reset restores the original, no horizontal overflow or page errors.
- Updated app.js, index.html and room.css in the installed desktop app under D:/Programs/RelayControlRoom/resources/app/dist/web. Port 4320 serves the editor; refresh the window to load it.
- The task-only scratch directory D:/CodexTemp/relay-theme-name-20261103 was checked for reparse points and removed after verification.
