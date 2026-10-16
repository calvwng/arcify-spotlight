# Overlay recovery after extension reload/update

Existing pages can keep an invalidated Spotlight content script after the extension
is reloaded or updated. Refreshing the page installs its normal dormant receiver,
but Spotlight now also repairs a missing receiver on its own keyboard command.

## Permissions and behavior

- `activeTab` grants Spotlight temporary access when its own browser keyboard command
  is invoked (defaults: Alt+T / Alt+L; users can remap them). `scripting` runs the
  extension's packaged `overlay.js` in the isolated main frame. No new host permission,
  page refresh, remote script, or persistent permission grant is added.
- Normal pages still use their existing dormant receiver first. Only Chrome's explicit
  “Receiving end does not exist” error permits one injection. The bundle stays dormant
  until a single ensure-open message targets the document ID returned by Chrome.
- The source tab/window/URL is captured before queueing. Navigation, including a
  same-URL reload, tab replacement/removal/move, or switching the active source cancels
  recovery. Identity is checked across awaited work; the receiving page also verifies
  the expected URL before showing a modal. After asynchronous initialization, a
  short-lived request token asks the worker for one final read-only source check;
  browser-attested sender metadata must match the injected main-frame document.
  No await separates that confirmation/draft snapshot from modal replacement. Navigation between the final check and
  script execution remains browser-mediated: an injected receiver stays dormant, and
  activation is constrained to the returned document, never broadcast to a later one.
- Paired Arcify launches and internal messages may use an existing receiver or the
  helper page. They cannot supply Spotlight's `activeTab` user invocation, so they do
  not trigger reinjection. Calling a worker handler or sending CDP key events is not
  evidence that the browser granted `activeTab`.
- Browser/extension pages, file/data/blob pages, and web-store pages are not recovery
  targets. Document-targeted recovery requires Chrome 106 or newer; if the browser
  cannot return a document ID, Spotlight keeps the helper fallback. Browser policy may deny other pages (including some document viewers).
  A definitive unavailable/denied recovery keeps the normal helper-page fallback.
- Delivery and injection waits are bounded. A timeout, closed response channel, or
  other uncertain delivery does not justify another injection/open or a helper that
  could close an already-open draft. A later deliberate keyboard invocation can try
  again. An observed navigation cancels the old command entirely.

## Updating and drafts

Build and load `dist`, then reload/update Spotlight through the browser's extension
manager; accept any permission prompt the browser requires. Existing ordinary pages
normally recover on the next Spotlight keyboard command. No page is automatically
refreshed. An existing live receiver is reused without duplicate dialogs/listeners.

New-version orphan overlays carry an extension-owner marker. Recovery retains their
input text and selection until the replacement dialog opens successfully; failed
replacement leaves the old draft intact. A first upgrade from an older build can leave
an unmarked overlay already open. Spotlight cannot safely prove that surface's
ownership, so it leaves it untouched and uses a helper instead. Copy any needed draft
before manually refreshing that page. Closed/dormant old pages have no such surface
and can recover immediately.

The separate iframe input document, ordinary shortcut toggle behavior, standalone
search, and direct trusted sidebar-command gesture are unchanged. Local regressions
exercise the real background/overlay modules with mocked browser boundaries. Native
keyboard-command dispatch and extension reload in a real browser are separate hosted
CI acceptance checks; a unit test calling the command listener is not that proof.
