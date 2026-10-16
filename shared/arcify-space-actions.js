/** Background-only optional action adapter. Never falls through to native mutation. */
import { validateSnapshot } from './arcify-bridge.js';
import { isBrowserNewTabAlias } from './active-newtab-reuse.js';
import { GLOBAL_FAVORITES_FEATURE, PEER_KEY, PAIRING_GENERATION_KEY, bridgeError, isWindowId, sendBridgeRequest } from './arcify-bridge-protocol.js';
import { SPACE_ACTIONS_FEATURE, SPACE_ACTION_COMMANDS, exactKeys, isActionId, validateActionContext, validateActionScope, validateActionPayload, sameActionContext } from './arcify-space-actions-protocol.js';
const fail = (code, message) => { throw bridgeError(code, message); };
export class ArcifySpaceActionsClient {
    constructor(api, bridge, send = sendBridgeRequest) { this.api = api; this.bridge = bridge; this.send = send; }
    async pairing() {
        const stored = await this.api.storage.local.get([PEER_KEY, PAIRING_GENERATION_KEY]);
        const peerId = await this.bridge.getPeerId();
        if ((stored[PEER_KEY] || null) !== peerId) fail('DISCONNECTED', 'Arcify pairing changed. Refresh Spotlight.');
        return { peerId, generation: stored[PAIRING_GENERATION_KEY] ?? null };
    }
    async check(pairing) {
        const current = await this.pairing();
        if (current.peerId !== pairing.peerId || current.generation !== pairing.generation) fail('DISCONNECTED', 'Arcify pairing changed. Refresh Spotlight.');
    }
    async call(pairing, command, payload) {
        await this.check(pairing);
        const response = await this.send(pairing.peerId, command, payload, { role: 'arcify', timeout: this.bridge.timeoutMs });
        await this.check(pairing);
        return response;
    }
    async hello(pairing, windowId) {
        // Only read-only negotiation is retried; no action is replayed on any error.
        let hello;
        for (const features of [[GLOBAL_FAVORITES_FEATURE, SPACE_ACTIONS_FEATURE], [GLOBAL_FAVORITES_FEATURE], null]) {
            try { hello = await this.call(pairing, 'hello', { windowId, ...(features ? { supportedFeatures: features } : {}) }); break; }
            catch (error) { if (error.code !== 'INVALID_REQUEST' || features === null) throw error; }
        }
        if (hello.extensionId !== pairing.peerId || hello.capabilities !== undefined && (!Array.isArray(hello.capabilities) ||
            hello.capabilities.some(value => !isActionId(value)) || new Set(hello.capabilities).size !== hello.capabilities.length)) fail('INVALID_RESPONSE', 'Arcify returned invalid action capabilities.');
        validateSnapshot(hello.snapshot, windowId, { allowOrdinaryFavorites: hello.capabilities?.includes(GLOBAL_FAVORITES_FEATURE) });
        return hello;
    }
    async read(source, expectedScope = null) {
        const pairing = await this.pairing();
        if (expectedScope && (pairing.peerId !== expectedScope.peerId || pairing.generation !== expectedScope.generation)) fail('DISCONNECTED', 'Arcify pairing changed. Refresh Spotlight.');
        if (!pairing.peerId) return null;
        const hello = await this.hello(pairing, source.windowId);
        if (!hello.capabilities?.includes(SPACE_ACTIONS_FEATURE)) return null;
        const response = await this.call(pairing, 'actionContext', { windowId: source.windowId, tabId: source.tabId,
            supportedFeatures: [GLOBAL_FAVORITES_FEATURE, SPACE_ACTIONS_FEATURE] });
        const keys = ['type', 'version', 'requestId', 'role', 'ok', 'extensionId', 'snapshot', 'actionContext'];
        if (!exactKeys(response, keys) || response.extensionId !== pairing.peerId) fail('INVALID_RESPONSE', 'Arcify did not confirm the action context.');
        validateSnapshot(response.snapshot, source.windowId, { allowOrdinaryFavorites: hello.capabilities.includes(GLOBAL_FAVORITES_FEATURE) });
        const context = validateActionContext(response.actionContext, source.windowId, source.tabId);
        const space = response.snapshot.spaces.find(item => item.id === context.spaceId);
        if (context.spaceId !== response.snapshot.activeSpaceId || space?.bookmarkFolderId !== context.bookmarkFolderId)
            fail('INVALID_RESPONSE', 'Arcify returned the wrong selected Space.');
        if (context.tab) {
            const live = response.snapshot.tabs.find(tab => tab.id === context.sourceTabId);
            const members = context.tab.section === 'today' ? space.temporaryTabIds : space.pinnedTabIds;
            const bookmark = context.tab.bookmark && response.snapshot.bookmarks.find(item => item.id === context.tab.bookmark.id);
            if (!live?.active || live.spaceId !== space.id || live.url !== context.tab.url || live.title !== context.tab.title ||
                !members.includes(context.sourceTabId) || context.tab.bookmark && (!bookmark || bookmark.spaceId !== space.id ||
                    bookmark.url !== context.tab.bookmark.url || bookmark.title !== context.tab.bookmark.title))
                fail('INVALID_RESPONSE', 'Arcify returned conflicting tab or saved-pin context. Refresh Spotlight.');
        }
        return { ...pairing, context };
    }
    async execute(source, scope, command, fields, beforeDispatch = async () => {}) {
        validateActionScope(scope);
        const fieldKeys = command === 'createSpaceFolder' ? ['title'] : command === 'removeCurrentPin' ? ['confirmed'] : [];
        if (!exactKeys(fields, fieldKeys)) fail('INVALID_REQUEST', 'Invalid Arcify action fields.');
        const payload = validateActionPayload(command, { context: scope.context, ...fields });
        return this.bridge.serializeAction(async () => {
            const fresh = await this.read(source, scope);
            if (!fresh) fail('UNSUPPORTED', 'This Arcify build does not support Space actions. Update both extensions.');
            if (!sameActionContext(fresh.context, scope.context)) fail('STALE_CONTEXT', 'The selected Space or current tab changed. Refresh Spotlight and choose the action again.');
            await beforeDispatch();
            const response = await this.call(fresh, command, { ...payload, windowId: source.windowId,
                supportedFeatures: [GLOBAL_FAVORITES_FEATURE, SPACE_ACTIONS_FEATURE] });
            const identityKeys = command === 'createSpaceFolder' ? ['folderId'] : command === 'openSettings' ? ['tabId'] : ['tabId', 'bookmarkId'];
            if (!exactKeys(response, ['type', 'version', 'requestId', 'role', 'ok', 'snapshot', ...identityKeys]) ||
                identityKeys.some(key => key === 'tabId' ? !isWindowId(response[key]) : !isActionId(response[key])) ||
                ['pinCurrentTab', 'removeCurrentPin'].includes(command) && response.tabId !== source.tabId ||
                command === 'removeCurrentPin' && response.bookmarkId !== scope.context.tab.bookmark.id) fail('INVALID_RESPONSE', 'Arcify did not confirm the action. Check its state before trying again.');
            validateSnapshot(response.snapshot, source.windowId, { allowOrdinaryFavorites: true });
            return { command, ...Object.fromEntries(identityKeys.map(key => [key, response[key]])) };
        });
    }
}

