// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { chromeMock } from '../mocks/chrome.js';
import './setup.js';
const PEER = 'a'.repeat(32);
const base = { peerId: PEER, generation: 'local', context: { windowId: 2, spaceId: 'space', bookmarkFolderId: 'root', pairingGeneration: 'peer', sourceTabId: 9,
    tab: { id: 9, url: 'https://same.test/', title: 'Current', section: 'today', bookmark: null } } };
let scope, listeners, frameWindows, eventSpy, calls;
const host = () => document.getElementById('arcify-spotlight-host');
const shell = () => host()?.shadowRoot.querySelector('dialog');
const frame = () => shell()?.querySelector('iframe').contentDocument;
const input = () => frame()?.querySelector('.arcify-spotlight-input');
const prompt = () => frame()?.querySelector('[role="dialog"]');
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function dispatch(message) { return new Promise(resolve => { let pending = false; for (const listener of [...listeners]) if (listener(message, { id: chromeMock.runtime.id }, resolve) === true) pending = true; if (!pending) resolve(); }); }
function fire(target, name, extra = {}) {
    const event = { type: name, key: 'Enter', button: 0, isTrusted: true, target, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra };
    eventSpy.mock.calls.forEach(([type, listener], i) => { if (type === name && eventSpy.mock.contexts[i] === target) listener(event); }); return event;
}
function type(text) { input().value = text; input().dispatchEvent(new (frame().defaultView.Event)('input', { bubbles: true })); }
beforeEach(async () => {
    document.body.replaceChildren(); listeners = []; frameWindows = []; calls = []; scope = structuredClone(base);
    for (const key of ['arcifySpotlightTabMode', 'arcifySpotlightInjected', 'arcifyCurrentTabUrl', 'arcifyCurrentTabId']) delete window[key];
    const documents = new WeakMap();
    eventSpy = vi.spyOn(EventTarget.prototype, 'addEventListener');
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
    chromeMock.runtime.sendMessage.mockImplementation(async message => {
        calls.push(message);
        if (message.action === 'arcifySpaceActionsContext') return { success: true, scope: structuredClone(scope) };
        if (message.action === 'arcifySpaceAction') return { success: true, result: { command: message.command, ...(['switchSpace', 'moveCurrentTodayTab'].includes(message.command) ? { spaceId: message.fields.destination.spaceId, tabId: message.command === 'switchSpace' ? null : 9 } : message.command === 'createSpaceFolder' ? { folderId: 'new' } : { tabId: 9, bookmarkId: scope.context.tab.bookmark?.id || 'new' }) } };
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
const mutations = () => calls.filter(message => message.action === 'arcifySpaceAction');
describe('Space actions in the actual isolated overlay document', () => {
    it('keeps a focused result when the late action-context response repaints an unchanged search', async () => {
        const send = chromeMock.runtime.sendMessage.getMockImplementation();
        let releaseContext;
        chromeMock.runtime.sendMessage.mockImplementation(message => message.action === 'arcifySpaceActionsContext'
            ? new Promise(resolve => { releaseContext = resolve; }) : send(message));
        await open(); type('w window');
        const original = frame().querySelector('[data-testid="spotlight-result"]'); original.focus();
        expect(frame().activeElement).toBe(original);
        releaseContext({ success: true, scope: structuredClone(scope) }); await flush();
        expect(original.isConnected).toBe(false);
        expect(frame().activeElement.tagName).toBe('BUTTON');
        expect(frame().activeElement.dataset.testid).toBe('spotlight-result');
        expect(input().value).toBe('w window'); expect(mutations()).toHaveLength(0);
    });
    it.each(['pin current tab', ''])('safely returns a removed focused action to the input for query %j', async query => {
        await open(); type(query); await flush();
        frame().querySelector('[data-result-type="arcify-space-action"]').focus();
        scope = null;
        const invalidate = () => {
            for (const [listener] of chromeMock.storage.onChanged.addListener.mock.calls) {
                listener({ arcifyBridgePairingGeneration: { newValue: 'changed' } }, 'local');
            }
        };
        invalidate(); await flush();
        expect(frame().activeElement.tagName).toBe('INPUT'); expect(input().value).toBe(query);
        fire(input(), 'keydown'); await flush();
        expect(mutations()).toHaveLength(0);
        expect(calls.some(message => message.action === 'spotlightHandleResult')).toBe(false);
        scope = structuredClone(base); invalidate(); await flush();
        fire(input(), 'keydown'); await flush();
        expect(mutations()).toHaveLength(0);
        expect(calls.some(message => message.action === 'spotlightHandleResult')).toBe(false);
    });
    it('keeps Pin in the overlay and never invokes navigation or closes its host', async () => {
        await open(); const original = host(); type('pin current tab'); fire(input(), 'keydown'); await flush();
        expect(mutations()).toHaveLength(1); expect(calls.some(message => message.action === 'spotlightHandleResult')).toBe(false);
        expect(host()).toBe(original); expect(shell().open).toBe(true); expect(frame().querySelector('[role="status"]').textContent).toContain('saved as a Space pin');
    });
    it('contains folder Escape in the inner prompt and restores the original query', async () => {
        await open(); type('new folder'); fire(input(), 'keydown');
        const original = host(), name = prompt().querySelector('input'); name.value = 'Draft';
        const event = fire(prompt(), 'keydown', { target: name, key: 'Escape' }); await flush();
        expect(event.stopPropagation).toHaveBeenCalled(); expect(prompt()).toBeNull(); expect(shell().open).toBe(true); expect(host()).toBe(original);
        expect(input().value).toBe('new folder'); expect(frame().activeElement).toBe(input()); expect(mutations()).toHaveLength(0);
    });
    it('ignores synthetic page events even though the page can reach the frame DOM', async () => {
        await open(); type('pin current tab'); input().dispatchEvent(new (frame().defaultView.KeyboardEvent)('keydown', { key: 'Enter', bubbles: true }));
        frame().querySelector('[data-result-type="arcify-space-action"]').click(); await flush(); expect(mutations()).toHaveLength(0);
    });
    it('holds destructive confirmation on Cancel and does not expose it to the outer document', async () => {
        scope.context.tab.section = 'saved'; scope.context.tab.bookmark = { id: 'exact', parentId: 'root', title: 'Saved', url: 'https://same.test/' };
        await open(); type('unpin'); fire(input(), 'keydown');
        const cancel = prompt().querySelector('[data-action-cancel]'); expect(frame().activeElement).toBe(cancel);
        fire(prompt(), 'keydown', { target: cancel, repeat: true }); expect(mutations()).toHaveLength(0); expect(prompt()).not.toBeNull();
        expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(frame()).not.toBe(document);
        await dispatch({ action: 'closeSpotlight' }); await flush(); expect(mutations()).toHaveLength(0);
    });
});

const withNavigation = () => { scope.navigation = { sourceUrl: scope.context.tab.url, inverted: false, destinations: [{ spaceId: 'target', bookmarkFolderId: 'target-root', name: 'Personal' }] }; };
describe('Space navigation in the actual isolated overlay', () => {
    it.each(['switch space', 'move tab'])('contains the %s picker, blocks held/IME Enter, and sends one explicit destination', async query => {
        withNavigation(); await open(); type(query); fire(input(), 'keydown');
        const original = host(), select = prompt().querySelector('select'); select.value = '0';
        expect(document.querySelector('select')).toBeNull(); expect(frame().activeElement).toBe(select);
        fire(prompt(), 'keydown', { target: select, repeat: true }); fire(prompt(), 'keydown', { target: select, isComposing: true });
        prompt().querySelector('[data-action-confirm]').click(); await flush(); expect(mutations()).toHaveLength(0);
        fire(prompt(), 'keydown', { target: select }); await flush();
        expect(mutations()).toHaveLength(1); expect(mutations()[0].fields).toEqual({ destination: { spaceId: 'target', bookmarkFolderId: 'target-root' } });
        expect(host()).toBe(original); expect(shell().open).toBe(true); expect(calls.some(message => message.action === 'spotlightHandleResult')).toBe(false);
    });
    it('keeps Escape inside the picker and external close cancels without dispatch', async () => {
        withNavigation(); await open(); type('move tab'); fire(input(), 'keydown');
        const select = prompt().querySelector('select'); select.value = '0';
        const event = fire(prompt(), 'keydown', { target: select, key: 'Escape' }); await flush();
        expect(event.stopPropagation).toHaveBeenCalled(); expect(prompt()).toBeNull(); expect(input().value).toBe('move tab'); expect(shell().open).toBe(true);
        fire(input(), 'keydown'); expect(prompt()).not.toBeNull(); await dispatch({ action: 'closeSpotlight' }); await flush();
        expect(mutations()).toHaveLength(0);
    });
});
