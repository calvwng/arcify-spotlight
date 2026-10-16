# Native Split actions

Spotlight negotiates the optional `splitActionsV1` capability with Arcify. This
feature uses Helium's native Split implementation through the paired Arcify
adapter. Unsupported peers expose no Split results. No manifest permissions,
native mutation fallback, arbitrary command executor, or focus compensation are
added to Spotlight.

## Source and choice

The source must be the browser-attested content-script tab, still active and
stable in its exact focused window. New-tab/helper renderers cannot substitute a
previous tab, even if they have a tab ID. Favorites, saved Space pins, native
pins, extension pages and browser New Tab aliases are ineligible.

A compatible ordinary Today source offers **Split current tab** only when another
unsplit Today tab is available in the same Space, window and native group. The
picker labels each choice with its exact tab ID and native position so duplicate
URLs and titles remain distinguishable. It selects nothing initially. Click,
Space or arrow keys explicitly choose a target; a separate trusted Enter/click
confirms. Cancel and Escape restore the search draft/focus without closing the
overlay. A verified adjacent native pair offers **End Split**, keeping both tabs
open. Neither action routes through ordinary navigation.

## Wire contract

Read-only `hello` requests `[globalFavoritesV1, splitActionsV1]`. Only a handshake
`INVALID_REQUEST` permits older-feature fallback. No mutation is retried.
`splitActionContext` carries the standard window/feature fields and `{tabId}`.
Its response adds `extensionId`, `snapshot`, `splitActionContext`, and
`splitTargets` to the standard success envelope.

The exact context is:

- `windowId`, `spaceId`, `bookmarkFolderId`, `pairingGeneration`, `sourceTabId`
- `tab`: null or an exact descriptor
- `pair`: empty or two descriptors in adjacent native left-to-right order,
  including the exact source descriptor

Descriptors contain exactly `id`, `url`, `title`, `index`, `groupId`, `pinned`,
and `splitViewId`. `pinned` is false, and an unsplit descriptor uses
`splitViewId: -1`. `splitTargets` contains unique compatible unsplit descriptors,
never the source. The pair, source and target lists are cross-checked against the
active Space's Today membership and the returned snapshot.

`createSplitView` sends `{context, target}`; `endSplitView` sends `{context}`,
plus the standard window/feature fields. The exact mutation success envelope
contains `snapshot` and `splitResult`. The receipt contains exactly:

- `action`: `create` or `end`
- `windowId`, `spaceId`, `sourceTabId`
- `tabIds`: the original native left-to-right pair, independent of which is source
- `splitViewId`: nonnegative for create, `-1` for end
- `reordered`: true for create only when the original tabs were nonadjacent;
  always false for end

## Staleness and uncertain outcomes

The local renderer scope wraps the wire context/targets with paired extension
ID, local pairing generation and a monotonic native-state epoch. Selection is
retired on context refresh, re-pairing, native split/group/tab/focus changes or
surface disposal. Each mutation freshly reads the exact context and selected
target, checks pairing, and rereads the exact source and target native descriptors
before dispatch. Persisted local pairing is checked again after those awaited
native reads; a separate storage-event fence retires same-peer revoke/re-pair
cycles even when the stored values are restored. Titles are Arcify-projected
aliases and are checked against the fresh provider context/snapshot, rather than
compared to native page titles. A state change followed by restoration still
retires the old epoch. Arcify independently owns its final native-operation checks.

Only an exact receipt and consistent post-action Today snapshot establish
success. Timeout, malformed response, partial native outcome, context drift or
pairing changes do not trigger retry or navigation. Native events during the
operation refresh the surface; they do not themselves establish success.

## Verification

Run `npm test` and `npm run build`. The Split suites exercise actual protocol and
client modules, source/helper rejection, local listener transport, capabilities,
descriptor/receipt validation, source-right ordering, epoch races, final native
target drift, no replay, trusted picker controls, stale selection, Cancel/Escape,
and the actual isolated overlay and new-tab renderers. Native Helium execution
and browser-level trusted-input/focus behavior require separate hosted QA; DOM
mocks do not establish those browser behaviors.
