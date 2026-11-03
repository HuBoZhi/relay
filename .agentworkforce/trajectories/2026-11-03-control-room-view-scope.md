# Control room view separation — 2026-11-03

Request: separate system overview from channel content, make sender timestamps explicit, and improve the flow diagram.

## Decisions

- Navigation changes the whole page scope. Overview shows global metrics, channel topology, throughput and recent activity; channel pages show only that channel’s membership and message history.
- Keep original ISO message timestamps. Show sender and HH:mm:ss together, with full date and workspace timezone in the time tooltip.
- Improve graph contrast, card size and spatial hierarchy. Live membership links remain neutral; only observed message events create a bounded highlight. Preserve highlights across immediately following status frames, deduplicate messages, and honor reduced motion and pause.
- Opus 5.5 consultation could not run: ZCode and WorkBuddy reported `restart_needed`; neither client was restarted.

## Verification

- 98 tests passed across 8 control-room and desktop test files, including navigation scope, timestamps, pulse deduplication, redraw persistence and channel removal.
- Desktop server/web build passed. `node --check` and `git diff --check` passed.
- Playwright: 1680×1000 and 390×844, no page errors or horizontal overflow; hidden global sections in channel scope; observed highlight created once and removed; overview restored with no selected channel.
- Updated the three installed web assets under `D:/Programs/RelayControlRoom/resources/app/dist/web`; HTTP on port 4320 serves the new frontend. Refresh the desktop window to load it. Existing service and agent processes were retained.
- A full installer packaging attempt could not download Electron from GitHub; no new installer was delivered. The installed app’s loose web assets were updated directly.
- Existing unrelated `.workbuddy/` files and another active Trail trajectory were left untouched. This Markdown is the isolated work/acceptance record.
- Initial forced cleanup was rejected by automatic approval. During the editable-name follow-up, the exact task directory was rechecked for reparse points and safely removed without forcing deletion. No task scratch files remain.
