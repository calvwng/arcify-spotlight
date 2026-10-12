# Optional Arcify connection (protocol v1)

Spotlight owns search, its overlay, shortcuts, and the new-tab page. When explicitly
paired, Arcify remains authoritative for stable space identities, active space per
window, live membership/order, exact saved-pin bindings, and workspace operations.
Spotlight requests fresh snapshots for workspace-backed searches and before actions;
it never writes a snapshot into its own `spaces` storage or replaces Arcify state.
Chrome tab-group sync is optional and is not the bridge's source of identity.

Companion: [Arcify draft PR #75](https://github.com/calvwng/arcify/pull/75).
The latest tested runtime pair for this guide is Arcify
[`5f8febd`](https://github.com/calvwng/arcify/commit/5f8febd100e21b06142c1fd8dd91d975d02f1d9f)
and Spotlight
[`5eedd346`](https://github.com/calvwng/arcify-spotlight/commit/5eedd3463580013ec03e88e23bac17b475770e5b).
Later documentation-only commits do not change that runtime pair or require a
rebuild. See the [Arcify-side guide](https://github.com/calvwng/arcify/blob/5f8febd100e21b06142c1fd8dd91d975d02f1d9f/docs/spotlight-bridge.md)
for its storage model, and the [deferred backlog](BACKLOG.md) for bookmark-only ideas.

## Load, pair, and update

Use a test profile first. These extensions can read bookmarks and change tabs.
Avoid two active Arcify copies in one profile: they share the Arcify bookmark
folder namespace. Avoid competing new-tab overrides during validation.

1. Check out `integration/arcify-bridge-v1` in the `calvwng/arcify` and
   `calvwng/arcify-spotlight` forks, or use the exact paired revisions above.
   Build each with `npm ci` and `npm run build` using Node 22 or 24.
   `PUPPETEER_SKIP_DOWNLOAD=1 npm ci` suffices for builds/unit tests; browser tests
   need their documented browser setup.
2. In the browser's extension manager (`chrome://extensions`), enable Developer
   mode and load each repository's **dist** folder as an unpacked extension.
   Use only a browser/profile where installation is permitted.
3. Open **Arcify Spotlight → Details → Extension options**, or use **Connection
   settings** below Spotlight results. Copy the actual Arcify extension ID into
   Spotlight and choose **Save Arcify ID**.
4. Choose **Copy Spotlight ID**, open Arcify's **Spotlight companion** settings,
   paste that ID into its Spotlight field, and save it there too. If copying is
   unavailable, the ID field is selected for manual copying.
5. After both saves, choose **Refresh status** in Spotlight and **Check connection**
   in Arcify. Both should report connected.

**Either side can be saved first.** Saving an ID is a local configuration change,
not proof that the other side approved it. The first side can show **Awaiting
approval** until the reciprocal ID is saved. This is expected setup, not a failed
save. Each page displays its saved peer ID separately from an unsaved edited field;
a refresh/check uses the saved ID. There is no discovery broadcast or auto-pairing.

IDs are 32 lowercase letters from `a` through `p`. Use the IDs actually displayed
for these installations; an unpacked path move or a different installation can
change them. No Chrome Web Store ID is assumed. An installed build works only if
it implements the matching bridge protocol; an older store release does not gain
bridge support merely by entering its ID. Never enter credentials or tokens.

For a runtime update, fetch the user forks, build matching revisions, Reload both
extensions, and refresh web pages with old Spotlight content scripts. Keep unpacked
paths fixed where possible. Check both connections again; re-pair if an ID changed.
Update both implementations when the protocol changes. A docs-only update needs
neither a rebuild nor a change to Arcify's pinned companion runtime revision.

## What pairing enables

- **Switch a space:** Search a space name and select its workspace result. Empty
  spaces are included. Selecting an empty space creates no tab; the helper new-tab
  page remains available for your next action.
- **Return to an exact live tab:** Select a live result from another space in the
  current window. Arcify activates that tab and its owning space instead of
  reopening its URL. Another window's active space is not intentionally changed.
- **Open a saved pin:** Search its saved title/URL. Arcify reuses its bound live tab
  in this window, even if that tab navigated elsewhere, or opens that exact bookmark
  in its space. Equal URLs in different bookmark nodes/spaces remain distinct.
- **Open a URL or search:** New-tab mode opens in Arcify's active space for this
  window. Current-tab mode on an ordinary page navigates the same tab without moving
  its membership. Selecting a live-tab result still activates the selected tab in
  either mode. The Spotlight helper page uses new-tab navigation and closes only
  after a confirmed result targets a different tab; empty-space selection keeps it.
- **Launch from the sidebar:** Arcify's separate **Search with Spotlight** button
  targets that sidebar's window. Unsupported pages use Spotlight's helper page;
  an already-active helper is reused. The original Arcify New Tab button is unchanged.
- **Use group sync off:** All the above use Arcify's model, not group names/IDs.
  Optional native groups remain Arcify's projection when sync is enabled.

Search also retains ordinary bookmarks, history, top sites, and autocomplete.
Workspace tab order comes from Arcify; global Chrome-pinned favorites and unowned
pages follow those tabs. A missing bookmark folder produces a visible warning;
other folders and live tabs remain usable, without guessing a missing pin by URL.

## What the bookmark folder can and cannot do alone

The shared `Arcify` bookmark folder contains saved space/folder names and pinned
link titles/URLs. Standalone Spotlight can read it without pairing, but its current
folder fallback is **not complete workspace integration**:

- [`ArcifyProvider`](../shared/data-providers/arcify-provider.js) builds normalized
  URL-to-folder metadata for existing search results. It uses the bookmark folder
  ID as `spaceId`, not Arcify's stable space UUID. Color defaults to grey without
  a matching `spaces` entry in Spotlight's own storage.
- [`BackgroundDataProvider.getPinnedTabsData`](../shared/data-providers/background-data-provider.js)
  additionally requires a name match in **Spotlight's own** `storage.local.spaces`;
  it skips a space folder without one. Extension-local storage is not shared with
  Arcify. Folder presence alone therefore does not guarantee complete saved-pin
  enumeration. Ordinary bookmark/history/tab results may still expose those URLs.
- The URL metadata cache and standalone result deduplication can collapse distinct
  saved pins sharing a normalized URL. URL matching is not exact live-pin identity.
- Standalone does not create the selectable `arcify-space` results supplied by the
  [paired provider](../shared/data-providers/arcify-bridge-provider.js), including
  empty-space switches. Native tab groups may supply labels, but do not reveal the
  authoritative active space or live membership when group sync is off.

Folder data could support a better saved-link fallback. That improvement is
[explicitly deferred, not implemented (B-001)](BACKLOG.md#b-001-improve-bookmark-only-discovery-without-pairing).
Even an improved fallback would lack Arcify's live per-window state and reliable
workspace action routing. It would complement pairing rather than replace it.

## How the bridge works

1. Each extension stores only its explicitly chosen companion ID under
   `storage.local.arcifyBridgePeerId`, local to that extension/profile.
2. Spotlight's settings check sends `hello` to Arcify. Arcify checks the sender and
   request before reading workspace data. A successful reply identifies Arcify and
   includes a fresh window snapshot. Spotlight verifies the protocol, request ID,
   role, declared extension ID, and snapshot integrity. Arcify can separately send
   `hello` to Spotlight to check its reciprocal approval.
3. The Spotlight background worker resolves the caller's window, requests a fresh
   snapshot, and constructs a request-scoped search provider. It does not maintain
   a Spotlight-owned copy of Arcify workspaces. Autocomplete keeps its own provider.
4. On selection, Spotlight refreshes state and sends a specific action. Arcify
   serializes it with native tab events/sidebar writes through its SpaceStore queue,
   rechecks current membership, and performs existing Arcify operations. Default-
   engine searches use an Arcify-managed target tab followed by Spotlight's existing
   `chrome.search` call.

### Protocol v1 reference

The [protocol helper](../shared/arcify-bridge-protocol.js) matches the Arcify copy.
Transport is extension-to-extension `chrome.runtime.sendMessage`, not a website
endpoint. Every request contains:

```json
{"type":"arcify-bridge","version":1,"requestId":"unique-request-id","command":"snapshot","windowId":123}
```

- Window/tab IDs must be positive integers, not Chrome's current-window sentinel.
  Request IDs are 1–80 permitted ASCII letters/digits/underscore/period/colon/hyphen.
  Unsupported commands, versions, surplus fields, and malformed payloads are rejected.
- Spotlight → Arcify: `hello`, `snapshot`, `activateSpace {spaceId}`,
  `activateTab {tabId}`, `openTab {url, spaceId?}`, `navigateTab {tabId, url}`,
  `openBookmark {spaceId, bookmarkId}`.
- Arcify → Spotlight: `hello`, `launch {mode}`, where mode is `current-tab` or
  `new-tab`. Arcify's sidebar currently requests `new-tab` mode.
- Success: `{type, version, requestId, role, ok:true, extensionId?, snapshot?, tabId?}`.
  Arcify includes a fresh snapshot on successes; Spotlight's hello/launch replies
  identify Spotlight without an Arcify snapshot. Failure uses `ok:false` and
  `error:{code,message}`. A matching request ID correlates the response.
- Snapshots carry `windowId`, `capturedAt`, `activeSpaceId`; ordered spaces with
  stable IDs/name/color and window-filtered tab/pinned/temporary membership; live
  tab metadata; exact saved bookmark IDs and optional bound tab IDs; and warnings.
  `capturedAt` is diagnostic, not a version permitting a stale overwrite.
- `openTab` without an explicit space uses the window's selected space.
  `openBookmark` validates exact current bookmark membership. `navigateTab` keeps
  existing membership; `activateTab` selects its owner. No URL/name inference is
  used to substitute a different workspace identity.
- Navigation allows `http:`, `https:`, `file:`, `chrome:`, and exact `about:blank`,
  subject to the browser's own restrictions. Other extension URLs and executable
  schemes are rejected by the bridge.

### Trust boundary

Both manifests have `externally_connectable.ids: ["*"]` so development and installed
extension IDs can reach the listener. This is **reachability, not authorization**.
There are no allowed website-origin matches. Handlers require `sender.id` to equal
the saved peer ID; when sender URL/origin is present, it must match that extension's
origin. Websites, unpaired extensions, and malformed requests do not gain access.
Spotlight accepts configuration changes only from its own options page.

Pair only builds you trust: paired Spotlight can read Arcify workspace/tab/bookmark
metadata and request workspace actions. Paired Arcify can request Spotlight launch
in a window. This does not create credentials, an account, or synced peer settings.
The bridge is not a replacement for the browser's extension permission model.

## Lifecycle, disconnect, and failures

MV3 listeners register synchronously. Subsequent requests wake the worker and obtain
fresh state; a suspended worker is not a reason to reuse old workspace snapshots.
Changing/disconnecting a peer invalidates obsolete results, and late settings
checks cannot label a replaced peer as connected. Search again after re-pairing.

- **Awaiting Arcify approval:** Arcify replied `UNAUTHORIZED`. The ID is saved in
  Spotlight; save this installation's Spotlight ID in Arcify, then refresh. If
  already saved, verify both IDs match the actual installations.
- **Unavailable / timeout:** Check that the peer is enabled in the same profile,
  verify its ID, reload matching builds, and refresh. The timeout is five seconds.
  An action may have completed despite a lost/late reply: inspect tabs and refresh
  before trying again. Mutations are never automatically retried.
- **Version/identity/invalid response:** Do not assume connection succeeded. Use
  matching protocol builds and the correct peer ID. Snapshot validation rejects
  inconsistent ownership/window membership rather than guessing.
- **Stale tab/space/bookmark:** Refresh results. Deleted or moved identities cannot
  safely be replaced with another same-URL item. Partial bookmark-folder warnings
  do not invalidate unrelated live tabs.
- **Disconnect:** Disconnect in both settings pages to clear both approvals.
  Clearing Arcify's peer ID rejects incoming Spotlight requests. Clearing Spotlight's
  ID restores standalone behavior; old paired results are rejected until refreshed.
  A still-configured broken/pending connection does not silently fall back to native
  workspace mutations.

Arcify keeps a bounded journal of the last 100 mutation request IDs in
`storage.session`. An identical completed duplicate returns its saved outcome plus
a fresh snapshot; conflicting data is rejected. A recorded but unfinished request
returns `UNCERTAIN_RESULT`, never an automatic replay. This covers worker restarts,
not durable transactions: Chrome clears session storage on extension
reload/update/disable and browser restart ([Chrome storage documentation](https://developer.chrome.com/docs/extensions/reference/api/storage#session)).
Spotlight's separate reverse-launch replay guard holds up to 100 entries only for
the current worker lifetime, with per-window serialization and active-helper reuse.
Neither mechanism guarantees deduplication after its retained state is lost.

## Verification and current limits

Run `npm test`, `npm run test:coverage`, and `npm run build`. From the companion
Arcify checkout, `node scripts/check-spotlight-pair.mjs ../arcify-spotlight` compares
protocol copies and exercises actual client/server modules with mocked Chrome APIs.
These checks do not load the pair into a real browser.

At the tested runtime revisions above:

- Spotlight: **894 tests / 32 files**, production build and [CI coverage run](https://github.com/calvwng/arcify-spotlight/actions/runs/38214051593) passed.
- Arcify: 188 unit passes / 1 explicit baseline skip, build, 12 Arcify-only browser
  regressions, and 123 legacy E2E tests on each Node 20/22 passed. Those browser tests
  use the existing Arcify-only harness, not full paired UI acceptance.
- The [dedicated paired run](https://github.com/calvwng/arcify/actions/runs/38214220014)
  failed before browser startup at its sandbox-helper safety preflight: 0 passed,
  1 preflight failure, 13 not run, 0 screenshots. No security protections were relaxed.
  The managed cloud browser separately blocks unpacked installation by policy.
- The user reported a successful Helium handshake after saving both reciprocal IDs.
  Updated builds are prepared locally, but revised UI/clipboard interaction and the
  full paired matrix are still pending manual acceptance. This observation is not
  comprehensive Helium compatibility or real-Chrome paired test evidence.

See the [full acceptance matrix and baseline caveats](https://github.com/calvwng/arcify/blob/5f8febd100e21b06142c1fd8dd91d975d02f1d9f/docs/bridge-validation.md)
for multiwindow identity, group sync off/on, native sidebar, physical shortcuts/focus,
worker reload, and complete browser-session restoration checks. Read exact-head CI
results in [Spotlight PR #1](https://github.com/calvwng/arcify-spotlight/pull/1) for
subsequent documentation-only revisions.

Unchanged upstream Spotlight built successfully but had 689 passing tests and seven
external autocomplete timeouts. A test-only autocomplete stub made the affected
35 tests deterministic; production autocomplete is unchanged. The inherited
checkout tracks some `node_modules` files: exclude install churn from bridge commits.
