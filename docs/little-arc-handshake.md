# Little Arc handshake document identity

Chrome can retain a content script's original URL in a newly opened Port after
same-document navigation. A new Little Arc hello therefore takes its URL from
`tabs.get`, not `Port.sender.url` or a page message.

Before binding that URL, the worker sends its existing read-only isolated-content
probe using both `documentId` and `frameId: 0`. Chrome must route the message to
the same top-level document that opened the Port. The returned URL corroborates
the browser tab URL; it does not supply or replace it. The worker checks the
same-origin relationship, pairing generation, protocol version, native tab and
window identity, privacy/window type, pending navigation and Port liveness.
These checks bracket the bounded probe waits and capability request. A second
exact-document probe is required before readiness is published.

The source is established only during hello. Navigation still invalidates an
existing session. Every opening action retains exact-document routing and live
proof; no action is replayed or rebound to a replacement document. A read-only
ready reply is not opening authority. The content-side pending-click deadline,
link revalidation and cancellation behavior are unchanged.

No manifest permissions are added. Missing browser document IDs or unsupported
exact routing fail closed, with no frame-only fallback. This requires the Chrome
106+ document-targeted messaging API (or equivalent support in the browser).
The worker and content script must both be available; no automatic extension or
page reload is performed.

Regression coverage includes stale sender URLs, refresh, same-URL replacement,
wrong frame/window/tab/origin, privacy, pairing and navigation races, missing
receivers, bounded probe failure and failed capability negotiation. Hosted
synthetic Chrome evidence demonstrates the browser metadata mismatch and checks
the candidate handshake; it does not establish the original Helium/YouTube
incident or qualify a full video launch/install.
