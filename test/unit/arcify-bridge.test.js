import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArcifyBridgeClient, PEER_STORAGE_KEY, validateSnapshot } from '../../shared/arcify-bridge.js';
import {
    BRIDGE_TYPE, BRIDGE_VERSION, PAIRING_GENERATION_KEY, responseFor, sendBridgeRequest, trustedSender, validateRequest
} from '../../shared/arcify-bridge-protocol.js';

const OWN_ID = 'a'.repeat(32);
const PEER_ID = 'b'.repeat(32);
const WINDOW_ID = 11;

function snapshot(windowId = WINDOW_ID) {
    return {
        windowId, capturedAt: Date.now(), activeSpaceId: 'work',
        spaces: [{ id: 'work', name: 'Work', color: 'blue', tabIds: [21], pinnedTabIds: [21], temporaryTabIds: [] }],
        tabs: [{ id: 21, windowId, spaceId: 'work', title: 'Docs', url: 'https://example.com', active: true, pinned: true }],
        bookmarks: [{ id: '31', spaceId: 'work', title: 'Docs', url: 'https://example.com', tabId: 21 }]
    };
}

function fakeApi(peerId = PEER_ID) {
    const local = peerId === undefined ? {} : { [PEER_STORAGE_KEY]: peerId };
    return {
        local,
        runtime: {
            id: OWN_ID,
            sendMessage: vi.fn((peer, request, callback) => {
                callback(responseFor(request, 'arcify', { ok: true, extensionId: peer, snapshot: snapshot(request.windowId) }));
            })
        },
        storage: { session: { set: vi.fn(async () => {}) }, local: {
            get: vi.fn(async key => ({ [key]: local[key] })),
            set: vi.fn(async values => { Object.assign(local, values); })
        } }
    };
}

