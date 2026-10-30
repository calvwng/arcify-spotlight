# Optional Space actions in Spotlight

The first context-action slice supports four commands through an explicitly paired
Arcify companion: open Arcify settings, create a named folder at the root of the
selected Space, pin the exact current Today tab, and remove its exact saved Space
pin. These commands do not replace normal web search, navigate the Spotlight
helper, or close it. Opening settings creates Arcify's settings tab in the source
window. The existing Open Arcify sidebar command retains its separate synchronous
trusted-gesture transport.

## UI behavior

- Typed action phrases, prefixes, and bounded typos rank valid action choices above
  web search. Web search remains available. Unrelated words and URL input do not
  become commands. Remove requires removal intent, such as `unpin` or `remove pin`.
- Empty-query results keep ordinary navigation/startup selection behavior. A sole
  action is never selected automatically; Remove is never the empty-query default.
- Folder/settings can be available from a helper page. Pin/Remove require a
  current-tab context from Arcify. There is no previous-tab, URL, title, or source
  guessing for helper pages.
- Folder creation asks for a nonempty name. Remove asks a second explicit question:
  the saved bookmark is deleted and every live copy linked to that exact pin stays
  open as Today. Other same-address pins are unchanged. Cancel has initial focus.
- Both activation and confirmation require trusted, non-repeated, non-composing
  Enter/primary-click events. Synthetic DOM events and held Enter cannot confirm
  deletion. Escape cancels a prompt without closing the underlying overlay.
- Prompts are labeled dialogs with contained focus, an error alert, and preserved
  search/folder drafts. A passive refresh preserves a manual selection by exact
  identity; if that context disappears, no replacement row is silently selected.
- An unknown, refused, or timed-out action displays an error, removes its prepared
  choices, and is never replayed or routed through native navigation. Check Arcify
  before deliberately trying it again. There is no automatic retry button.

## Protocol contract

`shared/arcify-space-actions-protocol.js` owns strict context, payload, and result
validation. `shared/arcify-space-actions.js` owns the background-only transport and
message handler. `shared/arcify-space-actions-ui.js` owns renderer choices/prompts.
No permission is added for this action layer.

All external messages retain protocol v1's authenticated extension-to-extension
envelope and request ID. The optional supported feature and advertised capability
are both `spaceActionsV1`. Actions require its negotiated presence. The adapter
first advertises `[globalFavoritesV1, spaceActionsV1, spaceNavigationV1]` on read-only hello; an exact
`INVALID_REQUEST` can fall back to the original `[globalFavoritesV1, spaceActionsV1]` pair, then `[globalFavoritesV1]`, then a bare hello. Only
hello is replayed. A peer without the action capability stays usable for ordinary
Spotlight search/navigation and existing commands.

Read request: `actionContext`, with exact current `tabId` and source `windowId`.
The successful envelope adds `extensionId`, `snapshot`, and `actionContext`:

```js
{
  windowId, spaceId, bookmarkFolderId, pairingGeneration, sourceTabId,
  tab: null | {
    id, url, title, section: 'today' | 'saved',
    bookmark: null | { id, parentId, title, url }
  }
}
```

Every key is required; no extra keys are accepted. `pairingGeneration` is Arcify's
string generation or null. `sourceTabId` is always the actual current requesting
tab. A null `tab` can represent a helper, native/global tab, unsupported split, or
ambiguous association; it cannot authorize Pin/Remove. A Today tab has a null
bookmark; a saved tab has one exact bookmark identity. IDs are nonempty strings
up to 200 characters, positive integer tab/window IDs, safe URL strings, and
bounded title strings. Snapshot and context must agree about the selected Space.

Mutations use these payloads and success identities, in addition to the common
request/success envelope and snapshot:

- `openSettings`: `{context}`; result `{tabId}`
- `createSpaceFolder`: `{context,title}`; result `{folderId}`
- `pinCurrentTab`: `{context}`; result `{tabId,bookmarkId}`
- `removeCurrentPin`: `{context,confirmed:true}`; result `{tabId,bookmarkId}`

The entire captured context is echoed. Folder names must already be trimmed,
1–256 characters, and contain no control characters. Context/result payloads
reject unexpected fields. Pin/Remove responses must identify the exact source
tab, and Remove must also identify the exact confirmed saved bookmark.

Spotlight's internal scope additionally contains its own peer ID and local pairing
generation. Pairing is checked before and after every external request. Immediately
before every mutation, the adapter negotiates and reads a fresh action context,
then compares the complete captured identity and metadata. Revocation, re-pairing,
tab moves/navigation, selected-Space changes, bookmark reassociation, and late
responses fail closed. Arcify independently revalidates the same context before
its authoritative operation.

Content-script source identity comes from the browser-attested sender tab. An
extension helper without `sender.tab` must supply its exact current helper ID;
the live tab must still be the owned new-tab page and active in the same window.
A browser `chrome://newtab/` alias additionally requires the existing fresh nonce
challenge and independent Chrome-attested renderer acknowledgement. The alias
verifier is shared with normal New Tab reuse, performs no navigation/focus work,
and has a false-only fallback. It runs again immediately before mutation dispatch;
verification failure or timeout sends no Arcify mutation. Literal extension helper
URLs retain their strict owned-path check. There is no last-focused-window or
previous-tab fallback for this route.

## Verification and remaining acceptance

Focused tests import the actual adapter, validators, controller, new-tab renderer,
selection manager, and DOM prompt code. They cover helper gating, absent capability,
legacy hello negotiation, malformed or unauthorized messages, all context identity
drift, duplicate URLs with distinct IDs, generation revocation, stale responses,
prompt cancellation, safe destructive focus, synthetic/repeated/IME events,
manual selection, preserved drafts, and unknown outcomes with no retry/fallback.

Run `npm test` and `npm run build`. These tests mock Chrome API boundaries and the
trusted-event flag; they do not establish paired live-browser acceptance. Before
publishing, verify both paired extensions together in the supported acceptance
browser, including the isolated overlay frame, restricted-page helper, exact
Today/Space-pin identity, multi-window same-address copies, and safe cancellation.
Switch Space and moving the current Today tab are a separate optional slice
in [Space navigation](SPACE-NAVIGATION.md). Independent current-tab commands
are documented in [TAB-ACTIONS.md](TAB-ACTIONS.md); they use `tabActionsV1`
and leave the Space-action context unchanged. Archive and Split remain outside
these slices.
