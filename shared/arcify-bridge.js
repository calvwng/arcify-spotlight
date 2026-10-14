/** Versioned, explicitly paired cross-extension transport. No workspace data is persisted. */
import { BRIDGE_TYPE, BRIDGE_VERSION, PEER_KEY, trustedSender, sendBridgeRequest, isFavoriteUrl } from './arcify-bridge-protocol.js';
export { BRIDGE_TYPE, BRIDGE_VERSION };
export const PEER_STORAGE_KEY = PEER_KEY;
export const EXTENSION_ID = /^[a-p]{32}$/;
export const BRIDGE_TIMEOUT_MS = 5000;

export class ArcifyBridgeError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'ArcifyBridgeError';
        this.code = code;
    }
}

const fail = (code, message) => { throw new ArcifyBridgeError(code, message); };
const positiveInt = value => Number.isSafeInteger(value) && value > 0;
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 4096;

export function validateSnapshot(snapshot, windowId) {
    if (!snapshot || snapshot.windowId !== windowId || !positiveInt(windowId) ||
        !Array.isArray(snapshot.spaces) || !Array.isArray(snapshot.tabs) ||
        !Array.isArray(snapshot.bookmarks) || !Number.isFinite(snapshot.capturedAt)) {
        fail('INVALID_RESPONSE', 'Arcify returned an invalid workspace snapshot.');
    }
    const spaces = new Set();
    const tabs = new Set();
    const bookmarks = new Set();
    for (const space of snapshot.spaces) {
        if (!text(space.id) || spaces.has(space.id) || typeof space.name !== 'string' ||
            typeof space.color !== 'string' || !Array.isArray(space.tabIds) ||
            !Array.isArray(space.pinnedTabIds) || !Array.isArray(space.temporaryTabIds) ||
            [...space.tabIds, ...space.pinnedTabIds, ...space.temporaryTabIds].some(id => !positiveInt(id))) {
            fail('INVALID_RESPONSE', 'Arcify returned invalid workspace metadata.');
        }
        spaces.add(space.id);
    }
    if (snapshot.activeSpaceId !== null && !spaces.has(snapshot.activeSpaceId)) {
        fail('INVALID_RESPONSE', 'Arcify returned an unknown active workspace.');
    }
    for (const tab of snapshot.tabs) {
        if (!positiveInt(tab.id) || tabs.has(tab.id) || tab.windowId !== windowId ||
            typeof tab.title !== 'string' || typeof tab.url !== 'string' ||
            typeof tab.active !== 'boolean' || typeof tab.pinned !== 'boolean' ||
            (tab.spaceId !== null && !spaces.has(tab.spaceId))) {
            fail('INVALID_RESPONSE', 'Arcify returned invalid tab metadata.');
        }
        tabs.add(tab.id);
    }
    for (const bookmark of snapshot.bookmarks) {
        if (!text(bookmark.id) || bookmarks.has(bookmark.id) || !spaces.has(bookmark.spaceId) ||
            typeof bookmark.title !== 'string' || typeof bookmark.url !== 'string' ||
            (bookmark.tabId !== null && !tabs.has(bookmark.tabId))) {
            fail('INVALID_RESPONSE', 'Arcify returned invalid pinned bookmark metadata.');
        }
        bookmarks.add(bookmark.id);
    }
    if (snapshot.warnings !== undefined && (!Array.isArray(snapshot.warnings) || snapshot.warnings.some(warning =>
        warning?.code !== 'BOOKMARKS_UNAVAILABLE' || !spaces.has(warning.spaceId) || !text(warning.message)))) {
        fail('INVALID_RESPONSE', 'Arcify returned invalid workspace warnings.');
    }
    // Workspace membership is identity-based, disjoint, and fully declared.
    const members = new Map();
    const tabById = new Map(snapshot.tabs.map(tab => [tab.id, tab]));
    for (const space of snapshot.spaces) {
        const ordered = new Set(space.tabIds);
        const pinned = new Set(space.pinnedTabIds);
        const temporary = new Set(space.temporaryTabIds);
        if (ordered.size !== space.tabIds.length || pinned.size !== space.pinnedTabIds.length ||
            temporary.size !== space.temporaryTabIds.length || pinned.size + temporary.size !== ordered.size ||
            [...pinned].some(id => temporary.has(id) || !ordered.has(id)) || [...temporary].some(id => !ordered.has(id))) {
            fail('INVALID_RESPONSE', 'Arcify returned inconsistent ordered workspace membership.');
        }
        for (const id of ordered) {
            if (members.has(id) || tabById.get(id)?.spaceId !== space.id) {
                fail('INVALID_RESPONSE', 'Arcify returned conflicting workspace ownership.');
            }
            members.set(id, space.id);
        }
    }
    for (const tab of snapshot.tabs) {
        if (tab.spaceId !== null && members.get(tab.id) !== tab.spaceId || tab.spaceId === null && members.has(tab.id)) {
            fail('INVALID_RESPONSE', 'Arcify returned an undeclared workspace tab.');
        }
    }
    for (const bookmark of snapshot.bookmarks) {
        if (bookmark.tabId !== null && (members.get(bookmark.tabId) !== bookmark.spaceId ||
            !snapshot.spaces.find(space => space.id === bookmark.spaceId).pinnedTabIds.includes(bookmark.tabId))) {
            fail('INVALID_RESPONSE', 'Arcify returned a pin bound to the wrong workspace.');
        }
    }
    if (snapshot.favorites !== undefined) {
        if (!Array.isArray(snapshot.favorites)) fail('INVALID_RESPONSE', 'Arcify returned invalid saved Favorites.');
        const ids = new Set(), bindings = new Set(), sources = new Set();
        const id = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
        for (const favorite of snapshot.favorites) {
            if (!favorite || typeof favorite !== 'object' || Array.isArray(favorite) ||
                Object.keys(favorite).some(key => !['id', 'title', 'url', 'sourceBookmarkId', 'tabId'].includes(key)) ||
                !id(favorite.id) || ids.has(favorite.id) || typeof favorite.title !== 'string' ||
                favorite.title.length > 4096 || !isFavoriteUrl(favorite.url) ||
                !(favorite.sourceBookmarkId === null || id(favorite.sourceBookmarkId)) ||
                (favorite.sourceBookmarkId !== null && sources.has(favorite.sourceBookmarkId)) ||
                (favorite.tabId !== null && (!positiveInt(favorite.tabId) || bindings.has(favorite.tabId) ||
                    !tabById.get(favorite.tabId)?.pinned || tabById.get(favorite.tabId)?.spaceId !== null))) {
                fail('INVALID_RESPONSE', 'Arcify returned invalid saved Favorite identity or binding.');
            }
            ids.add(favorite.id);
            if (favorite.sourceBookmarkId !== null) sources.add(favorite.sourceBookmarkId);
            if (favorite.tabId !== null) bindings.add(favorite.tabId);
        }
    }
    return snapshot;
}

