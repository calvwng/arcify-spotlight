import { isRoutedUrlSubmission } from './routed-open-source.js';
/** Route navigation through Arcify only while explicitly configured. */
import { ArcifyBridgeError } from './arcify-bridge.js';
import { ResultType, SpotlightTabMode } from './search-types.js';
import { isSafeUrl, isFavoriteUrl } from './arcify-bridge-protocol.js';
import { normalizeBrowserPageUrl } from './browser-page-url.js';

export async function handleBridgeResult(bridge, api, result, mode, context) {
    const peerId = await bridge.getPeerId();
    if (!peerId) {
        if (result.metadata?.arcifyBridge || result.type === ResultType.SAVED_FAVORITE) throw new ArcifyBridgeError('STALE_RESULT', 'Arcify was disconnected. Search again before selecting this result.');
        return false;
    }
    if (!['current-tab', 'new-tab'].includes(mode)) throw new ArcifyBridgeError('INVALID_MODE', 'Unknown Spotlight navigation mode.');
    return bridge.serializeAction(async () => {
        if (await bridge.getPeerId() !== peerId) throw new ArcifyBridgeError('DISCONNECTED', 'Arcify pairing changed. Search again.');
        const { windowId, tabId } = context;
        const owner = result.metadata?.arcifyBridge;
        const isSearch = result.type === ResultType.SEARCH_QUERY ||
            (result.type === ResultType.AUTOCOMPLETE_SUGGESTION && !result.metadata?.isUrl);
        // Owned selections and current-tab searches need a snapshot here to check
        // their identity. Ordinary navigation/new-tab searches do not consume it:
        // request() already performs a fresh authenticated hello, validates its
        // snapshot and checks pairing generation before dispatching the mutation.
        // Avoid a second full workspace reconciliation on those submit paths.
        const needsSnapshot = owner || [ResultType.SAVED_FAVORITE, ResultType.OPEN_TAB, ResultType.PINNED_TAB].includes(result.type) ||
            isSearch && mode === SpotlightTabMode.CURRENT_TAB;
        const snapshot = needsSnapshot ? await bridge.snapshot(windowId, peerId) : null;
        if (needsSnapshot && !snapshot) throw new ArcifyBridgeError('DISCONNECTED', 'Arcify connection changed. Try again.');
        if (owner?.peerId && owner.peerId !== peerId) throw new ArcifyBridgeError('STALE_RESULT', 'Arcify pairing changed. Search again.');
        if (owner && owner.windowId !== windowId) {
            throw new ArcifyBridgeError('WRONG_WINDOW', 'This result belongs to another browser window. Search again.');
        }
        let command;
        let payload;
        if (owner?.kind === 'remoteToday') {
            const row = snapshot.sharedToday?.find(row => row.id === owner.tabId && row.windowId === owner.ownerWindowId && row.spaceId === owner.spaceId && row.bookmarkFolderId === owner.bookmarkFolderId);
            if (!row || row.windowId === windowId) throw new ArcifyBridgeError('STALE_RESULT', 'This shared Today tab changed. Search again.');
            command = 'openSharedToday'; payload = { tabId: row.id, ownerWindowId: row.windowId, spaceId: row.spaceId, bookmarkFolderId: row.bookmarkFolderId };
        } else if (owner?.kind === 'favorite' || result.type === ResultType.SAVED_FAVORITE) {
            if (result.type !== ResultType.SAVED_FAVORITE || owner?.kind !== 'favorite' || owner.peerId !== peerId ||
                typeof owner.favoriteId !== 'string' || !owner.favoriteId || owner.favoriteId.length > 200 ||
                Object.keys(owner).some(key => !['kind', 'peerId', 'windowId', 'favoriteId'].includes(key)) ||
                result.metadata.favoriteId !== owner.favoriteId) {
                throw new ArcifyBridgeError('INVALID_RESULT', 'This saved Favorite result is invalid. Search again.');
            }
            if (!Array.isArray(snapshot.favorites)) {
                throw new ArcifyBridgeError('UNSUPPORTED', 'This Arcify build does not support saved Favorites. Update both extensions.');
            }
            const favorite = snapshot.favorites.find(item => item.id === owner.favoriteId);
            if (!favorite) throw new ArcifyBridgeError('STALE_RESULT', 'That Favorite was removed. Search again.');
            if (!isFavoriteUrl(favorite.url)) throw new ArcifyBridgeError('UNSUPPORTED_URL', 'This saved Favorite address cannot be opened.');
            let source;
            try { source = await api.tabs.get(tabId); }
            catch { throw new ArcifyBridgeError('STALE_TAB', 'The current tab closed. Search again.'); }
            if (source?.windowId !== windowId) throw new ArcifyBridgeError('WRONG_WINDOW', 'The current tab moved to another window. Search again.');
            command = 'openFavorite'; payload = { favoriteId: favorite.id };
        } else if (owner?.kind === 'space') {
            command = 'activateSpace'; payload = { spaceId: owner.spaceId };
        } else if (owner?.kind === 'bookmark') {
            command = 'openBookmark'; payload = { spaceId: owner.spaceId, bookmarkId: owner.bookmarkId };
        } else if (owner?.kind === 'tab' || result.type === ResultType.OPEN_TAB || result.type === ResultType.PINNED_TAB) {
            const selectedId = owner?.tabId ?? result.metadata?.tabId;
            if (!snapshot.tabs.some(tab => tab.id === selectedId)) {
                throw new ArcifyBridgeError('STALE_RESULT', 'That tab is no longer in this window. Search again.');
            }
            command = 'activateTab'; payload = { tabId: selectedId };
        } else if (isSearch) {
            const query = result.metadata?.query;
            if (typeof query !== 'string' || !query.trim()) throw new ArcifyBridgeError('INVALID_QUERY', 'Search text is missing.');
            let searchTabId;
            if (mode === SpotlightTabMode.NEW_TAB) {
                const response = await bridge.request('openTab', windowId, { url: 'about:blank' }, peerId);
                if (!Number.isSafeInteger(response?.tabId)) throw new ArcifyBridgeError('INVALID_RESPONSE', 'Arcify did not identify the search tab.');
                searchTabId = response.tabId;
            } else {
                // The fresh, authenticated Arcify snapshot above authorizes this
                // exact source tab. Do not blank the page while awaiting a bridge
                // round trip: a timeout must leave it intact with its error UI.
                if (!snapshot.tabs.some(tab => tab.id === tabId && tab.windowId === windowId)) {
                    throw new ArcifyBridgeError('STALE_TAB', 'The current tab is no longer in this window. Search again.');
                }
                let current;
                try { current = await api.tabs.get(tabId); }
                catch { throw new ArcifyBridgeError('STALE_TAB', 'The current tab closed. Search again.'); }
                if (current.windowId !== windowId) throw new ArcifyBridgeError('WRONG_WINDOW', 'The current tab moved to another window. Search again.');
                searchTabId = tabId;
            }
            if (await bridge.getPeerId() !== peerId) throw new ArcifyBridgeError('DISCONNECTED', 'Arcify pairing changed before the search. Search again.');
            // One final navigation, using Spotlight's existing search permission.
            await api.search.query({ text: query, tabId: searchTabId });
            return { handled: true, command: 'search', tabId: searchTabId };
        } else {
            if (typeof result.url !== 'string' || !result.url) throw new ArcifyBridgeError('INVALID_URL', 'The selected result has no URL.');
            // A result can outlive its provider/filter. Keep the same navigation
            // allowlist as Arcify and fail before dispatch, without native fallback.
            if (!isSafeUrl(result.url)) throw new ArcifyBridgeError('UNSUPPORTED_URL', 'This address cannot be opened through the Arcify connection. Choose another result.');
            command = mode === SpotlightTabMode.NEW_TAB ? 'openTab' : 'navigateTab';
            const url = normalizeBrowserPageUrl(result.url) ?? result.url;
            payload = command === 'openTab' ? { url } : { tabId, url };
            if (context.routing && isRoutedUrlSubmission(result, mode)) {
                if (context.routing.windowId !== windowId || context.routing.source.tabId !== tabId)
                    throw new ArcifyBridgeError('STALE_ROUTING_SOURCE', 'The original Spotlight page changed.');
                await context.routing.check();
                command = 'openRoutedTab'; payload = {url, source:context.routing.source};
            }
        }
        const response = await (command === 'openRoutedTab'
            ? bridge.request(command, windowId, payload, peerId, context.routing)
            : bridge.request(command, windowId, payload, peerId));
        if (!response) throw new ArcifyBridgeError('DISCONNECTED', 'Arcify connection changed. Try again.');
        return { handled: true, command, tabId: response.tabId };
    });
}
