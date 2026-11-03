# Compact channel inspector — 2026-11-03

- Limited the channel inspector to 360–460 CSS pixels instead of 39% of the workspace. Kept the existing stacked layout below 1100px.
- Hid the duplicate channel title/description already shown in the page heading. Reduced padding and gaps, retaining status, participants, running count, reason and evidence.
- Real-browser verification on the local live service at 2530×1200: inspector width 892.3 → 460px, summary height 239.5 → 138.7px. At 390×844 there was no horizontal overflow. No browser errors.
- Existing 100 tests across 8 files passed; desktop build and diff check passed. No new tests added for the reversible stylesheet adjustment.
- Updated the installed app’s room.css; port 4320 serves the new width limit. Refresh the desktop window to load it.
- Removed the task-only D:/CodexTemp/relay-compact-details-20261103 browser script, screenshot and caches after validation, with path and reparse-point checks.
