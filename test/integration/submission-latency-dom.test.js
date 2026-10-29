// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { chromeMock } from '../mocks/chrome.js';
import { transientScope, transientResult } from '../fixtures/transient-actions.js';
import './setup.js';

const flush = async () => { for (let i = 0; i < 35; i++) await Promise.resolve(); };
const waitForDebounce = () => new Promise(resolve => setTimeout(resolve, 180));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const requests = action => chromeMock.runtime.sendMessage.mock.calls.filter(([message]) => message?.action === action).map(([message]) => message);
let page, input, root, listeners, realms, submitted, local, localResults, transientEnabled, eventSpy;
function dispatch(message) { return new Promise(resolve => {
    let pending = false;
    for (const listener of [...listeners]) if (listener(message, { id: chromeMock.runtime.id }, resolve) === true) pending = true;
    if (!pending) resolve();
}); }
const type = text => { input.value = text; input.dispatchEvent(new root.defaultView.Event('input', { bubbles: true })); };
const enter = () => input.dispatchEvent(new root.defaultView.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
const trustedEnter = () => {
    // jsdom cannot create trusted events. Invoke the registered production
    // handler with browser-attested fields, matching the existing action tests.
    const event = { type: 'keydown', key: 'Enter', target: input, isTrusted: true, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    eventSpy.mock.calls.forEach(([name, listener], i) => {
        if (name === 'keydown' && eventSpy.mock.contexts[i] === input) listener(event);
    });
};
beforeEach(() => {
    document.body.innerHTML = '<div id="spotlight-container"></div>';
    listeners = []; realms = []; submitted = deferred(); local = null; localResults = [];
    transientEnabled = false; eventSpy = vi.spyOn(EventTarget.prototype, 'addEventListener');
    for (const key of ['arcifySpotlightTabMode', 'arcifySpotlightInjected', 'arcifyCurrentTabUrl', 'arcifyCurrentTabId']) delete window[key];
    HTMLElement.prototype.scrollIntoView = () => {};
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
    HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
    const documents = new WeakMap();
    vi.spyOn(HTMLIFrameElement.prototype, 'contentDocument', 'get').mockImplementation(function () {
        if (!documents.has(this)) {
            const realm = new JSDOM('<!doctype html><html><head></head><body></body></html>').window;
            realm.HTMLElement.prototype.scrollIntoView = () => {};
            realm.EventTarget.prototype.addEventListener = EventTarget.prototype.addEventListener;
            documents.set(this, realm.document); realms.push(realm);
        }
        return documents.get(this);
    });
    chromeMock.runtime.onMessage.addListener.mockImplementation(listener => listeners.push(listener));
    chromeMock.runtime.onMessage.removeListener.mockImplementation(listener => { listeners = listeners.filter(value => value !== listener); });
    chromeMock.storage.local.get.mockResolvedValue({});
    chromeMock.tabs.getCurrent = vi.fn(async () => ({ id: 9, windowId: 2, url: chromeMock.runtime.getURL('newtab.html') }));
    chromeMock.runtime.sendMessage.mockImplementation(async message => {
        if (message.action === 'spotlightHandleResult') return submitted.promise;
        if (message.action === 'arcifyTransientContext') return { success: true, scope: transientEnabled ? transientScope() : null };
        if (message.action === 'arcifyOpenTransient') return { success: true, result: transientResult() };
        if (message.action === 'getLocalSuggestions') return local ? local.promise : { success: true, results: localResults };
        if (message.action === 'arcifyBridgeStatus') return { success: true, status: { configured: false, status: 'disabled', capabilities: [] } };
        if (message.action === 'getActiveSpaceColor') return { success: true, color: 'purple' };
        return { success: true, results: [], scope: null };
    });
    vi.spyOn(window, 'close').mockImplementation(() => {});
});
afterEach(async () => {
    submitted.resolve({ success: false, error: 'Stopped test submission.' });
    local?.resolve({ success: true, results: [] });
    await flush();
    page?.dispose(); page = null;
    await dispatch({ action: 'closeSpotlight' });
    await new Promise(resolve => setTimeout(resolve, 210));
    realms.forEach(realm => realm.close());
    document.body.replaceChildren();
    vi.restoreAllMocks();
    delete HTMLElement.prototype.scrollIntoView;
    delete HTMLDialogElement.prototype.showModal;
    delete HTMLDialogElement.prototype.close;
});
async function open(surface) {
    if (surface === 'overlay') {
        await import('../../overlay.js');
        await dispatch({ action: 'activateSpotlight', mode: 'new-tab', tabUrl: 'https://source.test/', tabId: 9 });
        root = document.getElementById('arcify-spotlight-host').shadowRoot.querySelector('iframe').contentDocument;
    } else {
        const { initializeSpotlight } = await import('../../newtab.js');
        page = await initializeSpotlight();
        root = document;
    }
    await flush();
    input = root.querySelector('.arcify-spotlight-input');
}
for (const surface of ['overlay', 'newtab']) describe(surface + ' real submit handlers', () => {
    it('blocks a Little Arc submission while ordinary native navigation is pending', async () => {
        transientEnabled = true;
        await open(surface); type('https://target.test/');
        expect(root.querySelector('[data-result-type="arcify-transient-action"]')).not.toBeNull();
        trustedEnter(); await flush();
        input.dispatchEvent(new root.defaultView.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        expect(root.querySelector('.selected').dataset.resultType).toBe('arcify-transient-action');
        trustedEnter(); await flush();
        expect(requests('spotlightHandleResult')).toHaveLength(1);
        expect(requests('arcifyOpenTransient')).toHaveLength(0);
        submitted.resolve({ success: false, error: 'Navigation rejected.' }); await flush();
        type('little arc https://target.test/'); trustedEnter(); await flush();
        expect(requests('arcifyOpenTransient')).toHaveLength(1);
    });
    it('submits immediately, cancels pending ranking, and permits fresh input after rejection', async () => {
        await open(surface);
        type('first draft'); type('final query');
        enter(); enter(); await flush();
        expect(requests('spotlightHandleResult')).toHaveLength(1);
        expect(requests('spotlightHandleResult')[0].result.metadata.query).toBe('final query');
        await waitForDebounce();
        expect(requests('getLocalSuggestions')).toHaveLength(0);
        expect(requests('getAutocompleteSuggestions')).toHaveLength(0);
        submitted.resolve({ success: false, error: 'Connection unavailable.' }); await flush();
        type('fresh query'); await waitForDebounce(); await flush();
        expect(requests('getLocalSuggestions')).toHaveLength(1);
        expect(requests('getLocalSuggestions')[0].query).toBe('fresh query');
    });
    it('ignores a ranking response already in flight when Enter commits its visible choice', async () => {
        await open(surface); local = deferred();
        type('my exact query'); await waitForDebounce();
        expect(requests('getLocalSuggestions')).toHaveLength(1);
        enter(); await flush();
        local.resolve({ success: true, results: [{ type: 'history', title: 'Late result', url: 'https://late.test/' }] });
        await flush();
        expect(requests('getAutocompleteSuggestions')).toHaveLength(0);
        expect(root.querySelector('.arcify-spotlight-results').textContent).not.toContain('Late result');
        expect(requests('spotlightHandleResult')[0].result.metadata.query).toBe('my exact query');
        expect(requests('spotlightHandleResult')).toHaveLength(1);
    });
    it('submits a Helium settings address as a canonical browser-page result', async () => {
        await open(surface); type('helium://settings'); enter(); await flush();
        expect(requests('spotlightHandleResult')).toHaveLength(1);
        expect(requests('spotlightHandleResult')[0].result).toMatchObject({ type: 'url-suggestion', url: 'chrome://settings' });
    });
});
