import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArcifyBridgeClient, validateSnapshot } from '../../shared/arcify-bridge.js';
import { responseFor, validateRequest } from '../../shared/arcify-bridge-protocol.js';
import { ArcifyBridgeProvider } from '../../shared/data-providers/arcify-bridge-provider.js';
import { handleBridgeResult } from '../../shared/arcify-bridge-actions.js';
import { SpotlightUtils } from '../../shared/ui-utilities.js';
import { SharedSpotlightLogic } from '../../shared/shared-component-logic.js';
import { resultIdentity } from '../../shared/selection-manager.js';
import { isTabResultRemoved } from '../../shared/live-tab-results.js';

const OWN = 'a'.repeat(32), PEER = 'b'.repeat(32), OTHER = 'c'.repeat(32);
const URL = 'https://example.test/saved';
const favorite = (id = 'favorite-1', extra = {}) => ({ id, title: 'Saved document', url: URL, sourceBookmarkId: 'bookmark-1', tabId: 21, ...extra });
const snapshot = () => ({
    windowId: 11, capturedAt: 1, activeSpaceId: 'work',
    spaces: [{ id: 'work', name: 'Work', color: 'blue', tabIds: [22], pinnedTabIds: [22], temporaryTabIds: [] }],
    tabs: [{ id: 21, windowId: 11, spaceId: null, title: 'Current live document', url: 'https://example.test/current', pinned: true, active: false },
        { id: 22, windowId: 11, spaceId: 'work', title: 'Saved document', url: URL, pinned: false, active: true },
        { id: 23, windowId: 11, spaceId: null, title: 'Saved document', url: URL, pinned: false, active: false }],
    bookmarks: [{ id: 'bookmark-1', spaceId: 'work', title: 'Saved document', url: URL, tabId: 22 }],
    favorites: [favorite(), favorite('favorite-2', { sourceBookmarkId: null, tabId: null })]
});
const result = (extra = {}) => ({ type: 'arcify-favorite', title: 'Saved document', url: URL, metadata: {
    favoriteId: 'favorite-1', tabId: 21, arcifyBridge: { kind: 'favorite', peerId: PEER, windowId: 11, favoriteId: 'favorite-1' }, ...extra
} });
let state, peerId, capabilities, api, client;
beforeEach(() => {
    state = snapshot(); peerId = PEER; capabilities = ['openSidebar', 'persistentFavorites'];
    api = { runtime: { id: OWN, sendMessage: vi.fn((peer, request, callback) => callback(responseFor(request, 'arcify', {
        ok: true, extensionId: peer, snapshot: { ...structuredClone(state), ...(state.favorites && request.command === 'openFavorite' ? { favorites: state.favorites.map(favorite => ({ ...favorite, ...(favorite.id === request.favoriteId ? { tabId: 21 } : {}) })) } : {}) }, ...(request.command === 'hello' ? { capabilities } : {}),
        ...(request.command === 'openFavorite' ? { tabId: 21 } : {})
    }))) }, storage: { local: { get: vi.fn(async key => ({ [key]: peerId })), set: vi.fn() } },
        tabs: { get: vi.fn(async id => ({ id, windowId: 11 })), create: vi.fn(), update: vi.fn() }, search: { query: vi.fn() } };
    vi.stubGlobal('chrome', api); client = new ArcifyBridgeClient(api, 20);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const commands = () => api.runtime.sendMessage.mock.calls.map(([, request]) => request.command);
const action = value => handleBridgeResult(client, api, value, 'new-tab', { windowId: 11, tabId: 22 });

describe('optional persistent Favorite snapshot contract', () => {
    it('accepts live/closed exact identities and missing legacy fields', () => {
        expect(validateSnapshot(state, 11)).toBe(state);
        delete state.favorites;
        expect(validateSnapshot(state, 11)).toBe(state);
    });
    it.each([
        ['null array', s => { s.favorites = null; }],
        ['record array', s => { s.favorites[0] = []; }],
        ['missing record', s => { s.favorites[0] = null; }],
        ['empty ID', s => { s.favorites[0].id = ''; }],
        ['long ID', s => { s.favorites[0].id = 'x'.repeat(201); }],
        ['duplicate ID', s => { s.favorites[1].id = s.favorites[0].id; }],
        ['extra field', s => { s.favorites[0].spaceId = 'work'; }],
        ['missing provenance', s => { delete s.favorites[0].sourceBookmarkId; }],
        ['invalid provenance', s => { s.favorites[0].sourceBookmarkId = 1; }],
        ['duplicate provenance', s => { s.favorites[1].sourceBookmarkId = s.favorites[0].sourceBookmarkId; }],
        ['invalid title', s => { s.favorites[0].title = null; }],
        ['internal URL', s => { s.favorites[0].url = 'chrome://settings/'; }],
        ['local file URL', s => { s.favorites[0].url = 'file:///tmp/notes.txt'; }],
        ['blank URL', s => { s.favorites[0].url = 'about:blank'; }],
        ['long title', s => { s.favorites[0].title = 'x'.repeat(4097); }],
        ['executable URL', s => { s.favorites[0].url = 'javascript:alert(1)'; }],
        ['extension URL', s => { s.favorites[0].url = `chrome-extension://${PEER}/page.html`; }],
        ['missing binding', s => { delete s.favorites[0].tabId; }],
        ['unknown binding', s => { s.favorites[0].tabId = 999; }],
        ['string binding', s => { s.favorites[0].tabId = '21'; }],
        ['duplicate binding', s => { s.favorites[1].tabId = 21; }],
        ['Space binding', s => { s.favorites[0].tabId = 22; }],
        ['unpinned binding', s => { s.favorites[0].tabId = 23; }],
        ['another-window tab', s => { s.tabs[0].windowId = 12; }]
    ])('rejects %s', (_, mutate) => {
        mutate(state);
        expect(() => validateSnapshot(state, 11)).toThrow(expect.objectContaining({ code: 'INVALID_RESPONSE' }));
    });
    it('does not infer a live binding or require the source bookmark to still exist', () => {
        state.favorites[0].tabId = null; state.favorites[0].sourceBookmarkId = 'deleted-bookmark';
        expect(validateSnapshot(state, 11).favorites[0].tabId).toBeNull();
    });
    it('accepts only the strict openFavorite command payload', () => {
        const request = { type: 'arcify-bridge', version: 1, requestId: 'favorite-test', command: 'openFavorite', windowId: 11, favoriteId: 'favorite-1' };
        expect(validateRequest(request, ['openFavorite'])).toBe(request);
        for (const extra of [{ favoriteId: '' }, { favoriteId: 12 }, { favoriteId: 'x'.repeat(201) }, { url: URL }, { spaceId: 'work' }, { tabId: 21 }, { windowId: 0 }]) {
            expect(() => validateRequest({ ...request, ...extra }, ['openFavorite'])).toThrow();
        }
    });
    it('authenticates a fresh optional capability without persisting a snapshot', async () => {
        expect((await client.snapshot(11)).favorites).toEqual(state.favorites);
        expect(commands()).toEqual(['snapshot', 'hello']);
        expect(api.storage.local.set).not.toHaveBeenCalled();
        api.runtime.sendMessage.mockClear();
        await new ArcifyBridgeClient(api).snapshot(11);
        expect(commands()).toEqual(['snapshot', 'hello']);
    });
    it('keeps old peers without favorites on their existing single-read path', async () => {
        delete state.favorites; capabilities = ['openSidebar'];
        expect((await client.snapshot(11)).favorites).toBeUndefined();
        expect(commands()).toEqual(['snapshot']);
    });
    it('rejects unsupported saved data rather than creating misleading results', async () => {
        capabilities = ['openSidebar'];
        await expect(client.snapshot(11)).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    });
    it.each([null, 'persistentFavorites', ['persistentFavorites', 1], ['persistentFavorites', 'persistentFavorites']])('rejects malformed capabilities %j', async value => {
        capabilities = value;
        await expect(client.snapshot(11)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    });
    it('rejects advertised capability with missing records', async () => {
        delete state.favorites;
        await expect(client.request('hello', 11)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    });
    it('does not switch peers between snapshot and capability reads', async () => {
        const original = api.runtime.sendMessage.getMockImplementation();
        api.runtime.sendMessage.mockImplementation((peer, request, callback) => original(peer, request, response => {
            callback(response); queueMicrotask(() => { peerId = OTHER; });
        }));
        await expect(client.snapshot(11)).rejects.toMatchObject({ code: 'DISCONNECTED' });
        expect(api.runtime.sendMessage.mock.calls.every(([peer]) => peer === PEER)).toBe(true);
    });
});

describe('saved Favorite routing never falls back to a URL', () => {
    it.each(['current-tab', 'new-tab'])('uses exact Favorite identity in %s mode after a fresh read', async mode => {
        expect(await handleBridgeResult(client, api, result(), mode, { windowId: 11, tabId: 22 })).toMatchObject({ command: 'openFavorite', tabId: 21 });
        expect(commands()).toEqual(['snapshot', 'hello', 'openFavorite']);
        expect(api.runtime.sendMessage.mock.calls.at(-1)[1]).toMatchObject({ command: 'openFavorite', favoriteId: 'favorite-1', windowId: 11 });
        expect(api.runtime.sendMessage.mock.calls.at(-1)[1]).not.toHaveProperty('url');
        expect(api.tabs.create).not.toHaveBeenCalled(); expect(api.tabs.update).not.toHaveBeenCalled();
    });
    it('uses a closed saved record and current authoritative URL rather than stale result bindings', async () => {
        state.favorites[0].tabId = null; state.favorites[0].url = 'https://example.test/new-saved-url';
        const stale = result(); stale.url = 'javascript:alert(1)';
        await action(stale);
        expect(commands()).toEqual(['snapshot', 'hello', 'openFavorite']);
    });
    it('rejects removed records with the same URL still present', async () => {
        state.favorites.shift();
        await expect(action(result())).rejects.toMatchObject({ code: 'STALE_RESULT' });
        expect(commands()).toEqual(['snapshot', 'hello']);
    });
    it.each(['unsupported', 'unpaired', 'replacement', 'malformed', 'wrong-window', 'missing-owner', 'wrong-type', 'bad-id'])('fails closed for %s', async reason => {
        const selected = result();
        if (reason === 'unsupported') delete state.favorites;
        if (reason === 'unpaired') peerId = '';
        if (reason === 'replacement') peerId = OTHER;
        if (reason === 'malformed') selected.metadata.arcifyBridge.url = URL;
        if (reason === 'wrong-window') selected.metadata.arcifyBridge.windowId = 12;
        if (reason === 'missing-owner') delete selected.metadata.arcifyBridge;
        if (reason === 'wrong-type') selected.type = 'bookmark';
        if (reason === 'bad-id') selected.metadata.arcifyBridge.favoriteId = 21;
        await expect(action(selected)).rejects.toThrow();
        expect(commands().filter(command => !['snapshot', 'hello'].includes(command))).toEqual([]);
        expect(api.tabs.create).not.toHaveBeenCalled(); expect(api.tabs.update).not.toHaveBeenCalled();
    });
    it('rejects a source tab that moved windows while the capability snapshot was awaited', async () => {
        api.tabs.get.mockResolvedValue({ id: 22, windowId: 12 });
        await expect(action(result())).rejects.toMatchObject({ code: 'WRONG_WINDOW' });
        expect(commands()).not.toContain('openFavorite');
    });
    it('does not replay a Favorite command when its response is lost', async () => {
        const original = api.runtime.sendMessage.getMockImplementation();
        api.runtime.sendMessage.mockImplementation((peer, request, callback) => {
            if (request.command !== 'openFavorite') original(peer, request, callback);
        });
        await expect(action(result())).rejects.toMatchObject({ code: 'TIMEOUT' });
        expect(commands()).toEqual(['snapshot', 'hello', 'openFavorite']);
        expect(api.tabs.create).not.toHaveBeenCalled(); expect(api.tabs.update).not.toHaveBeenCalled();
    });
    it.each([undefined, 23, -1, '21'])('rejects an incorrect opened tab identity %j without retrying', async tabId => {
        const original = api.runtime.sendMessage.getMockImplementation();
        api.runtime.sendMessage.mockImplementation((peer, request, callback) => original(peer, request, response =>
            callback(request.command === 'openFavorite' ? { ...response, tabId } : response)));
        await expect(action(result())).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
        expect(commands()).toEqual(['snapshot', 'hello', 'openFavorite']);
        expect(api.tabs.create).not.toHaveBeenCalled(); expect(api.tabs.update).not.toHaveBeenCalled();
    });
    it('rechecks capability for every action instead of trusting prior readiness', async () => {
        await client.snapshot(11); capabilities = ['openSidebar'];
        await expect(action(result())).rejects.toMatchObject({ code: 'UNSUPPORTED' });
        expect(commands()).not.toContain('openFavorite');
    });
    it.each(['TIMEOUT', 'UNSUPPORTED', 'STALE_RESULT', 'UNAUTHORIZED'])('does not retry %s or execute native navigation', async code => {
        const original = api.runtime.sendMessage.getMockImplementation();
        api.runtime.sendMessage.mockImplementation((peer, request, callback) => request.command === 'openFavorite'
            ? callback(responseFor(request, 'arcify', { ok: false, error: { code, message: code } })) : original(peer, request, callback));
        await expect(action(result())).rejects.toMatchObject({ code });
        expect(commands().filter(command => command === 'openFavorite')).toHaveLength(1);
        expect(api.tabs.create).not.toHaveBeenCalled(); expect(api.tabs.update).not.toHaveBeenCalled(); expect(api.search.query).not.toHaveBeenCalled();
    });
});

describe('saved Favorite result identity, order and presentation', () => {
    let provider;
    beforeEach(() => {
        provider = new ArcifyBridgeProvider(state, { autocompleteProvider: {} }, PEER);
        vi.spyOn(provider, 'getBookmarksData').mockResolvedValue([]);
    });
    it('shows open and closed Favorites in saved order, preserving same-URL native tabs', async () => {
        const choices = await provider.getDefaultResults();
        expect(choices.map(choice => choice.metadata.favoriteId || choice.metadata.tabId)).toEqual(['favorite-1', 'favorite-2', 22, 23]);
        expect(choices[0].metadata).toMatchObject({ sourceBookmarkId: 'bookmark-1', arcifyBridge: { kind: 'favorite', favoriteId: 'favorite-1' } });
        expect(choices[0].metadata).not.toHaveProperty('spaceId');
    });
    it('keeps the exact source Space bookmark as a separate destination', async () => {
        const choices = provider.deduplicateResults([...await provider.getOpenTabs('saved'), ...await provider.getPinnedTabSuggestions('saved'), ...await provider.getBookmarkSuggestions('saved')]);
        expect(choices.filter(choice => choice.type === 'arcify-favorite')).toHaveLength(2);
        expect(choices.find(choice => choice.metadata.bookmarkId === 'bookmark-1').metadata.arcifyBridge.kind).toBe('bookmark');
        expect(choices.find(choice => choice.metadata.tabId === 23).metadata.arcifyBridge.kind).toBe('tab');
        expect(choices.some(choice => choice.metadata.arcifyBridge.kind === 'tab' && choice.metadata.tabId === 22)).toBe(false);
    });
    it('does not suppress an ordinary source bookmark just because its Favorite has the same URL', async () => {
        const ordinary = { type: 'bookmark', title: 'Saved document', url: URL, metadata: { bookmarkId: 'bookmark-1' } };
        expect(provider.deduplicateResults([...await provider.getPinnedTabSuggestions(), ordinary])).toContain(ordinary);
    });
    it('finds saved aliases after their live tab navigates, and keeps an independently matching live route', async () => {
        expect(await provider.getPinnedTabSuggestions('saved document')).toHaveLength(2);
        expect(provider.deduplicateResults([...await provider.getOpenTabs('Current live document'), ...await provider.getPinnedTabSuggestions('Current live document')])
            .some(choice => choice.metadata.arcifyBridge.kind === 'tab' && choice.metadata.tabId === 21)).toBe(true);
    });
    it('does not confuse title/URL twins, reordered bindings, or windows when preserving selection', () => {
        const first = result(), changed = structuredClone(first);
        changed.title = 'New label'; changed.url = 'https://example.test/changed'; changed.metadata.tabId = null;
        expect(resultIdentity(changed)).toBe(resultIdentity(first));
        const twin = result(); twin.metadata.arcifyBridge.favoriteId = 'favorite-2';
        expect(resultIdentity(twin)).not.toBe(resultIdentity(first));
        changed.metadata.arcifyBridge.windowId = 12;
        expect(resultIdentity(changed)).not.toBe(resultIdentity(first));
        expect(isTabResultRemoved(first, [21])).toBe(false);
    });
    it('renders an escaped stable Favorite ID attribute instead of relying on ambiguous display text', () => {
        const selected = result(); selected.metadata.arcifyBridge.favoriteId = 'favorite" onclick="unsafe';
        expect(SharedSpotlightLogic.generateResultsHTML([selected], 'new-tab')).toContain('data-favorite-id="favorite&quot; onclick=&quot;unsafe"');
    });
    it('renders a distinct saved Favorite icon/action and no misleading standalone Favorite label', () => {
        const live = result(), closed = result({ tabId: null });
        expect(SpotlightUtils.getFaviconUrl(live)).not.toBe(SpotlightUtils.getFaviconUrl({ type: 'bookmark', url: URL }));
        expect(SpotlightUtils.formatResult(live, 'current-tab')).toMatchObject({ action: 'Switch to Favorite', subtitle: expect.stringContaining('Saved Favorite') });
        expect(SpotlightUtils.formatResult(closed, 'new-tab').action).toBe('Open Favorite');
        expect(SpotlightUtils.formatResult({ type: 'pinned-tab', title: 'Native pin' }, 'new-tab').action).toBe('Open Pinned Tab');
    });
});
