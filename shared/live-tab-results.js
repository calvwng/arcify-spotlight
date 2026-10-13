/** Read-only result invalidation. Tab identities, never titles or URLs, expire rows. */
import { isExtensionId } from './arcify-bridge-protocol.js';

export const LIVE_TAB_RESULTS_CHANGED = 'spotlightLiveTabsChanged';
export const ARCIFY_RESULTS_CHANGED = 'spotlightArcifyResultsChanged';
export const LIVE_TAB_CONTEXT = 'spotlightLiveTabContext';
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const OVERLAY_TABS_KEY = 'spotlightVisibleOverlayTabIds';

/** Session-only tab IDs survive MV3 worker suspension; no browsing data is saved. */
export function createLiveOverlayRegistry(api) {
    const ids = new Set();
    const storage = api.storage?.session;
    let queue = Promise.resolve().then(async () => {
        if (!storage) return;
        const stored = await storage.get(OVERLAY_TABS_KEY);
        if (Array.isArray(stored[OVERLAY_TABS_KEY])) for (const id of stored[OVERLAY_TABS_KEY]) if (positiveId(id)) ids.add(id);
    }).catch(() => {});
    const update = mutate => {
        queue = queue.then(async () => {
            mutate();
            if (storage) await storage.set({ [OVERLAY_TABS_KEY]: [...ids] });
        }).catch(() => {});
        return queue;
    };
    return {
        async getIds() { await queue; return new Set(ids); },
        add(id) { return positiveId(id) ? update(() => ids.add(id)) : queue; },
        remove(tabIds) { return update(() => { for (const id of tabIds) ids.delete(id); }); }
    };
}

export function isTabResultRemoved(result, removedTabIds) {
    const owner = result?.metadata?.arcifyBridge;
    if (owner && owner.kind !== 'tab') return false; // A saved pin survives its live tab.
    if (!owner && !['open-tab', 'pinned-tab'].includes(result?.type)) return false;
    const id = owner?.tabId ?? result?.metadata?.tabId;
    return positiveId(id) && removedTabIds.includes(id);
}

/** Shared delivery reaches extension pages and tracked content-script overlays. */
async function fanOutResults(api, getOverlayTabIds, message, isCurrent) {
    const quietSend = send => { try { Promise.resolve(send()).catch(() => {}); } catch { /* A page may close during fan-out. */ } };
    let tabs;
    try { tabs = await api.tabs.query(positiveId(message.windowId) ? { windowId: message.windowId } : {}); }
    catch { tabs = []; } // The old window may close when its final tab moves.
    const targets = new Set(await getOverlayTabIds());
    if (!await isCurrent()) return;
    const destinations = new Set(tabs.filter(tab => targets.has(tab.id)).map(tab => tab.id));
    // A detached overlay has already left the queried old window. It must still
    // receive its identity invalidation so it can resolve its new one.
    for (const id of message.removedTabIds || []) if (targets.has(id)) destinations.add(id);
    quietSend(() => api.runtime.sendMessage(message));
    for (const id of destinations) quietSend(() => api.tabs.sendMessage(id, message));
}

/** Read-only paired signals are coalesced, scoped and never persist workspace data. */
export function createArcifyResultUpdates(api, getOverlayTabIds, getPeerId, delayMs = 100) {
    const pending = new Map();
    let timer;
    let flushing = false;
    let disposed = false;
    const schedule = () => {
        if (disposed || timer || flushing || !pending.size) return;
        // Leading-edge delivery cancels old generations promptly. Further bursts
        // wait out the cooldown, including notifications received during fan-out.
        timer = setTimeout(() => { timer = null; schedule(); }, delayMs);
        void flush();
    };
    const flush = async () => {
        flushing = true;
        const changes = [...pending.values()];
        pending.clear();
        try {
            for (const { windowId, peerId } of changes) {
                if (disposed) break;
                const isCurrent = async () => !disposed && await getPeerId() === peerId && !disposed;
                if (!await isCurrent()) continue;
                await fanOutResults(api, getOverlayTabIds, { action: ARCIFY_RESULTS_CHANGED, windowId, peerId }, isCurrent);
            }
        } catch { /* Pairing/storage may disappear during worker shutdown. Never retry a peer. */ }
        finally { flushing = false; schedule(); }
    };
    return {
        invalidate(windowId, peerId) {
            if (disposed || !positiveId(windowId) || !isExtensionId(peerId)) return;
            pending.set(windowId, { windowId, peerId });
            schedule();
        },
        dispose() { disposed = true; clearTimeout(timer); pending.clear(); }
    };
}

