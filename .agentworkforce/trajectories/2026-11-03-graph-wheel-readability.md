# Graph wheel zoom and minimum typography — 2026-11-03

## Change

- Bind plain mouse wheel input on the graph to cursor-anchored zoom. Share zoom bounds with the buttons, normalize wheel delta modes, prevent graph-wheel page scrolling, and preserve browser Ctrl/Command wheel gestures.
- Clamp local stylesheet pixel font sizes (including font shorthand/media rules) to at least 13px while preserving larger headings. Account for browser default small/time styles and SVG font-size attributes.
- Include SVG viewBox fitting in the zoom minimum: graph text must remain at least 13 screen pixels, rather than merely declaring a 13-unit SVG font. ResizeObserver recalculates the limit when switching scopes or resizing. Narrow screens retain readable graph size and use drag-to-pan rather than unreadable fit-to-width labels.
- Keep prior pending core/orbit visuals in the working tree. Stage only the independent zoom/font hunks from app.js; do not commit those unrelated pending design changes or the appended room.css block.

## Validation

- First browser regression failed with many sub-13px labels. After the fix, all visible text passed the physical SVG-scale-aware size check across 1/4/7 nodes and 1680/1280/390px viewports; the prior no-overlap checks still passed.
- Verified wheel up/down, the readable lower limit, reset, and overview typography after the scope resize settles. Existing renderer/interaction suites: 22 tests passed; JavaScript syntax passed.
- Exported the staged app.js and room.css to an isolated static directory and ran the same browser checks there. This verifies the committed renderer independently of pending design work. It exposed a legacy inline SVG 9px caption; SVG attribute normalization resolved it, and all checks passed on the staged assets.
- Installed the staged app.js/room.css into the existing D-drive desktop web directory, without restarting Relay, Factory, or the console. Existing pages load the change on refresh. Evidence screenshots are under `D:/CodexDeliverables/relay-zoom-font-20261103`.
- Task/browser scratch is isolated below `D:/CodexTemp/relay-zoom-font-20261103` and cleaned at completion. No C-drive task outputs. Trail CLI unavailable; this Markdown is the durable trajectory.
