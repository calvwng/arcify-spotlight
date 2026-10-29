import { isTransientUrl } from './arcify-bridge-protocol.js';

export const PEEK_WRAPPER_PORT = 'arcify-peek-wrapper-v2';
export const PEEK_OBSERVER_PORT = 'arcify-peek-observer-v2';
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const uuid = s => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
const unavailable = () => new Error('Preview document changed.');

/** Directional proofs are delivered only INSIDE our extension wrapper. Neither
 * page messages, frame positions, sender.url nor a WAR URL alone confer trust. */
export function createPeekPreviewRegistry(api, { sessions, notify, timeoutMs = 1500 }) {
    const wrapperUrl = api.runtime.getURL('peek-wrapper.html'), extensionOrigin = `chrome-extension://${api.runtime.id}`;
    const send = (endpoint, message) => { if (!endpoint?.alive) throw unavailable(); endpoint.port.postMessage(message); };
    const end = endpoint => {
        if (!endpoint?.alive) return;
        endpoint.alive = false;
        clearTimeout(endpoint.bindTimer);
        for (const request of endpoint.requests.values()) { clearTimeout(request.timer); request.reject(unavailable()); }
        endpoint.requests.clear();
        try { endpoint.port.disconnect(); } catch {}
    };
    const request = (endpoint, kind) => new Promise((resolve, reject) => {
        const id = crypto.randomUUID(), timer = setTimeout(() => { endpoint.requests.delete(id); reject(unavailable()); }, timeoutMs);
        endpoint.requests.set(id, { kind, resolve, reject, timer });
        try { send(endpoint, { kind, id }); } catch (error) { clearTimeout(timer); endpoint.requests.delete(id); reject(error); }
    });
    const answer = (endpoint, message) => {
        const pending = endpoint.requests.get(message?.id);
        if (!pending || pending.kind !== message.kind) return false;
        endpoint.requests.delete(message.id); clearTimeout(pending.timer); pending.resolve(message); return true;
    };
    const publish = (s, url = s.preview.original, known = false) => {
        if (!s.alive || !s.preview || s.preview.locked) return;
        notify(s, { kind: 'preview-url', url, known });
        if (s.preview.wrapper?.alive) send(s.preview.wrapper, { kind: 'address', url, known });
    };
    const invalidate = (s, endpoint = null) => {
        const p = s.preview;
        if (!p || endpoint && p.bound && p.bound.observer !== endpoint) return;
        p.bound = null; p.revision++; p.loaded = false;
        for (const observer of p.observers) observer.nonce = null;
        publish(s);
    };
    const challenge = (s, observer) => {
        const p = s.preview;
        if (!s.alive || p.locked || !p.loaded || !p.wrapper?.alive || !observer.alive) return;
        observer.nonce = crypto.randomUUID(); observer.revision = p.revision; observer.wrapper = p.wrapper;
        send(observer, { kind: 'challenge', nonce: observer.nonce });
    };
    const endpoint = port => ({ port, alive: true, requests: new Map(), documentId: port.sender.documentId || null, frameId: port.sender.frameId });
    const connect = port => {
        if (![PEEK_WRAPPER_PORT, PEEK_OBSERVER_PORT].includes(port.name)) return;
        const sender = port.sender, s = sessions.get(sender?.tab?.id), p = s?.preview;
        if (!s?.alive || !p || sender.id !== api.runtime.id || sender.tab.windowId !== s.source.windowId || sender.tab.incognito
            || !Number.isSafeInteger(sender.frameId) || sender.frameId <= 0 || sender.documentId !== undefined && (typeof sender.documentId !== 'string' || !sender.documentId)
            || sender.documentLifecycle && sender.documentLifecycle !== 'active') { port.disconnect(); return; }
        const e = endpoint(port);
        if (port.name === PEEK_WRAPPER_PORT) {
            if (sender.url !== wrapperUrl || sender.origin !== extensionOrigin || p.wrapper || p.wrappers.size >= 4) { port.disconnect(); return; }
            p.wrappers.add(e); e.bindTimer = setTimeout(() => end(e), 5000);
            port.onMessage.addListener(message => {
                if (!e.alive || !s.alive || s.preview !== p) return;
                if (!p.wrapper && exact(message, ['kind', 'nonce']) && message.kind === 'bind' && uuid(message.nonce) && message.nonce === p.nonce) {
                    p.nonce = null; p.wrapper = e; clearTimeout(e.bindTimer);
                    send(e, { kind: 'start', url: p.original }); publish(s); return;
                }
                if (p.wrapper !== e) { end(e); return; }
                if (answer(e, message)) return;
                if (exact(message, ['kind']) && message.kind === 'loaded') {
                    invalidate(s); p.loaded = true; for (const observer of p.observers) challenge(s, observer); return;
                }
                if (exact(message, ['kind', 'nonce']) && message.kind === 'child-proof' && uuid(message.nonce) && !p.locked) {
                    const observer = [...p.observers].find(o => o.alive && o.nonce === message.nonce && o.wrapper === e && o.revision === p.revision);
                    if (!observer) return;
                    observer.nonce = null;
                    const previous = p.bound?.observer;
                    p.bound = { observer, wrapper: e, revision: p.revision, identity: crypto.randomUUID() };
                    if (previous && previous !== observer) end(previous);
                    send(observer, { kind: 'bound' }); return;
                }
            });
            port.onDisconnect.addListener(() => { end(e); p.wrappers.delete(e); if (p.wrapper === e) invalidate(s); });
        } else {
            // Opaque origin is a required sandbox property, not an error to relax.
            if (!p.wrapper?.alive || p.locked || sender.origin !== 'null' || !isTransientUrl(sender.url) || p.observers.size >= 16) { port.disconnect(); return; }
            p.observers.add(e);
            port.onMessage.addListener(message => {
                if (!e.alive || !s.alive || s.preview !== p) return;
                if (answer(e, message)) return;
                if (exact(message, ['kind', 'url']) && message.kind === 'url' && p.bound?.observer === e) {
                    if (!isTransientUrl(message.url)) { invalidate(s, e); return; }
                    publish(s, message.url, true);
                }
            });
            port.onDisconnect.addListener(() => { end(e); p.observers.delete(e); invalidate(s, e); });
            challenge(s, e);
        }
    };
    api.runtime.onConnect?.addListener(connect);
    async function current(s, binding) {
        const p = s.preview, b = binding;
        if (!s.alive || !b || p.bound !== b || p.revision !== b.revision || !b.observer.alive || !b.wrapper.alive) throw unavailable();
        const [sample, proof] = await Promise.all([request(b.observer, 'sample'), request(b.wrapper, 'probe')]);
        if (!s.alive || p.bound !== b || p.revision !== b.revision || !b.observer.alive || !b.wrapper.alive
            || !exact(sample, ['kind', 'id', 'live', 'url']) || sample.live !== true || !isTransientUrl(sample.url)
            || !exact(proof, ['kind', 'id', 'live']) || proof.live !== true) throw unavailable();
        return { mode: 'current', url: sample.url, documentId: b.observer.documentId, frameId: b.observer.frameId, revision: b.identity };
    }
    return {
        prepare(s, original) { s.preview = { original, nonce: crypto.randomUUID(), wrapper: null, wrappers: new Set(), observers: new Set(), bound: null, revision: 0, loaded: false, locked: false }; return s.preview.nonce; },
        async select(s) {
            const p = s.preview, selection = p.bound ? await current(s, p.bound) : { mode: 'original', url: p.original, documentId: null, frameId: null, revision: null };
            p.locked = true;
            for (const observer of p.observers) if (observer.alive) send(observer, { kind: 'freeze' });
            notify(s, { kind: 'selected-url', url: selection.url, known: selection.mode === 'current' });
            return selection;
        },
        async verify(s, selection) {
            if (selection.mode === 'original') { if (selection.url !== s.preview.original) throw unavailable(); return; }
            const value = await current(s, s.preview.bound);
            if (!['mode', 'url', 'documentId', 'frameId', 'revision'].every(k => value[k] === selection[k])) throw unavailable();
        },
        close(s) { if (!s.preview) return; for (const wrapper of s.preview.wrappers) end(wrapper); for (const observer of s.preview.observers) end(observer); s.preview = null; },
        dispose() { api.runtime.onConnect?.removeListener(connect); }
    };
}
