import { isSameActiveTab } from './active-newtab-reuse.js';

export const OVERLAY_DELIVERY_TIMEOUT_MS = 2000;
export const VALIDATE_OVERLAY_RECOVERY = 'validateSpotlightRecovery';
const pendingRecoveries = new Map();

// Register in the worker synchronously. This read-only, one-request capability
// lets the renderer revalidate after asynchronous initialization, before its UI
// commits. It expires with the single ensure-open, including timeout/restart.
export function installOverlayRecoveryValidation(api) {
    api.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message?.action !== VALIDATE_OVERLAY_RECOVERY) return false;
        const request = pendingRecoveries.get(message.requestId);
        const validSender = request && sender?.id === api.runtime.id &&
            sender.frameId === 0 && sender.documentId === request.documentId && sender.documentLifecycle === 'active' &&
            sender.url === request.source.url && sender.tab?.id === request.source.id &&
            sender.tab.windowId === request.source.windowId && !!sender.tab.incognito === !!request.source.incognito;
        if (!validSender) { sendResponse({ valid: false }); return false; }
        request.guard.isCurrent({ settled: true }).then(valid => sendResponse({
            valid: valid && pendingRecoveries.get(message.requestId) === request
        }), () => sendResponse({ valid: false }));
        return true;
    });
}
export async function boundedOverlayDelivery(operation) {
    let timer;
    try {
        return await Promise.race([operation, new Promise((_, reject) => {
            timer = setTimeout(() => reject(Object.assign(new Error('Overlay delivery timed out.'),
                { code: 'OVERLAY_TIMEOUT' })), OVERLAY_DELIVERY_TIMEOUT_MS);
        })]);
    } finally { clearTimeout(timer); }
}

// Chrome distinguishes an absent receiver from a receiver that may have opened
// the UI before its response channel closed. Only the former permits reinjection.
export const isMissingOverlayReceiver = error =>
    error?.message === 'Could not establish connection. Receiving end does not exist.';

export function isRecoverableOverlayUrl(value) {
    try {
        const url = new URL(value);
        return ['https:', 'http:'].includes(url.protocol) &&
            url.hostname !== 'chromewebstore.google.com' &&
            !(url.hostname === 'chrome.google.com' && /^\/webstore(?:\/|$)/.test(url.pathname)) &&
            !(url.hostname === 'microsoftedge.microsoft.com' && /^\/addons(?:\/|$)/.test(url.pathname));
    } catch { return false; }
}

/** Begin before the first awaited lookup so same-URL reloads cannot escape it. */
export function captureOverlayCommand(api, commandTab) {
    const changes = [];
    const removers = [];
    let source;
    let changedBeforeLookup = false;
    const listen = (event, listener) => {
        if (!event?.addListener) return;
        event.addListener(listener);
        removers.push(() => event.removeListener?.(listener));
    };
    const changed = () => changedBeforeLookup || changes.some(matches => matches(source));
    listen(api.tabs.onUpdated, (id, change) => {
        if (Object.hasOwn(change, 'url') || Object.hasOwn(change, 'pendingUrl') || change.status === 'loading')
            changes.push(tab => tab?.id === id);
    });
    for (const event of [api.tabs.onDetached, api.tabs.onRemoved])
        listen(event, id => changes.push(tab => tab?.id === id));
    listen(api.tabs.onReplaced, (_added, removed) => changes.push(tab => tab?.id === removed));
    listen(api.tabs.onActivated, info => {
        if (!source) changedBeforeLookup = true;
        changes.push(tab => tab?.windowId === info.windowId && tab.id !== info.tabId);
    });
    // onCommand's Tab argument is optional. An unresolved query cannot prove
    // which window/tab received the user invocation after an activation change.
    listen(api.windows?.onFocusChanged, windowId => {
        // A command belongs to the focused window at invocation. Losing it,
        // including to a non-browser app, consumes this invocation even if the
        // original tab stays active in its now-background window.
        if (!source || windowId !== source.windowId) changedBeforeLookup = true;
    });
    listen(api.windows?.onRemoved, id => changes.push(tab => tab?.windowId === id));
    return {
        async resolve() {
            try {
                source = { ...(commandTab || (await api.tabs.query({ active: true, currentWindow: true }))[0]) };
                if (!Number.isSafeInteger(source.id) || source.id <= 0 || !Number.isSafeInteger(source.windowId) || source.windowId <= 0)
                    return null;
                return source;
            } catch { return null; }
        },
        // Existing receivers may work while a page loads. Repair requires a
        // settled document; no pending navigation is safe for either path.
        async isCurrent({ settled = false } = {}) {
            if (!source || changed() || source.pendingUrl) return false;
            if (settled) return await isSameActiveTab(api, source) && !changed();
            try {
                const tab = await api.tabs.get(source.id);
                const [active] = await api.tabs.query({ active: true, windowId: source.windowId });
                return !changed() && tab?.id === source.id && active?.id === source.id &&
                    [tab, active].every(value => value.windowId === source.windowId && value.active === true &&
                        value.url === source.url && !value.pendingUrl && !!value.incognito === !!source.incognito);
            } catch { return false; }
        },
        dispose() { removers.forEach(remove => remove()); }
    };
}

/** Called only by Spotlight's own commands.onCommand path after definite absence. */
export async function recoverOverlayReceiver(api, source, guard, message) {
    if (!isRecoverableOverlayUrl(source.url)) return { status: 'fallback' };
    if (!await guard.isCurrent({ settled: true })) return { status: 'changed' };
    let results;
    try {
        results = await boundedOverlayDelivery(api.scripting.executeScript({
            target: { tabId: source.id, frameIds: [0] },
            world: 'ISOLATED', files: ['overlay.js'], injectImmediately: true
        }));
    } catch (error) {
        if (error.code === 'OVERLAY_TIMEOUT') return { status: 'uncertain' };
        // Permission/policy denial: no refresh, permission escalation or retry.
        return { status: await guard.isCurrent() ? 'fallback' : 'changed' };
    }
    if (!await guard.isCurrent({ settled: true })) return { status: 'changed' };
    const documentId = results?.length === 1 && results[0].frameId === 0 && results[0].documentId;
    if (typeof documentId !== 'string' || !documentId) return { status: 'fallback' };
    const recoveryRequestId = crypto.randomUUID();
    pendingRecoveries.set(recoveryRequestId, { source, guard, documentId });
    try {
        // Registration is dormant. The browser may navigate between the last
        // check and injection; a returned document ID prevents opening a later
        // document, even if its URL is identical. There is exactly one open send.
        const response = await boundedOverlayDelivery(api.tabs.sendMessage(source.id, {
            ...message, ensureOpen: true, recovery: true, recoveryRequestId, expectedUrl: source.url
        }, { documentId }));
        if (!await guard.isCurrent()) return { status: 'changed' };
        if (response?.success === true && response.open === true) return { status: 'opened', response };
        if (response?.success === false && !response.changed) return { status: 'fallback' };
        return { status: 'uncertain' };
    } catch {
        // A missing document may be a navigation whose event is still queued.
        // Never retry or manufacture a helper from an uncertain recovery send.
        return { status: 'uncertain' };
    } finally { pendingRecoveries.delete(recoveryRequestId); }
}
