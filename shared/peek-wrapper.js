const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const uuid = s => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
const webUrl = value => { try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password; } catch { return false; } };

export function installPeekWrapper({ api = chrome, document = globalThis.document, window = globalThis.window } = {}) {
    let child = document.getElementById('peek-site');
    const address = document.getElementById('peek-current-url'), label = document.getElementById('peek-url-kind');
    let port = null, ended = false, started = false;
    const send = message => { try { port?.postMessage(message); } catch { dispose(); } };
    const loaded = event => { if (event.isTrusted && started && !ended) send({ kind: 'loaded' }); };
    const dispose = () => {
        if (ended) return; ended = true; const old = port; port = null; try { old?.disconnect(); } catch {}
        window.removeEventListener('message', message); window.removeEventListener('pagehide', dispose);
        label.textContent = 'Preview connection ended. Use the original-link actions outside this frame.';
    };
    const message = event => {
        if (ended || window.parent === window) return;
        // Bootstrap is not authorization. Only the worker can consume the nonce
        // sent privately to the top content script and bind this exact document.
        if (!port && event.source === window.parent && exact(event.data, ['kind', 'nonce']) && event.data.kind === 'peekWrapperBootstrap' && uuid(event.data.nonce)) {
            port = api.runtime.connect({ name: 'arcify-peek-wrapper-v2' });
            port.onDisconnect.addListener(() => { void api.runtime.lastError; dispose(); });
            port.onMessage.addListener(value => {
                if (ended) return;
                if (exact(value, ['kind', 'url']) && value.kind === 'start' && !started && webUrl(value.url)) {
                    started = true; address.textContent = value.url;
                    // Set the target before insertion: an old about:blank load
                    // must never be mistaken for this website's load boundary.
                    const next = child.cloneNode(false); next.src = value.url; next.addEventListener('load', loaded); child.replaceWith(next); child = next;
                }
                else if (exact(value, ['kind', 'url', 'known']) && value.kind === 'address' && webUrl(value.url)) {
                    address.textContent = value.url; label.textContent = value.known === true ? 'Current preview URL' : 'Original link — current preview URL unavailable';
                } else if (exact(value, ['kind', 'id']) && value.kind === 'probe' && uuid(value.id)) {
                    send({ kind: 'probe', id: value.id, live: started && child.isConnected && !document.prerendering });
                }
            });
            send({ kind: 'bind', nonce: event.data.nonce }); return;
        }
        // The nonce came from an isolated observer, directly to this extension
        // origin. A web page cannot read it, even when it owns the child document.
        if (port && started && event.source === child.contentWindow && event.origin === 'null'
            && exact(event.data, ['kind', 'nonce']) && event.data.kind === 'peekPreviewProof' && uuid(event.data.nonce)) send({ kind: 'child-proof', nonce: event.data.nonce });
    };
    window.addEventListener('message', message); window.addEventListener('pagehide', dispose);
    return { dispose };
}
if (typeof document !== 'undefined' && document.getElementById('peek-site')) installPeekWrapper();
