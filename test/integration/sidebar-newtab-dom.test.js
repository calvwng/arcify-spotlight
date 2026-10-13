// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chromeMock } from '../mocks/chrome.js';
import './setup.js';

// Production newtab/controller/selection/rendering/message modules. Chrome and the
// DOM platform's trusted-event flag are boundary mocks; browser CI proves native gestures.
const PEER = 'a'.repeat(32), OWN = 'b'.repeat(32);
const ordinary = { type: 'history', title: 'Example', url: 'https://example.test', domain: 'example.test' };
let page, initialResults, available, eventSpy, storageChanged;
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const commands = () => chromeMock.runtime.sendMessage.mock.calls.filter(args => args[0] === PEER);
const normalActions = () => chromeMock.runtime.sendMessage.mock.calls.filter(args => args[0]?.action === 'spotlightHandleResult');
const commandRow = () => page.resultsContainer.querySelector('[data-result-type="arcify-sidebar-command"]');

beforeEach(() => {
    document.body.innerHTML = '<div id="spotlight-container"></div>';
    Object.defineProperty(document, 'URL', { configurable: true, value: chromeMock.runtime.getURL('newtab.html') });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    HTMLElement.prototype.scrollIntoView = vi.fn();
    chromeMock.tabs.getCurrent = vi.fn().mockResolvedValue({ id: 9, windowId: 2, url: 'chrome://newtab/' });
    chromeMock.storage.local.get.mockResolvedValue({ arcifyBridgePeerId: PEER });
    chromeMock.storage.onChanged.addListener.mockImplementation(listener => { storageChanged = listener; });
    initialResults = [ordinary]; available = true;
    chromeMock.runtime.sendMessage.mockImplementation((message, request, callback) => {
        if (typeof message === 'string') {
            callback({ ...request, role: 'arcify', ok: true });
            return;
        }
        if (message.action === 'arcifyBridgeStatus') return Promise.resolve({ success: true, status: { status: 'connected', peerId: PEER, capabilities: available ? ['openSidebar'] : [] } });
        if (message.action === 'getActiveSpaceColor') return Promise.resolve({ success: true, color: 'purple' });
        if (message.action === 'getSpotlightSuggestions') return Promise.resolve(initialResults).then(results => ({ success: true, results }));
        if (message.action === 'getLocalSuggestions') return Promise.resolve({ success: true, results: [{ ...ordinary, title: message.query }] });
        if (message.action === 'getAutocompleteSuggestions') return Promise.resolve({ success: true, results: [] });
        if (message.action === 'spotlightHandleResult') return Promise.resolve({ success: true });
        return Promise.resolve({ success: true });
    });
    eventSpy = vi.spyOn(EventTarget.prototype, 'addEventListener');
    vi.spyOn(window, 'close').mockImplementation(() => {});
});
afterEach(() => {
    page?.dispose(); page = null; eventSpy.mockRestore(); vi.restoreAllMocks();
    delete HTMLElement.prototype.scrollIntoView;
});
async function open() {
    const { initializeSpotlight } = await import('../../newtab.js');
    page = await initializeSpotlight();
    await page.sidebarCommand.ready; await page.startupSuggestion.ready; await flush();
    return page;
}
function offer(extra = {}) {
    const reply = vi.fn();
    chromeMock.runtime.onMessage.callListeners({ action: 'arcifyStartupSidebarSuggestion', requestId: 'startup', peerId: PEER, tabId: 9, windowId: 2, ...extra }, { id: OWN }, reply);
    return reply.mock.calls[0]?.[0];
}
function type(query) { page.input.value = query; page.input.dispatchEvent(new Event('input', { bubbles: true })); }
function trustedKey(key, extra = {}) {
    const event = { type: 'keydown', key, isTrusted: true, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra };
    eventSpy.mock.calls.forEach(([name, listener], i) => {
        if (name === 'keydown' && eventSpy.mock.contexts[i] === page.input) listener(event);
    });
}
function trustedClick(element) {
    const event = { type: 'click', target: element, button: 0, isTrusted: true };
    eventSpy.mock.calls.forEach(([name, listener], i) => {
        if (name === 'click' && eventSpy.mock.contexts[i] === page.resultsContainer) listener(event);
    });
}

