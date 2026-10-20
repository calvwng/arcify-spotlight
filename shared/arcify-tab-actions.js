/** Background-only optional action adapter. Never falls through to native mutation. */
import { validateSnapshot } from './arcify-bridge.js';
import { resolveSpaceActionSource } from './arcify-space-actions.js';
import { GLOBAL_FAVORITES_FEATURE, PEER_KEY, PAIRING_GENERATION_KEY, bridgeError, sendBridgeRequest } from './arcify-bridge-protocol.js';
import { isActionId } from './arcify-space-actions-protocol.js';
import { TAB_ACTIONS_FEATURE, TAB_ACTION_COMMANDS, exactKeys, validateTabActionContext, validateTabActionScope, validateTabActionPayload, sameTabActionContext, tabActionFields, tabActionResultFields, validateTabActionResult } from './arcify-tab-actions-protocol.js';
const fail = (code, message) => { throw bridgeError(code, message); };
export class ArcifyTabActionsClient {
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
        for (const features of [[GLOBAL_FAVORITES_FEATURE, TAB_ACTIONS_FEATURE], [GLOBAL_FAVORITES_FEATURE], null]) {
            try { hello = await this.call(pairing, 'hello', { windowId, ...(features ? { supportedFeatures: features } : {}) }); break; }
            catch (error) { if (error.code !== 'INVALID_REQUEST' || features === null) throw error; }
        }
        if (hello.extensionId !== pairing.peerId || hello.capabilities !== undefined && (!Array.isArray(hello.capabilities) ||
            hello.capabilities.some(value => !isActionId(value)) || new Set(hello.capabilities).size !== hello.capabilities.length)) fail('INVALID_RESPONSE', 'Arcify returned invalid action capabilities.');
        validateSnapshot(hello.snapshot, windowId, { allowOrdinaryFavorites: hello.capabilities?.includes(GLOBAL_FAVORITES_FEATURE) });
        return hello;
    }
    async read(source, expectedScope = null, inspectSnapshot = () => {}) {
        const pairing = await this.pairing();
        if (expectedScope && (pairing.peerId !== expectedScope.peerId || pairing.generation !== expectedScope.generation)) fail('DISCONNECTED', 'Arcify pairing changed. Refresh Spotlight.');
        if (!pairing.peerId) return null;
        const hello = await this.hello(pairing, source.windowId);
        if (!hello.capabilities?.includes(TAB_ACTIONS_FEATURE)) return null;
        const response = await this.call(pairing, 'tabActionContext', { windowId: source.windowId, tabId: source.tabId,
            supportedFeatures: [GLOBAL_FAVORITES_FEATURE, TAB_ACTIONS_FEATURE] });
        const keys = ['type', 'version', 'requestId', 'role', 'ok', 'extensionId', 'snapshot', 'tabActionContext'];
        if (!exactKeys(response, keys) || response.extensionId !== pairing.peerId) fail('INVALID_RESPONSE', 'Arcify did not confirm the action context.');
        validateSnapshot(response.snapshot, source.windowId, { allowOrdinaryFavorites: hello.capabilities.includes(GLOBAL_FAVORITES_FEATURE) });
        const context = validateTabActionContext(response.tabActionContext, source.windowId, source.tabId);
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
        inspectSnapshot(response.snapshot);
        return { ...pairing, context };
    }
    async execute(source, scope, command, fields, beforeDispatch = async () => {}) {
        validateTabActionScope(scope);
        const fieldKeys = tabActionFields(command);
        if (!exactKeys(fields, fieldKeys)) fail('INVALID_REQUEST', 'Invalid Arcify action fields.');
        const payload = validateTabActionPayload(command, { context: scope.context, ...fields });
        return this.bridge.serializeAction(async () => {
            let priorTabIds;
            const fresh = await this.read(source, scope, snapshot => { priorTabIds = new Set(snapshot.tabs.map(tab => tab.id)); });
            if (!fresh) fail('UNSUPPORTED', 'This Arcify build does not support tab actions. Update both extensions.');
            if (!sameTabActionContext(fresh.context, scope.context)) fail('STALE_CONTEXT', 'The selected Space or current tab changed. Refresh Spotlight and choose the action again.');
            await beforeDispatch();
            const response = await this.call(fresh, command, { ...payload, windowId: source.windowId,
                supportedFeatures: [GLOBAL_FAVORITES_FEATURE, TAB_ACTIONS_FEATURE] });
            const identityKeys = tabActionResultFields(command);
            if (!exactKeys(response, ['type', 'version', 'requestId', 'role', 'ok', 'snapshot', ...identityKeys])) fail('INVALID_RESPONSE', 'Arcify did not confirm this tab action. Check its state before trying again.');
            const result = { command, ...Object.fromEntries(identityKeys.map(key => [key, response[key]])) };
            validateTabActionResult(command, result, scope.context, fields);
            validateSnapshot(response.snapshot, source.windowId, { allowOrdinaryFavorites: true });
            if (command === 'duplicateCurrentTab') {
                const duplicate = response.snapshot.tabs.find(tab => tab.id === result.tabId);
                const space = response.snapshot.spaces.find(item => item.id === scope.context.spaceId);
                if (priorTabIds.has(result.tabId) || !duplicate || duplicate.windowId !== source.windowId || duplicate.spaceId !== scope.context.spaceId || duplicate.pinned ||
                    space?.bookmarkFolderId !== scope.context.bookmarkFolderId || !space.temporaryTabIds.includes(result.tabId) ||
                    response.snapshot.favorites?.some(favorite => favorite.tabId === result.tabId))
                    fail('INVALID_RESPONSE', 'Arcify did not confirm the duplicate in this Space’s Today tabs. Check Arcify before trying again.');
            }
            return result;
        });
    }
}

// Reuse the exact browser-attested source boundary; never query another tab.
export const resolveTabActionSource = resolveSpaceActionSource;
export function installArcifyTabActionMessages(api, bridge, sourceOptions = {}) {
    const client = new ArcifyTabActionsClient(api, bridge);
    const listener = (message, sender, respond) => {
        if (!['arcifyTabActionsContext', 'arcifyTabAction'].includes(message?.action)) return false;
        (async () => {
            try {
                const keys = message.action === 'arcifyTabActionsContext' ? ['action'] : ['action', 'command', 'scope', 'fields'];
                if (!exactKeys(message, [...keys, ...(Object.hasOwn(message, 'tabId') ? ['tabId'] : [])])) fail('INVALID_REQUEST', 'Invalid Spotlight action request.');
                const source = await resolveTabActionSource(api, message, sender, sourceOptions);
                if (message.action === 'arcifyTabActionsContext') {
                    const scope = await client.read(source);
                    // Source may move while the companion is answering.
                    const live = await resolveTabActionSource(api, message, sender, sourceOptions);
                    if (live.windowId !== source.windowId) fail('STALE_CONTEXT', 'The source tab moved. Reopen Spotlight.');
                    respond({ success: true, scope });
                } else {
                    if (!TAB_ACTION_COMMANDS.includes(message.command) || !message.fields || typeof message.fields !== 'object' || Array.isArray(message.fields)) fail('INVALID_REQUEST', 'Invalid Spotlight action.');
                    const result = await client.execute(source, message.scope, message.command, message.fields, async () => {
                        const live = await resolveTabActionSource(api, message, sender, sourceOptions);
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
