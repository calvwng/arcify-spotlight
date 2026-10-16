# Optional Archive actions

`archiveActionsV1` adds two independent Spotlight choices without changing the
existing Sidebar command or the core bridge protocol:

- **Open Archive** requests Arcify's native sidebar Archive popup.
- **Reopen <title>** reopens the exact archived record in its original Space.

Both the overlay and owned New Tab renderer offer these for Archive-related
queries or matching archived titles. Ordinary empty, URL, and unrelated searches
retain their existing behavior. Archived rows display `Archive • <original Space>`
and keep same-URL/same-title records distinct by opaque entry ID.

## Identity and dispatch

A read-only `hello` negotiates `archiveActionsV1`; only `INVALID_REQUEST` permits
legacy read-only negotiation fallback. `archiveContext` takes `windowId`, `tabId`
and `supportedFeatures: ['globalFavoritesV1', 'archiveActionsV1']`. Its standard
bridge success envelope includes `extensionId`, `snapshot`, and `archiveActions`:

- `context`: exact `windowId`, `spaceId`, `bookmarkFolderId`, `sourceTabId`,
  `sourceUrl`, and nullable `pairingGeneration`
- `viewId`: an opaque view identity
- `openIntent`: an opaque one-shot token, or null when native sidebar support is
  unavailable
- `entries`: exact `entryId`, `title`, `url`, `spaceId`, `bookmarkFolderId`, and
  nonnegative finite numeric `archivedAt` for each safe reopen record

The active context and every entry's original Space/folder must match the
validated snapshot. Arcify retains the complete private records; Spotlight never
identifies one by URL, title, or array index. Separate internal display names come
from the same validated snapshot and do not change authorization scope.

`reopenArchivedTab` carries `windowId`, `context`, `viewId`, `entryId`, and the
same feature markers. Spotlight rechecks the exact browser-attested source and
pairing immediately before dispatch. It does not fetch a new `archiveContext`,
which would rotate the captured private view and token. Arcify authoritatively
validates current Space and original entry identity.

The response's `archiveResult` has exactly `entryId`, `tabId`, `spaceId`,
`windowId`, `consumed: true`, `status: 'reopened' | 'partial'`, and nullable
`warning`. A normal success must prove the returned tab belongs to its original
Space's Today membership, that Space is active, and the reopened tab is active. A partial result must contain a visible warning; a null
`tabId` is accepted only as a partial consumed result (for example, a prior browser
session). Spotlight does not replay a dispatched or uncertain operation. Its
worker also rejects repeated requests for the same peer/generation/view/entry
within its lifetime; authoritative persistence and recovery belong to Arcify.

## Native Archive popup

Preparation happens asynchronously. Only a trusted, non-repeated Enter or primary
click dispatches `{type:'arcify-archive-open', version:1, requestId, token}` directly
to the paired extension from the original renderer event stack. There is no await,
background relay, generic navigation, or native fallback before that call.

Spotlight reports success only for an exact correlated Arcify response containing
`ok:true` and `displayed:true`. Arcify sends that response after its authenticated
native sidebar document acknowledges its Archive popup. A 10-second timeout,
malformed reply, error, or pairing change clears the captured scope without a
retry. Both renderers remain open to display success or partial recovery guidance.

No new extension permissions are required. Source attestation reuses the existing
exact owned-helper nonce boundary, including browser New Tab aliases; it never
infers a previous tab or uses last-focused-window guessing.

## Verification limits

Focused adapter, controller, isolated-overlay DOM, real new-tab module, and
helper-alias tests run under `npm test`; `npm run build` verifies bundling. These
mocked Chrome/jsdom tests do not prove browser user activation, native sidebar
identity, or full paired acceptance. Companion hosted cases exercise those paths
against the exact final pair separately.