describe('real newtab sidebar and startup DOM wiring', () => {
    it('keeps ordinary first result selected and lists available sidebar after it', async () => {
        await open(); expect(commandRow()).not.toBeNull();
        expect(page.selectionManager.getSelectedResult()).toEqual(ordinary);
        expect(commandRow().classList.contains('selected')).toBe(false);
    });
    it('never defaults to sole empty-query command without accepted startup, including delayed initial results', async () => {
        let resolve; initialResults = new Promise(r => resolve = r); await open();
        expect(commandRow()).not.toBeNull(); expect(page.selectionManager.getSelectedResult()).toBeNull();
        expect(offer()).toMatchObject({ accepted: false, reason: 'not-ready' });
        resolve([]); await flush();
        expect(page.selectionManager.getSelectedResult()).toBeNull();
        trustedKey('Enter'); expect(commands()).toHaveLength(0);
    });
    it('accepts startup only once, highlights command and sends direct Enter synchronously without closing the page', async () => {
        await open(); const focus = vi.spyOn(page.input, 'focus');
        expect(offer()).toMatchObject({ accepted: true });
        expect(commandRow().classList.contains('selected')).toBe(true); expect(page.input.value).toBe('');
        expect(focus).not.toHaveBeenCalled();
        trustedKey('Enter');
        expect(commands()).toHaveLength(1); expect(normalActions()).toHaveLength(0);
        expect(window.close).not.toHaveBeenCalled();
        expect(document.querySelector('[role="status"]').textContent).toBe('Arcify sidebar opened.');
        expect(offer()).toMatchObject({ accepted: false });
    });
    it('sends a trusted result click immediately, but ignores synthetic DOM clicks and keys', async () => {
        await open(); commandRow().click(); expect(commands()).toHaveLength(0);
        expect(offer()).toMatchObject({ accepted: true });
        page.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
        expect(commands()).toHaveLength(0);
        trustedClick(commandRow()); expect(commands()).toHaveLength(1); expect(normalActions()).toHaveLength(0);
    });
    it('preserves ordinary URL preview and does not skip the first real typed input after selecting', async () => {
        await open(); offer(); trustedKey('ArrowDown');
        expect(page.input.value).toBe(ordinary.url); expect(page.selectionManager.getSelectedResult()).toEqual(ordinary);
        type('different query');
        expect(page.selectionManager.getSelectedResult()).toMatchObject({ type: 'search-query', metadata: { query: 'different query' } });
        expect(commandRow()).toBeNull();
        expect(offer()).toMatchObject({ accepted: false, reason: 'user-interaction' });
        trustedKey('Enter'); expect(normalActions()).toHaveLength(1); expect(commands()).toHaveLength(0);
    });
    it('typing then clearing cancels startup and cannot auto-select a sole sidebar command again', async () => {
        initialResults = []; await open(); offer(); type('typed'); type(''); await flush();
        expect(commandRow()).not.toBeNull(); expect(page.selectionManager.getSelectedResult()).toBeNull();
        expect(offer()).toMatchObject({ accepted: false, reason: 'user-interaction' });
    });
    it.each([' ', ''])('clears startup selection synchronously on blank input %j before delayed results return', async value => {
        initialResults = []; await open(); offer();
        let resolve; initialResults = new Promise(r => resolve = r);
        type(value);
        expect(page.selectionManager.getSelectedResult()).toBeNull();
        trustedKey('Enter'); expect(commands()).toHaveLength(0);
        resolve([]); await flush();
        expect(page.selectionManager.getSelectedResult()).toBeNull();
    });
    it('Escape clears startup selection so later Enter does not invoke it', async () => {
        await open(); offer(); trustedKey('Escape');
        expect(page.selectionManager.getSelectedResult()).toBeNull();
        trustedKey('Enter'); expect(commands()).toHaveLength(0);
    });
    it('does not allow late initial results to erase typed input or replace the selected search', async () => {
        let resolve; initialResults = new Promise(r => resolve = r); await open();
        type('typed before results'); resolve([ordinary]); await flush();
        expect(page.input.value).toBe('typed before results');
        expect(page.selectionManager.getSelectedResult()).toMatchObject({ metadata: { query: 'typed before results' } });
        expect(offer()).toMatchObject({ accepted: false, reason: 'user-interaction' });
    });
    it('hiding and returning clears actual startup selection and never reinstates it', async () => {
        await open(); offer();
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
        expect(page.selectionManager.getSelectedResult()).toBeNull();
        trustedKey('Enter'); expect(commands()).toHaveLength(0);
        expect(offer()).toMatchObject({ accepted: false, reason: 'user-interaction' });
    });
    it('capability absence preserves standalone search and removes command', async () => {
        available = false; await open(); expect(commandRow()).toBeNull();
        expect(page.selectionManager.getSelectedResult()).toEqual(ordinary);
        trustedKey('Enter'); expect(normalActions()).toHaveLength(1);
    });
    it.each(['failure', 'revocation'])('command %s leaves no fallback selected through refresh or held Enter', async cause => {
        await open(); offer();
        if (cause === 'failure') {
            const original = chromeMock.runtime.sendMessage.getMockImplementation();
            chromeMock.runtime.sendMessage.mockImplementation((message, request, callback) => {
                if (typeof message === 'string') return callback({ ...request, role: 'arcify', ok: false, error: { message: 'Revoked' } });
                return original(message, request, callback);
            });
            trustedKey('Enter');
        } else {
            chromeMock.storage.local.get.mockResolvedValue({});
            storageChanged({ arcifyBridgePeerId: { newValue: '' } }, 'local');
        }
        expect(page.selectionManager.getSelectedResult()).toBeNull();
        await page.sidebarCommand.ready;
        page.sidebarCommand.onChange(); // A later unrelated render cannot revive selection.
        expect(page.selectionManager.getSelectedResult()).toBeNull();
        trustedKey('Enter', { repeat: true }); trustedKey('Enter');
        expect(normalActions()).toHaveLength(0);
        trustedKey('ArrowDown'); trustedKey('Enter');
        expect(normalActions()).toHaveLength(1);
    });
    it('auto-selects a fuzzy sidebar action above retained web search, with the visible panel icon', async () => {
        await open(); type('opn arcfi');
        expect(page.selectionManager.getSelectedResult()).toMatchObject({ type: 'arcify-sidebar-command' });
        const rows = [...page.resultsContainer.querySelectorAll('[data-result-type]')];
        expect(rows.map(row => row.dataset.resultType)).toEqual(['arcify-sidebar-command', 'search-query']);
        expect(decodeURIComponent(rows[0].querySelector('img').getAttribute('src'))).toContain('M9 4v16');
        trustedKey('Enter');
        expect(commands()).toHaveLength(1); expect(normalActions()).toHaveLength(0);
        expect(window.close).not.toHaveBeenCalled();
    });
    it('lets ArrowDown choose web search and retains that choice through async local results', async () => {
        await open(); type('opn arcfi'); trustedKey('ArrowDown');
        expect(page.selectionManager.getSelectedResult()).toMatchObject({ type: 'search-query' });
        await vi.waitFor(() => expect(page.resultsContainer.querySelectorAll('[data-result-type]')).toHaveLength(3));
        expect(page.selectionManager.getSelectedResult()).toMatchObject({ type: 'search-query' });
        expect(page.input.value).toBe('opn arcfi');
        trustedKey('Enter');
        expect(normalActions()).toHaveLength(1); expect(commands()).toHaveLength(0);
    });
    it.each(['Home', 'ArrowUp'])('does not steal explicit %s selection when sidebar capability arrives late', async key => {
        available = false; await open(); type('open arcify'); trustedKey(key);
        expect(page.selectionManager.getSelectedResult()).toMatchObject({ type: 'search-query' });
        available = true; await page.sidebarCommand.prepare();
        expect(commandRow()).not.toBeNull();
        expect(page.selectionManager.getSelectedResult()).toMatchObject({ type: 'search-query' });
        expect(commandRow().classList.contains('selected')).toBe(false);
    });
    it('can promote a late capability before the user has made a manual choice', async () => {
        available = false; await open(); type('open arcify');
        available = true; await page.sidebarCommand.prepare();
        expect(page.selectionManager.getSelectedResult()).toMatchObject({ type: 'arcify-sidebar-command' });
    });
    it('keeps genuine query and manually selected identity through URL preview and later replacement', async () => {
        await open();
        let resolveAutocomplete;
        const original = chromeMock.runtime.sendMessage.getMockImplementation();
        chromeMock.runtime.sendMessage.mockImplementation((message, ...args) => {
            if (message.action === 'getAutocompleteSuggestions') return new Promise(resolve => resolveAutocomplete = resolve);
            return original(message, ...args);
        });
        type('open arcify');
        await vi.waitFor(() => expect(resolveAutocomplete).toBeTypeOf('function'));
        trustedKey('ArrowDown'); trustedKey('ArrowDown');
        expect(page.input.value).toBe(ordinary.url);
        expect(page.selectionManager.getSelectedResult()).toMatchObject({ type: 'history', url: ordinary.url });
        initialResults = [{ ...ordinary, title: 'Fresh title', score: 99 }];
        resolveAutocomplete({ success: true, results: [{ type: 'autocomplete-suggestion', title: 'Open Arcify' }] });
        await vi.waitFor(() => expect(page.selectionManager.getSelectedResult()?.title).toBe('Fresh title'));
        expect(page.input.value).toBe(ordinary.url);
        expect(commandRow()).not.toBeNull();
        expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ action: 'getSpotlightSuggestions', query: 'open arcify' }));
    });
    it('auto-selects matched workspace actions but never promotes stale actions after new unrelated input', async () => {
        await open();
        const workspace = { type: 'arcify-space', title: 'Pair Work', metadata: { matchScore: 0.8,
            arcifyBridge: { kind: 'space', peerId: PEER, windowId: 2, spaceId: 'work' } } };
        const original = chromeMock.runtime.sendMessage.getMockImplementation();
        chromeMock.runtime.sendMessage.mockImplementation((message, ...args) => {
            if (message.action === 'getLocalSuggestions') return Promise.resolve({ success: true, results: [workspace] });
            return original(message, ...args);
        });
        type('pair wrok');
        await vi.waitFor(() => expect(page.selectionManager.getSelectedResult()).toMatchObject({ type: 'arcify-space' }));
        expect([...page.resultsContainer.querySelectorAll('[data-result-type]')].map(row => row.dataset.resultType)).toEqual(['arcify-space', 'search-query']);
        type('completely unrelated');
        expect(page.selectionManager.getSelectedResult()).toMatchObject({ type: 'search-query', metadata: { query: 'completely unrelated' } });
        expect(page.resultsContainer.querySelector('[data-result-type="arcify-space"]')).toBeNull();
    });
    it.each(['sidebar documentation', 'https://arcify.com', 'qzxv'])('keeps non-command input %j on its ordinary instant result', async query => {
        await open(); type(query);
        expect(commandRow()).toBeNull();
        expect(page.selectionManager.getSelectedResult().type).toBe(query.startsWith('https:') ? 'url-suggestion' : 'search-query');
    });
    it('revocation removes startup command immediately and late page offers cannot revive a disposed page', async () => {
        await open(); offer(); chromeMock.storage.local.get.mockResolvedValue({});
        storageChanged({ arcifyBridgePeerId: { newValue: '' } }, 'local');
        expect(commandRow()).toBeNull();
        page.dispose(); expect(offer()).toBeUndefined();
        await page.sidebarCommand.ready; expect(commands()).toHaveLength(0);
    });
});
