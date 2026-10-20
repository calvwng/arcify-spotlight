/** Split-only adapter. No native mutation, active-tab guessing, retries, or focus changes. */
import { ArcifyTabActionsClient } from './arcify-tab-actions.js';
import { validateSnapshot } from './arcify-bridge.js';
import { GLOBAL_FAVORITES_FEATURE, PEER_KEY, PAIRING_GENERATION_KEY, bridgeError, isWindowId } from './arcify-bridge-protocol.js';
import { isActionId } from './arcify-space-actions-protocol.js';
import { SPLIT_ACTIONS_FEATURE, SPLIT_ACTION_COMMANDS, exactKeys, isSplitContentUrl, validateSplitContext, validateSplitTargets, validateSplitScope, validateSplitPayload, validateSplitResult, sameSplitContext } from './arcify-split-actions-protocol.js';
const fail = (code, message) => { throw bridgeError(code, message); };
const FEATURES = [GLOBAL_FAVORITES_FEATURE, SPLIT_ACTIONS_FEATURE];
const ENVELOPE = ['type', 'version', 'requestId', 'role', 'ok'];
const stale = () => fail('STALE_CONTEXT', 'The current tab or Split choices changed. Refresh Spotlight and choose again.');
function confirmMember(snapshot, context, descriptor, active = false) {
    const space = snapshot.spaces.find(item => item.id === context.spaceId), tab = snapshot.tabs.find(item => item.id === descriptor.id);
    if (snapshot.activeSpaceId !== context.spaceId || space?.bookmarkFolderId !== context.bookmarkFolderId || !space.temporaryTabIds.includes(descriptor.id) ||
        !tab || tab.spaceId !== context.spaceId || tab.windowId !== context.windowId || tab.pinned || active && !tab.active ||
        tab.url !== descriptor.url || tab.title !== descriptor.title || snapshot.favorites?.some(item => item.tabId === descriptor.id) ||
        snapshot.bookmarks.some(item => item.tabId === descriptor.id)) fail('INVALID_RESPONSE', 'Arcify returned conflicting Today tab identity. Refresh Spotlight.');
}
export class ArcifySplitActionsClient extends ArcifyTabActionsClient {
    constructor(...args) { super(...args); this.epoch = 0; }
    invalidate() { this.epoch++; }
    async hello(pairing, windowId) {
        let hello;
        for (const features of [FEATURES, [GLOBAL_FAVORITES_FEATURE], null]) {
            try { hello = await this.call(pairing, 'hello', { windowId, ...(features ? { supportedFeatures: features } : {}) }); break; }
            catch (error) { if (error.code !== 'INVALID_REQUEST' || features === null) throw error; }
        }
        if (!exactKeys(hello, [...ENVELOPE, 'extensionId', 'snapshot', ...(Object.hasOwn(hello || {}, 'capabilities') ? ['capabilities'] : [])]) || hello.extensionId !== pairing.peerId || hello.capabilities !== undefined && (!Array.isArray(hello.capabilities) ||
            hello.capabilities.some(value => !isActionId(value)) || new Set(hello.capabilities).size !== hello.capabilities.length)) fail('INVALID_RESPONSE', 'Arcify returned invalid Split capabilities.');
        validateSnapshot(hello.snapshot, windowId, { allowOrdinaryFavorites: hello.capabilities?.includes(GLOBAL_FAVORITES_FEATURE) });
        return hello;
    }
    async read(source, expectedScope = null) {
        const epoch = this.epoch, pairing = await this.pairing();
        if (expectedScope && (pairing.peerId !== expectedScope.peerId || pairing.generation !== expectedScope.generation)) fail('DISCONNECTED', 'Arcify pairing changed. Refresh Spotlight.');
        if (expectedScope && expectedScope.epoch !== epoch) stale();
        if (!pairing.peerId) return null;
        const hello = await this.hello(pairing, source.windowId);
        if (!hello.capabilities?.includes(SPLIT_ACTIONS_FEATURE)) return null;
        const response = await this.call(pairing, 'splitActionContext', { windowId: source.windowId, tabId: source.tabId, supportedFeatures: FEATURES });
        if (epoch !== this.epoch) stale();
        if (!exactKeys(response, [...ENVELOPE, 'extensionId', 'snapshot', 'splitActionContext', 'splitTargets']) || response.extensionId !== pairing.peerId)
            fail('INVALID_RESPONSE', 'Arcify did not confirm the Split context.');
        const snapshot = validateSnapshot(response.snapshot, source.windowId, { allowOrdinaryFavorites: hello.capabilities.includes(GLOBAL_FAVORITES_FEATURE) });
        const context = validateSplitContext(response.splitActionContext, source.windowId, source.tabId);
        const targets = validateSplitTargets(response.splitTargets, context);
        const space = snapshot.spaces.find(item => item.id === context.spaceId);
        if (snapshot.activeSpaceId !== context.spaceId || space?.bookmarkFolderId !== context.bookmarkFolderId) fail('INVALID_RESPONSE', 'Arcify returned the wrong selected Space.');
        if (context.tab) confirmMember(snapshot, context, context.tab, true);
        [...context.pair, ...targets].forEach(tab => confirmMember(snapshot, context, tab));
        return { ...pairing, epoch, context, targets };
    }
    async execute(source, scope, command, fields, beforeDispatch = async () => {}) {
        validateSplitScope(scope);
        if (!exactKeys(fields, command === 'createSplitView' ? ['target'] : [])) fail('INVALID_REQUEST', 'Invalid Split fields.');
        const payload = validateSplitPayload(command, { context: scope.context, ...fields });
        if (source.tabId !== scope.context.sourceTabId || source.windowId !== scope.context.windowId) stale();
        if (command === 'createSplitView' && !scope.targets.some(tab => sameSplitContext(tab, fields.target))) stale();
        return this.bridge.serializeAction(async () => {
            const fresh = await this.read(source, scope);
            if (!fresh) fail('UNSUPPORTED', 'This Arcify build does not support Split.');
            if (!sameSplitContext(fresh.context, scope.context) || command === 'createSplitView' && !fresh.targets.some(tab => sameSplitContext(tab, fields.target))) stale();
            await this.check(fresh);
            await beforeDispatch();
            // One combined persisted read is the final local authority boundary.
            // Do not follow it with a peer-only read that could hide generation drift.
            const stored = await this.api.storage.local.get([PEER_KEY, PAIRING_GENERATION_KEY]);
            if ((stored[PEER_KEY] || null) !== fresh.peerId || (stored[PAIRING_GENERATION_KEY] ?? null) !== fresh.generation)
                fail('DISCONNECTED', 'Arcify pairing changed. Refresh Spotlight.');
            if (fresh.epoch !== this.epoch) stale();
            // Mutations are sent once. Native events caused by this operation may
            // advance the epoch; only the exact receipt may establish success.
            const response = await this.send(fresh.peerId, command, { ...payload, windowId: source.windowId, supportedFeatures: FEATURES }, { role: 'arcify', timeout: this.bridge.timeoutMs });
            await this.check(fresh);
            if (!exactKeys(response, [...ENVELOPE, 'snapshot', 'splitResult'])) fail('INVALID_RESPONSE', 'Arcify did not confirm Split. Check Arcify before trying again.');
            const result = validateSplitResult(command, response.splitResult, scope.context, fields.target);
            const snapshot = validateSnapshot(response.snapshot, source.windowId, { allowOrdinaryFavorites: true });
            const members = command === 'createSplitView' ? [scope.context.tab, fields.target] : scope.context.pair;
            members.forEach(tab => confirmMember(snapshot, scope.context, tab, tab.id === source.tabId));
            return result;
        });
    }
}

