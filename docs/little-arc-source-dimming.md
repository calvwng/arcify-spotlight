# Optional source-page dimming

Enable **Dim the source page while its Little Arc window is focused** in Spotlight's Shift-click settings. It is off by default and applies only to successfully acknowledged Shift-click/Peek → Little Arc launches. Context-menu, Spotlight search, and other opening routes are unchanged.

Only the verified source document is dimmed. The overlay is decorative, static, hidden from assistive technology, and ignores pointer input. It does not change page focus, keyboard navigation, accessibility state, or browser focus. Static rendering also respects reduced-motion preferences without an animation.

Returning to the source, interacting with it, switching focus away from the Little Arc window, closing either associated window/tab, navigation/loading in either associated tab, changing pairing/settings, or losing the cosmetic connection ends dimming for that launch. It does not automatically reappear when refocusing Little Arc. The conservative loading cleanup can also end dimming when a subframe starts loading. This affects appearance only. A new successful launch can start a new dim.

A dedicated cosmetic connection renews a four-second lease, with a ten-minute absolute cap. Worker suspension, invalidated extension context, disconnection, or stalled communication fails to an undimmed page. Unsupported pages and unavailable receivers simply skip dimming. No new permissions are requested.

The cosmetic state retains only source tab/window/URL/document identity, confirmed destination tab/window identity, pairing generation, and a random cosmetic lease identifier. It carries no launch connection, operation, placement authorization, or replayable action. Exact documentId and frame-zero messaging and browser-owned sender metadata constrain the isolated receiver. Multiple source pages have independent leases; a replacement lease cannot be cleared by callbacks from its predecessor.

Native multi-window focus behavior and source-page appearance require later manual browser acceptance. Unit tests do not prove operating-system focus delivery timing.

Switching the active tab in Little Arc also ends dimming, including switching to its trusted window-size controls. The cosmetic association does not discover or grant authority to additional controller tabs.
