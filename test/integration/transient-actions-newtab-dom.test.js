// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromeMock } from '../mocks/chrome.js';
import { transientScope, transientResult, PEER } from '../fixtures/transient-actions.js';
import './setup.js';
let page, scope, eventSpy, mutation;
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function fire(target, type, extra = {}) {
    const event = { type, target, key: 'Enter', button: 0, isTrusted: true, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra };
    eventSpy.mock.calls.forEach(([name, callback], i) => { if (name === type && eventSpy.mock.contexts[i] === target) callback(event); });
}
const type = query => { page.input.value = query; page.input.dispatchEvent(new Event('input', { bubbles: true })); };
const calls = action => chromeMock.runtime.sendMessage.mock.calls.filter(([message]) => message.action === action);
beforeEach(() => {
    document.body.innerHTML = '<div id="spotlight-container"></div>'; scope = transientScope(); eventSpy = vi.spyOn(EventTarget.prototype, 'addEventListener');
    Object.defineProperty(document, 'URL', { configurable: true, value: chromeMock.runtime.getURL('newtab.html') });
    HTMLElement.prototype.scrollIntoView = vi.fn(); chromeMock.tabs.getCurrent = vi.fn().mockResolvedValue({ id: 9 });
    chromeMock.storage.local.get.mockResolvedValue({ arcifyBridgePeerId: PEER, arcifyBridgePairingGeneration: 'local' });
    mutation = vi.fn(async () => ({ success: true, result: transientResult() }));
    chromeMock.runtime.sendMessage.mockImplementation(async message => {
        if (message.action === 'arcifyTransientContext') return { success: true, scope: structuredClone(scope) };
        if (message.action === 'arcifyOpenTransient') return mutation(message);
        if (['arcifyTabActionsContext', 'arcifySpaceActionsContext', 'arcifyArchiveContext', 'arcifySplitActionsContext'].includes(message.action)) return { success: true, scope: null };
        if (message.action === 'arcifyBridgeStatus') return { success: true, status: { status: 'connected', peerId: PEER, capabilities: [] } };
        return { success: true, results: [] };
    });
});
afterEach(() => { page?.dispose(); page = null; vi.restoreAllMocks(); delete HTMLElement.prototype.scrollIntoView; });
async function mount() { const { initializeSpotlight } = await import('../../newtab.js'); page = await initializeSpotlight(); await page.transientActions.ready; await flush(); }
describe('Little Arc in the actual newtab renderer', () => {
    it('keeps ordinary URL Enter unchanged and offers a separate temporary-window row', async () => {
        await mount(); type('https://target.test/');
        expect(page.resultsContainer.querySelector('.selected').dataset.resultType).toBe('url-suggestion');
        const action = page.resultsContainer.querySelector('[data-result-type="arcify-transient-action"]');
        expect(action.textContent).toContain('Open link in Little Arc'); expect(action.textContent).toContain('After restart: no control tab → ordinary tabs');
        fire(page.input, 'keydown'); await flush(); expect(calls('spotlightHandleResult')).toHaveLength(1); expect(calls('arcifyOpenTransient')).toHaveLength(0);
    });
    it('dispatches explicit command once with exact helper tab, keeping the helper open', async () => {
        await mount(); const close = vi.spyOn(window, 'close').mockImplementation(() => {}); type('little arc https://target.test/');
        expect(page.resultsContainer.querySelector('.selected').dataset.resultType).toBe('arcify-transient-action');
        fire(page.input, 'keydown'); fire(page.input, 'keydown'); await page.transientActions.operation; await flush();
        expect(calls('arcifyOpenTransient')).toHaveLength(1); expect(calls('arcifyOpenTransient')[0][0]).toMatchObject({ tabId: 9, url: 'https://target.test/' });
        expect(calls('spotlightHandleResult')).toHaveLength(0); expect(close).not.toHaveBeenCalled();
        expect(document.querySelector('[role="status"]').textContent).toContain('Opened in Little Arc');
        fire(page.input, 'keydown', { repeat: true }); await flush(); expect(calls('arcifyOpenTransient')).toHaveLength(1); expect(calls('spotlightHandleResult')).toHaveLength(0);
    });
    it('does not let a synthetic click change selection or invoke', async () => {
        await mount(); type('https://target.test/'); page.resultsContainer.querySelector('[data-result-type="arcify-transient-action"]').click(); await flush();
        expect(page.resultsContainer.querySelector('.selected').dataset.resultType).toBe('url-suggestion'); expect(calls('arcifyOpenTransient')).toHaveLength(0);
    });
    it('offers nothing for old peers or incomplete/non-web links', async () => {
        scope = null; await mount(); type('little arc https://target.test/'); expect(page.resultsContainer.querySelector('[data-result-type="arcify-transient-action"]')).toBeNull();
        scope = transientScope(); await page.transientActions.prepare();
        for (const query of ['little arc', 'little arc example.test', 'little arc chrome://settings']) { type(query); expect(page.resultsContainer.querySelector('[data-result-type="arcify-transient-action"]')).toBeNull(); }
    });
    it('pagehide retires pending UI and never replays a late acknowledgement', async () => {
        await mount(); let resolve; mutation.mockImplementation(() => new Promise(done => { resolve = done; })); type('little arc https://target.test/'); fire(page.input, 'keydown');
        window.dispatchEvent(new Event('pagehide')); resolve({ success: true, result: transientResult() }); await page.transientActions.operation;
        expect(page.transientActions.disposed).toBe(true); expect(calls('arcifyOpenTransient')).toHaveLength(1); expect(document.querySelector('[role="status"]')?.textContent || '').not.toContain('Opened in Little Arc');
    });
});
