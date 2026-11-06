# Delete existing group conversations

- Request: existing groups cannot be deleted.
- Root cause: the engine and HTTP layer only supported creation, joining and messages; the chat had no delete action.
- Added a visible delete action with an in-page confirmation. A durable logical deletion hides the group, rejects new interaction, allows recreating the same name, and retains task records and late callbacks without resurrecting the group.
- The UI removes deleted drafts, selects the next conversation or shows the empty state, handles deletion from another window on refresh, and preserves the current conversation/draft on API failure.
- Verified 227 Vitest checks, TypeScript compilation, desktop bundle build, and a real headless browser test across three viewport sizes including cancel, delete and reload. No existing user group was deleted during verification.
