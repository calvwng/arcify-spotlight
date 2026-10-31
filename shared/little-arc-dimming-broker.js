import { PEER_KEY, PAIRING_GENERATION_KEY } from './arcify-bridge-protocol.js';
export const DIM_KEY = 'littleArcDimSource';
export const DIM_PORT = 'little-arc-cosmetic-v1';
export const DIM_OFFER = 'littleArcDimOffer';
const LEASE_MS = 4000, MAX_MS = 600000;

/** Cosmetic state only. No opening/placement authority or replayable launch intent. */
export function createSourceDimming(api, { now = Date.now } = {}) {
    const leases = new Map(), removers = [];
    let disposed = false;
    const listen = (event, fn) => { event?.addListener(fn); removers.push(() => event?.removeListener(fn)); };
    const clear = lease => {
        if (leases.get(lease.source.tabId) !== lease) return;
        leases.delete(lease.source.tabId); clearTimeout(lease.timer);
        try { lease.port?.disconnect(); } catch {}
    };
    const valid = async lease => {
        const [settings, source, origin, target, destination] = await Promise.all([
            api.storage.local.get([DIM_KEY, 'peekEnabled', PEER_KEY, PAIRING_GENERATION_KEY]),
            api.tabs.get(lease.source.tabId), api.windows.get(lease.source.windowId),
            api.tabs.get(lease.target.tabId), api.windows.get(lease.target.windowId)
        ]);
        return !disposed && leases.get(lease.source.tabId) === lease && now() < lease.expires
            && settings[DIM_KEY] === true && settings.peekEnabled === true
            && settings[PEER_KEY] === lease.pair.peerId && (settings[PAIRING_GENERATION_KEY] ?? null) === lease.pair.generation
            && source.id === lease.source.tabId && source.windowId === lease.source.windowId && source.url === lease.source.url
            && !source.pendingUrl && source.active && !source.incognito
            && origin.id === lease.source.windowId && origin.type === 'normal' && !origin.incognito && !origin.focused
            && target.id === lease.target.tabId && target.windowId === lease.target.windowId && target.active && !target.incognito
            && destination.id === lease.target.windowId && destination.type === 'normal' && !destination.incognito && destination.focused;
    };
    async function start(source, documentId, target, pair) {
        // Copy only the minimal cosmetic association, never the broker session.
        if (disposed || source.windowId === target.windowId || typeof documentId !== 'string' || !documentId) return;
        const prior = leases.get(source.tabId); if (prior) clear(prior);
        const lease = { id: crypto.randomUUID(), source: { ...source }, documentId, target: { ...target },
            pair: { peerId: pair.peerId, generation: pair.generation }, expires: now() + MAX_MS, port: null };
        leases.set(source.tabId, lease);
        lease.timer = setTimeout(() => clear(lease), LEASE_MS);
        try {
            if (!await valid(lease) || leases.get(source.tabId) !== lease) return clear(lease);
            const response = await api.tabs.sendMessage(source.tabId, { type: DIM_OFFER, id: lease.id, url: source.url }, { documentId, frameId: 0 });
            if (response?.accepted !== true) clear(lease);
        } catch { clear(lease); }
    }
    listen(api.runtime.onConnect, port => {
        if (port.name !== DIM_PORT) return;
        const sender = port.sender, lease = leases.get(sender?.tab?.id);
        if (!lease || lease.port || sender.id !== api.runtime.id || sender.frameId !== 0 || sender.documentId !== lease.documentId
            || sender.tab.windowId !== lease.source.windowId || sender.tab.incognito
            || sender.documentLifecycle && sender.documentLifecycle !== 'active'
            || sender.origin && sender.origin !== new URL(lease.source.url).origin) { port.disconnect(); return; }
        lease.port = port;
        port.onDisconnect.addListener(() => clear(lease));
        let bound = false, checking = false;
        port.onMessage.addListener(async message => {
            if (checking || !message || Object.keys(message).length !== 2 || message.id !== lease.id
                || message.kind !== (bound ? 'pulse' : 'bind')) return clear(lease);
            checking = true;
            try {
                if (!await valid(lease) || leases.get(lease.source.tabId) !== lease) return clear(lease);
                bound = true; clearTimeout(lease.timer);
                lease.timer = setTimeout(() => clear(lease), LEASE_MS);
                port.postMessage({ kind: 'lease', id: lease.id, ms: Math.min(LEASE_MS, lease.expires - now()) });
            } catch { clear(lease); } finally { checking = false; }
        });
    });
    const tabChanged = id => { for (const lease of [...leases.values()]) if ([lease.source.tabId, lease.target.tabId].includes(id)) clear(lease); };
    for (const name of ['onRemoved', 'onDetached', 'onAttached']) listen(api.tabs[name], tabChanged);
    listen(api.tabs.onReplaced, (added, removed) => { tabChanged(added); tabChanged(removed); });
    listen(api.tabs.onUpdated, (id, change) => { if (change.status === 'loading' || Object.hasOwn(change, 'url') || Object.hasOwn(change, 'pendingUrl')) tabChanged(id); });
    listen(api.tabs.onActivated, info => { for (const lease of [...leases.values()]) if (info.windowId === lease.source.windowId && info.tabId !== lease.source.tabId || info.windowId === lease.target.windowId && info.tabId !== lease.target.tabId) clear(lease); });
    listen(api.windows.onRemoved, id => { for (const lease of [...leases.values()]) if ([lease.source.windowId, lease.target.windowId].includes(id)) clear(lease); });
    listen(api.windows.onFocusChanged, id => { for (const lease of [...leases.values()]) if (id !== lease.target.windowId) clear(lease); });
    listen(api.storage.onChanged, (changes, area) => { if (area === 'local' && [DIM_KEY, 'peekEnabled', PEER_KEY, PAIRING_GENERATION_KEY].some(key => Object.hasOwn(changes, key))) for (const lease of [...leases.values()]) clear(lease); });
    return { start, dispose() { disposed = true; for (const lease of [...leases.values()]) clear(lease); removers.forEach(remove => remove()); } };
}
