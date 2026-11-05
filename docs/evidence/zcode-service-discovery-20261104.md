# ZCode Relay service discovery repair — 2026-11-04

The installed adapter imported `styles-CQuzX8si.js`, export `gt`, then searched
the module scope for `mT`. The current desktop instead loads
`styles-Dv5E6Odo.js` and stores services in `ka`. CDP returns an error object
with an objectId when the old import fails. Treating that object as a function
hid the original failure behind “service module scopes unavailable”.

The adapter now reads the current renderer entry's script metadata and imports
the unique local styles bundle referenced there. It inspects only module
scopes and identifies the existing store by its `getState` descriptor and
the createTask, sendPrompt and readSession service methods. It does not call
exported functions or create another service host. Unrecognized or ambiguous
builds fail before any prompt is submitted. Import errors are checked before
scope inspection. No client restart or credential change was needed.

Verification: regression tests fail against the original adapter and pass
with the repair, including changed asset/export/store names, import errors,
missing services and ambiguous bundle references. The script executes its
discovery expression in the test renderer rather than stubbing that parsing.
Live verification connected the current desktop service registry and resumed
and read the existing dedicated MediaDock Relay session, retaining its model.

Run: `node --test scripts/desktop-relay/native-clients.test.mjs`.
Set TEMP, TMP and TMPDIR to a dedicated D-drive task directory first.

The standalone adapter and its Runtime-only CDP transport were previously
present only in the installed runtime. Both now have maintainable source in
`scripts/desktop-relay/`; copy them to the runtime's `desktop-native/` to install.

## Desktop visibility follow-up

The first live task exposed separate existing adapter bugs: createTask set only
workspacePath, leaving project membership unset, and used plan mode despite an
execution request. Its runtime status remained running while a permission was
pending. An interrupted plan was subsequently classified completed and its
name replaced by a generic Relay title. No implementation completion DM was
received, so this receipt was not accepted as task completion.

Creation now resolves the existing local project by normalized root, preserves
its exact stored root string, and attaches the new task with projectService.moveTask
before returning. It uses build mode. Polling reports permission requests and
interruptions explicitly and never overwrites titles. Regression tests cover
all these conditions. The original task was moved to MediaDock and renamed
20261104-MediaDock-需求开发（开发）; both the desktop accessibility tree and
rendered screenshot confirmed it under that project. Existing project membership
was repaired without creating a duplicate development session.
