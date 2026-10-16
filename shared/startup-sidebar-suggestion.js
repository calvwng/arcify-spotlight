/** A targeted, one-shot offer to an already ready new-tab renderer. Never opens/focuses a tab. */
export const STARTUP_SUGGESTION_ACTION = 'arcifyStartupSidebarSuggestion';
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const newTabUrl = (api, url) => url?.split(/[?#]/)[0] === api.runtime.getURL('newtab.html') || ['chrome://newtab', 'chrome://newtab/'].includes(url);

export function mountStartupSidebarSuggestion({ api = chrome, document, input, controller, select, clearSelection = () => {}, isReady = () => true }) {
    let disposed = false;
    let touched = false;
    let offered = false;
    let selected = false;
    let tab = null;
    const cancel = event => {
        touched = true;
        if (selected && (['input', 'blur', 'pointerdown', 'visibilitychange'].includes(event?.type) || event?.key === 'Escape')) clearSelection();
        selected = false;
    };
    const onKey = event => {
        if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', 'Escape'].includes(event.key)) cancel(event);
    };
    input.addEventListener('input', cancel);
    input.addEventListener('keydown', onKey);
    input.addEventListener('blur', cancel);
    document.addEventListener('pointerdown', cancel, true);
    const onVisibility = event => { if (document.visibilityState !== 'visible') cancel(event); };
    document.addEventListener('visibilitychange', onVisibility);
    const listener = (message, sender, respond) => {
        if (message?.action !== STARTUP_SUGGESTION_ACTION || !tab || message.tabId !== tab.id || message.windowId !== tab.windowId) return false;
        // Only our worker may relay an authenticated paired offer. Other pages and
        // content scripts cannot turn this into a website-triggered command route.
        if (sender?.id !== api.runtime.id || sender.tab || (sender.url && sender.url !== api.runtime.getURL('background.js'))) return false;
        const valid = Object.keys(message).every(key => ['action', 'requestId', 'peerId', 'tabId', 'windowId'].includes(key)) &&
            typeof message.requestId === 'string' && /^[\w.:-]{1,80}$/.test(message.requestId);
        const interaction = touched || document.visibilityState !== 'visible' || input.value.trim() !== '';
        const prepared = isReady() && controller.prepared;
        const accepted = valid && !disposed && !offered && !interaction && prepared &&
            !!controller.peerId && message.peerId === controller.peerId;
        const reason = interaction ? 'user-interaction' : !prepared ? 'not-ready' : 'not-eligible';
        offered = true;
        if (accepted) { selected = true; select(); }
        respond({ accepted, ...(accepted ? {} : { reason }), requestId: message.requestId, tabId: tab.id, windowId: tab.windowId });
        return false;
    };
    api.runtime.onMessage.addListener(listener);
    const ready = Promise.resolve().then(() => api.tabs.getCurrent()).then(current => {
        if (!disposed && positiveId(current?.id) && positiveId(current?.windowId) &&
            document.URL?.split(/[?#]/)[0] === api.runtime.getURL('newtab.html') && newTabUrl(api, current.url)) tab = current;
    }).catch(() => {});
    return {
        ready,
        cancel,
        get selected() { return selected && !disposed && !input.value.trim(); },
        dispose() {
            disposed = true;
            selected = false;
            api.runtime.onMessage.removeListener(listener);
            input.removeEventListener('input', cancel);
            input.removeEventListener('keydown', onKey);
            input.removeEventListener('blur', cancel);
            document.removeEventListener('pointerdown', cancel, true);
            document.removeEventListener('visibilitychange', onVisibility);
        }
    };
}

/** Called only after the normal bridge listener has authenticated and validated. */
export async function offerStartupSidebarSuggestion(api, bridge, message, peerId) {
    const tab = await api.tabs.get(message.tabId);
    const window = await api.windows.get(message.windowId);
    const isSource = candidate => candidate?.id === message.tabId && candidate.windowId === message.windowId &&
        candidate.active === true && !candidate.incognito && !candidate.pendingUrl &&
        newTabUrl(api, candidate.url);
    if (!isSource(tab) || window.focused !== true) return { accepted: false, reason: 'not-eligible' };
    if (await bridge.getPeerId() !== peerId) throw Object.assign(new Error('Arcify pairing changed.'), { code: 'UNAUTHORIZED' });
    // Recheck after asynchronous pairing/window work. Never select on a navigated source.
    if (!isSource(await api.tabs.get(message.tabId))) return { accepted: false, reason: 'not-eligible' };
    try {
        // runtime.sendMessage reaches extension pages. tabs.sendMessage only reaches
        // content scripts and cannot deliver to chrome-extension://…/newtab.html.
        const response = await api.runtime.sendMessage({ action: STARTUP_SUGGESTION_ACTION,
            requestId: message.requestId, peerId, tabId: message.tabId, windowId: message.windowId });
        if (response?.requestId === message.requestId && response.tabId === message.tabId &&
            response.windowId === message.windowId && typeof response.accepted === 'boolean' &&
            (response.accepted || ['user-interaction', 'not-ready', 'not-eligible'].includes(response.reason)))
            return response.accepted ? { accepted: true } : { accepted: false, reason: response.reason };
        throw new Error('No correlated startup response.');
    } catch {
        // The caller must consume uncertainty, rather than also create a launcher.
        throw Object.assign(new Error('Spotlight did not confirm the startup suggestion.'), { code: 'DELIVERY_UNCERTAIN' });
    }
}
