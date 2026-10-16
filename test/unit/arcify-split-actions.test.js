import { chromeMock } from '../mocks/chrome.js';
import { describe, it, expect, vi } from 'vitest';
import { ArcifySplitActionsClient, installArcifySplitActionMessages, resolveSplitActionSource } from '../../shared/arcify-split-actions.js';
import { validateSplitScope, validateSplitPayload, validateSplitResult } from '../../shared/arcify-split-actions-protocol.js';
import { OWN, PEER, clone, source, descriptor, splitScope, snapshot, envelope, splitResult } from '../fixtures/split-actions.js';
const event = () => ({ addListener: vi.fn(), removeListener: vi.fn() });
function fixture(paired = false) {
    const stored = { arcifyBridgePeerId: PEER, arcifyBridgePairingGeneration: 'local' };
    const state = { scope: splitScope(paired), capabilities: ['globalFavoritesV1', 'splitActionsV1'] };
    const api = { storage: { local: { get: vi.fn(async () => clone(stored)) }, onChanged: event() }, runtime: { id: OWN, onMessage: event() },
        tabs: { get: vi.fn(async id => ({ ...descriptor(id, id - 9, paired && [9, 10].includes(id) ? 7 : -1), windowId: 2, active: id === 9, status: 'complete' })), query: vi.fn(), update: vi.fn(), create: vi.fn(), remove: vi.fn(), onUpdated: event(), onActivated: event(), onMoved: event() },
        windows: { get: vi.fn(async id => ({ id, focused: true })), update: vi.fn(), getLastFocused: vi.fn(), onFocusChanged: event() } };
    const bridge = { getPeerId: async () => stored.arcifyBridgePeerId || null, timeoutMs: 10, serializeAction: action => action() };
    const send = vi.fn(async (peer, command, payload) => command === 'hello' ? envelope({ extensionId: PEER, capabilities: state.capabilities, snapshot: snapshot(state.scope) })
        : command === 'splitActionContext' ? envelope({ extensionId: PEER, snapshot: snapshot(state.scope), splitActionContext: clone(state.scope.context), splitTargets: clone(state.scope.targets) })
        : envelope({ snapshot: snapshot(state.scope), splitResult: splitResult(command, state.scope, payload.target) }));
    return { stored, state, api, bridge, send, client: new ArcifySplitActionsClient(api, bridge, send) };
}
const mutations = f => f.send.mock.calls.filter(([, command]) => ['createSplitView', 'endSplitView'].includes(command));
const sender = { id: OWN, frameId: 0, tab: { id: 9, windowId: 2 } };
describe('Split optional client, actual module', () => {
    it.each([false, true])('freshly reads then sends exactly one create/end mutation, paired=%s', async paired => {
        const f = fixture(paired), scope = await f.client.read(source), command = paired ? 'endSplitView' : 'createSplitView';
        const fields = paired ? {} : { target: scope.targets[1] };
        await expect(f.client.execute(source, scope, command, fields)).resolves.toEqual(splitResult(command, scope, fields.target));
        expect(f.send.mock.calls.map(([, command]) => command)).toEqual(['hello', 'splitActionContext', 'hello', 'splitActionContext', command]);
        expect(mutations(f)[0][2]).toEqual({ windowId: 2, supportedFeatures: ['globalFavoritesV1', 'splitActionsV1'], context: scope.context, ...fields });
        for (const fn of [f.api.tabs.query, f.api.tabs.update, f.api.tabs.create, f.api.tabs.remove, f.api.windows.update, f.api.windows.getLastFocused]) expect(fn).not.toHaveBeenCalled();
    });
    it('preserves native left/right order when the source is the right tab', async () => {
        const f = fixture(); f.state.scope.context.tab.index = 4; const scope = await f.client.read(source);
        await expect(f.client.execute(source, scope, 'createSplitView', { target: scope.targets[0] })).resolves.toMatchObject({ tabIds: [10, 9], sourceTabId: 9 });
    });
    it.each([undefined, [], ['globalFavoritesV1'], ['tabActionsV1']])('hides unsupported Split without writes: %j', async capabilities => {
        const f = fixture(); f.state.capabilities = capabilities;
        expect(await f.client.read(source)).toBeNull(); expect(mutations(f)).toHaveLength(0);
    });
    it('rejects unexpected handshake fields', async () => {
        const f = fixture(), impl = f.send.getMockImplementation(); f.send.mockImplementation(async (...args) => ({ ...await impl(...args), unexpected: true }));
        await expect(f.client.read(source)).rejects.toHaveProperty('code', 'INVALID_RESPONSE'); expect(mutations(f)).toHaveLength(0);
    });
    it.each([null, true, 'splitActionsV1', ['splitActionsV1', 'splitActionsV1'], ['splitActionsV1', 3], ['']])('rejects malformed capability lists %j', async capabilities => {
        const f = fixture(); f.state.capabilities = capabilities; await expect(f.client.read(source)).rejects.toHaveProperty('code', 'INVALID_RESPONSE');
    });
    it('only falls back through read-only handshake negotiation', async () => {
        const f = fixture(), impl = f.send.getMockImplementation(); f.state.capabilities = [];
        f.send.mockImplementation((peer, command, payload) => { if (payload.supportedFeatures) throw Object.assign(new Error('old peer'), { code: 'INVALID_REQUEST' }); return impl(peer, command, payload); });
        expect(await f.client.read(source)).toBeNull(); expect(f.send.mock.calls.map(([, command]) => command)).toEqual(['hello', 'hello', 'hello']);
    });
    it.each(['url', 'title', 'index', 'groupId', 'splitViewId'])('rejects changed selected target %s', async field => {
        const f = fixture(), scope = await f.client.read(source); f.state.scope.targets[0][field] = typeof f.state.scope.targets[0][field] === 'number' ? 42 : 'changed';
        await expect(f.client.execute(source, scope, 'createSplitView', { target: scope.targets[0] })).rejects.toBeTruthy(); expect(mutations(f)).toHaveLength(0);
    });
    it.each(['pairingGeneration', 'spaceId', 'bookmarkFolderId'])('rejects changed exact context %s', async field => {
        const f = fixture(), scope = await f.client.read(source); f.state.scope.context[field] = 'changed';
        await expect(f.client.execute(source, scope, 'createSplitView', { target: scope.targets[0] })).rejects.toBeTruthy(); expect(mutations(f)).toHaveLength(0);
    });
    it('rejects a target identity absent from the offered scope even if URL/title match', async () => {
        const f = fixture(), scope = await f.client.read(source);
        await expect(f.client.execute(source, scope, 'createSplitView', { target: descriptor(20, 20) })).rejects.toHaveProperty('code', 'STALE_CONTEXT'); expect(mutations(f)).toHaveLength(0);
    });
    it('rejects changed-and-restored state through monotonic epoch', async () => {
        const f = fixture(), scope = await f.client.read(source); f.client.invalidate();
        await expect(f.client.execute(source, scope, 'createSplitView', { target: scope.targets[0] })).rejects.toHaveProperty('code', 'STALE_CONTEXT'); expect(mutations(f)).toHaveLength(0);
    });
    it('rechecks epoch after the final browser-attested source read', async () => {
        const f = fixture(), scope = await f.client.read(source);
        await expect(f.client.execute(source, scope, 'createSplitView', { target: scope.targets[0] }, async () => f.client.invalidate())).rejects.toHaveProperty('code', 'STALE_CONTEXT'); expect(mutations(f)).toHaveLength(0);
    });
    it.each([false, true])('rechecks persisted pairing after final native reads even without a storage event, paired=%s', async paired => {
        const f = fixture(paired), scope = await f.client.read(source), command = paired ? 'endSplitView' : 'createSplitView';
        await expect(f.client.execute(source, scope, command, paired ? {} : { target: scope.targets[0] }, async () => {
            f.stored.arcifyBridgePeerId = ''; f.stored.arcifyBridgePairingGeneration = 'revoked';
        })).rejects.toHaveProperty('code', 'DISCONNECTED');
        expect(mutations(f)).toHaveLength(0);
    });
    it.each([false, true])('rechecks same-peer persisted generation after final native reads, paired=%s', async paired => {
        const f = fixture(paired), scope = await f.client.read(source), command = paired ? 'endSplitView' : 'createSplitView';
        await expect(f.client.execute(source, scope, command, paired ? {} : { target: scope.targets[0] }, async () => {
            f.stored.arcifyBridgePairingGeneration = 'revoked';
        })).rejects.toHaveProperty('code', 'DISCONNECTED');
        expect(mutations(f)).toHaveLength(0);
    });
    it.each([false, true])('uses one combined persisted authority read without a later peer-only predispatch lookup, paired=%s', async paired => {
        const f = fixture(paired), scope = await f.client.read(source), command = paired ? 'endSplitView' : 'createSplitView';
        await expect(f.client.execute(source, scope, command, paired ? {} : { target: scope.targets[0] }, async () => {
            f.bridge.getPeerId = async () => {
                // The post-receipt check may read the peer again. The dispatch fence may not.
                expect(mutations(f)).toHaveLength(1);
                return PEER;
            };
        })).resolves.toMatchObject({ action: paired ? 'end' : 'create' });
        expect(mutations(f)).toHaveLength(1);
    });
    it('rejects re-pairing during response and suppresses success without replay', async () => {
        const f = fixture(), scope = await f.client.read(source), impl = f.send.getMockImplementation();
        f.send.mockImplementation(async (...args) => { const result = await impl(...args); if (args[1] === 'createSplitView') f.stored.arcifyBridgePairingGeneration = 'new'; return result; });
        await expect(f.client.execute(source, scope, 'createSplitView', { target: scope.targets[0] })).rejects.toHaveProperty('code', 'DISCONNECTED'); expect(mutations(f)).toHaveLength(1);
    });
    it.each(['TIMEOUT', 'INVALID_REQUEST', 'UNAUTHORIZED', 'UNAVAILABLE', 'STALE_CONTEXT'])('never replays mutation or uses native fallback after %s', async code => {
        const f = fixture(), scope = await f.client.read(source), impl = f.send.getMockImplementation();
        f.send.mockImplementation((...args) => args[1] === 'createSplitView' ? Promise.reject(Object.assign(new Error('unknown'), { code })) : impl(...args));
        await expect(f.client.execute(source, scope, 'createSplitView', { target: scope.targets[0] })).rejects.toHaveProperty('code', code); expect(mutations(f)).toHaveLength(1); expect(f.api.tabs.update).not.toHaveBeenCalled();
    });
    it.each(['unknown', 'favorite', 'saved', 'inactive', 'wrong-url'])('rejects conflicting snapshots: %s', async kind => {
        const f = fixture(), impl = f.send.getMockImplementation();
        f.send.mockImplementation(async (...args) => { const result = await impl(...args); if (args[1] === 'splitActionContext') {
            if (kind === 'unknown') result.extra = true;
            if (kind === 'favorite') { result.snapshot.tabs[1].spaceId = null; result.snapshot.spaces[0].tabIds = [9, 11]; result.snapshot.spaces[0].temporaryTabIds = [9, 11]; }
            if (kind === 'saved') { result.snapshot.spaces[0].temporaryTabIds = [9, 11]; result.snapshot.spaces[0].pinnedTabIds = [10]; }
            if (kind === 'inactive') result.snapshot.tabs[0].active = false;
            if (kind === 'wrong-url') result.snapshot.tabs[1].url = 'https://other.example/';
        } return result; });
        await expect(f.client.read(source)).rejects.toHaveProperty('code', 'INVALID_RESPONSE'); expect(mutations(f)).toHaveLength(0);
    });
    it.each([{ action: 'end' }, { tabIds: [10, 9] }, { tabIds: [9, 11] }, { splitViewId: -1 }, { reordered: 'yes' }, { reordered: true }, { extra: true }])('rejects malformed receipt %j', async patch => {
        const f = fixture(), scope = await f.client.read(source), impl = f.send.getMockImplementation();
        f.send.mockImplementation(async (...args) => { const result = await impl(...args); if (args[1] === 'createSplitView') Object.assign(result.splitResult, patch); return result; });
        await expect(f.client.execute(source, scope, 'createSplitView', { target: scope.targets[0] })).rejects.toHaveProperty('code', 'INVALID_RESPONSE'); expect(mutations(f)).toHaveLength(1);
    });
});
describe('exact Split protocol validation', () => {
    it.each([s => s.context.extra = true, s => s.context.tab.pinned = true, s => s.context.tab.url = 'chrome-extension://x/tutorial-practice.html', s => s.context.tab.url = 'chrome://newtab/',
        s => s.context.tab.index = 1.1, s => s.context.tab.groupId = null, s => s.context.tab.splitViewId = null, s => s.context.tab.title = 'line\n', s => s.targets.push(clone(s.targets[0])),
        s => s.targets[0].index = 0, s => s.targets[0].groupId = 5, s => s.targets[0].splitViewId = 7, s => s.context.tab = null, s => s.context.pair = [clone(s.context.tab)]])('rejects malformed descriptors and incompatible targets #%#', mutate => {
        const scope = splitScope(); mutate(scope); expect(() => validateSplitScope(scope)).toThrow();
    });
    it.each([s => s.context.pair[1].index = 4, s => s.context.pair.reverse(), s => s.context.pair[1].splitViewId = 8, s => s.context.pair[0].title = 'different', s => s.context.pair.push(descriptor(11, 2, 7))])('rejects malformed pair #%#', mutate => {
        const scope = splitScope(true); mutate(scope); expect(() => validateSplitScope(scope)).toThrow();
    });
    it('accepts null context only with no pair/targets and never authorizes a mutation', () => {
        const scope = splitScope(); scope.context.tab = null; scope.targets = []; expect(() => validateSplitScope(scope)).not.toThrow();
        for (const command of ['createSplitView', 'endSplitView']) expect(() => validateSplitPayload(command, { context: scope.context, ...(command === 'createSplitView' ? { target: descriptor(10, 1) } : {}) })).toThrow();
    });
    it('end receipt must retain exact pair and confirm no reorder', () => {
        const scope = splitScope(true), result = splitResult('endSplitView', scope);
        expect(() => validateSplitResult('endSplitView', result, scope.context)).not.toThrow();
        for (const patch of [{ reordered: true }, { splitViewId: 7 }, { tabIds: [10, 9] }]) expect(() => validateSplitResult('endSplitView', { ...result, ...patch }, scope.context)).toThrow();
    });
});
describe('browser-attested source and local boundary', () => {
    it('checks only sender exact tab and focused exact window', async () => {
        const f = fixture(); await expect(resolveSplitActionSource(f.api, {}, sender)).resolves.toEqual(source);
        expect(f.api.tabs.get).toHaveBeenCalledWith(9); expect(f.api.windows.get).toHaveBeenCalledWith(2); expect(f.api.tabs.query).not.toHaveBeenCalled(); expect(f.api.windows.getLastFocused).not.toHaveBeenCalled();
    });
    it.each([{ id: OWN, url: `chrome-extension://${OWN}/newtab.html` }, { ...sender, frameId: 1 }, { ...sender, id: PEER }, { ...sender, documentLifecycle: 'prerender' }])('rejects helpers/subframes/foreign/inactive documents %j', async value => {
        const f = fixture(); await expect(resolveSplitActionSource(f.api, { tabId: 9 }, value)).rejects.toHaveProperty('code', 'UNAUTHORIZED'); expect(f.api.tabs.query).not.toHaveBeenCalled();
    });
    it.each([{ active: false }, { pendingUrl: 'https://next.example/' }, { status: 'loading' }, { pinned: true }, { url: 'chrome://newtab/' }, { url: `chrome-extension://${OWN}/newtab.html` }, { windowId: 3 }])('rejects changed/excluded source %j', async patch => {
        const f = fixture(); f.api.tabs.get.mockResolvedValue({ ...descriptor(), windowId: 2, active: true, ...patch });
        await expect(resolveSplitActionSource(f.api, {}, sender)).rejects.toHaveProperty('code', 'STALE_CONTEXT');
    });
    it('rejects unfocused source window without changing focus', async () => {
        const f = fixture(); f.api.windows.get.mockResolvedValue({ id: 2, focused: false }); await expect(resolveSplitActionSource(f.api, {}, sender)).rejects.toHaveProperty('code', 'STALE_CONTEXT'); expect(f.api.windows.update).not.toHaveBeenCalled();
    });
    it('strictly rejects unexpected local fields before source lookup, registers/removes native guards', async () => {
        const f = fixture(), dispose = installArcifySplitActionMessages(f.api, f.bridge), listener = f.api.runtime.onMessage.addListener.mock.calls[0][0], respond = vi.fn();
        expect(listener({ action: 'spotlightHandleResult' }, sender, respond)).toBe(false);
        expect(listener({ action: 'arcifySplitAction', command: 'createSplitView', scope: {}, fields: {}, execute: 'anything' }, sender, respond)).toBe(true);
        await vi.waitFor(() => expect(respond).toHaveBeenCalledWith(expect.objectContaining({ success: false, errorCode: 'INVALID_REQUEST' })));
        expect(f.api.tabs.get).not.toHaveBeenCalled(); expect(f.api.tabs.onUpdated.addListener).toHaveBeenCalledOnce(); dispose(); expect(f.api.tabs.onUpdated.removeListener).toHaveBeenCalledOnce();
    });
});


