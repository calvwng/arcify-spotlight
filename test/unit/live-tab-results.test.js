// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIVE_TAB_CONTEXT, LIVE_TAB_RESULTS_CHANGED, createLiveOverlayRegistry, installLiveTabResultUpdates, isTabResultRemoved, mountLiveTabResults } from '../../shared/live-tab-results.js';

const event = () => {
    const listeners = new Set();
    return { listeners, addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), emit: (...args) => [...listeners].forEach(fn => fn(...args)) };
};
const tabResult = id => ({ type: 'open-tab', title: 'New Tab', url: 'chrome://newtab/', metadata: { tabId: id, arcifyBridge: { kind: 'tab', tabId: id } } });
let api, mounted, onInvalidate, onRefresh, source, cleanup;
const message = (windowId = 2, removedTabIds = []) => ({ action: LIVE_TAB_RESULTS_CHANGED, windowId, removedTabIds });
const notify = (value, sender = { id: 'own' }) => api.runtime.onMessage.emit(value, sender);
async function mount() {
    mounted = mountLiveTabResults({ api, onInvalidate, onRefresh });
    await mounted.ready;
    return mounted;
}
beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    source = { success: true, sourceTabId: 12, windowId: 2 };
    onInvalidate = vi.fn(); onRefresh = vi.fn().mockResolvedValue(undefined);
    api = { runtime: { id: 'own', getURL: path => `chrome-extension://own/${path}`, onMessage: event(), sendMessage: vi.fn(async request => request.action === LIVE_TAB_CONTEXT ? { ...source } : undefined) },
        tabs: { query: vi.fn(async () => [{ id: 12, windowId: 2 }, { id: 11, windowId: 2 }]), get: vi.fn(async () => ({ windowId: 2 })), sendMessage: vi.fn(async () => {}),
            ...Object.fromEntries(['onCreated', 'onRemoved', 'onDetached', 'onAttached', 'onMoved', 'onUpdated', 'onReplaced'].map(name => [name, event()])) } };
});
afterEach(() => { mounted?.dispose(); mounted = null; cleanup?.(); cleanup = null; vi.useRealTimers(); });

