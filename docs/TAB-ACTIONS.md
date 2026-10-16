# Exact current-tab actions

Spotlight negotiates the independent `tabActionsV1` capability with Arcify. Older
peers keep ordinary search and existing Space actions. Only read-only hello may
fall back on an explicit `INVALID_REQUEST`; no mutation is retried or sent through
native browser APIs when Arcify rejects it.

## Offered commands

- Rename current Today tab: an exact-ID local alias; a blank name restores the
  page title. Rename saved Space pin: the exact saved bookmark title, including
  linked live displays. Saved names must be nonblank, at most 256 characters.
- Edit saved pin URL: update the exact saved bookmark URL, preserve its title,
  and do not navigate its live page. Complete `http`, `https`, `file`, `chrome`
  URLs and `about:blank` are accepted, with no whitespace/control characters.
  The prompt canonicalizes the entered URL (for example, host casing and the
  trailing slash) before dispatch; the result must acknowledge that exact URL.
- Duplicate current Today tab: create a separate Today identity in that Space.
  Saved pins do not offer Duplicate.
- Copy current link: copy the live page URL, even if the pin's saved URL differs.
  Arcify's existing clipboard/offscreen path must acknowledge the exact text.
- Mute/unmute current tab: set the explicitly displayed opposite state on the
  exact live source; this is not an unguarded toggle.

Global Favorites, helper pages, provisional/recovery tabs, ambiguous ownership,
native split tabs, and unsafe/stale sources expose no tab actions. There is no
previous-tab or last-focused-window fallback. This slice does not add Archive,
Split, Favorite editing, permissions, or a separate clipboard transport.

## Prompts and input

Rename and URL editing use cancellable inline dialogs. Escape/Cancel restores
the Spotlight query and focus. Tab/Shift-Tab is trapped in the dialog. A trusted
click or fresh non-composing Enter is required; repeat, synthetic, Ctrl/Meta/Alt-modified, and
IME events cannot commit. The query uses the existing bounded fuzzy command
matcher and action-first ranking. Refreshes preserve manual result selection;
changed context clears selection rather than retargeting a later Enter.

The helper New Tab page may host the palette, but it cannot pick a prior content
tab. This means tab actions are intentionally absent when the helper itself is
the browser-attested source.

## Wire contract

Read command: `tabActionContext`, with exact `windowId`, `tabId`, and supported
features `[globalFavoritesV1, tabActionsV1]`. Successful response adds
`extensionId`, `snapshot`, and `tabActionContext`.

Context is `{windowId,spaceId,bookmarkFolderId,pairingGeneration,sourceTabId,tab}`.
`tab` is null or `{id,url,title,section,bookmark,alias,muted}`; section is `today`
or `saved`, bookmark is null or `{id,parentId,title,url}`, alias is the raw Today
override (empty for saved pins), and muted is boolean. This leaves the earlier
`spaceActionsV1` context unchanged. Unknown fields and conflicting snapshot
identities are rejected.

Commands and exact success fields (in addition to bridge envelope/snapshot):

- `renameCurrentTab {context,title}` → `{tabId,bookmarkId:null|string,title}`
- `editCurrentPinUrl {context,url}` → `{tabId,bookmarkId:string,url}`
- `duplicateCurrentTab {context}` → `{tabId}`, distinct from the source
- `copyCurrentLink {context}` → `{tabId,copied:true,url}` matching the live URL
- `setCurrentTabMuted {context,muted}` → `{tabId,muted}` matching requested state

Background authenticates browser-attested source tab/window, checks local pairing
before and after every call, re-reads capability/context before a write, and
compares every captured field. Arcify validates its fresh pairing, source, Space,
bookmark and binding again at execution and guards each write. The one-shot
request journal protects duplicate request IDs across worker restarts. Uncertain
or partially committed results are surfaced without automatic retries. Clipboard
success is shown only after affirmative exact-text acknowledgement.

## Verification

Run `npm test` and `npm run build`. Module and DOM regressions cover the real
new-tab and isolated-overlay paths, cancellation and synthetic input, fresh
context validation, same-URL distinct IDs, explicit mute state, malformed ACKs,
unsupported capability, pairing changes, and no native navigation fallback.
Paired real-browser acceptance is a separate parent-owned stage; unit/DOM tests
do not claim native clipboard or browser event ordering acceptance.
