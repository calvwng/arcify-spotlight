import { isTransientUrl, PEER_KEY, PAIRING_GENERATION_KEY } from './arcify-bridge-protocol.js';
// Keep protocol constants here: the content bundle must not install the worker broker.
const ENABLED = 'peekEnabled', IFRAME = 'peekIframeEnabled', PORT = 'arcify-peek-top-v1';

export function eligiblePeekLink(event, document, window) {
    if (!event.isTrusted || event.defaultPrevented || event.button !== 0 || !event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.detail < 1
        || window.top !== window || !isTransientUrl(window.location.href) || document.visibilityState !== 'visible' || !document.hasFocus() || document.fullscreenElement || document.prerendering) return null;
    const path = event.composedPath();
    if (path.some(node => node?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(node?.tagName))) return null;
    const link = path.find(node => node?.tagName === 'A' && node.namespaceURI === 'http://www.w3.org/1999/xhtml');
    if (!link?.isConnected || link.ownerDocument !== document || link.hasAttribute('download') || link.getAttribute('aria-disabled') === 'true'
        || link.target && !['_self', '_blank'].includes(link.target.toLowerCase()) || !isTransientUrl(link.href)) return null;
    return { link, url: link.href };
}

/** Only isolated-world closures handle controls; no page message receiver or DOM credential. */
export function installPeekContent({ api = chrome, document = globalThis.document, window = globalThis.window } = {}) {
    if (window.top !== window || !isTransientUrl(window.location.href)) return { dispose() {} };
    if (window.__arcifyPeek) return window.__arcifyPeek;
    let disposed = false, enabled = false, ready = false, port = null, host = null, dialog = null, shadow = null, preview = null;
    let expand = null, fallback = null, closeButton = null, status = null, address = null, observer = null, previousFocus = null, previewNonce = null, selected = null;
    let action = null, opening = false, failed = false, sourceUrl = window.location.href, revision = 0;
    let heartbeat = null, warmups = 0, completionObserved = false, iframeEnabled = false, connecting = false, direct = false, reconnectRequested = false;
    let pending = null, pendingTimer = null, notice = null, noticeTimer = null;
    const clearPending = () => { pending = null; clearTimeout(pendingTimer); pendingTimer = null; };
    const clearNotice = () => { notice?.remove(); notice = null; clearTimeout(noticeTimer); noticeTimer = null; };
    const announce = text => {
        clearNotice(); if (!document.body) return;
        notice = document.createElement('div'); notice.id = 'arcify-shift-link-status';
        notice.setAttribute('style', 'all:initial!important;position:fixed!important;bottom:24px!important;left:24px!important;z-index:2147483647!important;display:block!important;visibility:visible!important;opacity:1!important;');
        const root = notice.attachShadow({ mode: 'closed' }), label = document.createElement('p'); label.id = 'shift-link-status-text'; label.setAttribute('role', 'status');
        label.style.cssText = 'font:14px system-ui;background:#202127;color:white;padding:16px;border-radius:12px;max-width:440px;box-shadow:0 4px 24px #0006'; label.textContent = text;
        root.append(label); document.body.append(notice); noticeTimer = setTimeout(clearNotice, 6000);
    };
    const cancelPending = message => { const had = !!pending; clearPending(); if (had && message) announce(message); };
    const stopHeartbeat = () => { if (heartbeat !== null) { clearInterval(heartbeat); heartbeat = null; } };
    const send = value => { try { if (!port) throw Error(); port.postMessage(value); } catch { error(); } };
    const controls = () => { if (expand) expand.disabled = fallback.disabled = opening || !!action || failed; };
    const error = () => { stopHeartbeat(); ready = false; failed = true; cancelPending('Little Arc connection unavailable. Nothing was opened. Try Shift-click again, or use the Little Arc context menu.'); controls(); if (status) status.textContent = completionObserved
        ? 'The selected page already opened successfully. Confirmation cleanup was not confirmed. Check its destination; do not open another copy to retry. Close is available.'
        : action ? 'Could not confirm completion. Check existing Little Arc controls and your windows. An uncertain action blocks this link for this browser session. Close is still available. Nothing was retried.'
        : 'Link opening is unavailable. No opening action was sent from this preview. Check existing Little Arc controls; an earlier unconfirmed action may hold this link. Close is available.'; };
    const detach = () => {
        stopHeartbeat();
        observer?.disconnect(); observer = null;
        try { dialog?.close(); } catch {}
        host?.remove(); host = dialog = shadow = preview = expand = fallback = closeButton = status = address = null; previewNonce = selected = null;
        opening = false; action = null; failed = false; completionObserved = false; direct = false;
    };
    const disconnect = () => { const old = port; port = null; ready = false; try { old?.disconnect(); } catch {} };
    const presentation = (focus = false) => {
        try {
            if (!host?.isConnected || !dialog?.open || (!direct && !preview?.isConnected) || window.location.href !== sourceUrl || document.fullscreenElement || document.prerendering || document.visibilityState !== 'visible' || focus && !document.hasFocus()) return false;
            const box = dialog.getBoundingClientRect(), style = window.getComputedStyle(host), ds = window.getComputedStyle(dialog);
            if (box.width < 280 || box.height < 180 || box.left < 0 || box.top < 0 || box.right > window.innerWidth || box.bottom > window.innerHeight
                || style.visibility !== 'visible' || Number(style.opacity) !== 1 || ds.visibility !== 'visible' || Number(ds.opacity) !== 1) return false;
            return (direct ? [closeButton] : [expand, fallback, closeButton]).every(button => { const r = button.getBoundingClientRect(); return r.width > 0 && r.height > 0 && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === host; });
        } catch { return false; }
    };
    // Expected native window creation/movement hides the originating document.
    // Once a trusted action was admitted, retain identity/liveness checks without
    // requiring its old page to remain foreground. No new action uses this proof.
    const operationLive = () => !!(host?.isConnected && dialog?.open && (direct || preview?.isConnected) && port && !failed && action
        && window.location.href === sourceUrl && !document.fullscreenElement && !document.prerendering);
    const dismiss = (restore = true, reconnect = true) => {
        if (port) send({ kind: 'close' }); disconnect(); detach();
        if (restore && previousFocus?.isConnected && previousFocus.ownerDocument === document && window.location.href === sourceUrl) try { previousFocus.focus({ preventScroll: true }); } catch {}
        previousFocus = null;
        if (reconnect && !disposed) void connect();
    };
    const act = (event, kind, button) => {
        if (!event.isTrusted || event.button !== 0 || !event.composedPath().includes(button) || opening || action || failed || !presentation(true)) return;
        event.preventDefault(); event.stopPropagation();
        stopHeartbeat(); action = kind; controls(); status.textContent = 'Checking the current preview URL. Closing Peek cannot undo an action already sent; it may finish after closing. Check your windows if uncertain.';
        send({ kind });
    };
    function mount(url) {
        if (!document.body || !window.HTMLDialogElement || host) throw Error('Peek dialog unavailable.');
        host = document.createElement('div'); host.id = 'arcify-peek-host';
        host.setAttribute('style', 'all:initial!important;display:block!important;position:fixed!important;inset:0!important;visibility:visible!important;opacity:1!important;pointer-events:none!important;z-index:2147483647!important;');
        shadow = host.attachShadow({ mode: 'closed' });
        const style = document.createElement('style');
        style.textContent = ':host{all:initial!important}dialog{box-sizing:border-box;position:fixed;inset:0;margin:auto;width:min(1100px,94vw);height:min(850px,90vh);max-width:94vw;max-height:90vh;border:1px solid #74747b;border-radius:16px;padding:0;overflow:hidden;background:#f8f8fa;color:#1b1b20;box-shadow:0 16px 70px #0007;font:14px system-ui;pointer-events:auto;display:flex;flex-direction:column}dialog:not([open]){display:none}dialog::backdrop{background:#17172188}header{display:flex;align-items:center;gap:8px;padding:12px 16px;flex-wrap:wrap}strong{margin-right:auto;font-size:17px}button{font:inherit;cursor:pointer;padding:8px 12px;border-radius:8px;border:1px solid #8c8c98;background:white;color:#16161d}button:focus-visible{outline:3px solid #4e59c9;outline-offset:2px}button:disabled{opacity:.55;cursor:default}#peek-expand{background:#414bb4;color:white}p{margin:0;padding:0 16px 10px;font-size:12px;line-height:1.45}#peek-url{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#peek-status{padding-top:8px}iframe{display:block;border:0;width:100%;flex:1;min-height:100px;background:white}footer{padding:10px 16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}footer span{font-size:12px;flex:1;min-width:180px}@media(prefers-color-scheme:dark){dialog{background:#202127;color:#efeff5}button{background:#303139;color:#fff;border-color:#777986}}';
        if (direct) style.textContent += 'dialog{width:min(540px,94vw);height:240px}';
        dialog = document.createElement('dialog'); dialog.id = 'arcify-peek-dialog'; dialog.setAttribute('aria-label', direct ? 'Opening Little Arc' : 'Peek preview');
        const header = document.createElement('header'), title = document.createElement('strong'); title.textContent = direct ? 'Little Arc' : 'Peek';
        expand = document.createElement('button'); expand.id = 'peek-expand'; expand.textContent = 'Open in current Space'; expand.type = 'button';
        closeButton = document.createElement('button'); closeButton.id = 'peek-close'; closeButton.textContent = direct ? 'Close Little Arc status' : 'Close Peek'; closeButton.type = 'button';
        if (direct) header.append(title, closeButton); else header.append(title, expand, closeButton);
        address = document.createElement('p'); address.id = 'peek-url'; address.textContent = direct ? url : `Original link (current preview URL unavailable): ${url}`;
        const disclosure = document.createElement('p'); disclosure.textContent = direct ? 'Opening one real browser page in Little Arc. Use its header to place that same page in a Space. Closing this status cannot undo an action already sent.' : 'Both actions open the verified current preview URL anew, or the original link when it is unavailable. Forms, JavaScript state, history and sign-in state cannot be transferred.';
        if (!direct) {
        preview = document.createElement('iframe'); preview.id = 'peek-preview'; preview.title = 'Isolated Peek preview';
        // The extension-owned wrapper contains an opaque-sandbox website child.
        // It has no opening authority and receives no source URL or referrer.
        preview.setAttribute('referrerpolicy', 'no-referrer');
        preview.setAttribute('allow', "autoplay 'none'; camera 'none'; microphone 'none'; geolocation 'none'; fullscreen 'none'; payment 'none'");
        // Loading/error events never grant authority or open a native page.
        preview.addEventListener('load', () => {
            if (previewNonce) preview.contentWindow.postMessage({ kind: 'peekWrapperBootstrap', nonce: previewNonce }, `chrome-extension://${api.runtime.id}`);
            if (!action && !failed && status) status.textContent = 'Preview may be blocked or incomplete. Open in Little Arc is always available.';
        });
        preview.addEventListener('error', () => { if (!action && !failed && status) status.textContent = 'Preview unavailable. Use Open in Little Arc.'; });
        }
        status = document.createElement('p'); status.id = 'peek-status'; status.setAttribute('role', 'status'); status.textContent = direct ? 'Opening Little Arc. Closing this status cannot undo an action already sent.' : 'Preparing preview.';
        const footer = document.createElement('footer'), hint = document.createElement('span'); hint.textContent = 'Some sites block embedding or need a normal tab to sign in.';
        fallback = document.createElement('button'); fallback.id = 'peek-fallback'; fallback.textContent = 'Open in Little Arc'; fallback.type = 'button'; footer.append(hint, fallback);
        if (direct) dialog.append(header, address, disclosure, status); else dialog.append(header, address, disclosure, preview, status, footer); shadow.append(style, dialog); document.body.append(host);
        expand.addEventListener('click', event => act(event, 'expand', expand)); fallback.addEventListener('click', event => act(event, 'fallback', fallback));
        closeButton.addEventListener('click', event => { if (event.isTrusted && event.composedPath().includes(closeButton)) { event.preventDefault(); dismiss(); } });
        dialog.addEventListener('cancel', event => { event.preventDefault(); if (event.isTrusted) dismiss(); });
        dialog.addEventListener('close', () => { if (host) dismiss(true, false); });
        dialog.showModal(); closeButton.focus(); controls();
        // Start the iframe only after backend preparation confirms this immutable URL.
        if (window.MutationObserver) { observer = new window.MutationObserver(() => { if (host && (!host.isConnected || !dialog.open || window.location.href !== sourceUrl)) dismiss(false, false); }); observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'hidden', 'open'] }); }
    }
    async function connect() {
        if (disposed || connecting || port || host || !document.body || !window.HTMLDialogElement || !isTransientUrl(window.location.href)) return;
        const version = ++revision; connecting = true;
        try {
            const values = await api.storage.local.get([ENABLED, IFRAME]); enabled = values[ENABLED] === true; iframeEnabled = values[IFRAME] === true;
            if (disposed || version !== revision || !enabled || port || host) return;
            sourceUrl = window.location.href;
            const current = api.runtime.connect({ name: PORT }); port = current;
            current.onDisconnect.addListener(() => { void api.runtime.lastError; if (port === current) { port = null; ready = false; if (host || pending) error(); } });
            current.onMessage.addListener(message => {
                if (port !== current || disposed) return;
                if (message?.kind === 'ready' && !host) { ready = true; failed = false; warmups = 0; if (pending) launchPending(); }
                else if (message?.kind === 'show' && host && opening && isTransientUrl(message.url)) {
                    opening = false; previewNonce = message.nonce; preview.src = api.runtime.getURL('peek-wrapper.html'); status.textContent = 'Preview may be blocked or incomplete. Open in Little Arc is always available.'; controls();
                    stopHeartbeat(); heartbeat = setInterval(() => { if (host && !action && !failed && !opening) send({ kind: 'pulse' }); }, 15000);
                }
                else if (['preview-url', 'selected-url'].includes(message?.kind) && host && isTransientUrl(message.url)) {
                    address.textContent = `${message.known === true ? 'Current preview URL' : 'Original link (current preview URL unavailable)'}: ${message.url}`;
                    if (message.kind === 'selected-url' && action) {
                        selected = { url: message.url, mode: message.known === true ? 'current' : 'original' };
                        status.textContent = `Opening ${message.known === true ? 'the verified current preview URL' : 'the original link because the current preview URL is unavailable'} in ${action === 'expand' ? 'your current Space' : 'Little Arc'}. Closing cannot undo an action already sent.`;
                    }
                }
                else if (message?.kind === 'completed' && action === message.action && !completionObserved) { completionObserved = true; status.textContent = 'Selected page opened successfully. Finishing confirmation.'; send({ kind: 'acknowledge' }); }
                else if (message?.kind === 'acknowledged' && action) dismiss(false);
                else if (message?.kind === 'error') error();
            }); current.postMessage({ kind: 'hello' });
        } catch (error) {
            ready = false;
            const invalidated = /extension context invalidated/i.test(String(error?.message || error));
            cancelPending(invalidated
                ? 'The extension was updated. Reload this page once, or use the Little Arc link context menu. Nothing was opened.'
                : 'Little Arc connection unavailable. Nothing was opened. Try Shift-click again.');
        }
        finally { connecting = false; if (reconnectRequested && !disposed) { reconnectRequested = false; void connect(); } }
    }
    const launchPending = () => {
        const intent = pending; clearPending();
        if (!intent) return;
        if (!ready || !port || host || !enabled || intent.iframe !== iframeEnabled || Date.now() > intent.deadline
            || window.location.href !== intent.source || !intent.link.isConnected || intent.link.ownerDocument !== document || intent.link.href !== intent.url
            || intent.link.hasAttribute('download') || intent.link.getAttribute('aria-disabled') === 'true'
            || intent.link.target && !['_self', '_blank'].includes(intent.link.target.toLowerCase())
            || document.visibilityState !== 'visible' || !document.hasFocus() || document.fullscreenElement || document.prerendering) {
            announce('Link opening canceled because the page or link changed. Shift-click again when ready.'); return;
        }
        for (let node = intent.link; node; node = node.parentElement) if (node.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(node.tagName)) { announce('Link opening canceled because the link changed. Shift-click again.'); return; }
        clearNotice(); previousFocus = intent.link; sourceUrl = intent.source; direct = !iframeEnabled;
        opening = !direct; action = direct ? 'fallback' : null; selected = direct ? { mode: 'original', url: intent.url } : null; failed = false;
        try { mount(intent.url); } catch { detach(); announce('Little Arc status is unavailable on this page. Use the Little Arc context menu.'); return; }
        ready = false; send({ kind: direct ? 'launch' : 'open', url: intent.url });
    };
    const click = event => {
        if (!enabled || !document.body || !window.HTMLDialogElement) return;
        const intent = eligiblePeekLink(event, document, window); if (!intent) return;
        // Suppress native Shift-click before any await, including a cold handshake.
        event.preventDefault(); event.stopImmediatePropagation();
        if (host || pending) return;
        pending = { ...intent, source: window.location.href, iframe: iframeEnabled, deadline: Date.now() + 2500 };
        if (ready && port) { launchPending(); return; }
        announce('Connecting to Little Arc… Keep this page focused.');
        pendingTimer = setTimeout(() => { cancelPending('Little Arc is not ready. Nothing was opened. Try Shift-click again, or use the Little Arc context menu.'); if (!host && !ready) disconnect(); }, 2500);
        warmups = 0; void connect();
    };
    const probe = (message, sender, respond) => {
        if (message?.type === 'arcifyPeekLiveProbe' && sender.id === api.runtime.id && !sender.tab) respond({ url: window.location.href, live: operationLive(), safe: presentation(true), action, selected });
    };
    const requestConnect = () => { if (connecting) reconnectRequested = true; else void connect(); };
    const changed = (changes, area) => { if (area === 'local' && [ENABLED, IFRAME, PEER_KEY, PAIRING_GENERATION_KEY].some(k => Object.hasOwn(changes, k))) { revision++; cancelPending('Link opening canceled because settings changed. Shift-click again.'); disconnect(); detach(); requestConnect(); } };
    const pagehide = () => { revision++; reconnectRequested = false; clearPending(); clearNotice(); disconnect(); detach(); };
    // beforeunload on the top Window does not bubble from the preview iframe.
    // This also retires same-URL reloads before document replacement. A cancelled
    // navigation can warm fresh read-only capability on a later real gesture.
    const beforeunload = event => { if (event.isTrusted) pagehide(); };
    const pageshow = () => { if (!disposed) requestConnect(); };
    const fullscreen = () => { if (document.fullscreenElement && host) dismiss(false, false); };
    const navigated = () => { if (window.location.href !== sourceUrl) { pagehide(); void connect(); } };
    // MV3 may suspend idle workers. A subsequent real pointer/focus gesture warms
    // read-only capability, with at most two failed attempts; never replays a Peek.
    const warmup = event => { if (event.isTrusted && enabled && !port && !host && !disposed && warmups < 2) { warmups++; void connect(); } };
    const lostFocus = () => { cancelPending('Link opening canceled because this page lost focus. Shift-click again when ready.'); };
    const visibility = () => { if (document.visibilityState !== 'visible') lostFocus(); };
    const readyDocument = () => { void connect(); };
    const dispose = () => {
        disposed = true; revision++; clearPending(); clearNotice(); disconnect(); detach(); document.removeEventListener('click', click, true); document.removeEventListener('DOMContentLoaded', readyDocument); document.removeEventListener('fullscreenchange', fullscreen);
        window.removeEventListener('pagehide', pagehide); window.removeEventListener('pageshow', pageshow); window.removeEventListener('popstate', navigated); window.removeEventListener('hashchange', navigated);
        window.removeEventListener('beforeunload', beforeunload); window.removeEventListener('blur', lostFocus); document.removeEventListener('visibilitychange', visibility);
        document.removeEventListener('pointerover', warmup, true); window.removeEventListener('focus', warmup);
        api.runtime.onMessage.removeListener(probe); api.storage.onChanged.removeListener(changed); delete window.__arcifyPeek;
    };
    document.addEventListener('click', click, true); document.addEventListener('DOMContentLoaded', readyDocument); document.addEventListener('fullscreenchange', fullscreen);
    window.addEventListener('pagehide', pagehide); window.addEventListener('pageshow', pageshow); window.addEventListener('popstate', navigated); window.addEventListener('hashchange', navigated);
    window.addEventListener('beforeunload', beforeunload); window.addEventListener('blur', lostFocus); document.addEventListener('visibilitychange', visibility);
    document.addEventListener('pointerover', warmup, true); window.addEventListener('focus', warmup);
    api.runtime.onMessage.addListener(probe); api.storage.onChanged.addListener(changed);
    window.__arcifyPeek = { dispose }; void connect(); return window.__arcifyPeek;
}
