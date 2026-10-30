// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { chromeMock } from '../mocks/chrome.js';
import './setup.js';
import { PEER, transientScope, transientResult } from '../fixtures/transient-actions.js';
let scope, listeners, frameWindows, eventSpy, calls, mutation;
const host = () => document.getElementById('arcify-spotlight-host');
const shell = () => host()?.shadowRoot.querySelector('dialog');
const frame = () => shell()?.querySelector('iframe').contentDocument;
const input = () => frame()?.querySelector('.arcify-spotlight-input');
const flush = async () => { for (let i = 0; i < 35; i++) await Promise.resolve(); };
function dispatch(message) { return new Promise(resolve => { let pending = false; for (const listener of [...listeners]) if (listener(message, { id: chromeMock.runtime.id }, resolve) === true) pending = true; if (!pending) resolve(); }); }
function fire(target, name, extra = {}) {
    const event = { type: name, key: 'Enter', button: 0, isTrusted: true, target, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra };
    eventSpy.mock.calls.forEach(([type, listener], i) => { if (type === name && eventSpy.mock.contexts[i] === target) listener(event); }); return event;
}
function type(text) { input().value = text; input().dispatchEvent(new (frame().defaultView.Event)('input', { bubbles: true })); }
beforeEach(async () => {
    document.body.replaceChildren(); listeners = []; frameWindows = []; calls = []; scope = transientScope();
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
    mutation = vi.fn(async message => ({ success: true, result: transientResult() }));
    chromeMock.runtime.sendMessage.mockImplementation(async message => {
        calls.push(message);
        if (message.action === 'arcifyTransientContext') return { success: true, scope: structuredClone(scope) };
        if (message.action === 'arcifyOpenTransient') return mutation(message);
        if (message.action === 'spotlightLiveTabContext') return { success: true, sourceTabId: 9, windowId: 2, peerId: PEER };
        if (['arcifySpaceActionsContext', 'arcifyTabActionsContext', 'arcifyArchiveContext', 'arcifySplitActionsContext'].includes(message.action)) return { success: true, scope: null };
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
const mutations = () => calls.filter(message => message.action === 'arcifyOpenTransient');
const navigation = () => calls.filter(message => message.action === 'spotlightHandleResult');

describe('Little Arc in the isolated overlay', () => {
    it('keeps complete URL navigation primary and leaves the action explicitly selectable', async () => {
        await open(); type('https://target.test/');
        expect(frame().querySelector('.selected').dataset.resultType).toBe('url-suggestion');
        expect(frame().querySelector('[data-result-type="arcify-transient-action"]').textContent).toContain('After restart: no control tab → ordinary tabs');
        fire(input(), 'keydown'); await flush(); expect(navigation()).toHaveLength(1); expect(mutations()).toHaveLength(0);
    });
    it('opens an explicit Little Arc URL once without moving or navigating the source', async () => {
        await open(); type('little arc https://target.test/'); const original = host();
        expect(frame().querySelector('.selected').dataset.resultType).toBe('arcify-transient-action');
        fire(input(), 'keydown'); fire(input(), 'keydown'); await flush();
        expect(mutations()).toHaveLength(1); expect(mutations()[0].url).toBe('https://target.test/'); expect(navigation()).toHaveLength(0);
        expect(host()).toBe(original); expect(shell().open).toBe(true); expect(frame().querySelector('[role="status"]').textContent).toContain('Opened in Little Arc');
        fire(input(), 'keydown', { repeat: true }); await flush(); expect(mutations()).toHaveLength(1); expect(navigation()).toHaveLength(0);
    });
    it('preserves the typed URL while keyboard-selecting the secondary row and rejects synthetic clicks', async () => {
        await open(); type('https://target.test/'); frame().querySelector('[data-result-type="arcify-transient-action"]').click(); await flush();
        expect(frame().querySelector('.selected').dataset.resultType).toBe('url-suggestion'); expect(mutations()).toHaveLength(0);
        fire(input(), 'keydown', { key: 'ArrowDown' }); expect(input().value).toBe('https://target.test/');
        fire(input(), 'keydown'); await flush(); expect(mutations()).toHaveLength(1); expect(navigation()).toHaveLength(0);
    });
    it('keeps uncertain failures in the overlay with no fallback or repeated action', async () => {
        mutation.mockResolvedValue({ success: false, errorCode: 'TIMEOUT', error: 'Check for an existing Little Arc window before trying again.' });
        await open(); type('little arc https://target.test/'); fire(input(), 'keydown'); await flush();
        expect(frame().querySelector('[role="status"]').textContent).toContain('Check for an existing Little Arc window');
        fire(input(), 'keydown'); await flush(); expect(mutations()).toHaveLength(1); expect(navigation()).toHaveLength(0); expect(shell().open).toBe(true);
    });
    it('hides the command on older companions', async () => {
        scope = null; await open(); type('little arc https://target.test/');
        expect(frame().querySelector('[data-result-type="arcify-transient-action"]')).toBeNull(); expect(mutations()).toHaveLength(0);
    });
    it('ignores a late response after Escape disposes the overlay', async () => {
        let resolve; mutation.mockImplementation(() => new Promise(done => { resolve = done; }));
        await open(); type('little arc https://target.test/'); fire(input(), 'keydown'); fire(input(), 'keydown', { key: 'Escape' });
        resolve({ success: true, result: transientResult() }); await flush();
        expect(mutations()).toHaveLength(1); expect(navigation()).toHaveLength(0); expect(frame()?.querySelector('[role="status"]')?.textContent || '').not.toContain('Opened in Little Arc');
    });
});
