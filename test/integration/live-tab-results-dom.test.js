// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromeMock } from '../mocks/chrome.js';
import './setup.js';

// Real background/client/provider/action router and real new-tab DOM. Only the
// Chrome transport, tabs, and authenticated peer snapshot are API boundary mocks.
const PEER = 'a'.repeat(32);
const OWN = 'b'.repeat(32);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let live, sourceId, sourceUrl, page, registrationTarget, backgroundListeners, pageListeners, externalListeners, contextDelay;
const event = () => {
    const listeners = new Set();
    return { addListener: vi.fn(fn => listeners.add(fn)), removeListener: vi.fn(fn => listeners.delete(fn)), emit: (...args) => [...listeners].forEach(fn => fn(...args)) };
};
const tab = (id, windowId = 2) => ({ id, windowId, title: 'New Tab', url: 'chrome://newtab/', active: id === sourceId, pinned: false, spaceId: 'home', groupId: -1 });
const snapshot = windowId => ({ windowId, activeSpaceId: 'home', capturedAt: Date.now(),
    spaces: [{ id: 'home', name: 'Home', color: 'blue', tabIds: live.filter(t => t.windowId === windowId).map(t => t.id), pinnedTabIds: [], temporaryTabIds: live.filter(t => t.windowId === windowId).map(t => t.id) }],
    tabs: live.filter(t => t.windowId === windowId).map(t => ({ ...t })), bookmarks: [] });
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
    sourceId = 12; sourceUrl = chromeMock.runtime.getURL('newtab.html'); contextDelay = null;
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
    chromeMock.tabs.getCurrent = vi.fn(async () => ({ ...live.find(t => t.id === sourceId) }));
    chromeMock.runtime.sendMessage.mockImplementation((target, request, callback) => {
        if (target === PEER) {
            callback({ type: 'arcify-bridge', version: 1, role: 'arcify', extensionId: PEER, requestId: request.requestId, ok: true,
                snapshot: snapshot(request.windowId), capabilities: ['openSidebar'], ...(request.tabId ? { tabId: request.tabId } : {}) });
            return;
        }
        if (target.action === 'spotlightLiveTabsChanged') return dispatch(pageListeners, target, { id: OWN });
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
