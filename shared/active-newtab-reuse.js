/** Read-only proof that the active browser New Tab alias is our existing renderer. */
export const NEW_TAB_REUSE_PROBE = 'spotlightNewTabReuseProbe';
export const NEW_TAB_REUSE_ACK = 'spotlightNewTabReuseAck';
export const NEW_TAB_REUSE_TIMEOUT_MS = 300;
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const documentUrl = url => typeof url === 'string' ? url.split(/[?#]/)[0] : null;
export const isBrowserNewTabAlias = url => ['chrome://newtab', 'chrome://newtab/'].includes(url);
const isOwnNewTab = (api, url) => documentUrl(url) === api.runtime.getURL('newtab.html');
const validMessage = message => message && !Array.isArray(message) &&
    Object.keys(message).every(key => ['action', 'nonce', 'tabId', 'windowId'].includes(key)) &&
    typeof message.nonce === 'string' && /^[0-9a-f-]{36}$/.test(message.nonce) &&
    positiveId(message.tabId) && positiveId(message.windowId);

/** Check browser state again after any awaited renderer/overlay work. */
export async function isSameActiveTab(api, source) {
    try {
        const tab = await api.tabs.get(source.id);
        const [active] = await api.tabs.query({ active: true, windowId: source.windowId });
        return tab?.id === source.id && tab.windowId === source.windowId && tab.active === true &&
            tab.url === source.url && !!tab.incognito === !!source.incognito && !tab.pendingUrl && !source.pendingUrl &&
            tab.status !== 'loading' && source.status !== 'loading' &&
            active?.id === source.id && active.windowId === source.windowId &&
            active.url === source.url && !!active.incognito === !!source.incognito && !active.pendingUrl && active.status !== 'loading';
    } catch { return false; }
}

/** Register synchronously in the worker; replies must arrive as independent messages. */
export function createActiveNewTabReuse(api, timeoutMs = NEW_TAB_REUSE_TIMEOUT_MS) {
    const pending = new Map();
    const registrations = [];
    const listen = (event, listener) => {
        if (!event?.addListener) return;
        event.addListener(listener);
        registrations.push(() => event.removeListener?.(listener));
    };
    const invalidate = matches => {
        for (const request of pending.values()) if (matches(request.source)) {
            request.changed = true;
            request.resolve(false);
        }
    };
    listen(api.runtime.onMessage, (message, sender) => {
        if (message?.action !== NEW_TAB_REUSE_ACK || !validMessage(message)) return false;
        const request = pending.get(message.nonce);
        if (!request || request.changed || message.tabId !== request.source.id || message.windowId !== request.source.windowId ||
            sender?.id !== api.runtime.id || !isOwnNewTab(api, sender.url) ||
            (sender.frameId !== undefined && sender.frameId !== 0) ||
            (sender.documentLifecycle !== undefined && sender.documentLifecycle !== 'active') ||
            (sender.tab && (sender.tab.id !== message.tabId || sender.tab.windowId !== message.windowId ||
                !!sender.tab.incognito !== !!request.source.incognito))) return false;
        // Unlike a broadcast callback, this message has Chrome-attested sender metadata.
        request.resolve(true);
        return false;
    });
    listen(api.tabs.onUpdated, (id, change) => {
        if (Object.hasOwn(change, 'url') || Object.hasOwn(change, 'pendingUrl') || change.status === 'loading')
            invalidate(source => source.id === id);
    });
    listen(api.tabs.onActivated, info => invalidate(source => source.windowId === info.windowId && source.id !== info.tabId));
    listen(api.tabs.onDetached, id => invalidate(source => source.id === id));
    listen(api.tabs.onRemoved, id => invalidate(source => source.id === id));
    listen(api.tabs.onReplaced, (_addedId, removedId) => invalidate(source => source.id === removedId));
    return {
        async reuseOrFallback(source, fallback) {
            if (!positiveId(source?.id) || !positiveId(source.windowId) || !source.active || source.pendingUrl || source.status === 'loading' ||
                !isBrowserNewTabAlias(source.url)) return false;
            const nonce = crypto.randomUUID();
            let timer;
            const request = { source: { ...source }, changed: false };
            const response = new Promise(resolve => { request.resolve = resolve; });
            pending.set(nonce, request);
            timer = setTimeout(() => request.resolve(false), timeoutMs);
            try {
                // Extension pages are not tabs.sendMessage recipients. Broadcast only
                // a challenge, and never trust its response or let another page win it.
                try {
                    Promise.resolve(api.runtime.sendMessage({ action: NEW_TAB_REUSE_PROBE, nonce,
                        tabId: source.id, windowId: source.windowId })).catch(() => {});
                } catch { /* Missing receivers use the same bounded timeout. */ }
                const acknowledged = await response;
                const isCurrent = async () => !request.changed && await isSameActiveTab(api, source) && !request.changed;
                if (!await isCurrent()) return false;
                // Retain the event guard through fallback's awaited teardown too:
                // navigation away and back is still a changed source document.
                return acknowledged || await fallback(isCurrent);
            } catch {
                return false;
            } finally {
                clearTimeout(timer);
                pending.delete(nonce);
            }
        },
        dispose() {
            invalidate(() => true);
            registrations.forEach(remove => remove());
        }
    };
}

/** Mount only on the actual initialized New Tab document. Never touch its UI/focus. */
export function mountActiveNewTabReuse({ api = chrome, document: doc = document, isReady = () => true } = {}) {
    let disposed = false;
    const ready = () => !disposed && isReady() && doc.visibilityState === 'visible' && isOwnNewTab(api, doc.URL);
    const listener = (message, sender) => {
        if (message?.action !== NEW_TAB_REUSE_PROBE || !validMessage(message) || !ready() ||
            sender?.id !== api.runtime.id || sender.tab ||
            (sender.url && sender.url !== api.runtime.getURL('background.js'))) return false;
        void (async () => {
            try {
                // Never cache identity: the renderer may have moved since an earlier command.
                const tab = await api.tabs.getCurrent();
                if (!ready() || tab?.id !== message.tabId || tab.windowId !== message.windowId ||
                    tab.active !== true || tab.pendingUrl || tab.status === 'loading' ||
                    (!isBrowserNewTabAlias(tab.url) && !isOwnNewTab(api, tab.url))) return;
                await api.runtime.sendMessage({ action: NEW_TAB_REUSE_ACK, nonce: message.nonce,
                    tabId: tab.id, windowId: tab.windowId });
            } catch { /* Closing or navigating a page is never grounds for reusing it. */ }
        })();
        return false;
    };
    api.runtime.onMessage.addListener(listener);
    return { dispose() { disposed = true; api.runtime.onMessage.removeListener(listener); } };
}
