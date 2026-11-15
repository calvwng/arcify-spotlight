# Spotlight folder browsing

Type a folder name, partial name, or `open Areas` to discover saved bookmark folders at any depth. Typo-tolerant matching uses the existing Fuse search service. Results show their full ancestor path so identically named folders can be distinguished.

Selecting **Browse …** opens the folder inside Spotlight, not all its bookmarks. Choose a subfolder to descend, **Parent folder** to go up, or **Back to search** / Escape to return. Individual bookmarks open in a new tab in the source window. **Manage this folder in Bookmark Manager** is an explicit native management fallback.

Private contexts do not load folder data. Folder identity and bookmark membership are revalidated on each action; missing/moved entries produce an error instead of redirecting to a different target. No folder is automatically renamed, moved, or deleted by this browsing milestone.

Inline Arcify-owned management is a separate paired capability: it must preserve Space roots, nesting policy and linked live-pin ownership. Native manager fallback is not a claim that all management is available inside Spotlight.

Verification: unit/provider tests cover nested/empty/duplicate-name folders, partial/fuzzy matching, source-window targeting, private/foreign senders, stale membership, unsafe URLs, disposal and keyboard return. Native visual acceptance remains required when a browser executor is available.

## Paired inline management

With the matching Arcify `folderActionsV1` build, folders belonging to the currently selected Space offer **Create subfolder**, **Rename folder**, **Move folder to another Space**, and (only when empty) **Delete empty folder**. Forms capture the exact folder tree and current Space; the background rechecks that context and pairing before a mutation. Delete requires a separate confirmation with Cancel initially focused. Uncertain writes are not retried automatically. Space roots cannot be renamed or deleted here.

Arcify's existing nesting rules remain: at most two folder levels under a Space, and nested folders require native group sync to be disabled. Browsing/search itself remains able to discover deeper ordinary bookmark folders. Cross-Space moves use the existing saved-item ownership transaction, preserve linked pin identities, and leave the source Space selected. Moving folders to arbitrary other folders and recursively deleting nonempty folders are not exposed; use the explicit native manager fallback rather than silently applying raw recursive mutations.
