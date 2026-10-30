# Fork backlog

These are fork considerations with individual implementation status, separate from the inherited
[upstream roadmap](../.planning/ROADMAP.md). An entry alone does not imply an implemented feature,
a scheduled milestone, or a commitment to ship. See the [pairing guide](ARCIFY-BRIDGE.md)
for current behavior.

## B-001: Improve bookmark-only discovery without pairing

**Status: Implemented for draft PR review; not released.** Recorded 2026-10-12.

See [saved-bookmark fallback](BOOKMARK-FALLBACK.md) for behavior and limits.
The original proposal below is retained as rationale.

### Why consider it?

The shared Chrome `Arcify` bookmark folder contains saved space names, nested
folders, bookmark titles, and URLs. It could support a more useful read-only
Spotlight fallback when the companion is not paired. The current upstream-derived
fallback is incomplete: its URL metadata cache reads that folder, but dedicated
pin enumeration additionally depends on a matching `spaces` array in Spotlight's
own isolated local storage. URL-based caching/deduplication can also collapse
distinct saved pins with the same URL.

Improving this would make saved links easier to find without requiring a live
Arcify connection. It would **not replace pairing**: bookmark folders do not provide
Arcify's current per-window active space, temporary-tab membership/order, or the
exact binding between a saved bookmark and a live tab. They cannot supply reliable
workspace switching or workspace-sensitive action routing, especially with native
tab-group sync disabled.

### Possible scope, if separately selected for implementation

- Enumerate saved links directly from the Arcify bookmark tree without requiring
  Spotlight-local `spaces` data. Keep nested-folder and bookmark identities.
- Preserve distinct bookmark nodes with equal URLs, including across spaces.
- Label folder-derived context as saved-bookmark information; do not present it as
  authoritative live workspace state. Do not invent colors or active-space status.
- Define informational handling for empty folders without implying that selecting
  one can switch Arcify's active workspace.
- Use ordinary standalone link navigation where appropriate, with explicit limits;
  do not claim it reuses the correct live pin or opens in a selected Arcify space.
- Keep the paired provider authoritative whenever pairing is configured. A failed,
  timed-out, or unauthorized paired action must not silently fall back to native
  navigation or be retried through this discovery path.

### Candidate acceptance checks

These are review criteria for a future proposal, not promises of current behavior:

1. With no paired ID and no Spotlight-local `spaces`, saved links can be found in
   direct and nested space folders, including closed pins and equal-URL siblings.
2. Rename, move, deletion, imports, missing/ambiguous Arcify roots, and unavailable
   bookmark access produce accurate refreshed results or a clear limitation.
3. Results distinguish inferred folder labels from actual workspace state; there
   is no fake active space, empty-space switch, or live-pin identity guarantee.
4. Standalone tabs, bookmarks, history, autocomplete, and ordinary navigation retain
   their behavior. Group sync on/off does not change saved-bookmark discovery.
5. Paired mode keeps fresh snapshots, exact identities, window isolation, and
   fail-closed mutation routing. No shared workspace copy or automatic trust is added.

The implementation adds no protocol changes or permissions. Installed builds remain unchanged until separately approved.