describe('actual local Split listener through bridge transport', () => {
    function installed(paired = false) {
        const f = fixture(paired);
        chromeMock.runtime.sendMessage.mockImplementation((peer, request, callback) => {
            f.send(peer, request.command, request).then(response => callback({ ...response, requestId: request.requestId }));
        });
        f.dispose = installArcifySplitActionMessages(f.api, f.bridge);
        const listener = f.api.runtime.onMessage.addListener.mock.calls[0][0];
        f.request = (message, origin = sender) => new Promise(resolve => listener(message, origin, resolve));
        return f;
    }
    it('accepts a browser-attested source and verifies native source/target descriptors before one dispatch', async () => {
        const f = installed(), response = await f.request({ action: 'arcifySplitActionsContext' }); expect(response.success).toBe(true);
        const { scope } = response;
        await expect(f.request({ action: 'arcifySplitAction', command: 'createSplitView', scope, fields: { target: scope.targets[0] } })).resolves.toMatchObject({ success: true, result: { tabIds: [9, 10] } });
        expect(f.api.tabs.get).toHaveBeenCalledWith(10); expect(mutations(f)).toHaveLength(1); f.dispose();
    });
    it('accepts exact Arcify-projected aliases for source and target while checking native identity separately', async () => {
        const f = installed(); f.state.scope.context.tab.title = 'Aliased source'; f.state.scope.targets[0].title = 'Aliased target';
        const { scope } = await f.request({ action: 'arcifySplitActionsContext' });
        expect(scope.context.tab.title).toBe('Aliased source'); expect(scope.targets[0].title).toBe('Aliased target');
        await expect(f.request({ action: 'arcifySplitAction', command: 'createSplitView', scope, fields: { target: scope.targets[0] } })).resolves.toMatchObject({ success: true });
        expect(mutations(f)).toHaveLength(1); f.dispose();
    });
    it.each([{ index: 22 }, { groupId: -1 }, { splitViewId: 4 }, { pinned: true }, { windowId: 8 }, { pendingUrl: 'https://next.example/' }])('rejects final native target drift %j before dispatch', async patch => {
        const f = installed(), { scope } = await f.request({ action: 'arcifySplitActionsContext' }), get = f.api.tabs.get.getMockImplementation();
        f.api.tabs.get.mockImplementation(async id => ({ ...await get(id), ...(id === 10 ? patch : {}) }));
        await expect(f.request({ action: 'arcifySplitAction', command: 'createSplitView', scope, fields: { target: scope.targets[0] } })).resolves.toMatchObject({ success: false, errorCode: 'STALE_CONTEXT' });
        expect(mutations(f)).toHaveLength(0); f.dispose();
    });
    it.each(['splitViewId', 'groupId', 'status'])('native %s change revokes old context even when metadata is restored', async field => {
        const f = installed(), { scope } = await f.request({ action: 'arcifySplitActionsContext' });
        f.api.tabs.onUpdated.addListener.mock.calls[0][0](9, { [field]: field === 'status' ? 'loading' : 3 });
        await expect(f.request({ action: 'arcifySplitAction', command: 'createSplitView', scope, fields: { target: scope.targets[0] } })).resolves.toMatchObject({ success: false, errorCode: 'STALE_CONTEXT' });
        expect(mutations(f)).toHaveLength(0); f.dispose();
    });
    it.each([false, true])('fences emitted revoke/re-pair ABA during final native reads, paired=%s', async paired => {
        const f = installed(paired), { scope } = await f.request({ action: 'arcifySplitActionsContext' });
        const change = f.api.storage.onChanged.addListener.mock.calls[0][0], get = f.api.tabs.get.getMockImplementation();
        let revoked = false;
        f.api.tabs.get.mockImplementation(async id => {
            if (id === 10 && !revoked) {
                revoked = true;
                f.stored.arcifyBridgePeerId = ''; f.stored.arcifyBridgePairingGeneration = 'revoked';
                change({ arcifyBridgePeerId: { oldValue: PEER, newValue: '' }, arcifyBridgePairingGeneration: { oldValue: 'local', newValue: 'revoked' } }, 'local');
                f.stored.arcifyBridgePeerId = PEER; f.stored.arcifyBridgePairingGeneration = 'local';
                change({ arcifyBridgePeerId: { oldValue: '', newValue: PEER }, arcifyBridgePairingGeneration: { oldValue: 'revoked', newValue: 'local' } }, 'local');
            }
            return get(id);
        });
        await expect(f.request({ action: 'arcifySplitAction', command: paired ? 'endSplitView' : 'createSplitView', scope, fields: paired ? {} : { target: scope.targets[0] } })).resolves.toMatchObject({ success: false, errorCode: 'STALE_CONTEXT' });
        expect(revoked).toBe(true); expect(mutations(f)).toHaveLength(0);
        f.dispose(); expect(f.api.storage.onChanged.removeListener).toHaveBeenCalledWith(change);
    });
    it.each([false, true])('checks the pairing event epoch after awaiting the final persisted check, paired=%s', async paired => {
        const f = installed(paired), { scope } = await f.request({ action: 'arcifySplitActionsContext' });
        const change = f.api.storage.onChanged.addListener.mock.calls[0][0], getWindow = f.api.windows.get.getMockImplementation();
        let windowReads = 0, revoked = false;
        f.api.windows.get.mockImplementation(async id => {
            windowReads++;
            // The second read is checkSource at the end of beforeDispatch.
            if (windowReads === 2) f.api.storage.local.get.mockImplementationOnce(async () => {
                revoked = true;
                change({ arcifyBridgePairingGeneration: { oldValue: 'local', newValue: 'revoked' } }, 'local');
                change({ arcifyBridgePairingGeneration: { oldValue: 'revoked', newValue: 'local' } }, 'local');
                return clone(f.stored);
            });
            return getWindow(id);
        });
        await expect(f.request({ action: 'arcifySplitAction', command: paired ? 'endSplitView' : 'createSplitView', scope, fields: paired ? {} : { target: scope.targets[0] } })).resolves.toMatchObject({ success: false, errorCode: 'STALE_CONTEXT' });
        expect(revoked).toBe(true); expect(mutations(f)).toHaveLength(0); f.dispose();
    });
    it('ignores unrelated storage changes and other storage areas', async () => {
        const f = installed(), { scope } = await f.request({ action: 'arcifySplitActionsContext' }), change = f.api.storage.onChanged.addListener.mock.calls[0][0];
        change({ appearance: { newValue: 'dark' } }, 'local'); change({ arcifyBridgePeerId: { newValue: '' } }, 'sync');
        await expect(f.request({ action: 'arcifySplitAction', command: 'createSplitView', scope, fields: { target: scope.targets[0] } })).resolves.toMatchObject({ success: true });
        expect(mutations(f)).toHaveLength(1); f.dispose();
    });
    it('helper requests never handshake or query a previous/active tab', async () => {
        const f = installed();
        await expect(f.request({ action: 'arcifySplitActionsContext', tabId: 9 }, { id: OWN, url: `chrome-extension://${OWN}/newtab.html` })).resolves.toMatchObject({ success: false, errorCode: 'UNAUTHORIZED' });
        expect(f.send).not.toHaveBeenCalled(); expect(f.api.tabs.query).not.toHaveBeenCalled(); f.dispose();
    });
});
