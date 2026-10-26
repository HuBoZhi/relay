# Relay control-room design trajectory

Date: 2026-10-26 (Asia/Shanghai)

## Assignment

Design a futuristic Relay interface showing active channels, system-wide message flow, working nodes, channel status and message history. Messages must identify timestamp, sender and recipient; long text must collapse and open in an enlarged reader. Deliver a visual prototype first, then a Markdown requirements document.

## Decisions

- Kept this as a standalone local design prototype under `docs/design/relay-control-room`, on the existing `codex/hubozhi-dev` branch. No Relay runtime or package configuration changes were needed.
- Used three connected regions: channel navigation, logical topology, and a channel inspector with message history.
- Used dark graphite and cyan, with amber for attention states. The logical workspace hub is explicitly labeled so it is not mistaken for a physical network topology.
- Used fictional fixtures and visible demo labeling. No workspace credentials, backend calls or actual agent operations occur.
- Separated online presence from work state, and documented that channel membership alone cannot associate a direct message with a channel.
- Chose buildless HTML/CSS/JS and locally bundled Lucide assets for portable review.
- Recorded original requirements separately from design suggestions and future integration assumptions.

## Progress and validation

The user paused after the first interactive preview and later explicitly resumed. Work continued from that preview rather than restarting.

Browser checks covered channel and node selection, focus view, search, filters, history, long-message reading and copying, keyboard closure/focus, narrow viewports, pause/resume, reduced motion, and preservation of historical reading position when new messages arrive. 54 browser assertions passed. JavaScript syntax checks passed. No production-backend or scale claims are made.

Final screenshot QA exposed an SVG hit-testing gap in focused agent groups: the group center was unpainted and clicks reached the containing SVG. Confirmed with `elementFromPoint`, added a transparent hit rectangle only in focused nodes, and revalidated all four engineering nodes, keyboard activation, and global channel selection. This was a local interaction fix, with no changes to runtime APIs.

## Deliverables

- `docs/design/relay-control-room/index.html`
- `docs/design/relay-control-room/requirements.md`
- `docs/design/relay-control-room/README.md`
- Desktop and message-reader screenshots in the same directory.

## Tooling note

The `trail` executable was unavailable. The documented fallback `npx --no-install trail start` returned “could not determine executable to run”. This Markdown record preserves the decisions without changing trajectory indexes or deleting existing records.

## Outcome

The requested design prototype and requirements draft are delivered for user review. Visual acceptance and real Relay integration remain future work. No changelog entry was added because the repository rules exclude web-only changes from the release narrative.

## Chinese-only UI revision

On 2026-10-26 the user required an entirely Chinese interface. Localized all visible labels, channel/agent/host display names, sample messages, tooltips, accessibility names and dynamic states while retaining stable internal IDs. Updated the requirements to make this a mandatory acceptance criterion and removed the earlier mixed-language design option.
