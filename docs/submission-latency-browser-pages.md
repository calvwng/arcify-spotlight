# Search submission and explicit browser pages

Typing updates the primary URL/search result synchronously. A single 150 ms UI
debounce starts local ranking; autocomplete follows asynchronously. Enter and
click submit the currently selected result without waiting for either phase.
Existing result identities, manual selection, and stale-generation checks remain.

Once an ordinary result is admitted for submission, Spotlight cancels its pending
input debounce and increments the search generation. A ranking reply already in
flight cannot replace the submitted choice or start the autocomplete phase.
Ranking requested while submission is pending is skipped. A fresh input after a
failed submission starts discovery normally. Already dispatched bridge requests
are not canceled or replayed.

Paired new-tab searches used to fetch an unused initial snapshot, then call
`request('openTab')`, which performed a second authenticated hello. Ordinary URL
navigation had the same redundant read. Those paths now use the request's own
fresh handshake and snapshot validation. Owned tab, bookmark, Favorite, Space,
shared Today selections, and current-tab searches retain their initial snapshot.
Peer identity, pairing generation, serialized action dispatch, server request
journaling, and response validation are unchanged. Current-tab searches still
check the exact live source tab before one final `chrome.search.query` call.

## Timing evidence

The accompanying `submission-timing.mjs` runs the actual baseline and candidate
client, transport, validators, and action router against fake Chrome APIs. It
imposes 25 ms per external response and 5 ms for a live tab read, uses real timers,
and takes five samples per mode. The host's timer granularity adds overhead.
These are controlled API measurements, not native browser or network measurements.

| Search mode | Baseline commands | Candidate commands | Baseline median | Candidate median |
| --- | --- | --- | ---: | ---: |
| New tab | hello, hello, openTab | hello, openTab | 93.57 ms | 61.74 ms |
| Current tab | hello | hello | 47.58 ms | 47.20 ms |

The deterministic fake-timer regression imposes the same 25 ms response delay and
checks new-tab search dispatch at 50 ms, after one hello and one mutation. It
also checks that a pairing change during the handshake prevents dispatch.
Actual overlay/new-tab DOM tests verify no queued 150 ms ranking runs after
immediate Enter, no late ranking result repopulates the choice, and fresh input
works after rejection. Existing current-tab timeout, closed/moved tab, pairing,
and native search failure regressions continue to pass.

Native instrumentation should distinguish input-to-Enter, Enter-to-worker
receipt, worker-to-native API dispatch, and destination load. The baseline native
check opened `chrome://settings` successfully but rejected `helium://settings`;
the former failure was not reproduced. Native baseline/candidate timings and
acceptance evidence are recorded separately with the paired disposable-profile
harness. Neither the 150 ms suggestion debounce nor destination page network
loading should be reported as an unconditional submit delay.

## Browser-page navigation

An explicit supported browser-page address remains a URL result. It goes through
the existing `openTab`/`navigateTab` bridge commands when paired, and through
`chrome.tabs.create`/`chrome.tabs.update` when standalone. No browser page is
embedded or fetched. Browser-page input also skips network autocomplete.

The same exact allowlist is used on both sides of the bridge:

| Host | Allowed paths/query |
| --- | --- |
| settings | root, /appearance, /search, /searchEngines, /privacy, /security, /content, /languages, /downloads, /accessibility, /system, /help |
| history, downloads, extensions, version, newtab, new-tab-page | root only |
| bookmarks | root, optionally ?id= followed by 1–20 decimal digits for existing saved-folder results |

Root accepts a missing or single trailing slash. Other paths, fragments, general
queries, credentials, ports, whitespace, backslashes, encoded host/path ambiguity,
and command-like endpoints including quit, restart, crash, hang, flags, reset and
clearBrowserData are rejected before dispatch. JavaScript, data, and arbitrary
extension URLs remain excluded from URL navigation. Existing live tabs can still
be activated by their validated tab identity.

Both `chrome://` and `helium://` use this boundary. Valid Helium input in an
ordinary URL result is canonicalized to `chrome://` before tab dispatch.
Arcify also canonicalizes ordinary openTab/navigateTab URLs at native dispatch,
covering peers that supply a raw alias. Supplemental Helium 156 testing showed
that raw alias updates can drop a settings subpath. Closed Arcify-owned saved
Helium bookmarks with a path or query therefore fail with an explicit instruction
to use a canonical chrome address or enter the URL directly in Spotlight.
Root-only saved aliases retain their verified native opening. Live saved pins
still activate their exact bound tab without navigating. Stored bookmark URLs
and pin identities are not rewritten. Helium's
[upstream protocol patch](https://github.com/imputnet/helium/blob/main/patches/helium/core/override-chrome-protocol.patch)
registers the alias, maps it to Chromium WebUI during navigation, and displays
Chromium WebUI addresses with the Helium scheme. No new extension permission,
header override, or browser setting is required.
