// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromeMock } from '../mocks/chrome.js';
import { installArcifyTransientActionMessages } from '../../shared/arcify-transient-actions.js';
import { installLiveTabResultUpdates } from '../../shared/live-tab-results.js';
import { PEER, snapshot, envelope, transientResult } from '../fixtures/transient-actions.js';
import './setup.js';
let page, disposeAdapter, disposeFanout, handlers, eventSpy, external, originals, stored;
const flush = async () => { for (let i = 0; i < 35; i++) await Promise.resolve(); };
const settleEvents = async () => { await new Promise(resolve => setTimeout(resolve, 110)); await flush(); };
const event = () => { const listeners = new Set(); return { addListener: vi.fn(fn => listeners.add(fn)), removeListener: vi.fn(fn => listeners.delete(fn)), emit: (...args) => [...listeners].forEach(fn => fn(...args)) }; };
function fire(target, type, extra = {}) {
    const event = { type, target, key: 'Enter', button: 0, isTrusted: true, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra };
    eventSpy.mock.calls.forEach(([name, callback], i) => { if (name === type && eventSpy.mock.contexts[i] === target) callback(event); });
}
const type = query => { page.input.value = query; page.input.dispatchEvent(new Event('input', { bubbles: true })); };
const reads = () => chromeMock.runtime.sendMessage.mock.calls.filter(([message]) => message?.action === 'arcifyTransientContext');
const mutations = () => external.mock.calls.filter(([, request]) => request.command === 'openTransient');
beforeEach(() => {
    document.body.innerHTML = '<div id="spotlight-container"></div>'; handlers = new Set(); originals = [];
    Object.defineProperty(document, 'URL', { configurable: true, value: chromeMock.runtime.getURL('newtab.html') });
    HTMLElement.prototype.scrollIntoView = vi.fn(); eventSpy = vi.spyOn(EventTarget.prototype, 'addEventListener');
    for (const [owner, name] of [[chromeMock.tabs, 'onUpdated'], [chromeMock.tabs, 'onActivated'], [chromeMock.tabs, 'onRemoved'], [chromeMock.windows, 'onFocusChanged']]) {
        originals.push([owner, name, owner[name]]); owner[name] = event();
    }
    chromeMock.runtime.onMessage.addListener.mockImplementation(listener => handlers.add(listener));
    chromeMock.runtime.onMessage.removeListener.mockImplementation(listener => handlers.delete(listener));
    chromeMock.tabs.getCurrent = vi.fn(async () => ({ id: 9 }));
    chromeMock.tabs.get.mockImplementation(async id => ({ id, windowId: id === 9 ? 2 : 4, active: true, status: 'complete', url: id === 9 ? chromeMock.runtime.getURL('newtab.html') : 'https://other.test/' }));
    chromeMock.tabs.query.mockResolvedValue([]);
    chromeMock.windows.get.mockImplementation(async id => ({ id, focused: id === 2, type: 'normal', incognito: false }));
    stored = { arcifyBridgePeerId: PEER, arcifyBridgePairingGeneration: 'local' };
    chromeMock.storage.local.get.mockImplementation(async () => structuredClone(stored));
    external = vi.fn(async (peer, request) => ({ ...envelope(request.command === 'hello' ? { extensionId: PEER, capabilities: ['globalFavoritesV1', 'transientWindowsV1'], snapshot: snapshot() } : { ...transientResult(), snapshot: snapshot() }), requestId: request.requestId }));
    chromeMock.runtime.sendMessage.mockImplementation((message, request, callback) => {
        if (typeof message === 'string') { external(message, request).then(callback); return; }
        if (message.action === 'spotlightLiveTabsChanged') {
            for (const listener of handlers) listener(message, { id: chromeMock.runtime.id, url: chromeMock.runtime.getURL('background.js') }, () => {});
            return Promise.resolve();
        }
        if (['arcifyTransientContext', 'arcifyOpenTransient'].includes(message.action)) return new Promise(resolve => {
            for (const listener of handlers) listener(message, { id: chromeMock.runtime.id, url: chromeMock.runtime.getURL('newtab.html') }, resolve);
        });
        if (message.action === 'spotlightLiveTabContext') return Promise.resolve({ success: true, sourceTabId: 9, windowId: 2, peerId: PEER });
        if (['arcifyTabActionsContext', 'arcifySpaceActionsContext', 'arcifyArchiveContext', 'arcifySplitActionsContext'].includes(message.action)) return Promise.resolve({ success: true, scope: null });
        if (message.action === 'arcifyBridgeStatus') return Promise.resolve({ success: true, status: { status: 'connected', peerId: PEER, capabilities: [] } });
        return Promise.resolve({ success: true, results: [] });
    });
    let queue = Promise.resolve();
    const bridge = { getPeerId: async () => PEER, timeoutMs: 500, serializeAction: operation => { const next = queue.then(operation); queue = next.catch(() => {}); return next; } };
    disposeAdapter = installArcifyTransientActionMessages(chromeMock, bridge);
    disposeFanout = installLiveTabResultUpdates(chromeMock);
});
afterEach(() => { page?.dispose(); page = null; disposeAdapter?.(); disposeFanout?.(); for (const [owner, name, value] of originals) owner[name] = value; vi.restoreAllMocks(); delete HTMLElement.prototype.scrollIntoView; });
async function mount() { const { initializeSpotlight } = await import('../../newtab.js'); page = await initializeSpotlight(); await page.transientActions.ready; await flush(); type('little arc https://target.test/'); }
describe('native invalidation across the real background and newtab renderer', () => {
    it('keeps a visible window-2 action executable after unrelated window-4 completion', async () => {
        await mount(); const viewId = page.transientActions.scope.viewId, count = reads().length;
        chromeMock.tabs.onUpdated.emit(22, { status: 'complete' }, { id: 22, windowId: 4 }); await settleEvents();
        expect(reads()).toHaveLength(count); expect(page.transientActions.scope.viewId).toBe(viewId);
        expect(page.resultsContainer.querySelector('[data-result-type="arcify-transient-action"]')).not.toBeNull();
        fire(page.input, 'keydown'); await page.transientActions.operation; await flush();
        expect(mutations()).toHaveLength(1); expect(document.querySelector('[role="status"]').textContent).toContain('Opened in Little Arc');
    });
    it('retires source-window context and refreshes the visible row before a fresh gesture', async () => {
        await mount(); const viewId = page.transientActions.scope.viewId, count = reads().length;
        chromeMock.tabs.onUpdated.emit(10, { status: 'complete' }, { id: 10, windowId: 2 }); await settleEvents();
        expect(reads().length).toBeGreaterThan(count); expect(page.transientActions.scope.viewId).not.toBe(viewId);
        expect(mutations()).toHaveLength(0); fire(page.input, 'keydown', { key: 'ArrowDown' }); fire(page.input, 'keydown'); await page.transientActions.operation;
        expect(mutations()).toHaveLength(1); expect(document.querySelector('[role="status"]').textContent).toContain('Opened in Little Arc');
    });
    it('broadcasts unknown-window/focus changes and refreshes every affected visible scope', async () => {
        await mount(); const viewId = page.transientActions.scope.viewId;
        chromeMock.windows.onFocusChanged.emit(2); await settleEvents();
        expect(page.transientActions.scope.viewId).not.toBe(viewId); expect(mutations()).toHaveLength(0);
    });
    it.each(['pairing lookup', 'source attestation'])('keeps the newer renderer scope authoritative when an older %s completes late', async phase => {
        await mount(); let release;
        const delayed = phase === 'pairing lookup' ? chromeMock.storage.local.get : chromeMock.tabs.get;
        delayed.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
        const older = page.transientActions.prepare(); await flush(); expect(release).toBeTypeOf('function');
        await page.transientActions.prepare(); const viewId = page.transientActions.scope.viewId;
        release(phase === 'pairing lookup' ? structuredClone(stored) : { id: 9, windowId: 2, active: true, status: 'complete', url: chromeMock.runtime.getURL('newtab.html') }); await older; expect(page.transientActions.scope.viewId).toBe(viewId);
        type('little arc https://target.test/'); fire(page.input, 'keydown'); await page.transientActions.operation;
        expect(mutations()).toHaveLength(1); expect(document.querySelector('[role="status"]').textContent).toContain('Opened in Little Arc');
    });
});
