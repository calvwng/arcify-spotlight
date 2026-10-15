// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromeMock } from '../mocks/chrome.js';
import './setup.js';

// Real background/client/provider/action router and real new-tab DOM. Only the
// Chrome transport, tabs, and authenticated peer snapshot are API boundary mocks.
const PEER = 'a'.repeat(32);
const OWN = 'b'.repeat(32);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let live, sourceId, sourceUrl, page, registrationTarget, backgroundListeners, pageListeners, externalListeners, contextDelay, logicalSpaces, snapshotHook, savedFavorites;
const event = () => {
    const listeners = new Set();
    return { addListener: vi.fn(fn => listeners.add(fn)), removeListener: vi.fn(fn => listeners.delete(fn)), emit: (...args) => [...listeners].forEach(fn => fn(...args)) };
};
const tab = (id, windowId = 2) => ({ id, windowId, title: 'New Tab', url: 'chrome://newtab/', active: id === sourceId, pinned: false, spaceId: 'home', groupId: -1 });
const snapshot = windowId => ({ windowId, activeSpaceId: 'home', capturedAt: Date.now(),
    spaces: logicalSpaces.map(space => {
        const tabIds = (space.order || live.map(t => t.id)).filter(id => live.some(t => t.id === id && t.windowId === windowId && t.spaceId === space.id));
        return { id: space.id, name: space.name, color: space.color, tabIds, pinnedTabIds: [], temporaryTabIds: tabIds };
    }),
    tabs: live.filter(t => t.windowId === windowId).map(t => ({ ...t })), bookmarks: [],
    ...(savedFavorites === undefined ? {} : { favorites: savedFavorites.map(favorite => ({ ...favorite })) }) });
function dispatch(listeners, message, sender) {
    return new Promise(resolve => {
        let pending = false, answered = false;
        const respond = value => { answered = true; resolve(value); };
        for (const listener of [...listeners]) if (listener(message, sender, respond) === true) pending = true;
        if (!pending && !answered) resolve(undefined);
    });
}
const source = () => ({ id: OWN, url: sourceUrl, tab: { ...live.find(t => t.id === sourceId) } });
const internal = message => dispatch(backgroundListeners, message, source());
const rows = () => [...page.resultsContainer.querySelectorAll('[data-result-type="open-tab"]')];
const shownIds = () => page.selectionManager.results.filter(result => result.type === 'open-tab').map(result => result.metadata.tabId);
const bridgeMutations = () => chromeMock.runtime.sendMessage.mock.calls.filter(([target, request]) => target === PEER && !['hello', 'snapshot'].includes(request.command));
const invalidate = (extra = {}, sender = { id: PEER, origin: `chrome-extension://${PEER}` }) => dispatch(externalListeners, { type: 'arcify-bridge', version: 1, requestId: 'logical-change', command: 'invalidate', windowId: 2, ...extra }, sender);
const readCount = () => chromeMock.runtime.sendMessage.mock.calls.filter(([target, request]) => target === PEER && request.command === 'hello').length;
const actions = () => chromeMock.runtime.sendMessage.mock.calls.filter(([message]) => message?.action === 'spotlightHandleResult');
async function open() {
    const { initializeSpotlight } = await import('../../newtab.js');
    page = await initializeSpotlight();
    await page.sidebarCommand.ready; await page.startupSuggestion.ready;
    await vi.waitFor(() => expect(shownIds()).toEqual(live.filter(t => t.windowId === 2 && t.id !== sourceId).map(t => t.id)));
}
const closeTab = (id, emit = true) => {
    const current = live.find(t => t.id === id);
    live = live.filter(t => t.id !== id);
    if (emit) chromeMock.tabs.onRemoved.emit(id, { windowId: current.windowId, isWindowClosing: false });
};