describe('Arcify bridge pairing and transport', () => {
    let api;
    let client;

    beforeEach(() => {
        api = fakeApi();
        vi.stubGlobal('chrome', api);
        client = new ArcifyBridgeClient(api, 50);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it.each([undefined, ''])('stays disabled without a configured peer (%s)', async (peerId) => {
        api.local[PEER_STORAGE_KEY] = peerId;
        expect(await client.getPeerId()).toBeNull();
        expect(await client.snapshot(WINDOW_ID)).toBeNull();
        expect(await client.status(WINDOW_ID)).toMatchObject({ configured: false, peerId: '', status: 'disabled' });
        expect(api.runtime.sendMessage).not.toHaveBeenCalled();
        expect(api.storage.local.set).not.toHaveBeenCalled();
    });

    it.each([null, 'invalid', 'q'.repeat(32), 'B'.repeat(32), OWN_ID])(
        'rejects invalid or self-paired IDs (%s)', async (peerId) => {
            await expect(client.configure(peerId)).rejects.toMatchObject({ code: 'INVALID_PEER' });
            api.local[PEER_STORAGE_KEY] = peerId;
            await expect(client.getPeerId()).rejects.toMatchObject({ code: 'INVALID_PEER' });
            expect(api.storage.local.set).not.toHaveBeenCalled();
            expect(api.runtime.sendMessage).not.toHaveBeenCalled();
        }
    );

    it.each(['', 'c'.repeat(32)])('does not send a queued mutation to a disconnected or replacement peer (%s)', async changedPeer => {
        api.local[PEER_STORAGE_KEY] = changedPeer;
        await expect(client.request('openTab', WINDOW_ID, { url: 'https://example.com' }, PEER_ID)).rejects.toMatchObject({ code: 'DISCONNECTED' });
        expect(api.runtime.sendMessage).not.toHaveBeenCalled();
    });

    it('stores explicit pairing and a fresh revocation generation, including disconnect', async () => {
        await client.configure(PEER_ID);
        await client.configure('');
        expect(api.storage.local.set.mock.calls).toEqual([
            [{ [PEER_STORAGE_KEY]: PEER_ID, [PAIRING_GENERATION_KEY]: expect.any(String) }], [{ [PEER_STORAGE_KEY]: '', [PAIRING_GENERATION_KEY]: expect.any(String) }]
        ]);
        expect(await client.getPeerId()).toBeNull();
    });

    it('requests a versioned snapshot for the exact window and never stores workspace data', async () => {
        expect(await client.snapshot(WINDOW_ID)).toMatchObject({ windowId: WINDOW_ID, activeSpaceId: 'work' });
        expect(api.runtime.sendMessage).toHaveBeenCalledWith(PEER_ID, expect.objectContaining({
            type: BRIDGE_TYPE, version: BRIDGE_VERSION, command: 'hello', windowId: WINDOW_ID,
            requestId: expect.any(String)
        }), expect.any(Function));
        expect(api.storage.local.get).toHaveBeenCalledWith(PEER_STORAGE_KEY);
        expect(api.storage.local.set).not.toHaveBeenCalled();
        expect(await client.status(WINDOW_ID)).toMatchObject({ configured: true, peerId: PEER_ID, status: 'connected' });
    });

    it.each([0, -1, 1.5, '11', NaN])('rejects invalid windows (%s) before messaging', async (windowId) => {
        await expect(client.snapshot(windowId)).rejects.toMatchObject({ code: 'INVALID_WINDOW' });
        expect(api.runtime.sendMessage).not.toHaveBeenCalled();
    });

    it('only accepts the configured sender with matching extension URL and origin', async () => {
        expect(await client.acceptsSender({ id: PEER_ID })).toBe(true);
        expect(await client.acceptsSender({ id: PEER_ID, url: `chrome-extension://${PEER_ID}/options.html`, origin: `chrome-extension://${PEER_ID}` })).toBe(true);
        for (const sender of [
            { id: OWN_ID },
            { id: PEER_ID, url: 'https://example.com' },
            { id: PEER_ID, url: `chrome-extension://${PEER_ID}.example/options.html` },
            { id: PEER_ID, url: `chrome-extension://${OWN_ID}/options.html` },
            { id: PEER_ID, origin: 'https://example.com' },
            { id: PEER_ID, origin: `chrome-extension://${PEER_ID}/` },
            { id: PEER_ID, origin: `chrome-extension://${PEER_ID}.example` },
            null
        ]) expect(await client.acceptsSender(sender)).toBe(false);
        expect(trustedSender({ id: PEER_ID }, '')).toBe(false);
    });

    it.each([
        ['request ID', { requestId: 'stale-request' }, 'INVALID_RESPONSE'],
        ['protocol version', { version: 2 }, 'VERSION_MISMATCH'],
        ['role', { role: 'spotlight' }, 'INVALID_RESPONSE'],
        ['type', { type: 'another-protocol' }, 'INVALID_RESPONSE'],
        ['success flag', { ok: 'true' }, 'INVALID_RESPONSE']
    ])('rejects the wrong response %s', async (_, change, code) => {
        api.runtime.sendMessage.mockImplementation((peer, request, callback) => {
            callback({ ...responseFor(request, 'arcify', { ok: true, snapshot: snapshot() }), ...change });
        });
        await expect(client.snapshot(WINDOW_ID)).rejects.toMatchObject({ code });
        expect(api.storage.local.set).not.toHaveBeenCalled();
    });

    it('surfaces peer failures instead of silently returning success', async () => {
        api.runtime.sendMessage.mockImplementation((peer, request, callback) => {
            callback(responseFor(request, 'arcify', { ok: false, error: { code: 'UNKNOWN_SPACE', message: 'Space no longer exists.' } }));
        });
        await expect(client.request('activateSpace', WINDOW_ID, { spaceId: 'work' }))
            .rejects.toMatchObject({ code: 'UNKNOWN_SPACE', message: 'Space no longer exists.' });
        expect(api.runtime.sendMessage).toHaveBeenCalledTimes(1);
    });

    it.each([undefined, OWN_ID])('rejects a hello response with missing or wrong extension identity (%s)', async (extensionId) => {
        api.runtime.sendMessage.mockImplementation((peer, request, callback) => {
            callback(responseFor(request, 'arcify', { ok: true, extensionId, snapshot: snapshot() }));
        });
        await expect(client.request('hello', WINDOW_ID)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
        expect(await client.status(WINDOW_ID)).toMatchObject({ status: 'error', configured: true, peerId: PEER_ID });
        expect(api.storage.local.set).not.toHaveBeenCalled();
    });

    it('checks Chrome lastError inside the callback and reports an unavailable peer', async () => {
        api.runtime.sendMessage.mockImplementation((peer, request, callback) => {
            api.runtime.lastError = { message: 'Receiving end does not exist.' };
            callback(undefined);
            delete api.runtime.lastError;
        });
        expect(await client.status(WINDOW_ID)).toMatchObject({ configured: true, peerId: PEER_ID, status: 'unavailable' });
        expect(api.runtime.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('reports a saved ID awaiting reciprocal approval, then connects after the peer approves it', async () => {
        api.local[PEER_STORAGE_KEY] = '';
        await client.configure(PEER_ID);
        api.runtime.sendMessage.mockImplementationOnce((peer, request, callback) => {
            callback(responseFor(request, 'arcify', { ok: false, error: { code: 'UNAUTHORIZED', message: 'This extension is not paired with Arcify.' } }));
        });

        expect(await client.status(WINDOW_ID)).toMatchObject({
            configured: true, peerId: PEER_ID, status: 'pending',
            message: expect.stringContaining('Arcify ID saved.')
        });
        expect(api.local[PEER_STORAGE_KEY]).toBe(PEER_ID);
        expect(await client.status(WINDOW_ID)).toMatchObject({ configured: true, peerId: PEER_ID, status: 'connected' });
        expect(api.storage.local.set).toHaveBeenCalledExactlyOnceWith({ [PEER_STORAGE_KEY]: PEER_ID, [PAIRING_GENERATION_KEY]: expect.any(String) });
        expect(api.runtime.sendMessage.mock.calls.map(([, request]) => request.command)).toEqual(['hello', 'hello']);
    });

    it('only treats a validated unauthorized reply as pending approval', async () => {
        api.runtime.sendMessage.mockImplementation((peer, request, callback) => {
            callback({ ...responseFor(request, 'spotlight', { ok: false, error: { code: 'UNAUTHORIZED', message: 'Not paired.' } }) });
        });
        expect(await client.status(WINDOW_ID)).toMatchObject({ configured: true, status: 'error' });
        expect(api.storage.local.set).not.toHaveBeenCalled();
    });

    it('keeps unauthorized workspace requests rejected rather than treating pending approval as success', async () => {
        api.runtime.sendMessage.mockImplementation((peer, request, callback) => {
            callback(responseFor(request, 'arcify', { ok: false, error: { code: 'UNAUTHORIZED', message: 'Not paired.' } }));
        });
        await expect(client.snapshot(WINDOW_ID)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
        await expect(client.request('activateTab', WINDOW_ID, { tabId: 21 })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
        expect(api.storage.local.set).not.toHaveBeenCalled();
    });

    it('reports a timed-out status check as unavailable, not pending approval', async () => {
        vi.useFakeTimers();
        api.runtime.sendMessage.mockImplementation(() => {});
        const status = client.status(WINDOW_ID);
        await vi.advanceTimersByTimeAsync(51);
        expect(await status).toMatchObject({ configured: true, peerId: PEER_ID, status: 'unavailable' });
        expect(api.runtime.sendMessage).toHaveBeenCalledTimes(1);
        expect(api.storage.local.set).not.toHaveBeenCalled();
    });

    it.each([
        ['', false], ['', true], ['c'.repeat(32), false], ['c'.repeat(32), true]
    ])('reports current pairing after an in-flight status response (replacement=%s, accepted=%s)', async (replacementId, accepted) => {
        let request;
        let callback;
        let markStarted;
        const started = new Promise(resolve => { markStarted = resolve; });
        api.runtime.sendMessage.mockImplementation((peer, sent, reply) => {
            request = sent;
            callback = reply;
            markStarted();
        });
        const pendingStatus = client.status(WINDOW_ID);
        await started;
        await client.configure(replacementId);
        callback(responseFor(request, 'arcify', accepted
            ? { ok: true, extensionId: PEER_ID, snapshot: snapshot() }
            : { ok: false, error: { code: 'UNAUTHORIZED', message: 'Not paired.' } }));

        expect(await pendingStatus).toMatchObject({
            configured: !!replacementId, peerId: replacementId,
            status: replacementId ? 'error' : 'disabled',
            message: expect.stringContaining(replacementId ? 'pairing changed' : 'connection is off')
        });
        expect(api.runtime.sendMessage).toHaveBeenCalledTimes(1);
        expect(api.storage.local.set).toHaveBeenCalledExactlyOnceWith({ [PEER_STORAGE_KEY]: replacementId, [PAIRING_GENERATION_KEY]: expect.any(String) });
    });

    it('times out once without replaying a mutation and ignores its late callback', async () => {
        vi.useFakeTimers();
        let request;
        let callback;
        api.runtime.sendMessage.mockImplementation((peer, sent, reply) => { request = sent; callback = reply; });
        const action = client.request('openBookmark', WINDOW_ID, { spaceId: 'work', bookmarkId: '31' });
        const rejected = expect(action).rejects.toMatchObject({ code: 'TIMEOUT' });
        await vi.advanceTimersByTimeAsync(51);
        await rejected;
        callback(responseFor(request, 'arcify', { ok: true, snapshot: snapshot() }));
        await vi.advanceTimersByTimeAsync(500);
        expect(api.runtime.sendMessage).toHaveBeenCalledTimes(1);
        expect(api.storage.local.set).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not accept a prior request response for a newer request', async () => {
        const pending = [];
        api.runtime.sendMessage.mockImplementation((peer, request, callback) => { pending.push({ request, callback }); });
        const first = sendBridgeRequest(PEER_ID, 'snapshot', { windowId: WINDOW_ID }, { role: 'arcify' });
        const second = sendBridgeRequest(PEER_ID, 'snapshot', { windowId: WINDOW_ID }, { role: 'arcify' });
        expect(pending[0].request.requestId).not.toBe(pending[1].request.requestId);
        pending[0].callback(responseFor(pending[0].request, 'arcify', { ok: true, snapshot: snapshot() }));
        pending[1].callback(responseFor(pending[0].request, 'arcify', { ok: true, snapshot: snapshot() }));
        await expect(first).resolves.toMatchObject({ ok: true });
        await expect(second).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    });

    it.each(['', 'c'.repeat(32)])('rejects an in-flight response if pairing changes to %s', async (replacementId) => {
        let request;
        let callback;
        let markStarted;
        const started = new Promise(resolve => { markStarted = resolve; });
        api.runtime.sendMessage.mockImplementation((peer, sent, reply) => {
            request = sent;
            callback = reply;
            markStarted();
        });
        const action = client.request('openBookmark', WINDOW_ID, { spaceId: 'work', bookmarkId: '31' });
        await started;
        await client.configure(replacementId);
        callback(responseFor(request, 'arcify', { ok: true, snapshot: snapshot() }));

        await expect(action).rejects.toMatchObject({ code: 'DISCONNECTED' });
        expect(api.runtime.sendMessage).toHaveBeenCalledTimes(1);
        expect(api.storage.local.set).toHaveBeenCalledExactlyOnceWith({ [PEER_STORAGE_KEY]: replacementId, [PAIRING_GENERATION_KEY]: expect.any(String) });
    });

    it('serializes actions and allows the next explicit action after a failure', async () => {
        const calls = [];
        let finish;
        const first = client.serializeAction(async () => {
            calls.push('first');
            await new Promise(resolve => { finish = resolve; });
            throw new Error('First action failed.');
        });
        const failed = expect(first).rejects.toThrow('First action failed.');
        const second = client.serializeAction(async () => { calls.push('second'); return 'done'; });
        await Promise.resolve();
        expect(calls).toEqual(['first']);
        finish();
        await failed;
        await expect(second).resolves.toBe('done');
        expect(calls).toEqual(['first', 'second']);
    });
});

describe('Arcify snapshot validation', () => {
    it('accepts a valid snapshot and an empty window', () => {
        const value = snapshot();
        expect(validateSnapshot(value, WINDOW_ID)).toBe(value);
        expect(validateSnapshot({ windowId: WINDOW_ID, capturedAt: 1, activeSpaceId: null, spaces: [], tabs: [], bookmarks: [] }, WINDOW_ID)).toBeTruthy();
    });

    it.each([
        ['wrong window', value => { value.windowId = 12; }],
        ['invalid capture time', value => { value.capturedAt = NaN; }],
        ['unknown active space', value => { value.activeSpaceId = 'missing'; }],
        ['duplicate spaces', value => { value.spaces.push({ ...value.spaces[0] }); }],
        ['invalid pinned tab ID', value => { value.spaces[0].pinnedTabIds = [-1]; }],
        ['duplicate tabs', value => { value.tabs.push({ ...value.tabs[0] }); }],
        ['cross-window tab', value => { value.tabs[0].windowId = 12; }],
        ['unknown tab space', value => { value.tabs[0].spaceId = 'missing'; }],
        ['invalid tab flags', value => { value.tabs[0].pinned = 'true'; }],
        ['duplicate bookmarks', value => { value.bookmarks.push({ ...value.bookmarks[0] }); }],
        ['unknown bookmark space', value => { value.bookmarks[0].spaceId = 'missing'; }],
        ['unknown bookmark tab', value => { value.bookmarks[0].tabId = 999; }]
    ])('rejects %s', (_, mutate) => {
        const value = snapshot();
        mutate(value);
        expect(() => validateSnapshot(value, WINDOW_ID)).toThrow(expect.objectContaining({ code: 'INVALID_RESPONSE' }));
    });
});

describe('Arcify request validation', () => {
    const valid = { type: BRIDGE_TYPE, version: BRIDGE_VERSION, requestId: 'request-1', windowId: WINDOW_ID, command: 'launch', mode: 'current-tab' };

    it('accepts the exact launch schema and rejects extra fields, unsafe commands, and wrong windows', () => {
        expect(validateRequest(valid, ['launch'])).toBe(valid);
        for (const change of [{ extra: true }, { mode: 'all-tabs' }, { windowId: -1 }, { command: 'snapshot' }, { requestId: '<script>' }]) {
            expect(() => validateRequest({ ...valid, ...change }, ['launch'])).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
        }
        expect(() => validateRequest({ ...valid, version: 2 }, ['launch'])).toThrow(expect.objectContaining({ code: 'VERSION_MISMATCH' }));
    });
});
