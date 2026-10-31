// Isolated-world cosmetic receiver. No page messages or DOM-stored credentials.
const PORT = 'little-arc-cosmetic-v1', OFFER = 'littleArcDimOffer';
export function installSourceDimming({ api = chrome, document = globalThis.document, window = globalThis.window } = {}) {
    let current = null, disposed = false;
    const clear = () => {
        const old = current; current = null; if (!old) return;
        clearTimeout(old.timer); clearInterval(old.pulse); old.host?.remove();
        try { old.port.disconnect(); } catch {}
    };
    const safe = url => window.top === window && window.location.href === url && document.body
        && document.visibilityState === 'visible' && !document.hasFocus() && !document.fullscreenElement && !document.prerendering;
    const offer = (message, sender) => {
        if (disposed || message?.type !== OFFER || sender.id !== api.runtime.id || sender.tab
            || typeof message.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(message.id) || !safe(message.url)) return;
        clear();
        let port; try { port = api.runtime.connect({ name: PORT }); } catch { return; }
        const lease = { id: message.id, url: message.url, port, host: null, deadline: Date.now() + 600000 };
        current = lease;
        const expire = () => { if (current === lease) clear(); };
        lease.timer = setTimeout(expire, 4000);
        port.onDisconnect.addListener(() => { void api.runtime.lastError; if (current === lease) clear(); });
        port.onMessage.addListener(value => {
            if (current !== lease) return;
            if (value?.kind !== 'lease' || value.id !== lease.id || !Number.isFinite(value.ms) || value.ms <= 0 || value.ms > 4000
                || Date.now() >= lease.deadline || !safe(lease.url)) return clear();
            clearTimeout(lease.timer); lease.timer = setTimeout(expire, Math.min(value.ms, lease.deadline - Date.now()));
            if (!lease.host) {
                const host = document.createElement('div'); host.setAttribute('aria-hidden', 'true');
                // Static opacity: no animation, including when reduced motion is requested.
                for (const [name, value] of Object.entries({ all: 'initial', position: 'fixed', inset: '0', 'z-index': '2147483646', 'pointer-events': 'none', background: 'rgba(0,0,0,.28)', display: 'block' })) host.style.setProperty(name, value, 'important');
                document.body.append(host); lease.host = host;
            }
        });
        const pulse = () => {
            if (current !== lease) return;
            if (!safe(lease.url) || Date.now() >= lease.deadline || !api.runtime.id) return clear();
            try { port.postMessage({ kind: 'pulse', id: lease.id }); } catch { clear(); }
        };
        lease.pulse = setInterval(pulse, 1500);
        try { port.postMessage({ kind: 'bind', id: lease.id }); return true; } catch { clear(); }
    };
    const interact = event => { if (event.isTrusted) clear(); };
    const changed = () => { if (current && !safe(current.url)) clear(); };
    for (const type of ['pointerdown', 'keydown', 'focus']) window.addEventListener(type, interact, true);
    for (const type of ['pagehide', 'popstate', 'hashchange']) window.addEventListener(type, clear);
    document.addEventListener('visibilitychange', changed); document.addEventListener('fullscreenchange', changed);
    return { receive: offer, dispose() { disposed = true; clear();
        for (const type of ['pointerdown', 'keydown', 'focus']) window.removeEventListener(type, interact, true);
        for (const type of ['pagehide', 'popstate', 'hashchange']) window.removeEventListener(type, clear);
        document.removeEventListener('visibilitychange', changed); document.removeEventListener('fullscreenchange', changed);
    } };
}