beforeEach(async () => {
    document.body.innerHTML = '<div id="spotlight-container"></div>';
    Object.defineProperty(document, 'URL', { configurable: true, value: chromeMock.runtime.getURL('newtab.html') });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    HTMLElement.prototype.scrollIntoView = () => {};
    delete window.arcifyCurrentTabId;
    savedFavorites = undefined; sourceId = 12; sourceUrl = chromeMock.runtime.getURL('newtab.html'); contextDelay = null; snapshotHook = null;
    logicalSpaces = [{ id: 'home', name: 'Home', color: 'blue' }];
    live = [tab(11), tab(12)]; backgroundListeners = []; pageListeners = []; externalListeners = [];
    chromeMock.runtime.onMessage.addListener.mockImplementation(listener => registrationTarget.push(listener));
    chromeMock.runtime.onMessage.removeListener.mockImplementation(listener => {
        for (const listeners of [backgroundListeners, pageListeners]) {
            const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1);
        }
    });
    chromeMock.runtime.onMessageExternal.addListener.mockImplementation(listener => externalListeners.push(listener));
    chromeMock.storage.local.get.mockImplementation(async key => key === 'arcifyBridgePeerId' ? { arcifyBridgePeerId: PEER } : {});
    chromeMock.storage.sync.get.mockResolvedValue({ enableSpotlight: true });
    for (const name of ['onCreated', 'onRemoved', 'onDetached', 'onAttached', 'onMoved', 'onUpdated', 'onReplaced', 'onActivated']) chromeMock.tabs[name] = event();
    chromeMock.tabs.query.mockImplementation(async query => live.filter(t => (!query.windowId || t.windowId === query.windowId) && (!query.active || t.active)));
    chromeMock.tabs.get.mockImplementation(async id => {
        const current = live.find(t => t.id === id); if (!current) throw new Error('Closed tab'); return { ...current };
    });
    chromeMock.windows.get.mockImplementation(async id => ({ id, type: 'normal', incognito: false }));
    chromeMock.tabs.getCurrent = vi.fn(async () => ({ ...live.find(t => t.id === sourceId) }));
    chromeMock.runtime.sendMessage.mockImplementation((target, request, callback) => {
        if (target === PEER) {
            const response = { type: 'arcify-bridge', version: 1, role: 'arcify', extensionId: PEER, requestId: request.requestId, ok: true,
                snapshot: snapshot(request.windowId), capabilities: ['openSidebar', ...(savedFavorites === undefined ? [] : ['persistentFavorites'])], ...(request.tabId ? { tabId: request.tabId } : {}) };
            if (!snapshotHook?.(request, response, callback)) callback(response);
            return;
        }
        if (['spotlightLiveTabsChanged', 'spotlightArcifyResultsChanged'].includes(target.action)) return dispatch(pageListeners, target, { id: OWN });
        if (target.action === 'spotlightLiveTabContext' && contextDelay) return contextDelay;
        return internal(target);
    });
    vi.spyOn(window, 'close').mockImplementation(() => {});
    registrationTarget = backgroundListeners;
    await import('../../background.js');
    registrationTarget = pageListeners;
});
afterEach(async () => {
    page?.dispose(); page = null; await pause(90); document.body.replaceChildren();
    delete HTMLElement.prototype.scrollIntoView; vi.restoreAllMocks();
});

