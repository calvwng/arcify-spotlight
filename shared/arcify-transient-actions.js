/** Background-only Little Arc adapter. A consumed view can never replay a mutation. */
import { ArcifyTabActionsClient } from './arcify-tab-actions.js';
import { resolveSpaceActionSource } from './arcify-space-actions.js';
import { validateSnapshot } from './arcify-bridge.js';
import { GLOBAL_FAVORITES_FEATURE, PEER_KEY, PAIRING_GENERATION_KEY, bridgeError, isTransientUrl, isWindowId } from './arcify-bridge-protocol.js';
import { isActionId } from './arcify-space-actions-protocol.js';
import { TRANSIENT_WINDOWS_FEATURE, TRANSIENT_UNKNOWN, exactKeys, sameTransientContext, validateTransientScope, validateTransientResult } from './arcify-transient-actions-protocol.js';
const fail = (code, message) => { throw bridgeError(code, message); };
const stale = () => fail('STALE_CONTEXT', 'The Little Arc choice or source changed. Reopen Spotlight and choose the link again.');
const ENVELOPE = ['type', 'version', 'requestId', 'role', 'ok'];
export class ArcifyTransientActionsClient extends ArcifyTabActionsClient {
    constructor(...args) {
        super(...args); this.epoch = 0; this.globalEpoch = 0; this.windowEpochs = new Map(); this.pairingRevision = 0; this.views = new Map(); this.readRevision = 0; this.sourceReads = new Map();
    }
    epochFor(windowId) { return this.windowEpochs.get(windowId) ?? this.globalEpoch; }
    invalidate(pairingChanged = false, windowId = null) {
        const epoch = ++this.epoch;
        if (pairingChanged) this.pairingRevision++;
        if (!pairingChanged && isWindowId(windowId)) {
            this.windowEpochs.set(windowId, epoch);
            for (const [id, view] of this.views) if (view.context.windowId === windowId) this.views.delete(id);
        } else {
            this.globalEpoch = epoch; this.windowEpochs.clear(); this.views.clear();
        }
    }
    async hello(pairing, windowId) {
        let hello;
        // Only read-only negotiation is retried. Optional capability is not a
        // supportedFeatures marker, so older protocol-v1 peers keep working.
        for (const features of [[GLOBAL_FAVORITES_FEATURE], null]) {
            try { hello = await this.call(pairing, 'hello', { windowId, ...(features ? { supportedFeatures: features } : {}) }); break; }
            catch (error) { if (error.code !== 'INVALID_REQUEST' || features === null) throw error; }
        }
        if (!exactKeys(hello, [...ENVELOPE, 'extensionId', 'snapshot', ...(Object.hasOwn(hello || {}, 'capabilities') ? ['capabilities'] : [])]) ||
            hello.extensionId !== pairing.peerId || hello.capabilities !== undefined && (!Array.isArray(hello.capabilities) ||
            hello.capabilities.some(value => !isActionId(value)) || new Set(hello.capabilities).size !== hello.capabilities.length))
            fail('INVALID_RESPONSE', 'Arcify returned invalid Little Arc capabilities.');
        validateSnapshot(hello.snapshot, windowId, { allowOrdinaryFavorites: hello.capabilities?.includes(GLOBAL_FAVORITES_FEATURE) });
        return hello;
    }
    async inspect(source, expected = null) {
        const epoch = this.epochFor(source.windowId), pairing = await this.pairing();
        if (expected && (pairing.peerId !== expected.peerId || pairing.generation !== expected.generation)) fail('DISCONNECTED', 'Arcify pairing changed. Reopen Spotlight.');
        if (expected && epoch !== expected.epoch) stale();
        if (!pairing.peerId) return null;
        const hello = await this.hello(pairing, source.windowId);
        if (epoch !== this.epochFor(source.windowId)) stale();
        if (!hello.capabilities?.includes(TRANSIENT_WINDOWS_FEATURE)) return null;
        const snapshot = hello.snapshot, space = snapshot.spaces.find(item => item.id === snapshot.activeSpaceId);
        const context = { windowId: source.windowId, sourceTabId: source.tabId, sourceUrl: source.url,
            spaceId: snapshot.activeSpaceId, bookmarkFolderId: space?.bookmarkFolderId ?? null };
        return { ...pairing, epoch, context };
    }
    beginRead() { return ++this.readRevision; }
    async read(source, revision = this.beginRead()) {
        // The listener captures this ticket before source/nonce resolution.
        // Retain the latest ticket after completion: an older request can reach
        // this method late, after a newer renderer view has already been adopted.
        if ((this.sourceReads.get(source.tabId) ?? 0) > revision) stale();
        this.sourceReads.set(source.tabId, revision);
        const fresh = await this.inspect(source);
        if (this.sourceReads.get(source.tabId) !== revision) stale();
        if (!fresh) return null;
        const scope = validateTransientScope({ ...fresh, viewId: crypto.randomUUID() });
        for (const [id, view] of this.views) if (view.context.sourceTabId === source.tabId) this.views.delete(id);
        // Bound MV3 memory; a retired context always fails closed.
        if (this.views.size >= 128) this.views.delete(this.views.keys().next().value);
        this.views.set(scope.viewId, structuredClone(scope));
        return scope;
    }
    async execute(source, scope, url, beforeDispatch = async () => {}) {
        validateTransientScope(scope);
        if (!isTransientUrl(url)) fail('INVALID_REQUEST', 'Enter a complete http:// or https:// link without credentials.');
        if (!sameTransientContext(scope, this.views.get(scope.viewId))) stale();
        // Consume before queueing: simultaneous submits and uncertain failures
        // cannot use this exact authority again, even after a timeout.
        this.views.delete(scope.viewId);
        if (source.tabId !== scope.context.sourceTabId || source.windowId !== scope.context.windowId || source.url !== scope.context.sourceUrl) stale();
        return this.bridge.serializeAction(async () => {
            const fresh = await this.inspect(source, scope);
            if (!fresh) fail('UNSUPPORTED', 'This Arcify build does not support Little Arc. Update Arcify and reopen Spotlight.');
            if (!sameTransientContext(fresh.context, scope.context)) stale();
            await beforeDispatch();
            const stored = await this.api.storage.local.get([PEER_KEY, PAIRING_GENERATION_KEY]);
            if ((stored[PEER_KEY] || null) !== fresh.peerId || (stored[PAIRING_GENERATION_KEY] ?? null) !== fresh.generation)
                fail('DISCONNECTED', 'Arcify pairing changed. Reopen Spotlight.');
            if (fresh.epoch !== this.epochFor(source.windowId)) stale();
            // Send once, with no native fallback and no retry, including timeout.
            const pairingRevision = this.pairingRevision;
            const response = await this.send(fresh.peerId, 'openTransient', { windowId: source.windowId, url,
                supportedFeatures: [GLOBAL_FAVORITES_FEATURE] }, { role: 'arcify', timeout: this.bridge.timeoutMs });
            await this.check(fresh);
            if (pairingRevision !== this.pairingRevision) fail('DISCONNECTED', 'Arcify pairing changed. Check for an existing Little Arc window before trying again.');
            if (!exactKeys(response, [...ENVELOPE, 'tabId', 'transientWindowId', 'token', 'snapshot'])) fail('INVALID_RESPONSE', TRANSIENT_UNKNOWN);
            const result = validateTransientResult({ tabId: response.tabId, transientWindowId: response.transientWindowId, token: response.token }, scope.context);
            const snapshot = validateSnapshot(response.snapshot, source.windowId, { allowOrdinaryFavorites: true });
            if (snapshot.tabs.some(tab => tab.id === result.tabId)) fail('INVALID_RESPONSE', TRANSIENT_UNKNOWN);
            return result;
        });
    }
}
export async function resolveTransientActionSource(api, message, sender, options) {
    const source = await resolveSpaceActionSource(api, message, sender, options);
    const tab = await api.tabs.get(source.tabId), window = await api.windows.get(source.windowId);
    if (!tab || tab.windowId !== source.windowId || !tab.active || tab.pendingUrl || tab.status === 'loading' ||
        typeof tab.url !== 'string' || !tab.url || window?.id !== source.windowId || window.focused !== true || window.type !== 'normal' || window.incognito !== false) stale();
    return { ...source, url: tab.url };
}
export function installArcifyTransientActionMessages(api, bridge, sourceOptions = {}) {
    const client = new ArcifyTransientActionsClient(api, bridge), registrations = [];
    const listen = (event, callback) => { if (event?.addListener) { event.addListener(callback); registrations.push(() => event.removeListener?.(callback)); } };
    listen(api.storage?.onChanged, (changes, area) => {
        if (area === 'local' && [PEER_KEY, PAIRING_GENERATION_KEY].some(key => Object.hasOwn(changes, key))) client.invalidate(true);
    });
    // Match installLiveTabResultUpdates' window boundaries. Other-window
    // activity must not retire a row whose renderer will not be refreshed.
    const changed = windowId => client.invalidate(false, windowId);
    listen(api.tabs.onCreated, tab => changed(tab?.windowId));
    listen(api.tabs.onRemoved, (id, info) => changed(info?.windowId));
    listen(api.tabs.onActivated, info => changed(info?.windowId));
    listen(api.tabs.onAttached, (id, info) => changed(info?.newWindowId));
    listen(api.tabs.onDetached, (id, info) => changed(info?.oldWindowId));
    listen(api.tabs.onMoved, (id, info) => changed(info?.windowId));
    listen(api.tabs.onUpdated, (id, change, tab) => {
        if (['url', 'status', 'groupId'].some(key => Object.hasOwn(change, key))) changed(tab?.windowId);
    });
    listen(api.tabs.onReplaced, (addedId) => {
        // The shared fan-out resolves the replacement's window the same way;
        // failure broadcasts to every renderer and retires every local scope.
        Promise.resolve().then(() => api.tabs.get(addedId)).then(tab => changed(tab?.windowId), () => changed(null));
    });
    listen(api.windows?.onFocusChanged, () => changed(null));
    listen(api.tabGroups?.onUpdated, group => changed(group?.windowId));
    const listener = (message, sender, respond) => {
        if (!['arcifyTransientContext', 'arcifyOpenTransient'].includes(message?.action)) return false;
        const readRevision = message.action === 'arcifyTransientContext' ? client.beginRead() : null;
        (async () => {
            try {
                const keys = message.action === 'arcifyTransientContext' ? ['action'] : ['action', 'scope', 'url'];
                if (!exactKeys(message, [...keys, ...(Object.hasOwn(message, 'tabId') ? ['tabId'] : [])])) fail('INVALID_REQUEST', 'Invalid Spotlight Little Arc request.');
                const beforeSource = client.epoch, source = await resolveTransientActionSource(api, message, sender, sourceOptions);
                const epoch = client.epochFor(source.windowId);
                if (epoch > beforeSource) stale();
                const checkSource = async () => {
                    const live = await resolveTransientActionSource(api, message, sender, sourceOptions);
                    if (!sameTransientContext(live, source) || epoch !== client.epochFor(source.windowId)) stale();
                };
                if (message.action === 'arcifyTransientContext') {
                    const scope = await client.read(source, readRevision); await checkSource(); respond({ success: true, scope });
                } else {
                    const result = await client.execute(source, message.scope, message.url, checkSource);
                    respond({ success: true, result });
                }
            } catch (error) { respond({ success: false, error: error.message, errorCode: error.code || 'FAILED' }); }
        })();
        return true;
    };
    listen(api.runtime.onMessage, listener);
    return () => { client.invalidate(); registrations.forEach(remove => remove()); };
}
