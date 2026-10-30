import { chromeMock } from '../mocks/chrome.js';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { installArcifySplitActionMessages } from '../../shared/arcify-split-actions.js';
import { OWN, PEER, clone, descriptor, splitScope, snapshot, envelope, splitResult } from '../fixtures/split-actions.js';

const event = () => {
    const listeners = new Set();
    return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn),
        emit: (...args) => listeners.forEach(fn => fn(...args)) };
};
const cleanups = [];
afterEach(() => { cleanups.splice(0).forEach(dispose => dispose()); });
function installed() {
    const stored = { arcifyBridgePeerId: PEER, arcifyBridgePairingGeneration: 'local' }, scope = splitScope();
    const api = { storage: { local: { get: vi.fn(async () => clone(stored)) }, onChanged: event() },
        runtime: { id: OWN, onMessage: event() },
        tabs: { get: vi.fn(async id => ({ ...descriptor(id), windowId: 2, active: id === 9, status: 'complete' })),
            ...Object.fromEntries(['onCreated', 'onRemoved', 'onActivated', 'onAttached', 'onDetached', 'onMoved', 'onReplaced', 'onUpdated'].map(key => [key, event()])) },
        windows: { get: vi.fn(async id => ({ id, focused: true })), onFocusChanged: event() },
        tabGroups: { onUpdated: event() } };
    const send = vi.fn(async (peer, command, payload) => command === 'hello'
        ? envelope({ extensionId: PEER, capabilities: ['globalFavoritesV1', 'splitActionsV1'], snapshot: snapshot(scope) })
        : command === 'splitActionContext'
            ? envelope({ extensionId: PEER, snapshot: snapshot(scope), splitActionContext: clone(scope.context), splitTargets: clone(scope.targets) })
            : envelope({ snapshot: snapshot(scope), splitResult: splitResult(command, scope, payload.target) }));
    chromeMock.runtime.sendMessage.mockImplementation((peer, request, callback) => {
        send(peer, request.command, request).then(response => callback({ ...response, requestId: request.requestId }));
    });
    const bridge = { getPeerId: async () => stored.arcifyBridgePeerId, timeoutMs: 100, serializeAction: action => action() };
    cleanups.push(installArcifySplitActionMessages(api, bridge));
    const request = message => new Promise(resolve => api.runtime.onMessage.emit(message,
        { id: OWN, frameId: 0, tab: { id: 9, windowId: 2 } }, resolve));
    return { api, send, stored, request, read: () => request({ action: 'arcifySplitActionsContext' }),
        execute: captured => request({ action: 'arcifySplitAction', command: 'createSplitView', scope: captured, fields: { target: captured.targets[0] } }),
        mutations: () => send.mock.calls.filter(([, command]) => command === 'createSplitView') };
}

describe('Split picker invalidation follows its source window', () => {
    it('another window status-only same-URL reload preserves the captured picker and dispatches once', async () => {
        const f = installed(), { scope } = await f.read();
        for (const status of ['loading', 'complete']) f.api.tabs.onUpdated.emit(20, { status }, { id: 20, windowId: 3, status, url: 'https://same.example/' });
        await expect(f.execute(scope)).resolves.toMatchObject({ success: true });
        expect(f.mutations()).toHaveLength(1);
    });
    it.each(['status', 'url', 'title', 'pinned', 'groupId', 'splitViewId'])('same-window %s event rejects old choices even after native state is restored', async field => {
        const f = installed(), { scope } = await f.read();
        f.api.tabs.onUpdated.emit(10, { [field]: field === 'status' ? 'loading' : 'changed' }, { id: 10, windowId: 2 });
        await expect(f.execute(scope)).resolves.toMatchObject({ success: false, errorCode: 'STALE_CONTEXT' });
        expect(f.mutations()).toHaveLength(0);
    });
    it.each(['unknown-window', 'replacement', 'focus', 'pairing-aba'])('%s remains a global invalidation', async kind => {
        const f = installed(), { scope } = await f.read();
        // Populate another window's epoch first to exercise global reset.
        f.api.tabs.onUpdated.emit(20, { status: 'loading' }, { windowId: 3 });
        if (kind === 'unknown-window') f.api.tabs.onUpdated.emit(20, { status: 'complete' });
        if (kind === 'replacement') f.api.tabs.onReplaced.emit(21, 20);
        if (kind === 'focus') f.api.windows.onFocusChanged.emit(3);
        if (kind === 'pairing-aba') {
            f.api.storage.onChanged.emit({ arcifyBridgePairingGeneration: { oldValue: 'local', newValue: 'revoked' } }, 'local');
            f.api.storage.onChanged.emit({ arcifyBridgePairingGeneration: { oldValue: 'revoked', newValue: 'local' } }, 'local');
        }
        await expect(f.execute(scope)).resolves.toMatchObject({ success: false, errorCode: 'STALE_CONTEXT' });
        expect(f.mutations()).toHaveLength(0);
    });
    it.each([2, 3, null])('events during initial awaited source read are scoped correctly: window %s', async windowId => {
        const f = installed();
        let release, entered;
        const enteredPromise = new Promise(resolve => { entered = resolve; });
        const held = new Promise(resolve => { release = resolve; });
        f.api.windows.get.mockImplementationOnce(async id => { entered(); await held; return { id, focused: true }; });
        const pending = f.read(); await enteredPromise;
        f.api.tabs.onUpdated.emit(20, { status: 'loading' }, windowId === null ? undefined : { windowId });
        release();
        await expect(pending).resolves.toMatchObject(windowId === 3 ? { success: true } : { success: false, errorCode: 'STALE_CONTEXT' });
        expect(f.mutations()).toHaveLength(0);
    });
    it.each([2, 3])('events during final source validation are scoped correctly: window %s', async windowId => {
        const f = installed(), { scope } = await f.read();
        let reads = 0;
        f.api.windows.get.mockImplementation(async id => {
            if (++reads === 2) f.api.tabs.onUpdated.emit(20, { status: 'loading' }, { windowId });
            return { id, focused: true };
        });
        await expect(f.execute(scope)).resolves.toMatchObject(windowId === 3 ? { success: true } : { success: false, errorCode: 'STALE_CONTEXT' });
        expect(f.mutations()).toHaveLength(windowId === 3 ? 1 : 0);
    });
});