export class ArcifyBridgeClient {
    constructor(api = chrome, timeoutMs = BRIDGE_TIMEOUT_MS) {
        this.api = api;
        this.timeoutMs = timeoutMs;
        this.actionQueue = Promise.resolve();
    }

    async getPeerId() {
        const stored = await this.api.storage.local.get(PEER_STORAGE_KEY);
        const peerId = stored[PEER_STORAGE_KEY];
        if (peerId === undefined || peerId === '') return null;
        if (typeof peerId !== 'string' || !EXTENSION_ID.test(peerId) || peerId === this.api.runtime.id) {
            fail('INVALID_PEER', 'Arcify connection ID is invalid. Update the connection in Spotlight settings.');
        }
        return peerId;
    }

    async configure(peerId) {
        if (peerId !== '' && (typeof peerId !== 'string' || !EXTENSION_ID.test(peerId) || peerId === this.api.runtime.id)) {
            fail('INVALID_PEER', 'Enter the 32-letter Arcify extension ID, different from Spotlight’s ID.');
        }
        await this.api.storage.local.set({ [PEER_STORAGE_KEY]: peerId });
    }

    async acceptsSender(sender) {
        const peerId = await this.getPeerId();
        return trustedSender(sender, peerId);
    }

    async request(command, windowId, payload = {}, expectedPeerId = null) {
        const peerId = await this.getPeerId();
        if (expectedPeerId && peerId !== expectedPeerId) fail('DISCONNECTED', 'Arcify pairing changed before the request. Search again.');
        if (!peerId) return null;
        if (!positiveInt(windowId)) fail('INVALID_WINDOW', 'A browser window is required for the Arcify connection.');
        const response = await sendBridgeRequest(peerId, command, { ...payload, windowId },
            { role: 'arcify', timeout: this.timeoutMs });
        if (command === 'hello' && response.extensionId !== peerId) fail('INVALID_RESPONSE', 'The Arcify handshake did not match the paired extension ID.');
        if (await this.getPeerId() !== peerId) fail('DISCONNECTED', 'Arcify pairing changed while the request was in progress. Search again.');
        validateSnapshot(response.snapshot, windowId);
        if (command === 'openFavorite' && (!positiveInt(response.tabId) ||
            response.snapshot.favorites?.find(favorite => favorite.id === payload.favoriteId)?.tabId !== response.tabId)) {
            fail('INVALID_RESPONSE', 'Arcify did not identify the opened Favorite. Refresh before trying again.');
        }
        if (command === 'hello') {
            if (response.capabilities !== undefined && (!Array.isArray(response.capabilities) ||
                response.capabilities.some(value => typeof value !== 'string' || !value || value.length > 200) ||
                new Set(response.capabilities).size !== response.capabilities.length)) {
                fail('INVALID_RESPONSE', 'Arcify returned invalid capabilities.');
            }
            if (response.capabilities?.includes('persistentFavorites') && !Array.isArray(response.snapshot.favorites)) {
                fail('INVALID_RESPONSE', 'Arcify did not include its saved Favorites.');
            }
        }
        return response;
    }

