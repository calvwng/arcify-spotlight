// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { chromeMock } from '../mocks/chrome.js';
import './setup.js';
import { PEER, splitScope, splitResult } from '../fixtures/split-actions.js';
let scope, listeners, frameWindows, eventSpy, calls, mutation;
const host = () => document.getElementById('arcify-spotlight-host');
const shell = () => host()?.shadowRoot.querySelector('dialog');
const frame = () => shell()?.querySelector('iframe').contentDocument;
const input = () => frame()?.querySelector('.arcify-spotlight-input');
const prompt = () => frame()?.querySelector('.arcify-split-action-prompt');
const flush = async () => { for (let i = 0; i < 35; i++) await Promise.resolve(); };
function dispatch(message) { return new Promise(resolve => { let pending = false; for (const listener of [...listeners]) if (listener(message, { id: chromeMock.runtime.id }, resolve) === true) pending = true; if (!pending) resolve(); }); }
function fire(target, name, extra = {}) {
    const event = { type: name, key: 'Enter', button: 0, isTrusted: true, target, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra };
    eventSpy.mock.calls.forEach(([type, listener], i) => { if (type === name && eventSpy.mock.contexts[i] === target) listener(event); }); return event;
}
function type(text) { input().value = text; input().dispatchEvent(new (frame().defaultView.Event)('input', { bubbles: true })); }
beforeEach(async () => {
    document.body.replaceChildren(); listeners = []; frameWindows = []; calls = []; scope = splitScope();
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
    mutation = vi.fn(async message => ({ success: true, result: splitResult(message.command, message.scope, message.fields.target) }));
    chromeMock.runtime.sendMessage.mockImplementation(async message => {
        calls.push(message);
        if (message.action === 'arcifySplitActionsContext') return { success: true, scope: structuredClone(scope) };
        if (message.action === 'arcifySplitAction') return mutation(message);
        if (message.action === 'spotlightLiveTabContext') return { success: true, sourceTabId: 9, windowId: 2, peerId: PEER };
        if (['arcifySpaceActionsContext', 'arcifyTabActionsContext', 'arcifyArchiveContext'].includes(message.action)) return { success: true, scope: null };
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
const mutations = () => calls.filter(message => message.action === 'arcifySplitAction');
const navigation = () => calls.filter(message => message.action === 'spotlightHandleResult');

const targets = () => [...prompt().querySelectorAll('[role="option"]')];
const confirm = () => prompt().querySelector('[data-split-confirm]');
describe('Split in the actual isolated overlay renderer', () => {
    it('requires explicit target selection then separate trusted confirmation', async () => {
        await open(); const original = host(); type('split tab'); fire(input(), 'keydown');
        expect(prompt()).not.toBeNull(); expect(document.querySelector('.arcify-split-action-prompt')).toBeNull(); expect(confirm().disabled).toBe(true);
        fire(prompt(), 'keydown', { target: targets()[0] }); await flush(); expect(mutations()).toHaveLength(0);
        expect(targets().map(item => item.dataset.splitTargetId)).toEqual(['10', '11']); expect(targets()[1].textContent).toContain('Position 3');
        fire(targets()[1], 'click'); fire(confirm(), 'click'); await flush();
        expect(mutations()).toHaveLength(1); expect(mutations()[0].fields.target.id).toBe(11); expect(navigation()).toHaveLength(0);
        expect(host()).toBe(original); expect(shell().open).toBe(true); expect(frame().querySelector('[role="status"]').textContent).toContain('Split created');
    });
    it.each(['Escape', 'Cancel'])('keeps %s inside picker, retaining overlay and search draft', async method => {
        await open(); type('split tab'); fire(input(), 'keydown'); const original = host();
        if (method === 'Escape') { const event = fire(prompt(), 'keydown', { key: 'Escape' }); expect(event.stopPropagation).toHaveBeenCalled(); }
        else fire(prompt().querySelector('[data-split-cancel]'), 'click');
        await flush(); expect(prompt()).toBeNull(); expect(host()).toBe(original); expect(shell().open).toBe(true); expect(input().value).toBe('split tab'); expect(frame().activeElement).toBe(input()); expect(mutations()).toHaveLength(0);
    });
    it('does not accept page-generated input or replace manual search selection', async () => {
        await open(); type('split tab'); fire(input(), 'keydown', { key: 'ArrowDown' }); expect(frame().querySelector('.selected').dataset.resultType).toBe('search-query');
        frame().querySelector('[data-result-type="arcify-split-action"]').click(); await flush();
        expect(frame().querySelector('.selected').dataset.resultType).toBe('search-query'); expect(prompt()).toBeNull(); expect(mutations()).toHaveLength(0);
    });
    it('preserves fuzzy query across keyboard action selection and ignores held Enter', async () => {
        await open(); type('splt tab'); fire(input(), 'keydown', { key: 'ArrowDown' }); fire(input(), 'keydown', { key: 'ArrowUp' });
        expect(input().value).toBe('splt tab'); expect(frame().querySelector('.selected').dataset.resultType).toBe('arcify-split-action');
        fire(input(), 'keydown', { repeat: true }); expect(prompt()).toBeNull(); fire(input(), 'keydown'); fire(targets()[0], 'click'); fire(prompt(), 'keydown', { target: targets()[0], repeat: true }); await flush(); expect(mutations()).toHaveLength(0);
    });
    it('ends exact pair once, keeps overlay open, and never navigates', async () => {
        scope = splitScope(true); await open(); type('end split'); fire(input(), 'keydown'); fire(input(), 'keydown'); await flush();
        expect(mutations()).toHaveLength(1); expect(mutations()[0].command).toBe('endSplitView'); expect(prompt()).toBeNull(); expect(shell().open).toBe(true); expect(navigation()).toHaveLength(0);
    });
    it('retires an open picker immediately on native state invalidation and never replays the selection', async () => {
        await open(); type('split'); fire(input(), 'keydown'); fire(targets()[0], 'click');
        await dispatch({ action: 'spotlightLiveTabsChanged', windowId: 2, removedTabIds: [] }); await flush(); expect(prompt()).toBeNull();
        fire(input(), 'keydown'); await flush(); expect(mutations()).toHaveLength(0); expect(navigation()).toHaveLength(0);
    });
    it('cancels picker safely when closing the overlay', async () => {
        await open(); type('split'); fire(input(), 'keydown'); fire(targets()[1], 'click'); await dispatch({ action: 'closeSpotlight' }); await flush(); expect(mutations()).toHaveLength(0);
    });
    it('shows an uncertain result without retry or fallback navigation', async () => {
        mutation.mockResolvedValue({ success: false, errorCode: 'TIMEOUT', error: 'Check Arcify before trying again.' });
        scope = splitScope(true); await open(); type('end split'); fire(input(), 'keydown'); await flush(); fire(input(), 'keydown'); await flush();
        expect(mutations()).toHaveLength(1); expect(navigation()).toHaveLength(0); expect(shell().open).toBe(true); expect(frame().querySelector('[role="status"]').textContent).toBe('Check Arcify before trying again.');
    });
});
