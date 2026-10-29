# Shared Today across windows

This candidate builds on Arcify 0995d9a plus the tested V4 recovery patch and Spotlight 3b0b178. It is an isolated candidate, not an installed or committed release.

A Space's Today list can show eligible live ordinary Today tabs from other normal windows in the same profile. A remote row identifies its owning window and offers **Open in owning window**. Opening validates the exact tab, native window, Space and backing bookmark folder, selects that Space in the owning window, activates the existing tab and focuses its window. Success requires native readback. The requesting window's selected Space remains independent.

Remote rows do not offer local multi-selection, drag, menus, edits or destructive actions. No transfer, URL reopening, duplicate creation or automatic restoration is performed. Stale ownership, moved/closed tabs, deleted/replaced Spaces and closed windows require a refreshed list. A failed acknowledgement can follow a partial focus operation; check the owning window before acting again. Requests are never automatically replayed.

Native pins, saved pins, Favorites, provisional/recovery candidates, private/popup windows, startup helpers and transient Little Arc pages are excluded. Remote native Split pages are conservatively excluded until separately supported and verified. Existing local controls and guarded recovery remain unchanged.

Spotlight negotiates optional `sharedTodayV1`. Its legacy window-local snapshot fields and actions retain their existing meaning. Shared rows use a separate identity descriptor, never an ordinary local tab-action scope. Older peers fall back through bounded read-only handshakes; mutations are not retried. Native/ownership/title/binding changes refresh subscribed readers without persistent polling or browsing data in notifications.

## Native acceptance still required

Use disposable test pages and two normal windows. Check shared visibility in the same/different Spaces, then open a remote row and confirm the same page and native tab remain in the owning window with no reload, duplicate or transfer. Confirm the source Space and local selection/scroll remain unchanged. Test remote closure, reassignment and a deleted destination before using stale rows. Confirm saved pins/Favorites/Split/Little Arc and recovery candidates do not acquire new remote actions. Browser restart and restored-tab continuity need separate acceptance; this feature does not fix Helium's native window restoration behavior.