/** Background fan-out reaches extension pages and tracked content-script overlays. */
export function installLiveTabResultUpdates(api, getOverlayTabIds = () => []) {
    const registrations = [];
    const pending = new Map();
    let timer;
    let disposed = false;
    const listen = (event, callback) => {
        if (!event?.addListener) return;
        event.addListener(callback);
        registrations.push(() => event.removeListener?.(callback));
    };
    const flush = async () => {
        timer = null;
        const changes = [...pending.values()];
        pending.clear();
        for (const change of changes) {
            if (disposed) return;
            const message = { action: LIVE_TAB_RESULTS_CHANGED, windowId: change.windowId, removedTabIds: [...change.removedTabIds] };
            await fanOutResults(api, getOverlayTabIds, message, () => !disposed);
        }
    };
    const changed = (windowId, removedTabId) => {
        if (disposed) return;
        const key = positiveId(windowId) ? windowId : null;
        if (!pending.has(key)) pending.set(key, { windowId: key, removedTabIds: new Set() });
        if (positiveId(removedTabId)) pending.get(key).removedTabIds.add(removedTabId);
        if (!timer) timer = setTimeout(flush, 30);
    };
    listen(api.tabs.onCreated, tab => changed(tab.windowId));
    listen(api.tabs.onRemoved, (id, info) => changed(info?.windowId, id));
    listen(api.tabs.onDetached, (id, info) => changed(info?.oldWindowId, id));
    listen(api.tabs.onAttached, (id, info) => changed(info?.newWindowId));
    listen(api.tabs.onMoved, (id, info) => changed(info?.windowId));
    listen(api.tabs.onUpdated, (id, change, tab) => {
        if (['url', 'title', 'pinned'].some(key => Object.hasOwn(change, key))) changed(tab?.windowId);
    });
    listen(api.tabs.onReplaced, (addedId, removedId) => {
        // Replacement may race a close; unknown window means refresh scoped callers.
        Promise.resolve().then(() => api.tabs.get(addedId)).then(tab => changed(tab.windowId, removedId), () => changed(null, removedId));
    });
    return () => { disposed = true; clearTimeout(timer); pending.clear(); registrations.forEach(remove => remove()); };
}

