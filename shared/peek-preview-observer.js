const uuid = s => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));

/** Inert outside an immediate extension ancestor. No DOM reads, page listeners,
 * history patching, network requests or URL reports from ordinary subframes. */
export function installPeekPreviewObserver({ api = chrome, window = globalThis.window, document = globalThis.document } = {}) {
    const origin = `chrome-extension://${api.runtime.id}`;
    if (window.parent === window || window.location.ancestorOrigins?.[0] !== origin || !/^https?:$/.test(window.location.protocol)) return { dispose() {} };
    let port = null, alive = false, bound = false, timer = null, last = null, challenge = null;
    const stop = () => { if (timer !== null) clearInterval(timer); timer = null; };
    const send = message => { try { if (alive) port.postMessage(message); } catch { retire(); } };
    const report = () => { if (alive && bound && last !== window.location.href) { last = window.location.href; send({ kind: 'url', url: last }); } };
    const retire = () => { alive = false; bound = false; challenge = null; stop(); const old = port; port = null; try { old?.disconnect(); } catch {} };
    const prove = () => {
        if (!alive || !challenge || document.readyState !== 'complete') return;
        const nonce = challenge; challenge = null;
        window.parent.postMessage({ kind: 'peekPreviewProof', nonce }, origin);
    };
    const connect = () => {
        if (port || document.prerendering) return;
        try { port = api.runtime.connect({ name: 'arcify-peek-observer-v2' }); alive = true; } catch { return; }
        const current = port;
        current.onDisconnect.addListener(() => { void api.runtime.lastError; if (port === current) retire(); });
        current.onMessage.addListener(message => {
            if (!alive || port !== current) return;
            if (exact(message, ['kind', 'nonce']) && message.kind === 'challenge' && uuid(message.nonce)) {
                // Never '*' and never top/broadcast: only the trusted extension parent.
                challenge = message.nonce; prove();
            } else if (exact(message, ['kind']) && message.kind === 'bound') {
                bound = true; last = null; stop(); report(); timer = setInterval(report, 250);
            } else if (exact(message, ['kind']) && message.kind === 'freeze') { stop(); }
            else if (exact(message, ['kind', 'id']) && message.kind === 'sample' && uuid(message.id)) {
                send({ kind: 'sample', id: message.id, live: bound && document.readyState === 'complete' && !document.prerendering, url: window.location.href });
            }
        });
    };
    const unload = event => { if (event.isTrusted) retire(); };
    const pageshow = event => { if (event.isTrusted) connect(); };
    const loaded = event => { if (event.isTrusted) prove(); };
    window.addEventListener('beforeunload', unload); window.addEventListener('pagehide', unload); window.addEventListener('pageshow', pageshow);
    window.addEventListener('popstate', report); window.addEventListener('hashchange', report);
    window.addEventListener('load', loaded);
    connect();
    return { dispose() { retire(); window.removeEventListener('beforeunload', unload); window.removeEventListener('pagehide', unload); window.removeEventListener('pageshow', pageshow); window.removeEventListener('popstate', report); window.removeEventListener('hashchange', report); window.removeEventListener('load', loaded); } };
}
