# Channel graph label overlap — 2026-11-03

The user's screenshot showed graph heading/caption text overlapping the upper node's status and task. The in-progress visual design puts upper node labels above their circles; its decorative SVG heading occupies the same area. The page and panel already identify the channel.

## Fix and isolation

- Hide the two redundant decorative SVG captions through a scoped CSS rule. Preserve node name, task, status, existing page title, and the pending energy-core/orbit visuals.
- The working tree already contained related uncommitted `app.js` changes and an appended CSS visual block. Preserve those changes and stage only the separate CSS fix hunk; they are not part of this commit. The fix is compatible with the existing committed renderer and with the in-progress visual renderer.
- No service process or client session needs a restart. No uncommitted visual assets were installed as part of this correction; screenshots render the current workspace assets against an isolated demo server.

## Verification

- Added a real Chromium layout regression: measure all visible graph text rectangles and reject pairwise overlap for 1, 4, 7 nodes across 1680, 1280, 390 pixel viewports. Before the fix, the first case failed with the SVG caption overlapping node status. All nine cases passed after the scoped CSS fix; browser page errors were empty.
- Existing web renderer and interaction suites: 22 tests passed. JavaScript syntax and whitespace checks passed.
- Fixed screenshots are retained at `D:/CodexDeliverables/relay-label-fix-20261103`. Browser/test scratch is isolated below `D:/CodexTemp/relay-label-fix-20261103` and cleaned after completion.
- Trail CLI was unavailable; this Markdown is the durable trajectory.