describe('paired live-tab result DOM regression', () => {
    it('evicts the exact closed row when paired/native updates overlap an unfinished source read', async () => {
        let resolveInitial, resolveFresh;
        contextDelay = new Promise(resolve => { resolveInitial = resolve; });
        await open(); expect(shownIds()).toEqual([11]);
        const originalInput = page.input, originalContainer = page.resultsContainer;
        contextDelay = new Promise(resolve => { resolveFresh = resolve; });
        closeTab(11, false);
        await dispatch(pageListeners, { action: 'spotlightArcifyResultsChanged', windowId: 2, peerId: PEER }, { id: OWN });
        await dispatch(pageListeners, { action: 'spotlightLiveTabsChanged', windowId: 2, removedTabIds: [11] }, { id: OWN });
        resolveInitial({ success: true, windowId: 2, sourceTabId: 12, peerId: PEER });
        await pause(0);
        // Still waiting for the newer authenticated read, without an exception or
        // incorrectly consuming the native removal against the old shared context.
        expect(shownIds()).toEqual([11]);
        contextDelay = null;
        resolveFresh({ success: true, windowId: 2, sourceTabId: 12, peerId: PEER });
        await vi.waitFor(() => expect(shownIds()).toEqual([]));
        expect(page.selectionManager.getSelectedResult()).toBeNull();
        expect(page.input).toBe(originalInput); expect(page.resultsContainer).toBe(originalContainer);
        expect(window.close).not.toHaveBeenCalled(); expect(bridgeMutations()).toHaveLength(0);
    });
    it('omits only the exact calling helper and removes a closed twin while keeping the page open', async () => {
        await open(); expect(shownIds()).toEqual([11]);
        expect(rows()[0].textContent).toContain('New Tab'); expect(rows()[0].textContent).toContain('Home');
        closeTab(11);
        await vi.waitFor(() => expect(shownIds()).toEqual([]));
        expect(page.selectionManager.getSelectedResult()).toBeNull();
        expect(window.close).not.toHaveBeenCalled(); expect(bridgeMutations()).toHaveLength(0);
    });
    it('keeps two legitimate same-title and same-URL New Tabs, and scopes a move to its old window', async () => {
        live.push(tab(13), tab(20, 3)); await open(); expect(shownIds()).toEqual([11, 13]);
        live.find(t => t.id === 11).windowId = 3;
        chromeMock.tabs.onDetached.emit(11, { oldWindowId: 2 }); chromeMock.tabs.onAttached.emit(11, { newWindowId: 3 });
        await vi.waitFor(() => expect(shownIds()).toEqual([13]));
        expect(bridgeMutations()).toHaveLength(0);
        await pause(80); // The identity eviction is immediate; let its coalesced refresh settle.
        const requestCount = chromeMock.runtime.sendMessage.mock.calls.filter(([m]) => m?.action === 'getSpotlightSuggestions').length;
        closeTab(20); await pause(100);
        expect(chromeMock.runtime.sendMessage.mock.calls.filter(([m]) => m?.action === 'getSpotlightSuggestions')).toHaveLength(requestCount);
    });
    it('evicts a stale result rejected at action time and never executes the replacement under held Enter', async () => {
        live.push(tab(13)); await open(); closeTab(11, false);
        rows()[0].click();
        await vi.waitFor(() => expect(document.querySelector('[role="status"]').textContent).toContain('That tab is no longer'));
        await vi.waitFor(() => expect(shownIds()).toEqual([13]));
        expect(page.selectionManager.getSelectedResult()).toBeNull();
        page.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: true }));
        page.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); await pause(10);
        expect(actions()).toHaveLength(1); expect(bridgeMutations()).toHaveLength(0); expect(window.close).not.toHaveBeenCalled();
    });
    it('does not redraw a disposed page from queued notifications or a late context response', async () => {
        await open(); const before = page.resultsContainer.innerHTML;
        closeTab(11); page.dispose(); await pause(120);
        expect(page.resultsContainer.innerHTML).toBe(before);
        const old = page; page = null;
        document.body.innerHTML = '<div id="spotlight-container"></div>';
        let resolve; contextDelay = new Promise(r => { resolve = r; });
        const { initializeSpotlight } = await import('../../newtab.js');
        page = await initializeSpotlight(); page.dispose();
        resolve({ success: true, windowId: 2, sourceTabId: 12 }); await pause(90);
        expect(old.resultsContainer.innerHTML).toBe(before); expect(bridgeMutations()).toHaveLength(0);
    });
    it('does not exclude a current ordinary webpage or other tabs when the caller is not the helper', async () => {
        sourceUrl = 'https://example.test/';
        expect((await internal({ action: 'getSpotlightSuggestions', query: '', mode: 'new-tab' })).results.map(r => r.metadata.tabId)).toEqual([11, 12]);
    });
    it('uses the browser-attested helper ID rather than a spoofed message tab ID', async () => {
        const response = await internal({ action: 'getSpotlightSuggestions', query: '', mode: 'new-tab', tabId: 11 });
        expect(response.results.map(r => r.metadata.tabId)).toEqual([11]);
    });
    it('refreshes the real typed query while preserving manual tab identity and URL preview', async () => {
        live.push(tab(13)); live.forEach(t => { if (t.id !== sourceId) t.title = 'Budget document'; });
        await open();
        page.input.value = 'budg'; page.input.dispatchEvent(new Event('input', { bubbles: true }));
        await vi.waitFor(() => expect(chromeMock.runtime.sendMessage.mock.calls.some(([m]) => m?.action === 'getLocalSuggestions' && m.query === 'budg')).toBe(true));
        await pause(20);
        page.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
        const selectedId = page.selectionManager.getSelectedResult().metadata.tabId;
        expect([11, 13]).toContain(selectedId); expect(page.input.value).toBe('chrome://newtab/');
        const before = chromeMock.runtime.sendMessage.mock.calls.filter(([m]) => m?.action === 'getLocalSuggestions').length;
        chromeMock.tabs.onUpdated.emit(13, { title: 'Budget document updated' }, { ...live.find(t => t.id === 13) });
        await vi.waitFor(() => expect(chromeMock.runtime.sendMessage.mock.calls.filter(([m]) => m?.action === 'getLocalSuggestions').length).toBeGreaterThan(before));
        const queries = chromeMock.runtime.sendMessage.mock.calls.filter(([m]) => m?.action === 'getLocalSuggestions').map(([m]) => m.query);
        expect(queries.every(query => query === 'budg')).toBe(true);
        expect(page.selectionManager.getSelectedResult().metadata.tabId).toBe(selectedId);
        expect(page.input.value).toBe('chrome://newtab/'); expect(bridgeMutations()).toHaveLength(0);
    });
    it('omits its exact helper in standalone mode while preserving real same-URL tabs', async () => {
        chromeMock.storage.local.get.mockResolvedValue({});
        live = [tab(12), tab(11), tab(13)];
        const response = await internal({ action: 'getSpotlightSuggestions', query: '', mode: 'current-tab' });
        expect(response.results.map(r => r.metadata.tabId)).toEqual([11, 13]);
        expect(response.results[0].metadata.arcifyBridge).toBeUndefined();
    });
    it('refreshes standalone results after another-window tab closes', async () => {
        chromeMock.storage.local.get.mockResolvedValue({});
        live = [tab(12), tab(20, 3)];
        const { initializeSpotlight } = await import('../../newtab.js');
        page = await initializeSpotlight();
        await vi.waitFor(() => expect(shownIds()).toEqual([20]));
        closeTab(20); await vi.waitFor(() => expect(shownIds()).toEqual([]));
        expect(page.selectionManager.getSelectedResult()).toBeNull();
    });
});


