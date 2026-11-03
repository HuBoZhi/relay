# Local theme archive and deletion — 2026-11-03

User explicitly selected local interface organization: archives can be restored; deletion removes a theme from this machine’s list while retaining server messages.

- Added “主题管理” beside the title: local archive, restore and local delete. Added an archive filter to the sidebar. Controls do not increase the chat status strip height.
- Archive hides the theme from the main list, overview topology and recent activity. The archive section retains access to its history (all loaded dates) and restores it to the normal list.
- Deletion requires a dialog that names the theme and states the local-only effect. Cancel changes nothing. Confirm stores a local tombstone, removes the theme from lists/topology/recent activity and returns to overview.
- Persistence is scoped to live/demo mode, service target and workspace identity, alongside display-name aliases. Bootstrap/status refreshes cannot resurrect local deletions. Storage updates synchronize windows on the same origin. Failed persistence leaves the existing view intact and reports an error.
- Workspace metrics remain service-reported totals. Server archive state is not modified by local organization. No source API, credential or server mutation endpoint changed.
- Validation: 103 tests passed in 8 files; desktop build, JavaScript syntax and diff checks passed. Tests cover archive history, restore, refresh persistence, workspace isolation, deletion confirmation/cancel, intact source data and storage failure.
- Real browser: archive → reload → read history → restore → cancel deletion → confirm deletion → reload passed. Original source still has 8 themes, with zero non-GET/HEAD requests. At 390px the management menu stays inside the viewport, with no page errors.
- Installed app.js/index.html/room.css updated under D:/Programs/RelayControlRoom/resources/app/dist/web; port 4320 serves the new behavior. Refresh the desktop window to load it.
- Task-only scripts and caches in D:/CodexTemp/relay-local-organize-20261103 were removed after path and reparse-point checks.
