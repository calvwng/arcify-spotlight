import { describe, it, expect, vi } from 'vitest';
import { ArcifySpaceActionsClient, resolveSpaceActionSource, installArcifySpaceActionMessages } from '../../shared/arcify-space-actions.js';
import { validateActionContext, validateActionPayload } from '../../shared/arcify-space-actions-protocol.js';
const OWN = 'a'.repeat(32), PEER = 'b'.repeat(32);
const clone = value => structuredClone(value);
const source = { tabId: 9, windowId: 2 };
const base = { windowId: 2, spaceId: 'space', bookmarkFolderId: 'root', pairingGeneration: 'arcify-generation', sourceTabId: 9,
    tab: { id: 9, url: 'https://same.example/', title: 'Example', section: 'today', bookmark: null } };
function snapshot(context = base) {
    const saved = context.tab?.section === 'saved';
    return { windowId: 2, activeSpaceId: 'space', capturedAt: 1,
        spaces: [{ id: 'space', name: 'Work', color: 'purple', bookmarkFolderId: 'root', tabIds: [9, 10], pinnedTabIds: saved ? [9] : [], temporaryTabIds: saved ? [10] : [9, 10] }],
        tabs: [9, 10].map(id => ({ id, windowId: 2, spaceId: 'space', title: 'Example', url: 'https://same.example/', active: id === 9, pinned: false })),
        bookmarks: saved ? [{ id: context.tab.bookmark.id, spaceId: 'space', title: 'Example', url: 'https://same.example/', tabId: 9 }] : [] };
}
const envelope = extra => ({ type: 'arcify-bridge', version: 1, requestId: 'test', role: 'arcify', ok: true, ...extra });
function fixture() {
    const stored = { arcifyBridgePeerId: PEER, arcifyBridgePairingGeneration: 'spotlight-generation' };
    const state = { context: clone(base), capabilities: ['globalFavoritesV1', 'spaceActionsV1'] };
    const api = { storage: { local: { get: vi.fn(async () => clone(stored)) } }, runtime: { id: OWN, getURL: path => `chrome-extension://${OWN}/${path}`, onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
        tabs: { get: vi.fn(async id => ({ id, windowId: 2, active: true, url: 'https://same.example/' })), create: vi.fn(), update: vi.fn(), remove: vi.fn() } };
    const bridge = { getPeerId: vi.fn(async () => stored.arcifyBridgePeerId || null), timeoutMs: 20, serializeAction: action => action() };
    const send = vi.fn(async (peerId, command) => {
        if (command === 'hello') return envelope({ extensionId: PEER, capabilities: state.capabilities, snapshot: snapshot(state.context) });
        if (command === 'actionContext') return envelope({ extensionId: PEER, actionContext: clone(state.context), snapshot: snapshot(state.context) });
        if (command === 'createSpaceFolder') return envelope({ folderId: 'folder-new', snapshot: snapshot(state.context) });
        if (command === 'openSettings') return envelope({ tabId: 99, snapshot: snapshot(state.context) });
        return envelope({ tabId: 9, bookmarkId: state.context.tab?.bookmark?.id || 'saved-new', snapshot: snapshot(state.context) });
    });
    return { state, stored, api, bridge, send, client: new ArcifySpaceActionsClient(api, bridge, send) };
}
const mutations = f => f.send.mock.calls.filter(([, command]) => !['hello', 'actionContext'].includes(command));
const saved = context => { context.tab.section = 'saved'; context.tab.bookmark = { id: 'exact-bookmark', parentId: 'nested', title: 'Example', url: 'https://same.example/' }; return context; };

describe('optional exact Space action adapter', () => {
    it('freshly reads exact context then mutates without native navigation or URL inference', async () => {
        const f = fixture(), scope = await f.client.read(source);
        await expect(f.client.execute(source, scope, 'pinCurrentTab', {})).resolves.toEqual({ command: 'pinCurrentTab', tabId: 9, bookmarkId: 'saved-new' });
        expect(f.send.mock.calls.map(([, command]) => command)).toEqual(['hello', 'actionContext', 'hello', 'actionContext', 'pinCurrentTab']);
        expect(mutations(f)[0][2]).toMatchObject({ context: base, windowId: 2, supportedFeatures: ['globalFavoritesV1', 'spaceActionsV1'] });
        expect(f.api.tabs.update).not.toHaveBeenCalled(); expect(f.api.tabs.create).not.toHaveBeenCalled(); expect(f.api.tabs.remove).not.toHaveBeenCalled();
    });
    it.each(['createSpaceFolder', 'openSettings'])('permits %s from exact helper context without a previous tab', async command => {
        const f = fixture(); f.state.context.tab = null;
        const scope = await f.client.read(source);
        await expect(f.client.execute(source, scope, command, command === 'createSpaceFolder' ? { title: 'Reading' } : {})).resolves.toMatchObject({ command });
        expect(mutations(f)[0][2].context).toMatchObject({ sourceTabId: 9, tab: null });
    });
    it.each(['pinCurrentTab', 'removeCurrentPin'])('rejects helper %s without sending a mutation', async command => {
        const f = fixture(); f.state.context.tab = null;
        const scope = await f.client.read(source);
        await expect(f.client.execute(source, scope, command, command === 'removeCurrentPin' ? { confirmed: true } : {})).rejects.toHaveProperty('code', 'INVALID_REQUEST');
        expect(mutations(f)).toHaveLength(0);
    });
    it('requires explicit confirmation and exact bookmark identity even with duplicate URLs', async () => {
        const f = fixture(); saved(f.state.context);
        const scope = await f.client.read(source);
        await expect(f.client.execute(source, scope, 'removeCurrentPin', {})).rejects.toHaveProperty('code', 'INVALID_REQUEST');
        await expect(f.client.execute(source, scope, 'removeCurrentPin', { confirmed: false })).rejects.toHaveProperty('code', 'INVALID_REQUEST');
        await f.client.execute(source, scope, 'removeCurrentPin', { confirmed: true });
        expect(mutations(f)).toHaveLength(1);
        expect(mutations(f)[0][2].context.tab.bookmark.id).toBe('exact-bookmark');
        expect(mutations(f)[0][2].context.tab.id).toBe(9);
    });
    it.each(['spaceId', 'bookmarkFolderId', 'pairingGeneration', 'sourceTabId', 'url', 'title', 'bookmarkId'])('rejects drift in %s before mutation', async field => {
        const f = fixture(); saved(f.state.context);
        const scope = await f.client.read(source);
        if (field === 'url' || field === 'title') f.state.context.tab[field] += 'changed';
        else if (field === 'bookmarkId') f.state.context.tab.bookmark.id = 'same-url-different-id';
        else if (field === 'sourceTabId') f.state.context.sourceTabId = 10;
        else f.state.context[field] = 'changed';
        await expect(f.client.execute(source, scope, 'removeCurrentPin', { confirmed: true })).rejects.toBeTruthy();
        expect(mutations(f)).toHaveLength(0);
    });
    it.each([undefined, [], ['globalFavoritesV1']])('does not send actions when capability is absent: %j', async capabilities => {
        const f = fixture(); f.state.capabilities = capabilities;
        expect(await f.client.read(source)).toBeNull(); expect(f.send).toHaveBeenCalledTimes(1);
    });
    it('fallback retries only read-only hellos then stays compatible with an old peer', async () => {
        const f = fixture(), original = f.send.getMockImplementation();
        f.send.mockImplementation(async (peerId, command, payload) => {
            if (payload.supportedFeatures) throw Object.assign(new Error('Unexpected request field.'), { code: 'INVALID_REQUEST' });
            f.state.capabilities = []; return original(peerId, command);
        });
        expect(await f.client.read(source)).toBeNull();
        expect(f.send.mock.calls.map(([, command]) => command)).toEqual(['hello', 'hello', 'hello']);
    });
    it.each(['TIMEOUT', 'UNAUTHORIZED', 'UNAVAILABLE'])('does not retry read failures %s', async code => {
        const f = fixture(); f.send.mockRejectedValue(Object.assign(new Error('Unavailable'), { code }));
        await expect(f.client.read(source)).rejects.toHaveProperty('code', code); expect(f.send).toHaveBeenCalledTimes(1);
    });
    it.each(['TIMEOUT', 'INVALID_REQUEST', 'UNAUTHORIZED'])('never retries or falls back after mutation failure %s', async code => {
        const f = fixture(), scope = await f.client.read(source), original = f.send.getMockImplementation();
        f.send.mockImplementation((peer, command, ...args) => command === 'pinCurrentTab' ? Promise.reject(Object.assign(new Error('Unknown result'), { code })) : original(peer, command, ...args));
        await expect(f.client.execute(source, scope, 'pinCurrentTab', {})).rejects.toHaveProperty('code', code);
        expect(mutations(f)).toHaveLength(1); expect(f.api.tabs.update).not.toHaveBeenCalled();
    });
    it.each(['arcifyBridgePeerId', 'arcifyBridgePairingGeneration'])('revokes same-ID in-flight context on %s change', async key => {
        const f = fixture(), original = f.send.getMockImplementation();
        f.send.mockImplementation(async (...args) => { const response = await original(...args); if (args[1] === 'actionContext') f.stored[key] = key.endsWith('PeerId') ? '' : 'new-generation'; return response; });
        await expect(f.client.read(source)).rejects.toHaveProperty('code', 'DISCONNECTED');
    });
    it('rejects acknowledgement after local pairing generation changes', async () => {
        const f = fixture(), scope = await f.client.read(source), original = f.send.getMockImplementation();
        f.send.mockImplementation(async (...args) => { const response = await original(...args); if (args[1] === 'pinCurrentTab') f.stored.arcifyBridgePairingGeneration = 'new'; return response; });
        await expect(f.client.execute(source, scope, 'pinCurrentTab', {})).rejects.toHaveProperty('code', 'DISCONNECTED'); expect(mutations(f)).toHaveLength(1);
    });
    it.each([{ tabId: 10 }, { tabId: 9, bookmarkId: '' }, { tabId: 9, bookmarkId: 'saved-new', unexpected: true }])('rejects malformed/other same-address identity response %j', async fields => {
        const f = fixture(), scope = await f.client.read(source), original = f.send.getMockImplementation();
        f.send.mockImplementation((peer, command, ...args) => command === 'pinCurrentTab' ? envelope({ snapshot: snapshot(), ...fields }) : original(peer, command, ...args));
        await expect(f.client.execute(source, scope, 'pinCurrentTab', {})).rejects.toHaveProperty('code', 'INVALID_RESPONSE'); expect(mutations(f)).toHaveLength(1);
    });
    it('rejects unknown or overriding fields before any mutation', async () => {
        const f = fixture(), scope = await f.client.read(source);
        for (const fields of [{ context: scope.context }, { tabId: 10 }, { confirmed: true }]) await expect(f.client.execute(source, scope, 'pinCurrentTab', fields)).rejects.toHaveProperty('code', 'INVALID_REQUEST');
        expect(mutations(f)).toHaveLength(0);
    });
    it.each(['', '   ', ' x', 'x\n', 'x'.repeat(257)])('rejects malformed folder title %j', title => {
        expect(() => validateActionPayload('createSpaceFolder', { context: base, title })).toThrow();
    });
    it('rejects malformed nested context and unexpected metadata', () => {
        for (const change of [context => context.extra = true, context => context.tab.id = 10, context => context.tab.url = 'javascript:alert(1)', context => context.tab.section = 'favorite', context => context.tab.bookmark = {}, context => context.sourceTabId = 0]) {
            const context = clone(base); change(context); expect(() => validateActionContext(context, 2, 9)).toThrow();
        }
    });
});

describe('Space action source boundary', () => {
    it('uses attested content tab and rejects stale window, inactive, subframe, or untrusted callers', async () => {
        const f = fixture(); const sender = { id: OWN, tab: { id: 9, windowId: 2 }, frameId: 0 };
        await expect(resolveSpaceActionSource(f.api, {}, sender)).resolves.toEqual(source);
        for (const bad of [{ ...sender, id: PEER }, { ...sender, frameId: 1 }, { ...sender, tab: { id: 9, windowId: 3 } }]) await expect(resolveSpaceActionSource(f.api, {}, bad)).rejects.toBeTruthy();
        await expect(resolveSpaceActionSource(f.api, { tabId: 10 }, sender)).rejects.toHaveProperty('code', 'UNAUTHORIZED');
        f.api.tabs.get.mockResolvedValue({ id: 9, windowId: 2, active: false });
        await expect(resolveSpaceActionSource(f.api, {}, sender)).rejects.toHaveProperty('code', 'STALE_CONTEXT');
    });
    it('requires exact owned helper ID and never guesses a previous/active tab', async () => {
        const f = fixture(), sender = { id: OWN, url: f.api.runtime.getURL('newtab.html') };
        await expect(resolveSpaceActionSource(f.api, {}, sender)).rejects.toHaveProperty('code', 'UNAUTHORIZED');
        await expect(resolveSpaceActionSource(f.api, { tabId: 9 }, sender)).rejects.toHaveProperty('code', 'UNAUTHORIZED');
        f.api.tabs.get.mockResolvedValue({ id: 9, windowId: 2, active: true, url: sender.url });
        await expect(resolveSpaceActionSource(f.api, { tabId: 9 }, sender)).resolves.toEqual(source);
    });
    it('registers an isolated message route and rejects unknown payload keys', async () => {
        const f = fixture(); installArcifySpaceActionMessages(f.api, f.bridge);
        const listener = f.api.runtime.onMessage.addListener.mock.calls[0][0], respond = vi.fn();
        expect(listener({ action: 'spotlightHandleResult' }, {}, respond)).toBe(false);
        expect(listener({ action: 'arcifySpaceAction', command: 'pinCurrentTab', scope: {}, fields: {}, surprise: true }, { id: OWN }, respond)).toBe(true);
        await vi.waitFor(() => expect(respond).toHaveBeenCalledWith(expect.objectContaining({ success: false, errorCode: 'INVALID_REQUEST' })));
    });
});