describe('live tab result lifecycle', () => {
    it('invalidates only exact live tab identities and preserves saved bookmarks and URL twins', () => {
        expect(isTabResultRemoved(tabResult(11), [11])).toBe(true);
        expect(isTabResultRemoved(tabResult(12), [11])).toBe(false);
        expect(isTabResultRemoved({ ...tabResult(11), metadata: { tabId: 11, arcifyBridge: { kind: 'bookmark', bookmarkId: 'saved' } } }, [11])).toBe(false);
        expect(isTabResultRemoved({ type: 'history', metadata: { tabId: 11 } }, [11])).toBe(false);
    });
    it('authenticates, scopes windows, invalidates immediately and coalesces refreshes', async () => {
        await mount();
        expect(onRefresh).not.toHaveBeenCalled();
        notify(message(2, [11]), { id: 'other' }); notify(message(3, [11]));
        expect(onInvalidate).not.toHaveBeenCalled();
        notify(message(2, [11])); notify(message(2)); notify(message(2, [13]));
        expect(onInvalidate).toHaveBeenLastCalledWith([11, 13]);
        await vi.advanceTimersByTimeAsync(50);
        expect(onRefresh).toHaveBeenCalledTimes(1);
    });
    it('waits while hidden and refreshes with pending removals when visible again', async () => {
        await mount();
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        notify(message(2, [11])); await vi.advanceTimersByTimeAsync(100);
        expect(onRefresh).not.toHaveBeenCalled(); expect(onInvalidate).not.toHaveBeenCalled();
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
        document.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(50);
        expect(onInvalidate).toHaveBeenLastCalledWith([11]); expect(onRefresh).toHaveBeenCalledTimes(1);
    });
    it.each([
        { id: 'other' },
        { id: 'own', tab: { id: 12, windowId: 2 } },
        { id: 'own', url: 'https://example.test/' },
        { id: 'own', url: 'chrome-extension://own/newtab.html' },
        { id: 'own', url: 'chrome-extension://own/background.js?forged' }
    ])('rejects browser-attested non-worker senders: %j', async sender => {
        await mount(); notify(message(2, [11]), sender); await vi.advanceTimersByTimeAsync(60);
        expect(onInvalidate).not.toHaveBeenCalled(); expect(onRefresh).not.toHaveBeenCalled();
    });
    it.each([
        { windowId: 0 }, { windowId: '2' }, { windowId: undefined },
        { removedTabIds: null }, { removedTabIds: [0] }, { removedTabIds: ['11'] },
        { removedTabIds: [1.5] }, { extra: 'unexpected' }
    ])('rejects malformed event payloads: %j', async extra => {
        await mount(); notify({ ...message(2, [11]), ...extra }); await vi.advanceTimersByTimeAsync(60);
        expect(onInvalidate).not.toHaveBeenCalled(); expect(onRefresh).not.toHaveBeenCalled();
    });
    it('accepts an exact worker URL and refreshes all windows only for standalone results', async () => {
        source.allWindows = true; await mount();
        notify(message(3, [11]), { id: 'own', url: api.runtime.getURL('background.js') });
        await vi.advanceTimersByTimeAsync(60);
        expect(onInvalidate).toHaveBeenLastCalledWith([11]); expect(onRefresh).toHaveBeenCalledTimes(1);
    });
    it('re-resolves the source after moving windows and ignores later old-window events', async () => {
        await mount(); source.windowId = 3;
        notify(message(2, [12])); await vi.advanceTimersByTimeAsync(50);
        expect(onRefresh).toHaveBeenCalledTimes(1);
        onRefresh.mockClear(); onInvalidate.mockClear();
        notify(message(2, [11])); await vi.advanceTimersByTimeAsync(50);
        expect(onRefresh).not.toHaveBeenCalled(); expect(onInvalidate).not.toHaveBeenCalled();
        notify(message(3, [14])); await vi.advanceTimersByTimeAsync(50);
        expect(onRefresh).toHaveBeenCalledTimes(1);
    });
    it('evicts confirmed stale identities without replaying a failed or uncertain action', async () => {
        await mount();
        expect(mounted.handleActionFailure(tabResult(11), { success: false, errorCode: 'TIMEOUT' })).toBe(false);
        expect(mounted.handleActionFailure(tabResult(11), { success: false, errorCode: 'STALE_RESULT' })).toBe(true);
        expect(onInvalidate).toHaveBeenLastCalledWith([11]);
        await vi.advanceTimersByTimeAsync(50);
        expect(onRefresh).toHaveBeenCalledTimes(1);
        expect(api.runtime.sendMessage.mock.calls.every(([request]) => request.action === LIVE_TAB_CONTEXT)).toBe(true);
    });
    it('cleans up old pages and ignores late context reads after disposal', async () => {
        let resolve; api.runtime.sendMessage.mockImplementation(() => new Promise(r => { resolve = r; }));
        mounted = mountLiveTabResults({ api, onInvalidate, onRefresh }); await Promise.resolve();
        mounted.dispose(); resolve(source); await mounted.ready;
        notify(message(2, [11])); window.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(100);
        expect(onRefresh).not.toHaveBeenCalled(); expect(onInvalidate).not.toHaveBeenCalled();
        expect(api.runtime.onMessage.listeners.size).toBe(0);
        expect(mounted.handleActionFailure(tabResult(11), { success: false, errorCode: 'STALE_TAB' })).toBe(false);
    });
});

