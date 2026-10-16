// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromeMock } from '../mocks/chrome.js';
import { archiveScope, archiveResult, clone, spaceNames, PEER } from '../fixtures/archive-actions.js';
import './setup.js';
let page, scope, eventSpy, callback, externalRequest, mutation, storageListeners;
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const ordinary = { type: 'history', title: 'Ordinary result', url: 'https://ordinary.example/', domain: 'ordinary.example' };
const calls = action => chromeMock.runtime.sendMessage.mock.calls.filter(([message]) => message?.action === action);
const rows = () => [...page.resultsContainer.querySelectorAll('[data-result-type="arcify-archive-action"]')];
function fire(target, name, extra = {}) {
    const event = { type: name, key: 'Enter', button: 0, isTrusted: true, target, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra };
    eventSpy.mock.calls.forEach(([type, listener], i) => { if (type === name && eventSpy.mock.contexts[i] === target) listener(event); }); return event;
}
function type(value) { page.input.value = value; page.input.dispatchEvent(new Event('input', { bubbles: true })); }
const key = (name, extra) => fire(page.input, 'keydown', { key: name, ...extra });
const ack = () => callback({ type: 'arcify-archive-open', version: 1, requestId: externalRequest.requestId, role: 'arcify', ok: true, displayed: true });
beforeEach(() => {
    document.body.innerHTML = '<div id="spotlight-container"></div>';
    Object.defineProperty(document, 'URL', { configurable: true, value: chromeMock.runtime.getURL('newtab.html') });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    HTMLElement.prototype.scrollIntoView = vi.fn(); scope = archiveScope(); storageListeners = []; externalRequest = undefined; callback = undefined;
    chromeMock.tabs.getCurrent = vi.fn().mockResolvedValue({ id: 9 });
    chromeMock.storage.local.get.mockResolvedValue({ arcifyBridgePeerId: PEER, arcifyBridgePairingGeneration: 'local' });
    chromeMock.storage.onChanged.addListener.mockImplementation(listener => storageListeners.push(listener));
    mutation = vi.fn(async message => ({ success: true, result: archiveResult(message.entryId) }));
    chromeMock.runtime.sendMessage.mockImplementation((...args) => {
        const message = args[0];
        if (typeof message === 'string') { externalRequest = args[1]; callback = args[2]; return; }
        if (message.action === 'arcifyArchiveContext') return Promise.resolve({ success: true, scope: clone(scope), spaceNames: clone(spaceNames) });
        if (message.action === 'arcifyArchiveReopen') return mutation(message);
        if (['arcifyTabActionsContext', 'arcifySpaceActionsContext'].includes(message.action)) return Promise.resolve({ success: true, scope: null });
        if (message.action === 'arcifyBridgeStatus') return Promise.resolve({ success: true, status: { status: 'connected', peerId: PEER, capabilities: [] } });
        if (message.action === 'getActiveSpaceColor') return Promise.resolve({ success: true, color: 'purple' });
        if (['getSpotlightSuggestions', 'getLocalSuggestions'].includes(message.action)) return Promise.resolve({ success: true, results: [ordinary] });
        return Promise.resolve({ success: true, results: [] });
    });
    eventSpy = vi.spyOn(EventTarget.prototype, 'addEventListener'); vi.spyOn(window, 'close').mockImplementation(() => {});
});
afterEach(() => { page?.dispose(); page = null; vi.restoreAllMocks(); vi.useRealTimers(); delete HTMLElement.prototype.scrollIntoView; });
async function open() { const { initializeSpotlight } = await import('../../newtab.js'); page = await initializeSpotlight(); await page.archiveActions.ready; await flush(); }
describe('Archive in real new-tab renderer', () => {
    it('keeps ordinary empty and unrelated queries unchanged', async () => {
        await open(); expect(rows()).toHaveLength(0); expect(page.selectionManager.getSelectedResult()).toEqual(ordinary);
        type('https://same.example/'); expect(rows()).toHaveLength(0); expect(page.selectionManager.getSelectedResult().type).not.toBe('arcify-archive-action');
    });
    it.each(['click', 'keydown'])('opens directly from trusted %s before the handler returns and never navigates', async method => {
        await open(); type('open archive'); const row = rows()[0]; expect(row.dataset.archiveCommand).toBe('openArchive'); expect(row.querySelector('img').alt).toBe('');
        if (method === 'keydown') key('Enter'); else fire(page.resultsContainer, 'click', { target: row });
        expect(externalRequest).toMatchObject({ type: 'arcify-archive-open', token: 'intent-1' }); expect(callback).toBeTypeOf('function');
        ack(); await page.archiveActions.operation;
        expect(calls('spotlightHandleResult')).toHaveLength(0); expect(window.close).not.toHaveBeenCalled(); expect(document.querySelector('[role="status"]').textContent).toBe('Arcify Archive opened.');
    });
    it('keeps duplicate same-URL archived rows distinct and reopens selected original Space', async () => {
        await open(); type('same archived title'); expect(rows()).toHaveLength(2); expect(rows().map(row => row.dataset.archiveEntryId)).toEqual(['entry-a', 'entry-b']);
        key('ArrowDown'); expect(page.selectionManager.getSelectedResult().metadata.archiveAction.entryId).toBe('entry-b'); expect(page.input.value).toBe('same archived title'); key('Enter'); await page.archiveActions.operation;
        expect(mutation).toHaveBeenCalledOnce(); expect(mutation.mock.calls[0][0].entryId).toBe('entry-b'); expect(document.querySelector('[role="status"]').textContent).toBe('Archived tab reopened in Home.');
        expect(calls('spotlightHandleResult')).toHaveLength(0); expect(window.close).not.toHaveBeenCalled();
    });
    it('never lets synthetic row clicks replace manual web-search selection', async () => {
        await open(); type('open archive'); key('ArrowDown'); const selected = page.selectionManager.getSelectedResult(); rows()[0].click(); await flush();
        expect(page.selectionManager.getSelectedResult()).toEqual(selected); expect(externalRequest).toBeUndefined();
    });
    it('revokes old selection as soon as context reload starts and does not silently select an action', async () => {
        await open(); type('same archived title'); key('ArrowDown'); const refresh = page.archiveActions.prepare();
        expect(page.selectionManager.getSelectedResult()).toBeNull(); await refresh; expect(page.selectionManager.getSelectedResult()).toBeNull(); key('Enter'); expect(mutation).not.toHaveBeenCalled();
    });
    it('keeps partial warnings visible through passive context and search refresh', async () => {
        await open(); type('same archived title'); mutation.mockResolvedValue({ success: true, result: { ...archiveResult('entry-a'), status: 'partial', warning: 'Reopened; original Archive cleanup needs checking.' } });
        key('Enter'); await page.archiveActions.operation; await page.archiveActions.prepare(); type('ordinary'); await flush();
        expect(document.querySelector('[role="status"]').textContent).toBe('Reopened; original Archive cleanup needs checking.'); expect(window.close).not.toHaveBeenCalled();
    });
    it('removes stale rows immediately on re-pairing and suppresses late native popup ACK', async () => {
        await open(); type('open archive'); key('Enter'); scope = null;
        storageListeners.forEach(listener => listener({ arcifyBridgePairingGeneration: { newValue: 'new' } }, 'local')); expect(rows()).toHaveLength(0); ack(); await page.archiveActions.operation;
        expect(document.querySelector('[role="status"]').textContent).not.toBe('Arcify Archive opened.');
    });
});
