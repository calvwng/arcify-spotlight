# Open a link in Little Arc

Pair Spotlight with an Arcify build that advertises `transientWindowsV1`.

- Type a complete `https://` or `http://` URL. Ordinary navigation remains the first result. Choose the separate **Open link in Little Arc** result to open the link in a temporary window and choose a Space later.
- Alternatively, type `little arc https://example.com/` and choose the matching action.
- The source tab stays open. This command does not move the current tab, select a destination Space, or install an operating-system or browser context-menu integration.
- Incomplete addresses, non-HTTP(S) schemes, embedded credentials, whitespace, and backslashes are not accepted by this action. Normal Spotlight search/navigation continues to work as before.
- If Arcify does not confirm success, check for an existing temporary window before trying again. Spotlight never retries the mutation or falls back to ordinary tab creation. Reopen Spotlight if its source, pairing, or context changed.

## First-version restart behavior

The action shows this warning before launch: **After restart: no control tab → ordinary tabs**. The adjacent Little Arc control tab keeps the full warning visible.

After a browser restart or extension reload/update clears session state, pages in a window with the exact Little Arc control tab stay outside Spaces until the user explicitly selects a live page and then moves it. If the control tab is missing, navigated away, or the page restores in another window, temporary status cannot be preserved: that page behaves like an ordinary restored tab. There is no startup recovery prompt, URL-based guessing, automatic movement, recreation, or closure.

Closing the controller during the same browser session does not immediately make its surviving pages ordinary. Exact in-session quarantine remains until session state is cleared or the page is explicitly moved through a valid controller.

## Compatibility and authority

The protocol stays at v1. `openTransient` adds only the `url` payload field; the existing `supportedFeatures` contract remains unchanged. Only read-only hello negotiation may retry. Older companions simply do not expose this result.

The background checks the browser-attested source or the exact owned new-tab helper, its active tab and focused window, current pairing generation, current origin Space, and a one-use context. Captured contexts retire on relevant native changes or pairing changes. A restart retires in-memory contexts. The actual `openTransient` mutation is serialized with other bridge actions and dispatched once. Responses must identify a distinct tab and temporary window and include the origin-window snapshot.

## Verification

Run `npm test` and `npm run build`. Focused coverage is in `test/unit/arcify-transient-actions*.test.js` and `test/integration/transient-actions-*-dom.test.js`. It covers URL policy, old-peer hiding, helper attestation, stale context/pairing (including ABA), duplicate submission, uncertain timeouts, malformed acknowledgements, real overlay/newtab disposal, trusted gestures, and unchanged ordinary URL navigation.
