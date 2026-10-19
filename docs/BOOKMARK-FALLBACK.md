# Saved-bookmark discovery fallback (B-001)

Implemented for draft PR review on the `e2ffbe0` Spotlight baseline. No protocol or
manifest permissions change. Installed-build replacement and release are not
part of this work.

## Behavior

Without pairing, each search reads the current browser bookmark tree once. Exactly
one folder named `Arcify` enables saved-link and folder discovery at every depth,
without Spotlight-local `spaces`. Search matches titles, URLs and full saved paths. Selection also checks ancestor folder IDs, so same-named folder moves cannot evade freshness checks.
Rows say **Saved bookmarks: Arcify / ...**; they carry bookmark IDs, not Space IDs,
colors, active state, window membership, tab bindings or authoritative pin status.
Direct links below the root are supported as well as links inside saved folders.

A folder row opens a single `chrome://bookmarks/?id=...` bookmark-manager page using
the selected ordinary navigation mode. It never switches Spaces or opens its
contents as tabs. Empty folders work the same way. Link rows use ordinary standalone
URL navigation; they do not promise to reuse a live pin or target an Arcify Space.

Equal-URL saved nodes remain distinct by bookmark ID; repeat IDs are emitted once.
The matching exact instant URL row and ordinary bookmark/history/domain results already represented by saved rows are
suppressed. Live tabs remain independent destinations. Hierarchy appears in each
path; depth-first browser sibling order breaks equal-rank ties. Search relevance
still determines ranking; this is not a full bookmark browser.

Missing or multiple exact-title Arcify folders disable Arcify classification and
leave URLs searchable as ordinary bookmarks. The status says `missing` or
`ambiguous`; no root is guessed. Bookmark API failure says `unavailable` and other
sources remain usable. Production discovery writes no bookmarks. Browser fixtures create only synthetic bookmarks in a fresh temporary profile.

## Connection and freshness

Each ordinary refresh selects a new request-scoped provider. There is no persistent
fallback index and no dependency on the legacy URL cache. Create, rename, move,
remove, reorder and completed imports are reflected on the next search refresh.
Already displayed results do not automatically refresh for bookmark events; selecting
a saved row rereads the tree and rejects a changed path, kind, URL or missing ID.
A final pairing check rejects search results if the peer changed during the read.

Connected pairing remains authoritative. Missing transport, timeout or pending
approval enables clearly labelled saved-bookmark discovery. A new explicit fallback selection opens the current bookmark URL through ordinary
navigation, without Space routing. Selection rechecks availability and the exact
bookmark; a recovered peer requires a fresh paired search. This read-only check can
wait for the existing five-second bridge timeout. Invalid protocol/identity
responses remain errors. A scoped paired logical refresh never switches providers.
Old paired choices after disconnect and fallback choices after reconnect fail closed.
A fallback choice from a different pairing configuration is rejected until refreshed.
A failed paired action never enters native fallback or replays through this provider. A later explicit fallback selection is a new ordinary bookmark action; prior uncertain-action guidance remains visible.

## Validation and limits

See `fallback-tests.log`, `fallback-targeted.log`, `fallback-build.log` and
`LOCAL-REVIEW.md` in the isolated worktree for local execution evidence. Tests use
mocked Chrome APIs and synthetic bookmarks, including background action routing.
No personal browser or installed dist was used. Fixture-only browser acceptance uses a fresh temporary Chromium profile; see fallback-browser.log for its result.
Browser UI typing/keyboard acceptance is not established: an exploratory typing step
stalled and was excluded from the passing routing/navigation fixture. Mocked
keyboard selection regressions pass. Physical global shortcuts and full paired-browser
acceptance remain outside this fixture test. No private browser data was used.

Design choice for review: folder selection opens the browser's bookmark manager.
No input is required to review this version; a future in-Spotlight folder drilldown
would be a separate UX change. A configured unavailable connection permits discovery
and permits explicit ordinary bookmark URL navigation without changing workspace authority.
