import { describe, it, expect, vi } from 'vitest';
import { ArcifyArchiveActionsClient, installArcifyArchiveMessages, resolveArchiveSource } from '../../shared/arcify-archive-actions.js';
import { resolveSpaceActionSource } from '../../shared/arcify-space-actions.js';
import { validateArchiveScope } from '../../shared/arcify-archive-actions-protocol.js';
import { OWN, PEER, clone, source, archiveScope, snapshot, envelope, archiveResult } from '../fixtures/archive-actions.js';
function fixture() {
    const stored = { arcifyBridgePeerId: PEER, arcifyBridgePairingGeneration: 'local' };
    const state = { scope: archiveScope(), capabilities: ['globalFavoritesV1', 'archiveActionsV1'], tab: { id: 9, windowId: 2, active: true, url: 'https://source.example/' } };
    const api = { storage: { local: { get: vi.fn(async () => clone(stored)) } }, runtime: { id: OWN, getURL: path => `chrome-extension://${OWN}/${path}`, onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
        tabs: { get: vi.fn(async () => clone(state.tab)), query: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() }, windows: { getCurrent: vi.fn(), getLastFocused: vi.fn() }, bookmarks: { update: vi.fn() } };
    const bridge = { getPeerId: vi.fn(async () => stored.arcifyBridgePeerId || null), timeoutMs: 20, serializeAction: action => action() };
    const send = vi.fn(async (peer, command, payload) => {
        if (command === 'hello') return envelope({ extensionId: PEER, capabilities: state.capabilities, snapshot: snapshot() });
        if (command === 'archiveContext') { const { peerId, generation, ...archiveActions } = clone(state.scope); return envelope({ extensionId: PEER, archiveActions, snapshot: snapshot() }); }
        const result = archiveResult(payload.entryId); return envelope({ snapshot: snapshot(result.spaceId), archiveResult: result });
    });
    return { stored, state, api, bridge, send, client: new ArcifyArchiveActionsClient(api, bridge, send) };
}
const mutations = f => f.send.mock.calls.filter(([, command]) => command === 'reopenArchivedTab');
describe('strict optional Archive adapter', () => {
    it('reopens the chosen same-URL twin by exact entry and view without rotating tokens or native fallback', async () => {
        const f = fixture(), scope = await f.client.read(source); await expect(f.client.execute(source, scope, 'entry-b')).resolves.toEqual(archiveResult());
        expect(f.send.mock.calls.map(([, command]) => command)).toEqual(['hello', 'archiveContext', 'reopenArchivedTab']);
        expect(mutations(f)[0][2]).toEqual({ windowId: 2, context: scope.context, viewId: 'view-1', entryId: 'entry-b', supportedFeatures: ['globalFavoritesV1', 'archiveActionsV1'] });
        for (const method of ['query', 'create', 'update', 'remove']) expect(f.api.tabs[method]).not.toHaveBeenCalled();
        expect(f.api.windows.getLastFocused).not.toHaveBeenCalled(); expect(f.api.bookmarks.update).not.toHaveBeenCalled();
    });
    it.each([[], ['globalFavoritesV1'], ['tabActionsV1'], undefined])('does not offer Archive without optional capability: %j', async capabilities => {
        const f = fixture(); f.state.capabilities = capabilities; expect(await f.client.read(source)).toBeNull(); expect(f.send).toHaveBeenCalledTimes(1);
    });
    it('negotiates legacy hello only, never a mutation fallback', async () => {
        const f = fixture(), original = f.send.getMockImplementation(); f.send.mockImplementation(async (peer, command, payload) => {
            if (payload.supportedFeatures) throw Object.assign(new Error('Legacy'), { code: 'INVALID_REQUEST' });
            f.state.capabilities = []; return original(peer, command, payload);
        });
        expect(await f.client.read(source)).toBeNull(); expect(f.send.mock.calls.map(([, name]) => name)).toEqual(['hello', 'hello', 'hello']);
    });
    it.each(['peerId', 'generation'])('refuses changed local pairing %s before dispatch', async field => {
        const f = fixture(), scope = await f.client.read(source); f.stored[field === 'peerId' ? 'arcifyBridgePeerId' : 'arcifyBridgePairingGeneration'] = field === 'peerId' ? 'c'.repeat(32) : 'new';
        await expect(f.client.execute(source, scope, 'entry-b')).rejects.toHaveProperty('code', 'DISCONNECTED'); expect(mutations(f)).toHaveLength(0);
    });
    it.each([{ url: 'https://changed.example/' }, { windowId: 3 }, { id: 10 }, { active: false }, { pendingUrl: 'https://pending/' }, { status: 'loading' }])('rejects browser source drift %j', async patch => {
        const f = fixture(), scope = await f.client.read(source); Object.assign(f.state.tab, patch);
        await expect(f.client.execute(source, scope, 'entry-b')).rejects.toHaveProperty('code', 'STALE_CONTEXT'); expect(mutations(f)).toHaveLength(0);
    });
    it('rechecks the exact shared source boundary immediately before dispatch', async () => {
        expect(resolveArchiveSource).toBe(resolveSpaceActionSource);
        const f = fixture(), scope = await f.client.read(source), before = vi.fn(async () => { throw Object.assign(new Error('Moved'), { code: 'STALE_CONTEXT' }); });
        await expect(f.client.execute(source, scope, 'entry-b', before)).rejects.toHaveProperty('code', 'STALE_CONTEXT'); expect(before).toHaveBeenCalledTimes(1); expect(mutations(f)).toHaveLength(0);
    });
    it.each(['TIMEOUT', 'INVALID_REQUEST', 'UNAUTHORIZED', 'FAILED'])('never replays an uncertain %s result, even on duplicate local request', async code => {
        const f = fixture(), scope = await f.client.read(source); f.send.mockRejectedValue(Object.assign(new Error('Unknown'), { code }));
        await expect(f.client.execute(source, scope, 'entry-b')).rejects.toHaveProperty('code', code);
        await expect(f.client.execute(source, scope, 'entry-b')).rejects.toHaveProperty('code', 'ALREADY_ATTEMPTED'); expect(mutations(f)).toHaveLength(1);
    });
    it('refuses duplicate concurrent dispatches', async () => {
        const f = fixture(), scope = await f.client.read(source); await Promise.allSettled([f.client.execute(source, scope, 'entry-b'), f.client.execute(source, scope, 'entry-b')]); expect(mutations(f)).toHaveLength(1);
    });
    it('preserves partial warnings, including consumed entries from an earlier browser session', async () => {
        const f = fixture(), scope = await f.client.read(source), result = { ...archiveResult(), status: 'partial', tabId: null, warning: 'Already reopened in an earlier browser session; check Arcify.' };
        f.send.mockResolvedValue(envelope({ snapshot: snapshot(), archiveResult: result })); await expect(f.client.execute(source, scope, 'entry-b')).resolves.toEqual(result);
    });
    it.each([{ entryId: 'entry-a' }, { spaceId: 'work' }, { windowId: 3 }, { consumed: false }, { tabId: 0 }, { tabId: null }, { warning: 'unexpected' }, { status: 'unknown' }, { extra: true }, { status: 'partial', warning: null }])('rejects mismatched/malformed acknowledgement %j', async patch => {
        const f = fixture(), scope = await f.client.read(source); f.send.mockResolvedValue(envelope({ snapshot: snapshot('home'), archiveResult: { ...archiveResult(), ...patch } }));
        await expect(f.client.execute(source, scope, 'entry-b')).rejects.toHaveProperty('code', 'INVALID_RESPONSE'); expect(mutations(f)).toHaveLength(1);
    });
    it.each(['missing', 'saved', 'folder', 'pinned', 'inactive-tab', 'inactive-space'])('rejects normal success lacking exact original Today membership: %s', async failure => {
        const f = fixture(), scope = await f.client.read(source), after = snapshot('home');
        if (failure === 'missing') { after.tabs.pop(); after.spaces[1].tabIds = []; after.spaces[1].temporaryTabIds = []; }
        if (failure === 'saved') { after.spaces[1].temporaryTabIds = []; after.spaces[1].pinnedTabIds = [11]; }
        if (failure === 'folder') after.spaces[1].bookmarkFolderId = 'other';
        if (failure === 'pinned') after.tabs[1].pinned = true;
        if (failure === 'inactive-tab') after.tabs[1].active = false;
        if (failure === 'inactive-space') after.activeSpaceId = 'work';
        f.send.mockResolvedValue(envelope({ snapshot: after, archiveResult: archiveResult() }));
        await expect(f.client.execute(source, scope, 'entry-b')).rejects.toHaveProperty('code', 'INVALID_RESPONSE');
    });
    it('rejects a late successful acknowledgement after re-pairing', async () => {
        const f = fixture(), scope = await f.client.read(source), original = f.send.getMockImplementation();
        f.send.mockImplementation(async (...args) => { const response = await original(...args); f.stored.arcifyBridgePairingGeneration = 'new'; return response; });
        await expect(f.client.execute(source, scope, 'entry-b')).rejects.toHaveProperty('code', 'DISCONNECTED'); expect(mutations(f)).toHaveLength(1);
    });
    it.each(['space', 'folder', 'source', 'duplicate-entry'])('rejects conflicting read context: %s', async failure => {
        const f = fixture();
        if (failure === 'space') f.state.scope.context.spaceId = 'home';
        if (failure === 'folder') f.state.scope.entries[1].bookmarkFolderId = 'work-root';
        if (failure === 'source') f.state.scope.context.sourceUrl = 'https://wrong.example/';
        if (failure === 'duplicate-entry') f.state.scope.entries[1].entryId = 'entry-a';
        await expect(f.client.read(source)).rejects.toBeTruthy(); expect(mutations(f)).toHaveLength(0);
    });
});
describe('exact Archive schema', () => {
    it.each(['extra', 'entry-extra', 'url', 'title', 'timestamp', 'view', 'intent', 'generation'])('rejects malformed %s', field => {
        const scope = archiveScope();
        if (field === 'extra') scope.extra = true;
        if (field === 'entry-extra') scope.entries[0].index = 0;
        if (field === 'url') scope.entries[0].url = 'javascript:alert(1)';
        if (field === 'title') scope.entries[0].title = 'bad\n';
        if (field === 'timestamp') scope.entries[0].archivedAt = 'yesterday';
        if (field === 'view') scope.viewId = '';
        if (field === 'intent') scope.openIntent = 1;
        if (field === 'generation') scope.context.pairingGeneration = {};
        expect(() => validateArchiveScope(scope)).toThrow();
    });
    it('accepts null side-panel token and generation without enabling native fallback', () => {
        const scope = archiveScope(); scope.openIntent = null; scope.generation = null; scope.context.pairingGeneration = null;
        expect(validateArchiveScope(scope)).toBe(scope);
    });
});
describe('Archive local-message source boundary', () => {
    it('rejects extra local fields before source lookup', async () => {
        const f = fixture(); installArcifyArchiveMessages(f.api, f.bridge); const listener = f.api.runtime.onMessage.addListener.mock.calls[0][0], reply = vi.fn();
        expect(listener({ action: 'other' }, {}, reply)).toBe(false);
        listener({ action: 'arcifyArchiveReopen', scope: archiveScope(), entryId: 'entry-a', url: 'https://same.example/' }, { id: OWN }, reply);
        await vi.waitFor(() => expect(reply).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'INVALID_REQUEST' }))); expect(f.api.tabs.get).not.toHaveBeenCalled();
    });
    it.each([{ id: PEER, tab: { id: 9 } }, { id: OWN, frameId: 1, tab: { id: 9 } }, { id: OWN, url: `chrome-extension://${OWN}/newtab.html` }])('rejects foreign/subframe/unattested helper sender %j', async sender => {
        const f = fixture(); installArcifyArchiveMessages(f.api, f.bridge); const listener = f.api.runtime.onMessage.addListener.mock.calls[0][0], reply = vi.fn();
        listener({ action: 'arcifyArchiveContext' }, sender, reply); await vi.waitFor(() => expect(reply).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'UNAUTHORIZED' })));
        expect(f.api.tabs.query).not.toHaveBeenCalled(); expect(f.api.windows.getLastFocused).not.toHaveBeenCalled();
    });
});
