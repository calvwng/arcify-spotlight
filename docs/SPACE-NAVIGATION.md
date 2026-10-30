# Optional paired Space navigation (`spaceNavigationV1`)

This second slice adds only **Switch Space** and **Move current Today tab to another existing Space**. It does not change `spaceActionsV1`, its four commands, its exact context shape, or existing navigation/snapshot envelopes. No permissions are added.

## User behavior

Both commands open a destination picker with no preselected Space. Choices use exact existing Space IDs and bookmark-folder IDs. Duplicate display names are disambiguated by ID. Cancel/Escape changes nothing and restores the typed Spotlight query. Trusted, nonrepeated, noncomposing Enter or primary click is required to open and submit the picker. Ordinary web search remains available and manual search selection survives a passive refresh.

- **Switch Space:** deliberately changes only the requesting window's selected Space. It focuses that Space's existing `lastTab` in this window, or its last available member. An empty Space (including one with only tabs in other windows) stays empty and preserves native tab/window focus. No tab is created, navigated, closed, or moved between browser windows. An unsafe/helper/split/recovery destination is rejected rather than substituted by URL.
- **Move current Today tab:** only the exact active, ordinary, unambiguous Today tab is eligible. Saved pins, Favorites, native pins, native splits, startup/practice/New Tab helpers (including query/hash aliases), provisional and recovery candidates are excluded. The tab is appended at the destination's visible bottom under the captured Today representation. Existing relative order, selected source Space, and native focus are preserved. The destination is not activated. There is no previous-tab or general `assign` shortcut.

## Additive protocol

`hello` advertises the new capability only when requested. Updated Spotlight first offers `[globalFavoritesV1, spaceActionsV1, spaceNavigationV1]`, then retries only a read-only hello on exact `INVALID_REQUEST`, falling back to the original feature pair, the Favorites marker, and a bare hello. A mutation is never retried or sent under another capability.

The new `navigationContext` request takes `{windowId,tabId}`. Its response contains the ordinary envelope, `extensionId`, `snapshot`, the unchanged `actionContext`, and:

```js
navigationContext: {
  destinations: [{ spaceId, bookmarkFolderId, name }],
  inverted: Boolean,
  sourceUrl: String
}
```

Only unique valid Space/folder identities under the unique Arcify bookmark root are offered. Context reads observe legacy Today ordering without initializing storage. The renderer's scope adds this as `navigation` to its captured peer/local-generation/context envelope; old scopes still have their original exact keys.

New commands require `spaceNavigationV1` and exact payloads:

- `switchSpace`: `{context,sourceUrl,destination:{spaceId,bookmarkFolderId}}`
- `moveCurrentTodayTab`: `{context,sourceUrl,destination:{spaceId,bookmarkFolderId},inverted}`

Both return `{spaceId,tabId}` with the ordinary success envelope and refreshed snapshot. Only Switch may return `tabId:null`, for an empty destination. Move must return the original source tab ID. The client validates the returned destination folder, membership and selected-Space/focus semantics before showing success. The background freshly negotiates, re-reads context, verifies the chosen destination, and reattests its source before one dispatch.

## Queue and mutation boundaries

The bridge already holds `SpaceStore.run()`. `moveTodayTabsToSpaceCore` is the queue-free canonical operation; the existing public `moveTodayTabsToSpace` wrapper still owns the menu/sidebar queue. The core accepts a read-only order getter and a boundary guard; its default menu semantics are unchanged. Moves preserve restoration rank/checkpoint behavior and deliberately skip native group projection during this action.

Switch stages an exact selected-Space map, persists it through the existing store, then guards before/after native tab and window focus. It recognizes only its exact staged membership/selection and confirmed native focus. Every guard resolves both exact folder roots, checks source and destination metadata, captures fresh native tab identities, and rechecks persisted pairing after any awaited feature check. Canonical and legacy Today-order changes are fenced during move validation. No arbitrary current selected Space is accepted as a self-authored transition.

A failure before attempted persistence restores staged in-memory selection/membership and forces reload where needed. After a possibly committed write, errors report partial/uncertain results and do not roll back or replay. The existing request journal records pending attempts and confirmed identities before ancillary snapshot refresh.

## Verification

`npm test` and `npm run build` cover this Spotlight build. The paired Arcify backend uses `npm run test:unit` and `npm run build`. Focused tests include the real store queue, real `SpaceStore.persist` guard behavior from the existing action suite, both ordering representations, stale target/source identities, malformed payloads, helper exclusions, late pairing and ordering changes, no native move effects, empty/multiwindow destination behavior, exact self-focus events, and partial/no-replay paths.

Prompt layout uses a shrinkable single-column grid, bounded native controls, and wrapping descriptions/errors/buttons. Long names and duplicate-name ID suffixes remain intact in the option text; layout never shortens stored names or changes destination identity. `test/unit/action-prompt-layout.test.js` checks this CSS contract, full field/option text, labels, focus trapping, and query restoration in page and isolated documents. These DOM checks do not measure rendered geometry.

The paired real-browser acceptance and release CI remain separate. In the supported acceptance browser, verify genuine picker input in the isolated overlay and New Tab helper, both Today representations, empty Space focus, exact active tab movement, equal URLs/names, revocation, and post-commit display behavior. Renaming, URL editing, duplicate/copy/mute, Archive, and split actions remain out of scope.