/** A source must be the browser-attested, focused active content tab itself. */
export async function resolveSplitActionSource(api, message, sender) {
    if (sender?.id !== api.runtime.id || !isWindowId(sender.tab?.id) || sender.frameId && sender.frameId !== 0 ||
        sender.documentLifecycle && sender.documentLifecycle !== 'active' || message.tabId !== undefined && message.tabId !== sender.tab.id)
        fail('UNAUTHORIZED', 'Open Spotlight on the exact content tab to use Split.');
    const tab = await api.tabs.get(sender.tab.id);
    if (!isWindowId(tab?.windowId) || tab.id !== sender.tab.id || sender.tab.windowId !== tab.windowId || !tab.active || tab.pendingUrl ||
        tab.status === 'loading' || !isSplitContentUrl(tab.url) || tab.pinned) stale();
    const window = await api.windows.get(tab.windowId);
    if (window?.id !== tab.windowId || window.focused !== true) stale();
    return { windowId: tab.windowId, tabId: tab.id };
}
export function installArcifySplitActionMessages(api, bridge) {
    const client = new ArcifySplitActionsClient(api, bridge), registrations = [];
    const listen = (event, callback) => { if (event?.addListener) { event.addListener(callback); registrations.push(() => event.removeListener?.(callback)); } };
    // Local revocation/re-pairing is independent of Arcify's generation. Fence
    // same-peer ABA even when persisted values have returned to their old state.
    listen(api.storage?.onChanged, (changes, area) => {
        if (area === 'local' && [PEER_KEY, PAIRING_GENERATION_KEY].some(key => Object.hasOwn(changes, key))) client.invalidate();
    });
    // Conservatively retire captured views even if a native change is reverted.
    for (const name of ['onCreated', 'onRemoved', 'onActivated', 'onAttached', 'onDetached', 'onMoved', 'onReplaced']) listen(api.tabs[name], () => client.invalidate());
    listen(api.tabs.onUpdated, (id, change) => { if (['status', 'url', 'title', 'pinned', 'groupId', 'splitViewId'].some(key => Object.hasOwn(change, key))) client.invalidate(); });
    listen(api.windows?.onFocusChanged, () => client.invalidate());
    listen(api.tabGroups?.onUpdated, () => client.invalidate());
    const listener = (message, sender, respond) => {
        if (!['arcifySplitActionsContext', 'arcifySplitAction'].includes(message?.action)) return false;
        (async () => {
            try {
                const keys = message.action === 'arcifySplitActionsContext' ? ['action'] : ['action', 'command', 'scope', 'fields'];
                if (!exactKeys(message, [...keys, ...(Object.hasOwn(message, 'tabId') ? ['tabId'] : [])])) fail('INVALID_REQUEST', 'Invalid Spotlight Split request.');
                const epoch = client.epoch, source = await resolveSplitActionSource(api, message, sender);
                const checkSource = async () => {
                    const live = await resolveSplitActionSource(api, message, sender);
                    if (!sameSplitContext(live, source) || epoch !== client.epoch) stale();
                };
                if (message.action === 'arcifySplitActionsContext') {
                    const scope = await client.read(source); await checkSource(); respond({ success: true, scope });
                } else {
                    if (!SPLIT_ACTION_COMMANDS.includes(message.command)) fail('INVALID_REQUEST', 'Invalid Split command.');
                    const result = await client.execute(source, message.scope, message.command, message.fields, async () => {
                        const context = message.scope.context;
                        const descriptors = message.command === 'createSplitView' ? [context.tab, message.fields.target] : context.pair;
                        for (const expected of descriptors) {
                            const tab = await api.tabs.get(expected.id);
                            // Titles are Arcify-projected (including Today aliases), not native page titles.
                            const expectedNative = { ...expected }; delete expectedNative.title;
                            const descriptor = tab && { id: tab.id, url: tab.url, index: tab.index,
                                groupId: tab.groupId, pinned: tab.pinned, splitViewId: tab.splitViewId ?? -1 };
                            if (!tab || tab.windowId !== source.windowId || tab.pendingUrl || tab.status === 'loading' || !sameSplitContext(descriptor, expectedNative)) stale();
                        }
                        await checkSource();
                    });
                    respond({ success: true, result });
                }
            } catch (error) { respond({ success: false, error: error.message, errorCode: error.code || 'FAILED' }); }
        })();
        return true;
    };
    listen(api.runtime.onMessage, listener);
    return () => registrations.forEach(remove => remove());
}
