// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { chromeMock } from '../mocks/chrome.js';
import './setup.js';
const PEER = 'a'.repeat(32);
const base = { peerId: PEER, generation: 'local', context: { windowId: 2, spaceId: 'space', bookmarkFolderId: 'root', pairingGeneration: 'peer', sourceTabId: 9,
    tab: { id: 9, url: 'https://same.test/', title: 'Current', section: 'today', bookmark: null, alias: '', muted: false } } };
let scope, listeners, frameWindows, eventSpy, calls, mutation;
const host = () => document.getElementById('arcify-spotlight-host');
const shell = () => host()?.shadowRoot.querySelector('dialog');
const frame = () => shell()?.querySelector('iframe').contentDocument;
const input = () => frame()?.querySelector('.arcify-spotlight-input');
const prompt = () => frame()?.querySelector('.arcify-tab-action-prompt');
const flush = async () => { for (let i = 0; i < 35; i++) await Promise.resolve(); };
function dispatch(message) { return new Promise(resolve => { let pending = false; for (const listener of [...listeners]) if (listener(message, { id: chromeMock.runtime.id }, resolve) === true) pending = true; if (!pending) resolve(); }); }
function fire(target, name, extra = {}) {
    const event = { type: name, key: 'Enter', button: 0, isTrusted: true, target, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra };
    eventSpy.mock.calls.forEach(([type, listener], i) => { if (type === name && eventSpy.mock.contexts[i] === target) listener(event); }); return event;
}
function type(text) { input().value = text; input().dispatchEvent(new (frame().defaultView.Event)('input', { bubbles: true })); }
beforeEach(async () => {
    document.body.replaceChildren(); listeners = []; frameWindows = []; calls = []; scope = structuredClone(base);
    for (const key of ['arcifySpotlightTabMode', 'arcifySpotlightInjected', 'arcifyCurrentTabUrl', 'arcifyCurrentTabId']) delete window[key];
    const documents = new WeakMap(); eventSpy = vi.spyOn(EventTarget.prototype, 'addEventListener');
    vi.spyOn(HTMLIFrameElement.prototype, 'contentDocument', 'get').mockImplementation(function () {
        if (!documents.has(this)) {
            const realm = new JSDOM('<!doctype html><html><head></head><body></body></html>').window;
            realm.HTMLElement.prototype.scrollIntoView = () => {};
            realm.EventTarget.prototype.addEventListener = EventTarget.prototype.addEventListener;
            documents.set(this, realm.document); frameWindows.push(realm);
        }
        return documents.get(this);
    });
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
    HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
    chromeMock.runtime.onMessage.addListener.mockImplementation(listener => listeners.push(listener));
    chromeMock.runtime.onMessage.removeListener.mockImplementation(listener => { listeners = listeners.filter(item => item !== listener); });
    chromeMock.storage.local.get.mockResolvedValue({ arcifyBridgePeerId: PEER, arcifyBridgePairingGeneration: 'local' });
    mutation = vi.fn(async message => ({ success: true, result: message.command === 'renameCurrentTab' ? { command: message.command, tabId: 9, bookmarkId: message.scope.context.tab.bookmark?.id || null, title: message.fields.title }
        : message.command === 'editCurrentPinUrl' ? { command: message.command, tabId: 9, bookmarkId: message.scope.context.tab.bookmark.id, url: message.fields.url }
        : { command: message.command, tabId: 11 } }));
    chromeMock.runtime.sendMessage.mockImplementation(async message => {
        calls.push(message);
        if (message.action === 'arcifyTabActionsContext') return { success: true, scope: structuredClone(scope) };
        if (message.action === 'arcifyTabAction') return mutation(message);
        if (message.action === 'arcifySpaceActionsContext') return { success: true, scope: null };
        if (message.action === 'arcifyBridgeStatus') return { success: true, status: { status: 'connected', peerId: PEER, capabilities: [] } };
        if (message.action === 'getActiveSpaceColor') return { success: true, color: 'purple' };
        return { success: true, results: [] };
    });
    await import('../../overlay.js');
});
afterEach(async () => {
    await dispatch({ action: 'closeSpotlight' }); await new Promise(resolve => setTimeout(resolve, 210));
    frameWindows.forEach(realm => realm.close()); document.body.replaceChildren();
    delete HTMLDialogElement.prototype.showModal; delete HTMLDialogElement.prototype.close; vi.restoreAllMocks();
});
async function open() { await dispatch({ action: 'activateSpotlight', mode: 'new-tab', tabUrl: 'https://same.test/', tabId: 9 }); await flush(); }
const mutations = () => calls.filter(message => message.action === 'arcifyTabAction');
const navigation = () => calls.filter(message => message.action === 'spotlightHandleResult');

