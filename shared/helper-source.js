import { bridgeError, isWindowId, trustedSender } from './arcify-bridge-protocol.js';

const stale = () => bridgeError('STALE_HELPER_SOURCE', 'The Spotlight helper moved or changed. Reopen Spotlight in the intended window.');

// Capture before any await. The event fence rejects same-URL document changes
// and move-away/move-back even when a later tabs.get looks unchanged.
export function createHelperSourceCapture(api) {
    const grants = new Map();
    const capture = sender => {
        if (sender?.id !== api.runtime.id || sender.url?.split(/[?#]/)[0] !== api.runtime.getURL('newtab.html')) return null;
        if (!isWindowId(sender.tab?.id) || !isWindowId(sender.tab.windowId) || sender.tab.url !== sender.url ||
            sender.frameId !== 0 || sender.documentLifecycle !== undefined && sender.documentLifecycle !== 'active') throw stale();
        const source = Object.freeze({ tabId: sender.tab.id, url: sender.url, token: crypto.randomUUID() });
        const windowId = sender.tab.windowId, removers = [], expiresAt = performance.now() + 20000;
        let changed = false, disposed = false;
        const dispose = () => { disposed = true; grants.delete(source.token); removers.splice(0).forEach(remove => remove()); };
        const listen = (event, fn) => {
            if (!event?.addListener || !event?.removeListener) throw stale();
            event.addListener(fn); removers.push(() => event.removeListener(fn));
        };
        try {
            listen(api.tabs.onUpdated, (id, change) => { if (id === source.tabId && (change.status === 'loading' || ['url', 'pendingUrl'].some(key => Object.hasOwn(change, key)))) changed = true; });
            listen(api.tabs.onDetached, id => { if (id === source.tabId) changed = true; });
            listen(api.tabs.onRemoved, id => { if (id === source.tabId) changed = true; });
            listen(api.tabs.onReplaced, (added, removed) => { if ([added, removed].includes(source.tabId)) changed = true; });
            listen(api.storage.onChanged, (changes, area) => { if (area === 'local' && ['arcifyBridgePeerId', 'arcifyBridgePairingGeneration'].some(key => Object.hasOwn(changes, key))) changed = true; });
        } catch (error) { dispose(); throw error; }
        const assert = () => { if (changed || disposed || performance.now() >= expiresAt) throw stale(); };
        const guard = { source, windowId, assert, dispose, async check() {
            assert();
            const tab = await api.tabs.get(source.tabId);
            assert();
            if (tab?.id !== source.tabId || tab.windowId !== windowId || tab.url !== source.url || tab.pendingUrl || tab.status === 'loading') throw stale();
        }, async dismiss() {
            await guard.check();
            // Chrome offers no compare-and-remove API; this is the final exact
            // native read, with an event fence immediately before removal.
            assert();
            await api.tabs.remove(source.tabId);
        } };
        grants.set(source.token, guard);
        return guard;
    };
    capture.verify = async message => {
        const guard = grants.get(message?.token);
        if (!guard || Object.keys(message).length !== 5 || message.type !== 'arcify-helper-source' ||
            message.tabId !== guard.source.tabId || message.url !== guard.source.url || message.windowId !== guard.windowId) throw stale();
        await guard.check();
        return { live: true };
    };
    return capture;
}

export function installHelperSourceValidation(api, bridge, capture) {
    const listener = (message, sender, respond) => {
        if (message?.type !== 'arcify-helper-source') return false;
        (async () => {
            const peerId = await bridge.getPeerId();
            if (!trustedSender(sender, peerId)) throw stale();
            const result = await capture.verify(message);
            if (await bridge.getPeerId() !== peerId) throw stale();
            respond(result);
        })().catch(() => respond({ live: false }));
        return true;
    };
    api.runtime.onMessageExternal.addListener(listener);
    return () => api.runtime.onMessageExternal.removeListener(listener);
}
