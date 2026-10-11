/** Route navigation through Arcify only while explicitly configured. */
import { ArcifyBridgeError } from './arcify-bridge.js';
import { ResultType, SpotlightTabMode } from './search-types.js';

export async function handleBridgeResult(bridge, api, result, mode, context) {
    const peerId = await bridge.getPeerId();
    if (!peerId) {
        if (result.metadata?.arcifyBridge) throw new ArcifyBridgeError('STALE_RESULT', 'Arcify was disconnected. Search again before selecting this result.');
        return false;
    }
    if (!['current-tab', 'new-tab'].includes(mode)) throw new ArcifyBridgeError('INVALID_MODE', 'Unknown Spotlight navigation mode.');
    return bridge.serializeAction(async () => {
        if (await bridge.getPeerId() !== peerId) throw new ArcifyBridgeError('DISCONNECTED', 'Arcify pairing changed. Search again.');
        const { windowId, tabId } = context;
        const snapshot = await bridge.snapshot(windowId, peerId);
        if (!snapshot) throw new ArcifyBridgeError('DISCONNECTED', 'Arcify connection changed. Try again.');
        const owner = result.metadata?.arcifyBridge;
        if (owner?.peerId && owner.peerId !== peerId) throw new ArcifyBridgeError('STALE_RESULT', 'Arcify pairing changed. Search again.');
        if (owner && owner.windowId !== windowId) {
            throw new ArcifyBridgeError('WRONG_WINDOW', 'This result belongs to another browser window. Search again.');
        }
        let command;
        let payload;
        if (owner?.kind === 'space') {
            command = 'activateSpace'; payload = { spaceId: owner.spaceId };
        } else if (owner?.kind === 'bookmark') {
            command = 'openBookmark'; payload = { spaceId: owner.spaceId, bookmarkId: owner.bookmarkId };
        } else if (owner?.kind === 'tab' || result.type === ResultType.OPEN_TAB || result.type === ResultType.PINNED_TAB) {
            const selectedId = owner?.tabId ?? result.metadata?.tabId;
            if (!snapshot.tabs.some(tab => tab.id === selectedId)) {
                throw new ArcifyBridgeError('STALE_RESULT', 'That tab is no longer in this window. Search again.');
            }
            command = 'activateTab'; payload = { tabId: selectedId };
        } else if (result.type === ResultType.SEARCH_QUERY ||
            (result.type === ResultType.AUTOCOMPLETE_SUGGESTION && !result.metadata?.isUrl)) {
            const query = result.metadata?.query;
            if (typeof query !== 'string' || !query.trim()) throw new ArcifyBridgeError('INVALID_QUERY', 'Search text is missing.');
            const response = mode === SpotlightTabMode.NEW_TAB
                ? await bridge.request('openTab', windowId, { url: 'about:blank' }, peerId)
                : await bridge.request('navigateTab', windowId, { tabId, url: 'about:blank' }, peerId);
            if (!Number.isSafeInteger(response?.tabId)) throw new ArcifyBridgeError('INVALID_RESPONSE', 'Arcify did not identify the search tab.');
            await api.search.query({ text: query, tabId: response.tabId });
            return { handled: true, command: 'search', tabId: response.tabId };
        } else {
            if (typeof result.url !== 'string' || !result.url) throw new ArcifyBridgeError('INVALID_URL', 'The selected result has no URL.');
            command = mode === SpotlightTabMode.NEW_TAB ? 'openTab' : 'navigateTab';
            payload = command === 'openTab' ? { url: result.url } : { tabId, url: result.url };
        }
        const response = await bridge.request(command, windowId, payload, peerId);
        if (!response) throw new ArcifyBridgeError('DISCONNECTED', 'Arcify connection changed. Try again.');
        return { handled: true, command, tabId: response.tabId };
    });
}