describe('background tab-change fan-out', () => {
    it.each([false, true])('delivers a detached overlay its old-window invalidation (old window closed: %s)', async oldWindowClosed => {
        await mount();
        source.windowId = 3;
        // Old-window query cannot include the moved source. Exercise real fan-out,
        // then the real receiver, rather than injecting an impossible delivery.
        api.tabs.query.mockImplementation(async query => {
            if (query.windowId === 2 && oldWindowClosed) throw new Error('No window with ID 2');
            return query.windowId === 2 ? [{ id: 11, windowId: 2 }] : [{ id: 12, windowId: 3 }];
        });
        api.runtime.sendMessage.mockImplementation(async request => request.action === LIVE_TAB_CONTEXT ? { ...source } : undefined);
        api.tabs.sendMessage.mockImplementation(async (id, request) => { if (id === 12) notify(request); });
        cleanup = installLiveTabResultUpdates(api, () => new Set([12]));
        api.tabs.onDetached.emit(12, { oldWindowId: 2 });
        api.tabs.onAttached.emit(12, { newWindowId: 3 });
        await vi.advanceTimersByTimeAsync(100);
        expect(api.tabs.sendMessage).toHaveBeenCalledWith(12, message(2, [12]));
        expect(onRefresh).toHaveBeenCalledTimes(1);
        onRefresh.mockClear();
        api.tabs.onRemoved.emit(14, { windowId: 3 }); await vi.advanceTimersByTimeAsync(100);
        expect(onRefresh).toHaveBeenCalledTimes(1);
        onRefresh.mockClear();
        api.tabs.onRemoved.emit(11, { windowId: 2 }); await vi.advanceTimersByTimeAsync(100);
        expect(onRefresh).not.toHaveBeenCalled();
    });
    it('cannot resurrect a removed ID when persisted hydration resolves after the close', async () => {
        let resolve; const values = [];
        api.storage = { session: { get: vi.fn(() => new Promise(r => { resolve = r; })), set: vi.fn(async value => values.push(value)) } };
        const registry = createLiveOverlayRegistry(api);
        const closed = registry.remove([12]);
        await Promise.resolve();
        resolve({ spotlightVisibleOverlayTabIds: [12, 13, 13, 0, -1, '14', null] });
        await closed;
        expect([...await registry.getIds()]).toEqual([13]);
        expect(values).toEqual([{ spotlightVisibleOverlayTabIds: [13] }]);
    });
    it('rehydrates active overlays after worker restart and serializes closes racing restoration', async () => {
        let stored = {};
        api.storage = { session: { get: vi.fn(async () => structuredClone(stored)), set: vi.fn(async value => { stored = structuredClone(value); }) } };
        const original = createLiveOverlayRegistry(api);
        await original.add(12);
        const restarted = createLiveOverlayRegistry(api);
        cleanup = installLiveTabResultUpdates(api, () => restarted.getIds());
        api.tabs.onRemoved.emit(11, { windowId: 2 }); await vi.advanceTimersByTimeAsync(35);
        expect(api.tabs.sendMessage).toHaveBeenCalledWith(12, message(2, [11]));
        const reloading = createLiveOverlayRegistry(api);
        await reloading.remove([12]);
        expect([...await reloading.getIds()]).toEqual([]);
        expect([...await createLiveOverlayRegistry(api).getIds()]).toEqual([]);
        expect(Object.values(stored)).toEqual([[]]);
    });
    it('coalesces native events and sends only scoped tracked overlays plus extension pages', async () => {
        cleanup = installLiveTabResultUpdates(api, () => new Set([12, 99]));
        api.tabs.onRemoved.emit(11, { windowId: 2 }); api.tabs.onDetached.emit(13, { oldWindowId: 2 });
        api.tabs.onAttached.emit(13, { newWindowId: 3 });
        api.tabs.query.mockImplementation(async query => query.windowId === 2 ? [{ id: 12 }, { id: 20 }] : [{ id: 99 }]);
        await vi.advanceTimersByTimeAsync(35);
        expect(api.runtime.sendMessage).toHaveBeenCalledWith(message(2, [11, 13]));
        expect(api.runtime.sendMessage).toHaveBeenCalledWith(message(3));
        expect(api.tabs.sendMessage).toHaveBeenCalledWith(12, message(2, [11, 13]));
        expect(api.tabs.sendMessage).toHaveBeenCalledWith(99, message(3));
        expect(api.tabs.sendMessage).toHaveBeenCalledTimes(2);
    });
    it('handles native replacements and cancels queued updates on worker teardown', async () => {
        cleanup = installLiveTabResultUpdates(api);
        api.tabs.onReplaced.emit(14, 11); await vi.advanceTimersByTimeAsync(35);
        expect(api.runtime.sendMessage).toHaveBeenCalledWith(message(2, [11]));
        api.runtime.sendMessage.mockClear(); api.tabs.onCreated.emit({ id: 15, windowId: 2 }); cleanup();
        await vi.advanceTimersByTimeAsync(100);
        expect(api.runtime.sendMessage).not.toHaveBeenCalled();
        expect(api.tabs.onRemoved.listeners.size).toBe(0);
    });
});