/** Source identity must be browser-attested or an exact owned helper tab. No active/previous-tab guessing. */
export async function resolveSpaceActionSource(api, message, sender, { verifyHelper } = {}) {
    if (sender.id !== api.runtime.id || sender.frameId && sender.frameId !== 0 || sender.documentLifecycle && sender.documentLifecycle !== 'active') fail('UNAUTHORIZED', 'This action must come from Spotlight.');
    let tabId = sender.tab?.id;
    if (!tabId) {
        if (sender.url?.split(/[?#]/)[0] !== api.runtime.getURL('newtab.html') || !isWindowId(message.tabId)) fail('UNAUTHORIZED', 'Reopen Spotlight on the tab you want to use.');
        tabId = message.tabId;
    }
    if (message.tabId !== undefined && message.tabId !== tabId) fail('UNAUTHORIZED', 'The Spotlight source tab does not match.');
    const tab = await api.tabs.get(tabId);
    if (!isWindowId(tab?.windowId) || tab.id !== tabId || !tab.active || tab.pendingUrl || tab.status === 'loading' || sender.tab?.windowId && sender.tab.windowId !== tab.windowId) fail('STALE_CONTEXT', 'The source tab is no longer active in this window. Reopen Spotlight.');
    if (!sender.tab && tab.url?.split(/[?#]/)[0] !== api.runtime.getURL('newtab.html')) {
        // A browser New Tab alias is not proof of ownership. Reuse the existing
        // nonce challenge and independent Chrome-attested renderer ACK, with no
        // fallback creation/navigation. Never accept a URL/title match alone.
        if (!isBrowserNewTabAlias(tab.url) || !verifyHelper || !await verifyHelper(tab))
            fail('UNAUTHORIZED', 'The exact Spotlight helper could not be verified. Reopen Spotlight.');
    }
    return { windowId: tab.windowId, tabId };
}
export function installArcifySpaceActionMessages(api, bridge, sourceOptions = {}) {
    const client = new ArcifySpaceActionsClient(api, bridge);
    const listener = (message, sender, respond) => {
        if (!['arcifySpaceActionsContext', 'arcifySpaceAction'].includes(message?.action)) return false;
        (async () => {
            try {
                const keys = message.action === 'arcifySpaceActionsContext' ? ['action'] : ['action', 'command', 'scope', 'fields'];
                if (!exactKeys(message, [...keys, ...(Object.hasOwn(message, 'tabId') ? ['tabId'] : [])])) fail('INVALID_REQUEST', 'Invalid Spotlight action request.');
                const source = await resolveSpaceActionSource(api, message, sender, sourceOptions);
                if (message.action === 'arcifySpaceActionsContext') {
                    const scope = await client.read(source);
                    // Source may move while the companion is answering.
                    const live = await resolveSpaceActionSource(api, message, sender, sourceOptions);
                    if (live.windowId !== source.windowId) fail('STALE_CONTEXT', 'The source tab moved. Reopen Spotlight.');
                    respond({ success: true, scope });
                } else {
                    if (!SPACE_ACTION_COMMANDS.includes(message.command) || !message.fields || typeof message.fields !== 'object' || Array.isArray(message.fields)) fail('INVALID_REQUEST', 'Invalid Spotlight action.');
                    const result = await client.execute(source, message.scope, message.command, message.fields, async () => {
                        const live = await resolveSpaceActionSource(api, message, sender, sourceOptions);
                        if (live.windowId !== source.windowId) fail('STALE_CONTEXT', 'The source tab moved. Reopen Spotlight.');
                    });
                    respond({ success: true, result });
                }
            } catch (error) { respond({ success: false, error: error.message, errorCode: error.code || 'FAILED' }); }
        })();
        return true;
    };
    api.runtime.onMessage.addListener(listener);
    return () => api.runtime.onMessage.removeListener(listener);
}
