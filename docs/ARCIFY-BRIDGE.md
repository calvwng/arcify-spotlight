# Optional Arcify connection (protocol v1)

Spotlight owns search, its overlay, shortcuts, and the new-tab page. When explicitly
paired, Arcify remains authoritative for stable space identities, active space per
window, live membership/order, exact saved-pin bindings, and workspace operations.
Spotlight requests fresh snapshots for workspace-backed searches and before actions;
it never writes a snapshot into its own `spaces` storage or replaces Arcify state.
Chrome tab-group sync is optional and is not the bridge's source of identity.

Companion: [Arcify draft PR #75](https://github.com/calvwng/arcify/pull/75).
Current matching runtime revisions and exact-head checks are recorded in
[Spotlight draft PR #1](https://github.com/calvwng/arcify-spotlight/pull/1) and the
companion PR. The four-finding regression fixes retain protocol v1; update both
runtime builds to obtain all fixes. Documentation-only commits do not require a
rebuild. See the [Arcify-side guide](https://github.com/calvwng/arcify/blob/integration/arcify-bridge-v1/docs/spotlight-bridge.md)
for its storage model, and the [deferred backlog](BACKLOG.md) for bookmark-only ideas.

## Load, pair, and update

Use a test profile first. These extensions can read bookmarks and change tabs.
Avoid two active Arcify copies in one profile: they share the Arcify bookmark
folder namespace. Avoid competing new-tab overrides during validation.

1. Check out `integration/arcify-bridge-v1` in the `calvwng/arcify` and
   `calvwng/arcify-spotlight` forks, or use the exact paired revisions recorded in their PRs.
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
  an already-active helper is reused. Bridge launch explicitly ensures the overlay
  is open, including during pending close animation or after worker restart; it is
  not a toggle. Normal Spotlight shortcuts retain their toggle behavior. The
  original Arcify New Tab button is unchanged.
- **Repeat Spotlight's New Tab command on a New Tab:** If the active
  `chrome://newtab/` page is already Spotlight, it is reused from the first
  command. Spotlight authenticates its ready renderer with a one-use nonce and
  fresh browser tab/window identity before treating the browser alias as its own.
  Reuse preserves the existing document, query, selection and focus; it does not
  navigate, focus the input, close tabs or find an inactive helper elsewhere.
  Concurrent shortcut, internal and sidebar launches are serialized in their
  originating window. Missing or other New Tab providers retain the ordinary
  helper fallback. A loading, navigating, moved or changed source aborts instead
  of opening a helper on stale context. This does not change shortcut assignments.
- **Use group sync off:** All the above use Arcify's model, not group names/IDs.
  Optional native groups remain Arcify's projection when sync is enabled.

The page overlay keeps its search UI in a source-less `about:blank` frame inside
its modal dialog. This separates typing from the host page's keyboard event path,
including earlier document/window shortcut listeners. Trusted input handlers still
run in Spotlight's original content-script context; sidebar actions do not use a
message relay or gain broader sender permissions. Tab/Shift+Tab stay within the
overlay, Escape dismisses it, and ordinary text-editing modifiers remain available.
New Tab UI and focus behavior are unchanged; initial omnibox focus remains a
manual check.

Search also retains ordinary bookmarks, history, top sites, and autocomplete.
Workspace tab order comes from Arcify; native Chrome-pinned tabs and unowned
pages follow those tabs. Matching saved-Favorite builds also include the ordered
shared Favorites list, including closed records. A missing bookmark folder produces a visible warning;
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
   engine searches in new-tab mode create an Arcify-managed blank target before
   Spotlight's existing `chrome.search` call. In current-tab mode, the fresh
   authenticated snapshot validates the exact source tab; Spotlight also checks
   the live tab/window and saved peer immediately before its final `chrome.search`
   navigation. It does not first navigate the existing page to `about:blank`, so a
   snapshot timeout leaves that page and its error UI intact.

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
  `openBookmark {spaceId, bookmarkId}`, and optional `openFavorite {favoriteId}`
  when the authenticated peer advertises `persistentFavorites`.
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
There are no allowed website-origin matches. Normal v1 bridge handlers require `sender.id` to equal
the saved peer ID; when sender URL/origin is present, it must match that extension's
origin. Websites, unpaired extensions, and malformed requests do not gain access.
Spotlight accepts configuration changes only from its own options page.

Pair only builds you trust: paired Spotlight can read Arcify workspace/tab/bookmark
metadata and request workspace actions. Paired Arcify can request Spotlight launch
in a window. This does not create credentials, an account, or synced peer settings.
The bridge is not a replacement for the browser's extension permission model.

## Open Arcify sidebar and startup suggestion

Matching builds advertise optional capabilities: Arcify's `hello` includes
`openSidebar`; Spotlight's includes `startupSuggestion`. Older paired builds keep
ordinary bridge behavior, but Spotlight does not show this command without a
successful, explicitly paired capability check. No manifest permissions were added.

“Open Arcify sidebar” is an ordinary result in the new-tab page and HTTP(S) overlay.
It appears after ordinary empty-query results and is never the sole default
empty-query selection unless the startup offer below was accepted. Search for
“Arcify sidebar,” or a close partial/typo such as “opn arcfi.” Matched sidebar
commands and already-matched workspace-switch actions appear ahead of the ordinary
**Search for …** row, which remains available below them. Ordinary tab/bookmark
navigation rows keep their existing data ranking. Unrelated or URL-like queries
keep the normal search/URL behavior. The sidebar command has a distinct split-panel
icon rather than a magnifying glass.

The best matching action is initially selected for Enter. Explicit keyboard or
pointer selection takes precedence over late capability/search updates, including
navigation keys that remain at the current row. Result refreshes preserve stable
identity rather than comparing changing scores or preview text. Typing a new query
resets that choice; merely previewing a selected URL does not change the search
query. Select with the arrow keys or click. Its native Enter/click
handler directly sends `{type: 'arcify-sidebar', version: 1, requestId}` to the cached
paired Arcify ID on the original gesture stack, without an awaited lookup, Spotlight
background relay, generic navigation action, or mutation queue. Synthetic events
are rejected. Arcify independently checks its freshly saved peer and browser-supplied
source tab before calling its own `sidePanel.open({tabId})`; the request cannot supply
a target. The dedicated route accepts the exact paired Spotlight new-tab document
or its authenticated top-frame HTTP(S) content script. This narrow exception does
not broaden normal bridge authentication or create a website messaging gateway.

Arcify's existing **opt-in** startup launcher setting remains the sole startup
controller. For an unchanged active Spotlight new tab, Arcify can offer the
`startupSuggestion` v1 command instead of creating its legacy helper. Spotlight
revalidates the source and relays only to that new-tab renderer through internal
runtime messaging. Only an already ready, visible, empty, untouched page accepts,
selecting the sidebar result once without clearing text, creating a tab, or changing
focus. Typing, navigation/selection, pointer interaction, focus loss, hiding, or
page disposal suppresses later automatic selection. Whitespace/clearing input and
Escape also remove an existing startup selection immediately. A declined offer is
never applied later when initialization completes.

Replies include `accepted: true`, or `accepted: false` with `user-interaction`,
`not-ready`, or `not-eligible`. Intentional interaction and uncertain delivery are
consumed without a foreground fallback. The companion retains its legacy launcher
for unsupported/unpaired startup paths; explicit other declines can at most create
an inactive helper. Neither extension newly enables the startup setting, and
Spotlight does not register a separate browser-startup/tab-creation flow.

Success keeps the new-tab page open. Failure, timeout, unsupported/revoked pairing,
or an invalid response keeps the UI available with a visible error and Arcify
toolbar-button fallback; no automatic retry occurs. Removing a selected command
leaves no ordinary fallback selected until fresh input or explicit navigation, so a
held Enter cannot accidentally navigate somewhere else. Pairing changes immediately
invalidate cached readiness, and stale preparation/action replies cannot revive it.

Chrome may initially focus its native omnibox on a new tab. The startup offer does
not steal that focus: bare Enter at browser startup is therefore not guaranteed to
invoke Spotlight. Focus Spotlight's input or click its command. The prior exact
pair Arcify `3576654` / Spotlight `23f741b` passed all 21 checks in
[paired Chrome run 38350796537](https://github.com/calvwng/arcify/actions/runs/38350796537),
including genuine warm/cold-worker gestures, native rendering and security rejection.
That run explicitly focused Spotlight before Enter; it did not test browser-startup
focus or Helium. Later logical-state invalidation changes require their own exact-head run;
see the linked draft PRs for current results. Mocked module/DOM tests remain distinct
from this browser evidence.

## Persistent saved Favorites (optional capability)

Matching Arcify builds advertise `persistentFavorites` on `hello`. The optional
ordered snapshot field is `favorites: [{id, title, url, sourceBookmarkId, tabId}]`.
Each record has exactly those five fields: IDs are nonempty strings up to 200
characters, title is a string up to 4096 characters, URL is HTTP(S) only, and `sourceBookmarkId` and `tabId` may be null. Favorite IDs, non-null
source bookmark IDs, and live bindings are unique. A bound tab must be the exact
pinned, unowned tab in the requested window, outside all Space memberships.
Source bookmark provenance does not require the original bookmark to still exist.

Arcify owns the profile-local saved list shared across normal windows and Spaces;
Spotlight keeps no separate list or persistent capability cache. When a snapshot
contains Favorites, Spotlight authenticates `hello` and uses its fresh snapshot
only after confirming the optional capability. Older peers omitting the field
retain their existing behavior. Data without the capability, malformed records,
wrong-window bindings and unsupported URLs fail visibly instead of implying
ownership. This preserves the bookmark-to-Favorites HTTP(S) boundary; generic
bridge navigation retains its existing broader URL allowlist. Native-only pinned
internal or local-file pages remain ordinary live tabs, outside saved Favorites. This requires no new manifest permissions.

- Empty search shows Favorites in saved order, including closed ones. Typed search
  matches their saved titles/URLs even when the exact live tab navigated elsewhere.
- Favorite results have a star icon, a **Saved Favorite** subtitle, and **Open
  Favorite** or **Switch to Favorite** action. Native pinned tabs retain their own
  **Open Pinned Tab** label; standalone Spotlight does not claim saved ownership.
- Selection remains keyed by Favorite ID, peer and window across title, URL,
  binding and order changes. Equal-title/URL Favorites remain separate. A saved
  Favorite suppresses only its matching live tab ID when both match the query;
  source Space bookmarks remain independent destinations. URLs never assign
  ownership or bind restored tabs.
- Ctrl+W removes the live binding, leaving the saved result. Clicking it activates
  its exact bound tab or asks Arcify to reopen the saved address in this window.
  Both Spotlight navigation modes use `openFavorite {favoriteId}`, never generic
  navigation, source-bookmark mutation, or a guessed same-URL tab.
- Each action obtains a fresh capability-checked snapshot, verifies the Favorite
  still exists and the source tab still belongs to this window, then dispatches
  the exact ID. The returned tab ID must match that Favorite’s fresh binding. Revoked pairing, unsupported peers, stale records, timeouts and
  failed Favorite commands never fall back to opening the display URL or retry.
- Arcify record/order/binding notifications use the existing trusted `invalidate`
  path. Refresh preserves typed text/manual selection and rejects stale async
  generations. Deleting the selected record leaves nothing selected, so held Enter
  cannot run an unrelated replacement. Hidden pages refresh upon return.

The list survives browser restarts but does not sync across devices. Exact live
bindings are session-local; restored tabs are not adopted by guessing. Original
bookmarks remain intact and **Remove Favorite** is a separate Arcify action.
The new unit and real-module DOM regressions use mocked Chrome APIs; actual
browser/worker-restart acceptance must be verified separately on the exact paired
builds in the approved CI environment.

## Live-tab results and helper identity

The current Spotlight new-tab/helper page is excluded by its exact browser tab ID;
it is not a useful “Switch to Tab” destination for itself. Other live tabs remain
separate even when both are titled **New Tab** or have the same URL. Titles and URLs
are never used to discard an authoritative live-tab identity.

Relevant removal, replacement and cross-window movement events invalidate the live
list. Visible pages coalesce refreshes, preserve the user's typed query/selection,
and reject late responses; hidden pages refresh on return. A stale-action rejection
evicts the invalid tab choice and refreshes without replaying the action or silently
selecting an unrelated fallback under held Enter. Generic paired URL-navigation
choices must satisfy the existing bridge URL allowlist. Unsupported extension-page
history/bookmark/top-site choices (including helper URL variants) are therefore
omitted rather than offered as commands that cannot execute. This does not delete
stored data, discard ID-based live extension tabs, hide similarly named supported
websites, or change standalone behavior. A stale unsupported generic row fails
locally with a clear message before navigation dispatch and never uses native
fallback. The real sidebar command retains its separate trusted-gesture path.

Paired tab refreshes are scoped to the source window. Standalone new-tab/helper
results can span windows and refresh accordingly; standalone content overlays still
need a new query or focus return for changes made only in another window.

With matching updated peers, Arcify also sends an optional protocol-v1 `invalidate`
request containing only the relevant `windowId`. This covers authoritative
membership/order, active-space and metadata changes even with native group sync
off, plus relevant saved bookmark updates. Spotlight validates the currently saved
peer, extension sender, strict payload/version and window; coalesced internal
notifications then use the same fresh-snapshot refresh path. Accepted changes
invalidate older pending results immediately and preserve typed query/manual
selection. No workspace content is trusted from the signal and no competing
workspace database is maintained.

Notification bursts are bounded. The current peer is rechecked across asynchronous
work and on delivery; revoked or old-peer signals do not change standalone results.
Arcify worker startup sends a best-effort invalidation for current normal windows, and Spotlight's
session-only overlay identities survive worker suspension. Missing companion,
unsupported older v1 peers or notification timeouts do not retry actions or loop.
Older builds still work through ordinary queries/focus refresh; update both to gain
logical-state notifications. Browser-created duplicate tabs are not automatically
closed, because arbitrary unfinished address-bar text cannot be observed safely.

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

Historical checks before the four-finding fixes (Arcify `5f8febd`, Spotlight
`5eedd346`; later docs-only head `a5f28ee` shares that runtime):

- Spotlight: **894 tests / 32 files**, production build and [CI coverage run](https://github.com/calvwng/arcify-spotlight/actions/runs/38214051593) passed.
- Arcify: 188 unit passes / 1 explicit baseline skip, build, 12 Arcify-only browser
  regressions, and 123 legacy E2E tests on each Node 20/22 passed. Those browser tests
  use the existing Arcify-only harness, not full paired UI acceptance.
- The [dedicated paired run](https://github.com/calvwng/arcify/actions/runs/38214220014)
  failed before browser startup at its sandbox-helper safety preflight: 0 passed,
  1 preflight failure, 13 not run, 0 screenshots. No security protections were relaxed.
  The managed cloud browser separately blocks unpacked installation by policy.
- The user reported a successful Helium handshake after saving both reciprocal IDs.
  Updated runtime builds require reload and renewed manual acceptance. Revised
  UI/clipboard interaction and the full paired matrix are still pending. This observation is not
  comprehensive Helium compatibility or real-Chrome paired test evidence.

See the [full acceptance matrix and baseline caveats](https://github.com/calvwng/arcify/blob/5f8febd100e21b06142c1fd8dd91d975d02f1d9f/docs/bridge-validation.md)
for multiwindow identity, group sync off/on, native sidebar, physical shortcuts/focus,
worker reload, and complete browser-session restoration checks. Read exact-head CI
results in [Spotlight PR #1](https://github.com/calvwng/arcify-spotlight/pull/1) for
subsequent runtime and documentation revisions. The review-fix regression tests
exercise actual refresh/overlay/client modules with mocked Chrome and DOM APIs;
those tests remain separate from real paired-browser acceptance.

Unchanged upstream Spotlight built successfully but had 689 passing tests and seven
external autocomplete timeouts. A test-only autocomplete stub made the affected
35 tests deterministic; production autocomplete is unchanged. The inherited
checkout tracks some `node_modules` files: exclude install churn from bridge commits.


## Ordinary global Favorites and reload witnessing

`globalFavoritesV1` is an optional v1 capability. Spotlight starts each operation
with a marker-bearing read-only hello. Only an exact old-peer `INVALID_REQUEST`
permits one unmarked hello fallback. A negotiated hello supplies the fresh
snapshot; mutations carry the feature marker only for capable peers and are never
replayed. The Favorite wire object still has its original five keys. Native
`tabs[].pinned` stays truthful, and same-window/exact-ID/unique/no-Space-owner
checks remain strict. Old pinned-only peers continue to work.

The independently authenticated `arcify-favorite-witness` v1 endpoint lets a
surviving Spotlight session attest Arcify's opaque epoch and latest ownership
revision. `storage.session.arcifyFavoriteWitness` contains only those tokens,
paired ID and pairing generations. Spotlight stores no duplicate workspace or
Favorite database, browsing snapshots or URLs for this feature. Its local pairing
settings rotate a random generation in the same durable write as any peer change,
including disconnect/reconnect. Conditional recovery commits require the exact
original peer generation and previous receipt; reads never enroll a candidate.

The advertised hello capability is `favoriteContinuityWitnessV1`. The witness
endpoint uses strict message shapes, browser-authenticated paired sender/origin,
correlated request IDs, explicit role/version and a 1.5-second bounded transport.
It needs no new permissions. Clearing Spotlight's extension session destroys the
witness. Arcify may reenroll only from its own still-valid session. Full browser
restart, loss of both extension sessions before reenrollment, old/missing peers,
or revoked/stale evidence do not recover live identity. Unsupported unobserved
old-build downgrade/re-upgrade interludes cannot be proved safe and are explicitly
unsupported. No URL/title/order matching is used.

Paired mocked verification from the Arcify checkout:
`node scripts/check-favorite-witness-pair.mjs <spotlight-checkout>`. This exercises
the real adapter, receiver and transport code with mocked Chrome APIs; it is not
browser/native-keyboard evidence. Arcify's `docs/favorite-continuity.md` documents
the complete commit ordering, provisional recovery receipts and lifecycle limits.

## Optional context actions

See [Space actions](SPACE-ACTIONS.md) for the initial settings/folder/Pin/Remove
slice, exact-identity protocol contract, confirmation behavior, and test limits.

See [Archive actions](ARCHIVE-ACTIONS.md) for optional native Archive opening and
exact archived-entry reopening, one-shot identity, partial warnings, and test limits.
