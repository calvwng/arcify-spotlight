import { PEER_KEY, PAIRING_GENERATION_KEY, isExtensionId, isTransientUrl } from './arcify-bridge-protocol.js';
import { createPeekPreviewRegistry } from './peek-preview-broker.js';
export const PEEK_ENABLED_KEY = 'peekEnabled';
export const PEEK_IFRAME_KEY = 'peekIframeEnabled';
export const PEEK_PORT = 'arcify-peek-top-v1';
export const PEEK_TYPE = 'arcify-peek-v1';
export const PEEK_AUTHORITY = 'arcifyPeekAuthorityV1';
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const positive = n => Number.isSafeInteger(n) && n > 0;
const uuid = s => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
const unavailable = () => new Error('Peek ended or its result is uncertain. Check Little Arc and your windows; nothing was retried.');

export function installPeekBroker(api = chrome, { timeoutMs = 30000 } = {}) {
    const sessions = new Map(), removers = [];
    const listen = (event, fn) => { event?.addListener(fn); removers.push(() => event?.removeListener(fn)); };
    const post = (s, message) => { try { s.port.postMessage(message); } catch {} };
    const previews = createPeekPreviewRegistry(api, { sessions, notify: post });
    const settings = async () => {
        const v = await api.storage.local.get([PEEK_ENABLED_KEY, PEEK_IFRAME_KEY, PEER_KEY, PAIRING_GENERATION_KEY]);
        return { enabled: v[PEEK_ENABLED_KEY] === true, iframe: v[PEEK_IFRAME_KEY] === true, peerId: v[PEER_KEY], generation: v[PAIRING_GENERATION_KEY] ?? null };
    };
    const close = s => { if (!s.alive) return; s.alive = false; previews.close(s); if (sessions.get(s.source.tabId) === s) sessions.delete(s.source.tabId); try { s.port.disconnect(); } catch {} };
    async function live(s, active = false, source = s.source) {
        if (!s.alive) throw unavailable();
        const [pair, tab, window] = await Promise.all([settings(), api.tabs.get(source.tabId), api.windows.get(source.windowId)]);
        if (!s.alive || !pair.enabled || !isExtensionId(pair.peerId) || pair.peerId !== s.pair.peerId || pair.generation !== s.pair.generation || pair.iframe !== s.pair.iframe
            || tab.id !== source.tabId || window.id !== source.windowId || tab.windowId !== source.windowId || tab.incognito || window.type !== 'normal' || window.incognito || tab.url !== source.url
            || tab.pendingUrl && tab.pendingUrl !== source.url || active && (!tab.active || !window.focused)) throw unavailable();
    }
    async function sourceDocument(s, source) {
        await live(s, false, source);
        // Browser routing must resolve BOTH the original document and the top
        // frame. Only our isolated content script receives this read-only probe.
        // Its URL corroborates tabs.get; it never supplies the session URL.
        let timer, value;
        try {
            value = await Promise.race([
                api.tabs.sendMessage(source.tabId, { type: 'arcifyPeekLiveProbe' }, { documentId: s.documentId, frameId: 0 }),
                new Promise((_, reject) => { timer = setTimeout(() => reject(unavailable()), timeoutMs); })
            ]);
        } finally { clearTimeout(timer); }
        if (!s.alive || value?.url !== source.url) throw unavailable();
        await live(s, false, source);
    }
    async function handshakeSource(s) {
        const tab = await api.tabs.get(s.source.tabId);
        if (!isTransientUrl(tab.url) || new URL(tab.url).origin !== s.origin) throw unavailable();
        const source = { ...s.source, url: tab.url };
        await sourceDocument(s, source);
        // Establish once during hello. Later navigation retires the session;
        // never rebase an admitted operation or replay a link-opening request.
        s.source = source;
    }
    async function proof(s, active = false) {
        await live(s, active);
        const value = await api.tabs.sendMessage(s.source.tabId, { type: 'arcifyPeekLiveProbe' }, { documentId: s.documentId, frameId: 0 });
        if (!s.alive || !value || value.url !== s.source.url || value.live !== true || value.action !== s.executing || active && value.safe !== true) throw unavailable();
        if (s.selection) {
            if (value.selected?.url !== s.selection.url || value.selected?.mode !== s.selection.mode) throw unavailable();
            if (s.direct) { if (s.selection.mode !== 'original' || s.selection.url !== s.directUrl) throw unavailable(); }
            else await previews.verify(s, s.selection);
        }
        await live(s, active);
    }
    async function call(s, action, fields = {}) {
        await live(s);
        let timer;
        try {
            const result = await Promise.race([api.runtime.sendMessage(s.pair.peerId, { type: PEEK_TYPE, action, source: s.source, ...fields }),
                new Promise((_, reject) => { timer = setTimeout(() => reject(unavailable()), timeoutMs); })]);
            await live(s);
            if (!s.alive || result?.success !== true) throw unavailable();
            return result;
        } finally { clearTimeout(timer); }
    }
    listen(api.runtime.onConnect, port => {
        if (port.name !== PEEK_PORT) return;
        const sender = port.sender;
        let origin; try { origin = new URL(sender?.url).origin; } catch {}
        if (sender?.id !== api.runtime.id || sender.frameId !== 0 || !positive(sender.tab?.id) || !positive(sender.tab?.windowId) || sender.tab.incognito
            || typeof sender.documentId !== 'string' || !sender.documentId
            || !isTransientUrl(sender.url) || sender.origin && sender.origin !== origin || sender.documentLifecycle && sender.documentLifecycle !== 'active') { port.disconnect(); return; }
        const prior = sessions.get(sender.tab.id); if (prior) close(prior);
        const s = { alive: true, port, source: { tabId: sender.tab.id, windowId: sender.tab.windowId, url: sender.url }, origin, documentId: sender.documentId, connection: crypto.randomUUID(), begun: false, prepared: false, consumed: false, executing: null };
        sessions.set(s.source.tabId, s);
        port.onDisconnect.addListener(() => close(s));
        let queue = Promise.resolve();
        const handle = async message => {
            if (!s.alive) return;
            try {
                if (!s.begun && exact(message, ['kind']) && message.kind === 'hello') {
                    s.begun = true; s.pair = await settings(); await handshakeSource(s);
                    const result = await call(s, 'capability'); if (result.version !== 3) throw unavailable();
                    await sourceDocument(s, s.source);
                    s.ready = true; post(s, { kind: 'ready' }); return;
                }
                if (s.ready && !s.prepared && s.pair.iframe && exact(message, ['kind', 'url']) && message.kind === 'open' && isTransientUrl(message.url)) {
                    s.prepared = true; await live(s, true);
                    const result = await call(s, 'prepare', { url: message.url, connection: s.connection });
                    if (!uuid(result.operation)) throw unavailable();
                    s.operation = result.operation; const nonce = previews.prepare(s, message.url); post(s, { kind: 'show', url: message.url, nonce }); return;
                }
                if (s.ready && !s.prepared && !s.pair.iframe && exact(message, ['kind', 'url']) && message.kind === 'launch' && isTransientUrl(message.url)) {
                    // Consume before any await: a trusted Shift-click is one explicit
                    // Little Arc action, never an implicit Space promotion or retry.
                    s.prepared = s.consumed = s.direct = true; s.directUrl = message.url; s.executing = 'fallback';
                    s.selection = { mode: 'original', url: message.url, frameId: null, documentId: null, revision: null };
                    await proof(s, true);
                    const prepared = await call(s, 'prepare', { url: message.url, connection: s.connection });
                    if (!uuid(prepared.operation)) throw unavailable();
                    s.operation = prepared.operation; await proof(s, true);
                    const result = await call(s, 'fallback', { connection: s.connection, operation: s.operation });
                    if (result.completed !== true || result.action !== 'fallback' || !positive(result.tabId) || !positive(result.windowId)) throw unavailable();
                    s.completed = true; post(s, { kind: 'completed', action: 'fallback' }); s.executing = null; return;
                }
                if (s.operation && !s.consumed && exact(message, ['kind']) && ['expand', 'fallback'].includes(message.kind)) {
                    s.consumed = true; s.executing = message.kind;
                    s.selection = await previews.select(s);
                    await proof(s, true);
                    const result = await call(s, message.kind, { connection: s.connection, operation: s.operation });
                    if (result.completed !== true || result.action !== message.kind || !positive(result.tabId) || !positive(result.windowId)) throw unavailable();
                    s.completed = true; post(s, { kind: 'completed', action: message.kind }); s.executing = null; return;
                }
                if (s.operation && !s.consumed && exact(message, ['kind']) && message.kind === 'pulse') {
                    const result = await call(s, 'pulse', { connection: s.connection, operation: s.operation });
                    if (result.alive !== true) throw unavailable();
                    return;
                }
                if (s.completed && !s.acknowledged && exact(message, ['kind']) && message.kind === 'acknowledge') {
                    s.acknowledged = true;
                    const result = await call(s, 'acknowledge', { connection: s.connection, operation: s.operation });
                    if (result.acknowledged !== true) throw unavailable();
                    post(s, { kind: 'acknowledged' }); return;
                }
                throw unavailable();
            } catch { s.consumed = true; s.executing = null; post(s, { kind: 'error', message: unavailable().message }); if (!s.ready) close(s); }
        };
        port.onMessage.addListener(message => {
            // Close invalidates immediately, even while a queued mutation is awaiting native APIs.
            if (exact(message, ['kind']) && message.kind === 'close') { close(s); return; }
            queue = queue.then(() => handle(message)); return queue;
        });
    });
    listen(api.runtime.onMessageExternal, (message, sender, respond) => {
        if (message?.type !== PEEK_AUTHORITY) return;
        const verify = async () => {
            const pair = await settings();
            if (!exact(message, ['type', 'connection', 'operation', 'action', 'source']) || sender.id !== pair.peerId || sender.tab
                || sender.url && sender.url !== `chrome-extension://${pair.peerId}/background.js` || sender.origin && sender.origin !== `chrome-extension://${pair.peerId}`) return { authorized: false };
            const s = sessions.get(message.source?.tabId);
            if (!s?.alive || s.connection !== message.connection || s.operation !== message.operation || s.executing !== message.action
                || !['tabId', 'windowId', 'url'].every(k => s.source[k] === message.source[k])) return { authorized: false };
            await proof(s); return { authorized: s.alive && s.executing === message.action, selection: s.selection };
        };
        verify().then(respond, () => respond({ authorized: false })); return true;
    });
    const invalidate = id => { const s = sessions.get(id); if (s) close(s); };
    // A status-only loading update also fires for the preview iframe. It is not
    // proof of top navigation; the top Port/document probe and unload close that gap.
    listen(api.tabs.onUpdated, (id, change) => { if (Object.hasOwn(change, 'url') || Object.hasOwn(change, 'pendingUrl')) invalidate(id); });
    for (const name of ['onRemoved', 'onDetached', 'onAttached']) listen(api.tabs[name], invalidate);
    listen(api.tabs.onReplaced, (added, removed) => { invalidate(added); invalidate(removed); });
    listen(api.windows.onRemoved, id => { for (const s of [...sessions.values()]) if (s.source.windowId === id) close(s); });
    listen(api.storage.onChanged, (changes, area) => { if (area === 'local' && [PEEK_ENABLED_KEY, PEEK_IFRAME_KEY, PEER_KEY, PAIRING_GENERATION_KEY].some(k => Object.hasOwn(changes, k))) for (const s of [...sessions.values()]) close(s); });
    return { sessions, dispose() { for (const s of [...sessions.values()]) close(s); previews.dispose(); removers.forEach(fn => fn()); } };
}
