# Prioritize chat history height — 2026-11-03

- User clarified that the highlighted summary was too tall, rather than too wide. Restored the inspector’s original 39% workspace width (390px minimum), retaining existing stacked breakpoints.
- Replaced the summary’s vertical presentation with a single status/count row, approximately 42.5 CSS pixels tall. Duplicate title/description and avatars do not occupy space.
- Kept reason and evidence in a keyboard-accessible native “状态详情” disclosure. Its panel overlays rather than resizes the timeline. Preserve its open state across status redraws.
- Browser verification against the updated installed service: at 2530×1200, summary height 42.5px, inspector width 892.3px, history viewport 761px. Opening details leaves both summary and timeline height unchanged. At 1120×900 and 390×844 the summary remains 42.5px; no horizontal overflow or page errors. Enter toggles the disclosure.
- Existing 100 tests in 8 files passed. Desktop build, JavaScript syntax and diff checks passed.
- Updated installed app.js/room.css under D:/Programs/RelayControlRoom/resources/app/dist/web. Refresh the desktop window to load the change.
- Removed task-only scripts/screenshots/caches in D:/CodexTemp/relay-chat-height-20261103 after validation and path/reparse-point checks.