describe('paired logical Arcify changes in the real result DOM', () => {
    it('refreshes membership, order, name and color from a fresh snapshot without native tab/group events', async () => {
        live.push(tab(13)); await open(); const before = readCount();
        logicalSpaces.push({ id: 'work', name: 'Work renamed', color: 'red', order: [13, 11] });
        live.find(t => t.id === 11).spaceId = 'work'; live.find(t => t.id === 13).spaceId = 'work';
        expect(await invalidate()).toMatchObject({ type: 'arcify-bridge', version: 1, requestId: 'logical-change', role: 'spotlight', ok: true });
        await vi.waitFor(() => expect(shownIds()).toEqual([13, 11]));
        expect(readCount()).toBeGreaterThan(before);
        expect(rows().every(row => row.textContent.includes('Work renamed'))).toBe(true);
        expect(page.selectionManager.results.filter(r => r.type === 'open-tab').every(r => r.metadata.spaceColor === 'red')).toBe(true);
        expect(live.every(t => t.groupId === -1)).toBe(true);
        expect(chromeMock.tabs.group).not.toHaveBeenCalled(); expect(chromeMock.tabs.update).not.toHaveBeenCalled();
        expect(chromeMock.storage.local.set).not.toHaveBeenCalled(); expect(bridgeMutations()).toHaveLength(0);
    });
    it('preserves the typed query, manually selected identity and URL preview across logical membership changes', async () => {
        live.push(tab(13)); live.forEach(t => { if (t.id !== sourceId) t.title = 'Budget document'; });
        await open(); page.input.value = 'budg'; page.input.dispatchEvent(new Event('input', { bubbles: true }));
        await vi.waitFor(() => expect(chromeMock.runtime.sendMessage.mock.calls.some(([m]) => m?.action === 'getLocalSuggestions' && m.query === 'budg')).toBe(true));
        await pause(20); page.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
        const selectedId = page.selectionManager.getSelectedResult().metadata.tabId;
        logicalSpaces.push({ id: 'work', name: 'Work', color: 'red' });
        live.find(t => t.id === selectedId).spaceId = 'work';
        await invalidate();
        await vi.waitFor(() => expect(page.selectionManager.getSelectedResult()?.metadata.spaceName).toBe('Work'));
        expect(page.selectionManager.getSelectedResult().metadata.tabId).toBe(selectedId);
        expect(page.input.value).toBe('chrome://newtab/');
        expect(chromeMock.runtime.sendMessage.mock.calls.filter(([m]) => m?.action === 'getLocalSuggestions').every(([m]) => m.query === 'budg')).toBe(true);
        expect(bridgeMutations()).toHaveLength(0);
    });
    it('discards an older delayed snapshot when a logical invalidation has refreshed the same query', async () => {
        await open(); let release;
        snapshotHook = (request, response, callback) => {
            if (request.command !== 'hello') return false;
            snapshotHook = null; release = () => callback(response); return true;
        };
        page.input.value = 'new'; page.input.dispatchEvent(new Event('input', { bubbles: true }));
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        logicalSpaces[0].name = 'Fresh space'; await invalidate();
        await vi.waitFor(() => expect(rows()[0]?.textContent).toContain('Fresh space'));
        release(); await pause(60);
        expect(rows()[0].textContent).toContain('Fresh space'); expect(rows()[0].textContent).not.toContain('Home');
        expect(page.input.value).toBe('new'); expect(bridgeMutations()).toHaveLength(0);
    });
    it('rejects malformed, revoked, origin-spoofed and cross-window tab senders before a refresh', async () => {
        await open(); const before = readCount();
        for (const extra of [{ windowId: 0 }, { windowId: '2' }, { snapshot: {} }, { version: 2 }]) expect((await invalidate(extra)).ok).toBe(false);
        for (const sender of [{ id: 'c'.repeat(32) }, { id: PEER, url: 'https://wrong.test' }, { id: PEER, origin: 'https://wrong.test' }]) {
            expect(await invalidate({}, sender)).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
        }
        expect(await invalidate({}, { id: PEER, tab: { id: 20, windowId: 3 } })).toMatchObject({ ok: false, error: { code: 'INVALID_WINDOW' } });
        chromeMock.windows.get.mockResolvedValueOnce({ id: 2, type: 'normal', incognito: true });
        expect(await invalidate()).toMatchObject({ ok: false, error: { code: 'INVALID_WINDOW' } });
        chromeMock.windows.get.mockResolvedValueOnce({ id: 2, type: 'popup' });
        expect(await invalidate()).toMatchObject({ ok: false, error: { code: 'INVALID_WINDOW' } });
        chromeMock.windows.get.mockRejectedValueOnce(new Error('No window with ID 2'));
        expect(await invalidate()).toMatchObject({ ok: false, error: { code: 'INVALID_WINDOW' } });
        chromeMock.storage.local.get.mockResolvedValue({});
        expect(await invalidate()).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
        await pause(130); expect(readCount()).toBe(before); expect(shownIds()).toEqual([11]);
    });
    it('rejects pairing changed while validating the requested browser window', async () => {
        await open(); const before = readCount(); let resolve;
        chromeMock.windows.get.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
        const response = invalidate(); await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
        chromeMock.storage.local.get.mockResolvedValue({}); resolve({ id: 2, type: 'normal' });
        expect(await response).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
        await pause(130); expect(readCount()).toBe(before);
    });
    it('safely scopes valid wrong-window signals and moved helper contexts', async () => {
        live.push(tab(20, 3)); await open(); const before = readCount();
        await invalidate({ windowId: 3 }); await pause(130); expect(readCount()).toBe(before);
        live.find(t => t.id === sourceId).windowId = 3;
        await invalidate(); await pause(130); expect(readCount()).toBe(before);
        await invalidate({ windowId: 3 }); await vi.waitFor(() => expect(shownIds()).toEqual([20]));
        expect(bridgeMutations()).toHaveLength(0);
    });
    it('keeps the accepted pairing scope when revocation races the fresh search dispatch', async () => {
        await open(); const before = readCount();
        const original = chromeMock.runtime.sendMessage.getMockImplementation();
        chromeMock.runtime.sendMessage.mockImplementation((message, request, callback) => {
            if (message?.bridgeRefresh) chromeMock.storage.local.get.mockResolvedValue({});
            return original(message, request, callback);
        });
        await invalidate(); await vi.waitFor(() => expect(shownIds()).toEqual([]));
        expect(readCount()).toBe(before);
        expect(document.querySelector('[role="status"]').textContent).toContain('connection or window changed');
        expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
            action: 'getSpotlightSuggestions', bridgeRefresh: { peerId: PEER, windowId: 2 }
        }));
    });
    it.each(['pairing', 'window'])('rejects a fresh result if %s changes after snapshot validation during result production', async changed => {
        await open();
        const { ArcifyBridgeProvider } = await import('../../shared/data-providers/arcify-bridge-provider.js');
        const original = ArcifyBridgeProvider.prototype.getOpenTabs;
        vi.spyOn(ArcifyBridgeProvider.prototype, 'getOpenTabs').mockImplementationOnce(async function (...args) {
            if (changed === 'pairing') chromeMock.storage.local.get.mockResolvedValue({});
            else live.find(t => t.id === sourceId).windowId = 3;
            return original.apply(this, args);
        });
        await invalidate(); await vi.waitFor(() => expect(shownIds()).toEqual([]));
        expect(document.querySelector('[role="status"]').textContent).toContain('connection or window changed');
    });
    it('rejects a fresh result when its source moves while the snapshot is awaited', async () => {
        await open(); let release;
        snapshotHook = (request, response, callback) => {
            if (request.command !== 'hello') return false;
            snapshotHook = null; release = () => callback(response); return true;
        };
        await invalidate(); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        live.find(t => t.id === sourceId).windowId = 3; release();
        await vi.waitFor(() => expect(shownIds()).toEqual([]));
        expect(document.querySelector('[role="status"]').textContent).toContain('connection or window changed');
    });
    it('fails a refresh visibly when the companion disappears instead of falling back to native tabs', async () => {
        await open();
        snapshotHook = (request, response, callback) => {
            if (request.command !== 'hello') return false;
            callback({ ...response, ok: false, error: { code: 'UNAVAILABLE', message: 'Companion unavailable' } }); return true;
        };
        await invalidate(); await vi.waitFor(() => expect(shownIds()).toEqual([]));
        expect(chromeMock.tabs.update).not.toHaveBeenCalled(); expect(bridgeMutations()).toHaveLength(0);
    });
});

