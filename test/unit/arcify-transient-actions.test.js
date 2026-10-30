import { chromeMock } from '../mocks/chrome.js';
import { describe, it, expect, vi } from 'vitest';
import { ArcifyTransientActionsClient, installArcifyTransientActionMessages, resolveTransientActionSource } from '../../shared/arcify-transient-actions.js';
import { isTransientUrl, validateRequest } from '../../shared/arcify-bridge-protocol.js';
import { validateTransientScope, validateTransientResult } from '../../shared/arcify-transient-actions-protocol.js';
import { source, transientScope, transientResult, snapshot, envelope, OWN, PEER, clone } from '../fixtures/transient-actions.js';
const event = () => ({ addListener: vi.fn(), removeListener: vi.fn() });
const sender = { id: OWN, tab: { id: 9, windowId: 2 }, frameId: 0 };
function fixture() {
    const stored = { arcifyBridgePeerId: PEER, arcifyBridgePairingGeneration: 'local' };
    const state = { snapshot: snapshot(), capabilities: ['globalFavoritesV1', 'transientWindowsV1'] };
    const api = { storage: { local: { get: vi.fn(async () => clone(stored)) }, onChanged: event() },
        runtime: { id: OWN, getURL: file => `chrome-extension://${OWN}/${file}`, onMessage: event() },
        tabs: { get: vi.fn(async () => ({ id: 9, windowId: 2, active: true, url: source.url })), query: vi.fn(), update: vi.fn(), create: vi.fn(),
            ...Object.fromEntries(['onCreated', 'onRemoved', 'onActivated', 'onAttached', 'onDetached', 'onReplaced', 'onUpdated'].map(name => [name, event()])) },
        windows: { get: vi.fn(async () => ({ id: 2, focused: true, type: 'normal', incognito: false })), update: vi.fn(), create: vi.fn(), getLastFocused: vi.fn(), onFocusChanged: event() } };
    let queue = Promise.resolve();
    const bridge = { getPeerId: vi.fn(async () => stored.arcifyBridgePeerId || null), timeoutMs: 50,
        serializeAction: vi.fn(operation => { const result = queue.then(operation); queue = result.catch(() => {}); return result; }) };
    const send = vi.fn(async (peer, command) => command === 'hello'
        ? envelope({ extensionId: PEER, capabilities: clone(state.capabilities), snapshot: clone(state.snapshot) })
        : envelope({ ...transientResult(), snapshot: clone(state.snapshot) }));
    return { stored, state, api, bridge, send, client: new ArcifyTransientActionsClient(api, bridge, send) };
}
const mutations = f => f.send.mock.calls.filter(([, command]) => command === 'openTransient');
describe('Little Arc HTTP(S) request boundary', () => {
    it.each(['https://example.test/a?q=x#fragment', 'http://localhost:3000/', 'HTTPS://EXAMPLE.TEST/', 'http://[::1]/'])('accepts complete %s', url => {
        expect(isTransientUrl(url)).toBe(true);
        expect(() => validateRequest({ type: 'arcify-bridge', version: 1, requestId: 'one', windowId: 2, command: 'openTransient', url }, ['openTransient'])).not.toThrow();
    });
    it.each(['', 'example.test', 'https:example.test', 'https:///example.test', '//example.test', 'file:///tmp/file', 'chrome://settings', 'javascript:alert(1)', 'data:text/html,hello', 'about:blank', 'https://', ' https://example.test', 'https://example.test\n', 'https://example.test/\x00', 'https://example.test/\x01', 'https://example.test/\x7f', 'https://example.test/a b', 'https://example.test\\other', 'https://user:password@example.test', `https://example.test/${'x'.repeat(8192)}`])('rejects unsafe/incomplete %s', url => {
        expect(isTransientUrl(url)).toBe(false);
        expect(() => validateRequest({ type: 'arcify-bridge', version: 1, requestId: 'one', windowId: 2, command: 'openTransient', url }, ['openTransient'])).toThrow();
    });
    it('does not broaden the existing supportedFeatures marker', () => {
        expect(() => validateRequest({ type: 'arcify-bridge', version: 1, requestId: 'one', windowId: 2, command: 'openTransient', url: 'https://example.test/', supportedFeatures: ['globalFavoritesV1', 'transientWindowsV1'] }, ['openTransient'])).toThrow();
    });
});
describe('capability-gated one-shot transient adapter', () => {
    it('hides old peers without a mutation; only read-only hello can negotiate', async () => {
        const f = fixture(); f.state.capabilities = ['globalFavoritesV1']; expect(await f.client.read(source)).toBeNull(); expect(mutations(f)).toHaveLength(0);
        expect(f.send.mock.calls[0][2].supportedFeatures).toEqual(['globalFavoritesV1']);
        const impl = f.send.getMockImplementation(); f.send.mockImplementation((...args) => args[2].supportedFeatures ? Promise.reject(Object.assign(new Error('old'), { code: 'INVALID_REQUEST' })) : impl(...args));
        expect(await f.client.read(source)).toBeNull(); expect(f.send.mock.calls.at(-1)[2]).toEqual({ windowId: 2 });
    });
    it('sends exact URL once and validates the origin snapshot without native mutation', async () => {
        const f = fixture(), scope = await f.client.read(source);
        await expect(f.client.execute(source, scope, 'https://target.test/')).resolves.toEqual(transientResult());
        expect(mutations(f)[0][2]).toEqual({ windowId: 2, url: 'https://target.test/', supportedFeatures: ['globalFavoritesV1'] });
        expect(f.api.tabs.update).not.toHaveBeenCalled(); expect(f.api.tabs.create).not.toHaveBeenCalled(); expect(f.api.windows.create).not.toHaveBeenCalled();
    });
    it('consumes the same view before queueing double submit', async () => {
        const f = fixture(), scope = await f.client.read(source);
        const results = await Promise.allSettled([f.client.execute(source, scope, 'https://target.test/'), f.client.execute(source, scope, 'https://target.test/')]);
        expect(results.map(item => item.status).sort()).toEqual(['fulfilled', 'rejected']); expect(mutations(f)).toHaveLength(1);
    });
    it.each(['TIMEOUT', 'UNAVAILABLE', 'INVALID_REQUEST', 'UNAUTHORIZED'])('never replays or falls back after %s', async code => {
        const f = fixture(), scope = await f.client.read(source), impl = f.send.getMockImplementation();
        f.send.mockImplementation((...args) => args[1] === 'openTransient' ? Promise.reject(Object.assign(new Error('Check Little Arc before retrying.'), { code })) : impl(...args));
        await expect(f.client.execute(source, scope, 'https://target.test/')).rejects.toHaveProperty('code', code);
        await expect(f.client.execute(source, scope, 'https://target.test/')).rejects.toHaveProperty('code', 'STALE_CONTEXT');
        expect(mutations(f)).toHaveLength(1); expect(f.api.tabs.create).not.toHaveBeenCalled(); expect(f.api.windows.create).not.toHaveBeenCalled();
    });
    it.each(['pairing', 'epoch', 'space', 'source', 'view'])('rejects stale %s before dispatch', async kind => {
        const f = fixture(), scope = await f.client.read(source); let nextSource = source;
        if (kind === 'pairing') f.stored.arcifyBridgePairingGeneration = 'new';
        if (kind === 'epoch') f.client.invalidate();
        if (kind === 'space') f.state.snapshot.activeSpaceId = null;
        if (kind === 'source') nextSource = { ...source, url: 'https://changed.test/' };
        if (kind === 'view') await f.client.read(source);
        await expect(f.client.execute(nextSource, scope, 'https://target.test/')).rejects.toThrow(); expect(mutations(f)).toHaveLength(0);
    });
    it('preserves another window’s context through native changes, including a pending peer read', async () => {
        const f = fixture(), scope = await f.client.read(source), impl = f.send.getMockImplementation();
        f.client.invalidate(false, 4);
        f.send.mockImplementation(async (...args) => { const response = await impl(...args); if (args[1] === 'hello') f.client.invalidate(false, 4); return response; });
        await expect(f.client.execute(source, scope, 'https://target.test/')).resolves.toEqual(transientResult()); expect(mutations(f)).toHaveLength(1);
    });
    it('still fences source-window ABA before dispatch without affecting other windows', async () => {
        const f = fixture(), scope = await f.client.read(source);
        await expect(f.client.execute(source, scope, 'https://target.test/', async () => { f.client.invalidate(false, 2); })).rejects.toHaveProperty('code', 'STALE_CONTEXT');
        expect(mutations(f)).toHaveLength(0);
    });
    it('does not let a late old context read retire the latest completed view', async () => {
        const f = fixture(); let release;
        f.api.storage.local.get.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
        const older = f.client.read(source); const olderOutcome = older.catch(error => error);
        const newer = await f.client.read(source); release(clone(f.stored));
        expect(await olderOutcome).toHaveProperty('code', 'STALE_CONTEXT');
        await expect(f.client.execute(source, newer, 'https://target.test/')).resolves.toEqual(transientResult()); expect(mutations(f)).toHaveLength(1);
    });
    it('guards pairing drift at the final persisted boundary', async () => {
        const f = fixture(), scope = await f.client.read(source);
        await expect(f.client.execute(source, scope, 'https://target.test/', async () => { f.stored.arcifyBridgePairingGeneration = 'changed'; })).rejects.toHaveProperty('code', 'DISCONNECTED'); expect(mutations(f)).toHaveLength(0);
    });
    it('does not claim success if pairing changes in flight', async () => {
        const f = fixture(), scope = await f.client.read(source), impl = f.send.getMockImplementation();
        f.send.mockImplementation(async (...args) => { const result = await impl(...args); if (args[1] === 'openTransient') f.stored.arcifyBridgePairingGeneration = 'changed'; return result; });
        await expect(f.client.execute(source, scope, 'https://target.test/')).rejects.toHaveProperty('code', 'DISCONNECTED'); expect(mutations(f)).toHaveLength(1);
    });
    it.each([{ tabId: 9 }, { transientWindowId: 2 }, { token: '' }, { token: 'bad\n' }, { extra: true }, { snapshot: { ...snapshot(), windowId: 3 } }])('rejects malformed receipts %j without replay', async patch => {
        const f = fixture(), scope = await f.client.read(source), impl = f.send.getMockImplementation();
        f.send.mockImplementation(async (...args) => ({ ...await impl(...args), ...(args[1] === 'openTransient' ? patch : {}) }));
        await expect(f.client.execute(source, scope, 'https://target.test/')).rejects.toHaveProperty('code', 'INVALID_RESPONSE'); expect(mutations(f)).toHaveLength(1);
    });
    it('rejects in-flight same-peer pairing ABA even if persisted values return', async () => {
        const f = fixture(), scope = await f.client.read(source), impl = f.send.getMockImplementation();
        f.send.mockImplementation(async (...args) => { const response = await impl(...args); if (args[1] === 'openTransient') f.client.invalidate(true); return response; });
        await expect(f.client.execute(source, scope, 'https://target.test/')).rejects.toHaveProperty('code', 'DISCONNECTED'); expect(mutations(f)).toHaveLength(1);
    });
    it('accepts native focus/tab changes caused by its own dispatch receipt', async () => {
        const f = fixture(), scope = await f.client.read(source), impl = f.send.getMockImplementation();
        f.send.mockImplementation(async (...args) => { const response = await impl(...args); if (args[1] === 'openTransient') f.client.invalidate(); return response; });
        await expect(f.client.execute(source, scope, 'https://target.test/')).resolves.toEqual(transientResult()); expect(mutations(f)).toHaveLength(1);
    });
    it('rejects forged scope/receipt fields', () => {
        expect(() => validateTransientScope({ ...transientScope(), injected: true })).toThrow();
        expect(() => validateTransientResult({ ...transientResult(), extra: true }, transientScope().context)).toThrow();
    });
});
describe('exact browser-attested content and helper sources', () => {
    it('checks only the exact source and focused window', async () => {
        const f = fixture(); expect(await resolveTransientActionSource(f.api, {}, sender)).toEqual(source);
        expect(f.api.tabs.query).not.toHaveBeenCalled(); expect(f.api.windows.getLastFocused).not.toHaveBeenCalled();
    });
    it.each([{ id: PEER, tab: { id: 9, windowId: 2 } }, { ...sender, frameId: 1 }, { ...sender, documentLifecycle: 'prerender' }])('rejects foreign/subframe/inactive sources %j', async value => {
        const f = fixture(); await expect(resolveTransientActionSource(f.api, {}, value)).rejects.toHaveProperty('code', 'UNAUTHORIZED');
    });
    it('requires a browser-attested helper nonce for Chrome new-tab aliases', async () => {
        const f = fixture(), helper = { id: OWN, url: f.api.runtime.getURL('newtab.html') }, verifyHelper = vi.fn(async () => false);
        f.api.tabs.get.mockResolvedValue({ id: 9, windowId: 2, url: 'chrome://newtab/', active: true });
        await expect(resolveTransientActionSource(f.api, { tabId: 9 }, helper, { verifyHelper })).rejects.toHaveProperty('code', 'UNAUTHORIZED');
        verifyHelper.mockResolvedValue(true); expect(await resolveTransientActionSource(f.api, { tabId: 9 }, helper, { verifyHelper })).toEqual({ ...source, url: 'chrome://newtab/' });
        expect(f.api.tabs.query).not.toHaveBeenCalled();
    });
    it('rejects a source moved or unfocused during preparation', async () => {
        const f = fixture(); f.api.tabs.get.mockResolvedValueOnce({ id: 9, windowId: 2, active: true, url: source.url }).mockResolvedValueOnce({ id: 9, windowId: 4, active: true, url: source.url });
        await expect(resolveTransientActionSource(f.api, {}, sender)).rejects.toHaveProperty('code', 'STALE_CONTEXT');
        f.api.tabs.get.mockResolvedValue({ id: 9, windowId: 2, active: true, url: source.url }); f.api.windows.get.mockResolvedValue({ id: 2, focused: false });
        await expect(resolveTransientActionSource(f.api, {}, sender)).rejects.toHaveProperty('code', 'STALE_CONTEXT');
    });
    it.each([{ type: 'popup' }, { incognito: true }, { type: undefined }, { incognito: undefined }])('rejects unsupported origin windows %j', async patch => {
        const f = fixture(); f.api.windows.get.mockResolvedValue({ id: 2, focused: true, type: 'normal', incognito: false, ...patch });
        await expect(resolveTransientActionSource(f.api, {}, sender)).rejects.toHaveProperty('code', 'STALE_CONTEXT');
    });
    it('strictly rejects unexpected local fields and unregisters native invalidators', async () => {
        const f = fixture(), dispose = installArcifyTransientActionMessages(f.api, f.bridge), listener = f.api.runtime.onMessage.addListener.mock.calls[0][0], respond = vi.fn();
        expect(listener({ action: 'ordinary' }, sender, respond)).toBe(false);
        expect(listener({ action: 'arcifyOpenTransient', scope: {}, url: 'https://target.test/', extra: true }, sender, respond)).toBe(true);
        await vi.waitFor(() => expect(respond).toHaveBeenCalledWith(expect.objectContaining({ success: false, errorCode: 'INVALID_REQUEST' })));
        expect(f.api.tabs.get).not.toHaveBeenCalled(); dispose(); expect(f.api.tabs.onUpdated.removeListener).toHaveBeenCalledOnce();
    });
    it('rechecks a changed source after the peer read through the actual listener', async () => {
        const f = fixture(); chromeMock.runtime.sendMessage.mockImplementation((peer, request, callback) => {
            f.send(peer, request.command, request).then(response => { f.api.tabs.get.mockResolvedValue({ id: 9, windowId: 2, active: true, url: 'https://changed.test/' }); callback({ ...response, requestId: request.requestId }); });
        });
        const dispose = installArcifyTransientActionMessages(f.api, f.bridge), listener = f.api.runtime.onMessage.addListener.mock.calls[0][0];
        const response = await new Promise(resolve => listener({ action: 'arcifyTransientContext' }, sender, resolve));
        expect(response).toMatchObject({ success: false, errorCode: 'STALE_CONTEXT' }); expect(mutations(f)).toHaveLength(0); dispose();
    });
});