describe('tab actions in the actual isolated overlay document', () => {
    it('duplicates once under a trusted gesture without routing through navigation or closing its host', async () => {
        await open(); const original = host(); type('duplicate tab'); fire(input(), 'keydown'); fire(input(), 'keydown'); await flush();
        expect(mutations()).toHaveLength(1); expect(navigation()).toHaveLength(0);
        expect(host()).toBe(original); expect(shell().open).toBe(true); expect(frame().querySelector('[role="status"]').textContent).toContain('duplicated');
    });
    it('contains rename Escape inside the inner prompt and restores the original search draft', async () => {
        await open(); type('rename tab'); fire(input(), 'keydown'); const original = host(), name = prompt().querySelector('[data-tab-action-input]'); name.value = 'Draft';
        const event = fire(prompt(), 'keydown', { target: name, key: 'Escape' }); await flush();
        expect(event.stopPropagation).toHaveBeenCalled(); expect(prompt()).toBeNull(); expect(shell().open).toBe(true); expect(host()).toBe(original);
        expect(input().value).toBe('rename tab'); expect(frame().activeElement).toBe(input()); expect(mutations()).toHaveLength(0); expect(navigation()).toHaveLength(0);
    });
    it('rejects synthetic page key and click events even if a hostile page can locate the frame DOM', async () => {
        await open(); type('duplicate tab'); input().dispatchEvent(new (frame().defaultView.KeyboardEvent)('keydown', { key: 'Enter', bubbles: true }));
        frame().querySelector('[data-result-type="arcify-tab-action"]').click(); await flush(); expect(mutations()).toHaveLength(0); expect(navigation()).toHaveLength(0);
    });
    it('preserves the typed fuzzy query while keyboard-selecting a tab action', async () => {
        await open(); type('duplcate tab'); fire(input(), 'keydown', { key: 'ArrowDown' }); fire(input(), 'keydown', { key: 'ArrowUp' });
        expect(input().value).toBe('duplcate tab');
        expect(frame().querySelector('.selected').dataset.resultType).toBe('arcify-tab-action');
    });
    it('cannot have manual web-search selection replaced by an untrusted synthetic action click', async () => {
        await open(); type('duplicate tab'); fire(input(), 'keydown', { key: 'ArrowDown' });
        expect(frame().querySelector('.selected').dataset.resultType).toBe('search-query');
        frame().querySelector('[data-result-type="arcify-tab-action"]').click(); await flush();
        expect(frame().querySelector('.selected').dataset.resultType).toBe('search-query'); expect(mutations()).toHaveLength(0);
    });
    it('keeps the rename prompt isolated, blocks held Enter, and cancels when the overlay closes', async () => {
        await open(); type('rename tab'); fire(input(), 'keydown'); const name = prompt().querySelector('[data-tab-action-input]'); name.value = 'Draft';
        fire(prompt(), 'keydown', { target: name, repeat: true }); expect(mutations()).toHaveLength(0); expect(prompt()).not.toBeNull();
        expect(document.querySelector('.arcify-tab-action-prompt')).toBeNull(); expect(frame()).not.toBe(document);
        await dispatch({ action: 'closeSpotlight' }); await flush(); expect(mutations()).toHaveLength(0);
    });
    it('submits exact saved pin URL only after separate trusted input confirmation', async () => {
        scope.context.tab.section = 'saved'; scope.context.tab.bookmark = { id: 'exact', parentId: 'root', title: 'Saved', url: 'https://same.test/' };
        await open(); type('edit pin url'); fire(input(), 'keydown'); const name = prompt().querySelector('[data-tab-action-input]'); name.value = 'https://updated.test/';
        prompt().querySelector('[data-action-confirm]').click(); await flush(); expect(mutations()).toHaveLength(0);
        fire(prompt(), 'keydown', { target: name }); await flush();
        expect(mutations()).toHaveLength(1); expect(mutations()[0]).toMatchObject({ command: 'editCurrentPinUrl', fields: { url: 'https://updated.test/' }, scope: { context: { sourceTabId: 9, tab: { id: 9, bookmark: { id: 'exact' } } } } });
        expect(shell().open).toBe(true); expect(navigation()).toHaveLength(0);
    });
    it('keeps errors on this surface and never retries or converts them to navigation', async () => {
        mutation.mockResolvedValue({ success: false, errorCode: 'STALE_CONTEXT', error: 'The exact tab changed.' });
        await open(); type('duplicate tab'); fire(input(), 'keydown'); await flush(); fire(input(), 'keydown'); await flush();
        expect(mutations()).toHaveLength(1); expect(navigation()).toHaveLength(0); expect(shell().open).toBe(true);
        expect(frame().querySelector('[role="status"]').textContent).toBe('The exact tab changed.');
    });
});