const saved = (id, tabId = null) => ({ id, title: 'Saved budget', url: 'https://example.test/budget', sourceBookmarkId: null, tabId });
const favoriteRows = () => [...page.resultsContainer.querySelectorAll('[data-result-type="arcify-favorite"]')];
const favoriteIds = () => page.selectionManager.results.filter(result => result.type === 'arcify-favorite').map(result => result.metadata.favoriteId);
async function openFavorites() {
    const { initializeSpotlight } = await import('../../newtab.js');
    page = await initializeSpotlight();
    await page.sidebarCommand.ready; await page.startupSuggestion.ready;
    await vi.waitFor(() => expect(favoriteIds()).toEqual(savedFavorites.map(favorite => favorite.id)));
}

describe('persistent Favorites in the real new-tab result lifecycle', () => {
    it('refreshes shared saved order and new closed records without native events, preserving a manually chosen identity', async () => {
        savedFavorites = [saved('first'), saved('second')];
        await openFavorites();
        page.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
        expect(page.selectionManager.getSelectedResult().metadata.favoriteId).toBe('second');
        expect(favoriteRows().map(row => row.dataset.favoriteId)).toEqual(['first', 'second']);
        const input = page.input, container = page.resultsContainer;
        savedFavorites = [saved('second'), saved('third'), saved('first')];
        await invalidate(); await vi.waitFor(() => expect(favoriteIds()).toEqual(['second', 'third', 'first']));
        expect(page.selectionManager.getSelectedResult().metadata.favoriteId).toBe('second');
        expect(page.input).toBe(input); expect(page.resultsContainer).toBe(container);
        expect(bridgeMutations()).toHaveLength(0);
    });
    it('keeps the saved row selected after Ctrl+W-like tab removal, with a closed action label', async () => {
        Object.assign(live.find(t => t.id === 11), { pinned: true, spaceId: null });
        savedFavorites = [saved('first', 11), saved('second')];
        await openFavorites();
        page.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' }));
        expect(favoriteRows()[0].textContent).toContain('Switch to Favorite');
        savedFavorites[0].tabId = null; closeTab(11); await invalidate();
        await vi.waitFor(() => expect(favoriteRows()[0].textContent).toContain('Open Favorite'));
        expect(favoriteIds()).toEqual(['first', 'second']);
        expect(page.selectionManager.getSelectedResult().metadata.favoriteId).toBe('first');
        expect(page.selectionManager.getSelectedResult().metadata.tabId).toBeNull();
        expect(window.close).not.toHaveBeenCalled(); expect(bridgeMutations()).toHaveLength(0);
    });
    it('preserves the real typed query and manual saved identity across binding and title changes', async () => {
        savedFavorites = [saved('first'), saved('second')]; await openFavorites();
        page.input.value = 'budget'; page.input.dispatchEvent(new Event('input', { bubbles: true }));
        await vi.waitFor(() => expect(favoriteIds()).toHaveLength(2)); await pause(30);
        page.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
        await vi.waitFor(() => expect(page.selectionManager.getSelectedResult()?.metadata.favoriteId).toBe('first'));
        const preview = page.input.value;
        Object.assign(live.find(t => t.id === 11), { pinned: true, spaceId: null });
        savedFavorites[0] = { ...saved('first', 11), title: 'Updated budget title' };
        await invalidate();
        await vi.waitFor(() => expect(page.selectionManager.getSelectedResult()?.title).toBe('Updated budget title'));
        expect(page.selectionManager.getSelectedResult().metadata.favoriteId).toBe('first');
        expect(page.input.value).toBe(preview);
        expect(chromeMock.runtime.sendMessage.mock.calls.filter(([m]) => m?.action === 'getLocalSuggestions').every(([m]) => m.query === 'budget')).toBe(true);
        expect(bridgeMutations()).toHaveLength(0);
    });
    it('drops the selected removed Favorite without silently selecting a URL twin under Enter', async () => {
        savedFavorites = [saved('first'), saved('second')]; await openFavorites();
        page.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' }));
        savedFavorites.shift(); await invalidate();
        await vi.waitFor(() => expect(favoriteIds()).toEqual(['second']));
        expect(page.selectionManager.getSelectedResult()).toBeNull();
        page.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: true }));
        page.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); await pause(20);
        expect(bridgeMutations()).toHaveLength(0); expect(actions()).toHaveLength(0);
    });
    it('rejects a removed Favorite at action time, refreshing without replay or ordinary-URL fallback', async () => {
        savedFavorites = [saved('first'), saved('second')]; await openFavorites();
        savedFavorites.shift(); favoriteRows()[0].click();
        await vi.waitFor(() => expect(document.querySelector('[role="status"]').textContent).toContain('That Favorite was removed'));
        await vi.waitFor(() => expect(favoriteIds()).toEqual(['second']));
        expect(page.selectionManager.getSelectedResult()).toBeNull();
        expect(bridgeMutations()).toHaveLength(0); expect(actions()).toHaveLength(1);
        expect(chromeMock.tabs.create).not.toHaveBeenCalled(); expect(chromeMock.tabs.update).not.toHaveBeenCalled();
    });
    it('discards a late authenticated hello snapshot after a newer Favorite invalidation', async () => {
        savedFavorites = [saved('first'), saved('second')]; await openFavorites(); let release;
        snapshotHook = (request, response, callback) => {
            if (request.command !== 'hello') return false;
            snapshotHook = null; release = () => callback(response); return true;
        };
        page.input.value = 'budget'; page.input.dispatchEvent(new Event('input', { bubbles: true }));
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        savedFavorites = [saved('second')]; await invalidate();
        await vi.waitFor(() => expect(favoriteIds()).toEqual(['second']));
        release(); await pause(60);
        expect(favoriteIds()).toEqual(['second']); expect(page.input.value).toBe('budget');
        expect(bridgeMutations()).toHaveLength(0);
    });
    it('does not refresh from revoked peer Favorite notifications or revive obsolete capability checks', async () => {
        savedFavorites = [saved('first')]; await openFavorites(); let release;
        snapshotHook = (request, response, callback) => {
            if (request.command !== 'hello') return false;
            snapshotHook = null; release = () => callback(response); return true;
        };
        await invalidate(); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        chromeMock.storage.local.get.mockResolvedValue({}); release();
        await vi.waitFor(() => expect(favoriteIds()).toEqual([]));
        expect(await invalidate()).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
        expect(shownIds()).toEqual([]); expect(bridgeMutations()).toHaveLength(0);
    });
    it('ignores hidden/disposed-page notifications and refreshes saved state upon return', async () => {
        savedFavorites = [saved('first')]; await openFavorites();
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        savedFavorites = [saved('second')]; await invalidate(); await pause(130);
        expect(favoriteIds()).toEqual(['first']);
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.waitFor(() => expect(favoriteIds()).toEqual(['second']));
        page.dispose(); savedFavorites = [saved('third')]; await invalidate(); await pause(130);
        expect(favoriteIds()).toEqual(['second']); expect(bridgeMutations()).toHaveLength(0);
    });
    it('dispatches a closed Favorite click through the real router and validates its newly bound tab', async () => {
        savedFavorites = [saved('first')]; await openFavorites();
        snapshotHook = (request, response, callback) => {
            if (request.command !== 'openFavorite') return false;
            live.push({ ...tab(30), url: savedFavorites[0].url, title: savedFavorites[0].title, pinned: true, spaceId: null });
            savedFavorites[0].tabId = 30;
            callback({ ...response, tabId: 30, snapshot: snapshot(request.windowId) }); return true;
        };
        favoriteRows()[0].click();
        await vi.waitFor(() => expect(bridgeMutations()).toHaveLength(1)); await pause(10);
        expect(bridgeMutations()[0][1]).toMatchObject({ command: 'openFavorite', favoriteId: 'first', windowId: 2 });
        expect(savedFavorites[0].tabId).toBe(30);
        expect(chromeMock.tabs.create).not.toHaveBeenCalled(); expect(chromeMock.tabs.update).not.toHaveBeenCalled();
        expect(document.querySelector('[role="status"]')?.textContent || '').not.toContain('invalid');
    });
    it('opens a closed Favorite only by its ID and keeps an unsupported command error visible', async () => {
        savedFavorites = [saved('first')]; await openFavorites();
        snapshotHook = (request, response, callback) => {
            if (request.command !== 'openFavorite') return false;
            callback({ ...response, ok: false, error: { code: 'UNSUPPORTED', message: 'Saved Favorites unsupported. Update Arcify.' } }); return true;
        };
        favoriteRows()[0].click();
        await vi.waitFor(() => expect(document.querySelector('[role="status"]').textContent).toContain('Saved Favorites unsupported'));
        expect(bridgeMutations()).toHaveLength(1);
        expect(bridgeMutations()[0][1]).toMatchObject({ command: 'openFavorite', windowId: 2, favoriteId: 'first' });
        expect(bridgeMutations()[0][1]).not.toHaveProperty('url');
        expect(chromeMock.tabs.create).not.toHaveBeenCalled(); expect(chromeMock.tabs.update).not.toHaveBeenCalled(); expect(window.close).not.toHaveBeenCalled();
    });
    it('revalidates saved Favorites after a mocked cold background-worker restart', async () => {
        savedFavorites = [saved('first')]; await openFavorites();
        backgroundListeners = []; externalListeners = []; registrationTarget = backgroundListeners;
        vi.resetModules(); await import('../../background.js'); registrationTarget = pageListeners;
        savedFavorites = [saved('second')]; const before = readCount(); await invalidate();
        await vi.waitFor(() => expect(favoriteIds()).toEqual(['second']));
        expect(readCount()).toBeGreaterThan(before);
        expect(chromeMock.runtime.sendMessage.mock.calls.some(([target, request]) => target === PEER && request.command === 'hello')).toBe(true);
        expect(bridgeMutations()).toHaveLength(0);
    });
    it('does not expose saved-Favorite ownership when used standalone', async () => {
        savedFavorites = [saved('first')]; chromeMock.storage.local.get.mockResolvedValue({});
        live.find(t => t.id === 11).pinned = true;
        const response = await internal({ action: 'getSpotlightSuggestions', query: '', mode: 'current-tab' });
        expect(response.results.every(result => result.type !== 'arcify-favorite' && !result.metadata.arcifyBridge)).toBe(true);
        const { SpotlightUtils } = await import('../../shared/ui-utilities.js');
        expect(SpotlightUtils.formatResult(response.results[0], 'new-tab').action).toBe('Open Pinned Tab');
    });
});