    async snapshot(windowId, expectedPeerId = null) {
        const peerId = expectedPeerId || await this.getPeerId();
        const response = await this.request('snapshot', windowId, {}, peerId);
        if (!response) return null;
        if (response.snapshot.favorites === undefined) return response.snapshot;
        // Optional v1 data is usable only with an authenticated capability check.
        // Never retain readiness across requests, worker suspension or revocation.
        const hello = await this.request('hello', windowId, {}, peerId);
        if (!hello?.capabilities?.includes('persistentFavorites')) {
            fail('UNSUPPORTED', 'This Arcify build does not support saved Favorites. Update both extensions.');
        }
        return hello.snapshot;
    }

    async status(windowId) {
        let peerId = '';
        try {
            peerId = await this.getPeerId() || '';
            if (!peerId) return { configured: false, peerId, status: 'disabled', message: 'Arcify connection is off. Spotlight works on its own.' };
            const response = await this.request('hello', windowId, {}, peerId);
            const warnings = response.snapshot.warnings || [];
            const warningText = warnings.length ? ` Some pinned bookmarks are unavailable. ${warnings.map(warning => warning.message).join(' ')}` : '';
            const capabilities = Array.isArray(response.capabilities) ? response.capabilities.filter(value => ['openSidebar', 'persistentFavorites'].includes(value)) : [];
            return { configured: true, peerId, status: 'connected', capabilities, warnings, message: 'Connected to Arcify. Workspace changes are managed by Arcify.' + warningText };
        } catch (error) {
            // Another options tab can change pairing while the check is in flight.
            // Report the currently saved ID without retrying the old or new peer.
            try {
                const savedPeerId = await this.getPeerId() || '';
                if (savedPeerId !== peerId) {
                    return { configured: !!savedPeerId, peerId: savedPeerId, status: savedPeerId ? 'error' : 'disabled', message: savedPeerId
                        ? 'Arcify pairing changed during the check. Refresh status to check the saved ID.'
                        : 'Arcify connection is off. Spotlight works on its own.' };
                }
            } catch (configurationError) {
                return { configured: true, peerId: '', status: 'error', message: configurationError.message };
            }
            // Saving an ID and completing the reciprocal pairing are separate steps.
            // This is only a local status label; the peer still rejects all requests
            // until its own explicitly configured ID matches this extension.
            if (error.code === 'UNAUTHORIZED') {
                return { configured: true, peerId, status: 'pending', message: 'Arcify ID saved. To finish pairing, copy Spotlight’s ID from Connection settings into Arcify’s connection settings and save it, then refresh status.' };
            }
            return { configured: true, peerId, status: error.code === 'UNAVAILABLE' || error.code === 'TIMEOUT' ? 'unavailable' : 'error', message: error.message };
        }
    }

    // A failed or timed-out mutation is never automatically replayed.
    serializeAction(action) {
        const result = this.actionQueue.then(action);
        this.actionQueue = result.catch(() => {});
        return result;
    }
}

export const arcifyBridge = new ArcifyBridgeClient();
