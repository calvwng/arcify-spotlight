import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArcifyBridgeClient } from '../../shared/arcify-bridge.js';
import { handleBridgeResult } from '../../shared/arcify-bridge-actions.js';
import { BRIDGE_VERSION, responseFor } from '../../shared/arcify-bridge-protocol.js';

// Actual client, transport helper, snapshot validator and action router. Only the
// browser APIs/remote endpoint are mocked; this is not paired browser evidence.
const PEER = 'a'.repeat(32), SELF = 'b'.repeat(32);
const ORIGINAL_URL = 'https://form.example.test/unsaved';
const context = { windowId: 2, tabId: 20 };
let state, api, client;
const snapshot = () => ({
    windowId: 2, activeSpaceId: 'work', capturedAt: Date.now(),
    spaces: [{ id: 'work', name: 'Work', color: 'blue', tabIds: state.missing ? [] : [20], pinnedTabIds: [], temporaryTabIds: state.missing ? [] : [20] }],
    tabs: state.missing ? [] : [{ id: 20, windowId: 2, title: 'Original page', url: state.url, spaceId: 'work', active: true, pinned: false }],
    bookmarks: []
});
const result = type => ({ type, metadata: { query: 'weather tomorrow' } });
const action = (type = 'search-query', mode = 'current-tab') => handleBridgeResult(client, api, result(type), mode, context);

beforeEach(() => {
    state = { peer: PEER, url: ORIGINAL_URL, missing: false, commands: [], delay: false, response: null };
    api = {
        storage: { local: { get: vi.fn(async () => ({ arcifyBridgePeerId: state.peer })) } },
        runtime: {
            id: SELF,
            sendMessage: vi.fn((peer, request, callback) => {
                expect(peer).toBe(PEER);
                expect(request.version).toBe(BRIDGE_VERSION);
                state.commands.push(request.command);
                const response = () => callback(responseFor(request, 'arcify', { ok: true, extensionId: PEER, snapshot: snapshot(), ...(request.command === 'openTab' ? { tabId: 30 } : {}) }));
                if (request.command === 'hello') {
                    if (state.delay) state.response = response;
                    else response();
                } else if (request.command === 'navigateTab') {
                    // Original regression: mutation executes, but its response is lost.
                    state.url = request.url;
                } else if (request.command === 'openTab') {
                    expect(request.url).toBe('about:blank'); response();
                } else throw new Error(`Unexpected command ${request.command}`);
            })
        },
        tabs: { get: vi.fn(async () => ({ id: 20, windowId: 2, url: state.url })), update: vi.fn(), create: vi.fn() },
        search: { query: vi.fn(async () => {}) }
    };
    vi.stubGlobal('chrome', api);
    client = new ArcifyBridgeClient(api, 10);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

for (const type of ['search-query', 'autocomplete-suggestion']) {
    it(`${type} performs one final current-tab search without preliminary navigation`, async () => {
        const response = await action(type);
        expect(response).toMatchObject({ command: 'search', tabId: 20 });
        expect(state.commands).toEqual(['hello']);
        expect(state.url).toBe(ORIGINAL_URL);
        expect(api.tabs.get).toHaveBeenCalledExactlyOnceWith(20);
        expect(api.search.query).toHaveBeenCalledExactlyOnceWith({ text: 'weather tomorrow', tabId: 20 });
        expect(api.tabs.update).not.toHaveBeenCalled();
        expect(api.tabs.create).not.toHaveBeenCalled();
    });
}

it('snapshot timeout and its late reply leave the original page intact and never search or retry', async () => {
    vi.useFakeTimers(); state.delay = true;
    const outcome = action().catch(error => error);
    await vi.advanceTimersByTimeAsync(11);
    expect(await outcome).toMatchObject({ code: 'TIMEOUT' });
    expect(state.url).toBe(ORIGINAL_URL);
    expect(state.commands).toEqual(['hello']);
    expect(api.tabs.get).not.toHaveBeenCalled();
    expect(api.search.query).not.toHaveBeenCalled();
    state.response();
    await vi.runAllTimersAsync();
    expect(api.search.query).not.toHaveBeenCalled();
    expect(state.url).toBe(ORIGINAL_URL);
});

it('unauthorized snapshot fails closed before any native search/navigation', async () => {
    api.runtime.sendMessage.mockImplementation((peer, request, callback) => callback(responseFor(request, 'arcify', { ok: false, error: { code: 'UNAUTHORIZED', message: 'Not paired.' } })));
    await expect(action()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(api.search.query).not.toHaveBeenCalled();
    expect(api.tabs.get).not.toHaveBeenCalled();
    expect(state.url).toBe(ORIGINAL_URL);
});

it('requires the source tab in the fresh authenticated snapshot', async () => {
    state.missing = true;
    await expect(action()).rejects.toMatchObject({ code: 'STALE_TAB' });
    expect(api.search.query).not.toHaveBeenCalled();
    expect(api.tabs.get).not.toHaveBeenCalled();
});

it('rejects a source tab moved into another window after the snapshot', async () => {
    api.tabs.get.mockResolvedValue({ id: 20, windowId: 3, url: ORIGINAL_URL });
    await expect(action()).rejects.toMatchObject({ code: 'WRONG_WINDOW' });
    expect(api.search.query).not.toHaveBeenCalled();
    expect(state.url).toBe(ORIGINAL_URL);
});

it('rejects a source tab closed after the snapshot', async () => {
    api.tabs.get.mockRejectedValue(new Error('No tab with id:20'));
    await expect(action()).rejects.toMatchObject({ code: 'STALE_TAB' });
    expect(api.search.query).not.toHaveBeenCalled();
});

for (const peer of ['', 'c'.repeat(32)]) {
    it(`rejects pairing ${peer ? 'replacement' : 'disconnect'} while awaiting the live tab check`, async () => {
        api.tabs.get.mockImplementation(async () => { state.peer = peer; return { id: 20, windowId: 2, url: ORIGINAL_URL }; });
        await expect(action()).rejects.toMatchObject({ code: 'DISCONNECTED' });
        expect(api.search.query).not.toHaveBeenCalled();
        expect(state.url).toBe(ORIGINAL_URL);
    });
}

it('Chrome search rejection does not leave a blank intermediate page or retry', async () => {
    api.search.query.mockRejectedValue(new Error('Search unavailable'));
    await expect(action()).rejects.toThrow('Search unavailable');
    expect(state.url).toBe(ORIGINAL_URL);
    expect(state.commands).toEqual(['hello']);
    expect(api.search.query).toHaveBeenCalledTimes(1);
});

it('new-tab search still creates its owned target through Arcify before search', async () => {
    expect(await action('search-query', 'new-tab')).toMatchObject({ command: 'search', tabId: 30 });
    expect(state.commands).toEqual(['hello', 'hello', 'openTab']);
    expect(api.search.query).toHaveBeenCalledExactlyOnceWith({ text: 'weather tomorrow', tabId: 30 });
    expect(api.tabs.get).not.toHaveBeenCalled();
    expect(state.url).toBe(ORIGINAL_URL);
});
