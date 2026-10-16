import { it, expect, vi, afterEach } from 'vitest';
import { ArcifyBridgeClient, validateSnapshot } from '../../shared/arcify-bridge.js';
import { GLOBAL_FAVORITES_FEATURE, responseFor } from '../../shared/arcify-bridge-protocol.js';
const SELF = 'a'.repeat(32), PEER = 'b'.repeat(32);
const snapshot = (pinned = false) => ({ windowId: 1, capturedAt: 1, activeSpaceId: null, spaces: [], bookmarks: [],
    tabs: [{ id: 10, windowId: 1, title: 'Live', url: 'https://live.test/', active: false, pinned, spaceId: null }],
    favorites: [{ id: 'saved', title: 'Saved', url: 'https://saved.test/', sourceBookmarkId: null, tabId: 10 }] });
function setup({ old = false, ordinaryCapability = true } = {}) {
    const sent = [];
    const api = { storage: { local: { get: async key => ({ [key]: key === 'arcifyBridgePeerId' ? PEER : undefined }) } }, runtime: { id: SELF,
        sendMessage(peer, request, callback) {
            sent.push(request);
            if (old && request.supportedFeatures !== undefined) return callback(responseFor(request, 'arcify', { ok: false, error: { code: 'INVALID_REQUEST' } }));
            callback(responseFor(request, 'arcify', { ok: true, extensionId: PEER, snapshot: snapshot(old), tabId: 10,
                ...(request.command === 'hello' ? { capabilities: ['persistentFavorites', ...(!old && ordinaryCapability ? [GLOBAL_FAVORITES_FEATURE] : [])] } : {}) }));
        } } };
    vi.stubGlobal('chrome', api); return { api, sent, client: new ArcifyBridgeClient(api, 10) };
}
afterEach(() => vi.unstubAllGlobals());
it('new client negotiates ordinary capability before an explicitly marked mutation', async () => {
    const { client, sent } = setup(); const response = await client.request('openFavorite', 1, { favoriteId: 'saved' });
    expect(response.snapshot.tabs[0].pinned).toBe(false);
    expect(sent.map(value => value.command)).toEqual(['hello', 'openFavorite']);
    expect(sent.every(value => value.supportedFeatures?.[0] === GLOBAL_FAVORITES_FEATURE)).toBe(true);
});
it('old pinned peer gets only one read-only compatibility fallback, then an unmarked mutation', async () => {
    const { client, sent } = setup({ old: true }); await client.request('openFavorite', 1, { favoriteId: 'saved' });
    expect(sent.map(value => value.command)).toEqual(['hello', 'hello', 'openFavorite']);
    expect(sent[0].supportedFeatures).toEqual([GLOBAL_FAVORITES_FEATURE]);
    expect(sent[1].supportedFeatures).toBeUndefined(); expect(sent[2].supportedFeatures).toBeUndefined();
});
it('unadvertised ordinary bindings fail before any mutation', async () => {
    const { client, sent } = setup({ ordinaryCapability: false });
    await expect(client.request('openFavorite', 1, { favoriteId: 'saved' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(sent.map(value => value.command)).toEqual(['hello']);
});
it.each(['TIMEOUT', 'UNAVAILABLE', 'UNAUTHORIZED', 'VERSION_MISMATCH', 'INVALID_RESPONSE', 'UNSUPPORTED_FEATURE'])('does not fall back or mutate after %s handshake failure', async code => {
    const { client, api, sent } = setup(); api.runtime.sendMessage = (peer, request, callback) => { sent.push(request); callback(responseFor(request, 'arcify', { ok: false, error: { code } })); };
    await expect(client.request('openFavorite', 1, { favoriteId: 'saved' })).rejects.toMatchObject({ code }); expect(sent).toHaveLength(1);
});
it('an old server appearing after a new hello rejects the marker with no mutation replay', async () => {
    const { client, api, sent } = setup(); const original = api.runtime.sendMessage;
    api.runtime.sendMessage = (peer, request, callback) => request.command === 'hello' ? original(peer, request, callback)
        : (sent.push(request), callback(responseFor(request, 'arcify', { ok: false, error: { code: 'INVALID_REQUEST' } })));
    await expect(client.request('openFavorite', 1, { favoriteId: 'saved' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(sent.map(value => value.command)).toEqual(['hello', 'openFavorite']);
});
it('ordinary relaxation only changes the native-pin requirement; exact identity remains strict', () => {
    expect(() => validateSnapshot(snapshot(), 1)).toThrow();
    expect(validateSnapshot(snapshot(), 1, { allowOrdinaryFavorites: true })).toBeTruthy();
    for (const mutate of [s => s.tabs[0].windowId = 2, s => s.favorites[0].tabId = 11,
        s => s.favorites.push({ ...s.favorites[0], id: 'other' }), s => s.favorites[0].mode = 'ordinary',
        s => s.tabs[0].spaceId = 'unknown', s => s.tabs[0].pinned = 'false']) {
        const value = snapshot(); mutate(value); expect(() => validateSnapshot(value, 1, { allowOrdinaryFavorites: true })).toThrow();
    }
});