/** Mount only while the result surface exists; refresh never executes a result. */
export function mountLiveTabResults({ api = chrome, document: doc = document, window: win = window,
    isActive = () => true, onInvalidate = () => {}, onRefresh = () => {}, delayMs = 40 } = {}) {
    let disposed = false;
    let context = null;
    let timer;
    let dirty = false;
    let pairedDirty = null;
    let contextRead = null;
    const removed = new Set();
    const active = () => !disposed && isActive() && doc.visibilityState !== 'hidden';
    const readContext = () => {
        if (contextRead) return contextRead;
        contextRead = Promise.resolve().then(() => api.runtime.sendMessage({ action: LIVE_TAB_CONTEXT,
            ...(positiveId(win.arcifyCurrentTabId) ? { tabId: win.arcifyCurrentTabId } : {}) }))
            .then(response => {
                if (!disposed && response?.success && positiveId(response.windowId) && positiveId(response.sourceTabId)) {
                    context = { windowId: response.windowId, tabId: response.sourceTabId, allWindows: response.allWindows === true, peerId: response.peerId || null };
                }
                return context;
            }).catch(() => null).finally(() => { contextRead = null; });
        return contextRead;
    };
    const currentPair = (value, change) => value && value.peerId === change.peerId && value.windowId === change.windowId;
    const freshContext = async () => {
        if (contextRead) await contextRead;
        context = null;
        return readContext();
    };
    const schedule = () => {
        if (!active() || (!dirty && !pairedDirty) || timer) return;
        timer = setTimeout(async () => {
            timer = null;
            if (!active() || (!dirty && !pairedDirty)) return;
            const change = pairedDirty;
            pairedDirty = null;
            const paired = change && currentPair(await freshContext(), change);
            if (!active()) return;
            if (!dirty && !paired) return;
            if (!context && !await readContext()) return;
            if (!active()) return;
            dirty = false;
            const ids = [...removed]; removed.clear();
            onInvalidate(ids);
            await onRefresh(paired ? change : undefined);
        }, delayMs);
    };
    const invalidate = ids => {
        if (disposed) return;
        for (const id of ids) if (positiveId(id)) removed.add(id);
        dirty = true;
        // Discard in-flight responses and dead selections immediately, before refresh.
        if (active()) onInvalidate([...removed]);
        schedule();
    };
    const receive = (message, sender) => {
        // Browser-attested content scripts/pages cannot impersonate the worker.
        if (sender?.id !== api.runtime.id || sender.tab || (sender.url && sender.url !== api.runtime.getURL('background.js')) ||
            (sender.origin && sender.origin !== `chrome-extension://${api.runtime.id}`)) return false;
        if (message?.action === ARCIFY_RESULTS_CHANGED) {
            if (Array.isArray(message) || !Object.keys(message).every(key => ['action', 'windowId', 'peerId'].includes(key)) ||
                !positiveId(message.windowId) || !isExtensionId(message.peerId)) return false;
            void (async () => {
                // Never let an old peer or pre-revocation signal refresh standalone results.
                if (!currentPair(await freshContext(), message) || disposed) return;
                pairedDirty = { windowId: message.windowId, peerId: message.peerId };
                if (active()) onInvalidate([]); // Discard any older snapshot already in flight.
                schedule();
            })();
            return false;
        }
        if (message?.action !== LIVE_TAB_RESULTS_CHANGED || Array.isArray(message) ||
            !Object.keys(message).every(key => ['action', 'windowId', 'removedTabIds'].includes(key)) ||
            !(message.windowId === null || positiveId(message.windowId)) || !Array.isArray(message.removedTabIds) ||
            !message.removedTabIds.every(positiveId)) return false;
        const apply = async () => {
            let source = context || await readContext();
            // A paired signal can clear/replace context while this native signal
            // awaits the same read. Follow that newer read rather than dereference
            // null, discard the removal, or scope it using the superseded result.
            while (source && !disposed && source !== context) source = context || await readContext();
            if (!source || disposed) return;
            if (message.removedTabIds.includes(source.tabId)) {
                // A page can itself move windows without reloading. Resolve its sender again.
                context = null;
                if (!await readContext() || disposed) return;
                invalidate(message.removedTabIds);
            } else if (source.allWindows || message.windowId === null || message.windowId === source.windowId) invalidate(message.removedTabIds);
        };
        void apply();
        return false;
    };
    const resume = () => {
        if (!active()) return;
        // The page may have missed events while hidden or a service worker restarted.
        context = null;
        invalidate([]);
    };
    api.runtime.onMessage.addListener(receive);
    doc.addEventListener('visibilitychange', resume);
    win.addEventListener('focus', resume);
    const ready = readContext();
    return {
        ready,
        handleActionFailure(result, response) {
            if (disposed || response?.success !== false || !['STALE_RESULT', 'STALE_TAB'].includes(response.errorCode)) return false;
            const id = result?.metadata?.arcifyBridge?.tabId ?? result?.metadata?.tabId;
            invalidate(positiveId(id) ? [id] : []);
            return true;
        },
        dispose() {
            disposed = true; clearTimeout(timer); removed.clear(); pairedDirty = null;
            api.runtime.onMessage.removeListener(receive);
            doc.removeEventListener('visibilitychange', resume);
            win.removeEventListener('focus', resume);
        }
    };
}
