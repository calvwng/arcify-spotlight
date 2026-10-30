/** Background-only Archive adapter; no native mutation or uncertain-action replay. */
import { validateSnapshot } from './arcify-bridge.js';
import { resolveSpaceActionSource } from './arcify-space-actions.js';
import { GLOBAL_FAVORITES_FEATURE, PEER_KEY, PAIRING_GENERATION_KEY, bridgeError, sendBridgeRequest } from './arcify-bridge-protocol.js';
import { ARCHIVE_ACTIONS_FEATURE, archiveId, exactKeys, validateArchiveActions, validateArchiveScope, validateArchiveResult } from './arcify-archive-actions-protocol.js';
const fail = (code, message) => { throw bridgeError(code, message); };
const FEATURES = [GLOBAL_FAVORITES_FEATURE, ARCHIVE_ACTIONS_FEATURE];
const ENVELOPE = ['type', 'version', 'requestId', 'role', 'ok'];
export class ArcifyArchiveActionsClient {
    constructor(api, bridge, send = sendBridgeRequest) { this.api = api; this.bridge = bridge; this.send = send; this.attempted = new Set(); }
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
        let hello;
        // Legacy fallback is read-only; never retry a mutation.
        for (const features of [FEATURES, [GLOBAL_FAVORITES_FEATURE], null]) {
            try { hello = await this.call(pairing, 'hello', { windowId, ...(features ? { supportedFeatures: features } : {}) }); break; }
            catch (error) { if (error.code !== 'INVALID_REQUEST' || features === null) throw error; }
        }
        if (!exactKeys(hello, [...ENVELOPE, 'extensionId', 'snapshot', ...(Object.hasOwn(hello || {}, 'capabilities') ? ['capabilities'] : [])]) ||
            hello.extensionId !== pairing.peerId || hello.capabilities !== undefined && (!Array.isArray(hello.capabilities) ||
            hello.capabilities.some(value => !archiveId(value)) || new Set(hello.capabilities).size !== hello.capabilities.length))
            fail('INVALID_RESPONSE', 'Arcify returned invalid Archive capabilities.');
        validateSnapshot(hello.snapshot, windowId, { allowOrdinaryFavorites: hello.capabilities?.includes(GLOBAL_FAVORITES_FEATURE) });
        return hello;
    }
    async sourceCheck(source, context) {
        if (source.windowId !== context.windowId || source.tabId !== context.sourceTabId) fail('STALE_CONTEXT', 'The Archive source changed. Reopen Spotlight.');
        const tab = await this.api.tabs.get(source.tabId);
        if (tab?.id !== source.tabId || tab.windowId !== source.windowId || !tab.active || tab.pendingUrl || tab.status === 'loading' || tab.url !== context.sourceUrl)
            fail('STALE_CONTEXT', 'The Archive source changed. Reopen Spotlight.');
    }
    async read(source, inspectSnapshot = () => {}) {
        const pairing = await this.pairing();
        if (!pairing.peerId) return null;
        const hello = await this.hello(pairing, source.windowId);
        if (!hello.capabilities?.includes(ARCHIVE_ACTIONS_FEATURE)) return null;
        const response = await this.call(pairing, 'archiveContext', { windowId: source.windowId, tabId: source.tabId, supportedFeatures: FEATURES });
        if (!exactKeys(response, [...ENVELOPE, 'extensionId', 'snapshot', 'archiveActions']) || response.extensionId !== pairing.peerId)
            fail('INVALID_RESPONSE', 'Arcify did not confirm the Archive context.');
        const snapshot = validateSnapshot(response.snapshot, source.windowId, { allowOrdinaryFavorites: hello.capabilities.includes(GLOBAL_FAVORITES_FEATURE) });
        const actions = validateArchiveActions(response.archiveActions, source.windowId, source.tabId);
        const current = snapshot.spaces.find(space => space.id === actions.context.spaceId);
        if (snapshot.activeSpaceId !== current?.id || current.bookmarkFolderId !== actions.context.bookmarkFolderId)
            fail('INVALID_RESPONSE', 'Arcify returned the wrong selected Space.');
        const sourceTab = snapshot.tabs.find(tab => tab.id === source.tabId);
        if (sourceTab && (!sourceTab.active || sourceTab.url !== actions.context.sourceUrl))
            fail('INVALID_RESPONSE', 'Arcify returned conflicting source-tab context.');
        for (const entry of actions.entries) {
            if (snapshot.spaces.find(space => space.id === entry.spaceId)?.bookmarkFolderId !== entry.bookmarkFolderId)
                fail('INVALID_RESPONSE', 'Arcify returned an archived entry from an unknown Space.');
        }
        await this.sourceCheck(source, actions.context);
        await this.check(pairing);
        inspectSnapshot(snapshot);
        return validateArchiveScope({ ...pairing, ...actions });
    }
    async execute(source, scope, entryId, beforeDispatch = async () => {}) {
        validateArchiveScope(scope);
        if (!archiveId(entryId) || !scope.entries.some(entry => entry.entryId === entryId)) fail('INVALID_REQUEST', 'Choose an exact archived entry.');
        return this.bridge.serializeAction(async () => {
            // Reading archiveContext here would rotate its private view/token.
            // Check only browser-attested source and pairing; Arcify owns context validation.
            await beforeDispatch();
            await this.sourceCheck(source, scope.context);
            await this.check(scope);
            const key = JSON.stringify([scope.peerId, scope.generation, scope.viewId, entryId]);
            if (this.attempted.has(key)) fail('ALREADY_ATTEMPTED', 'This archived entry was already requested. Check Arcify before trying again.');
            if (this.attempted.size >= 2000) fail('UNAVAILABLE', 'Reload Spotlight before requesting more Archive actions.');
            this.attempted.add(key);
            const response = await this.call(scope, 'reopenArchivedTab', { windowId: source.windowId, context: scope.context, viewId: scope.viewId, entryId, supportedFeatures: FEATURES });
            if (!exactKeys(response, [...ENVELOPE, 'snapshot', 'archiveResult'])) fail('INVALID_RESPONSE', 'Arcify did not confirm this archived entry. Check Arcify before trying again.');
            const result = validateArchiveResult(response.archiveResult, scope, entryId);
            const snapshot = validateSnapshot(response.snapshot, source.windowId, { allowOrdinaryFavorites: true });
            if (result.status === 'reopened') {
                const entry = scope.entries.find(item => item.entryId === entryId);
                const target = snapshot.spaces.find(space => space.id === entry.spaceId);
                const tab = snapshot.tabs.find(item => item.id === result.tabId);
                if (snapshot.activeSpaceId !== entry.spaceId || target?.bookmarkFolderId !== entry.bookmarkFolderId || !target.temporaryTabIds.includes(result.tabId) ||
                    !tab?.active || tab.windowId !== source.windowId || tab.spaceId !== entry.spaceId || tab.pinned ||
                    snapshot.favorites?.some(favorite => favorite.tabId === result.tabId))
                    fail('INVALID_RESPONSE', 'Arcify did not confirm the reopened tab in its original Space. Check Arcify before trying again.');
            }
            return result;
        });
    }
}
export const resolveArchiveSource = resolveSpaceActionSource;
export function installArcifyArchiveMessages(api, bridge, sourceOptions = {}) {
    const client = new ArcifyArchiveActionsClient(api, bridge);
    const listener = (message, sender, respond) => {
        if (!['arcifyArchiveContext', 'arcifyArchiveReopen'].includes(message?.action)) return false;
        (async () => {
            try {
                const keys = message.action === 'arcifyArchiveContext' ? ['action'] : ['action', 'scope', 'entryId'];
                if (!exactKeys(message, [...keys, ...(Object.hasOwn(message, 'tabId') ? ['tabId'] : [])])) fail('INVALID_REQUEST', 'Invalid Spotlight Archive request.');
                const source = await resolveArchiveSource(api, message, sender, sourceOptions);
                if (message.action === 'arcifyArchiveContext') {
                    let spaceNames = [];
                    const scope = await client.read(source, snapshot => { spaceNames = snapshot.spaces.map(space => ({ spaceId: space.id, name: space.name })); });
                    const live = await resolveArchiveSource(api, message, sender, sourceOptions);
                    if (live.windowId !== source.windowId) fail('STALE_CONTEXT', 'The source tab moved. Reopen Spotlight.');
                    respond({ success: true, scope, spaceNames });
                } else {
                    const result = await client.execute(source, message.scope, message.entryId, async () => {
                        const live = await resolveArchiveSource(api, message, sender, sourceOptions);
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
