# Little Arc destination theme and chooser dismissal

The header uses the selected destination Space tint resolved by Arcify's normal rules: validated custom tint, named palette override, then the default named color. It uses the same flat light/dark palette and contrast algorithm as the sidebar. Missing or invalid tints fall back safely; no CSS fragments, gradients, page-supplied themes or permissions are accepted. System appearance uses the verified top content connection's browser preference, avoiding the embedded frame's own color-scheme feedback. Explicit Light/Dark takes precedence. Metadata is read when choices are inspected/refreshed; choosing a different Space repaints without transferring the page.

Clicking outside the chooser closes it. A click in the header is handled within the extension document. A genuine top-page pointer event sends a dismissal-only notice through the existing authenticated top port, broker session and bound header frame. It cannot change selection, mint authorization or dispatch placement. No page `postMessage` commands are accepted. Early dismissal while binding is harmless. Escape still returns focus to the chooser button; clicking the page does not steal focus back.

Authenticated bounded numeric hit regions clip the frame's transparent surroundings so page clicks reach the page itself once, without synthetic click replay. Resize and passive coalesced scrolling update those regions. The iframe container and document share a validated light/dark scheme to preserve transparent corners. Critical status/error text retains readable panel contrast.

Limitations: clicks inside unrelated cross-origin child frames do not bubble into the top document, and a host page can interfere with event delivery or cover extension UI. This is a page-hosted overlay, not browser chrome. Escape and a header click remain available. Dismissal provides no new anti-clickjacking guarantee. Existing exact destination validation, one-use fresh placement authorization, duplicate suppression and uncertain-dispatch lock remain unchanged.

Validation records in the local candidate distinguish native synthetic-profile tests from unverified restart/interruption, BFCache/prerender, hostile presentation and media-history cases. Reload both paired extensions after delivery; do not uninstall or clear storage. Existing source pages may need one reload after extension-context invalidation.

## Destination Space icons

The Little Arc chooser shows a configured preset or single emoji beside the Space name, on a small background tinted by its destination. The glyph is decorative and hidden from assistive technology; the original name, keyboard selection and exact destination IDs are unchanged. Missing or malformed glyphs keep the existing colored dot.

Spotlight asks the already-paired Arcify worker for the icon-aware read-only inspection. It tries the legacy inspection only after that worker explicitly rejects the new action as unsupported, and remembers the fallback for the current header session. Transport, pairing or other validation failures do not trigger a downgrade or replay. The original inspection and placement protocol remain unchanged for older Spotlight.
