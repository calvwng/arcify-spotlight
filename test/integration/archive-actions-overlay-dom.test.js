// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { chromeMock } from '../mocks/chrome.js';
import './setup.js';
import { archiveScope, archiveResult, clone, spaceNames, PEER } from '../fixtures/archive-actions.js';
let scope, listeners, frameWindows, eventSpy, calls, mutation, nativeRequest, nativeCallback;
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
    document.body.replaceChildren(); listeners = []; frameWindows = []; calls = []; scope = archiveScope(); nativeRequest = null; nativeCallback = null;
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
    mutation = vi.fn(async message => ({ success: true, result: archiveResult(message.entryId) }));
    chromeMock.runtime.sendMessage.mockImplementation((...args) => {
        const message = args[0];
        if (typeof message === 'string') { nativeRequest = args[1]; nativeCallback = args[2]; return; }
        calls.push(message);
        if (message.action === 'arcifyArchiveContext') return Promise.resolve({ success: true, scope: clone(scope), spaceNames: clone(spaceNames) });
        if (message.action === 'arcifyArchiveReopen') return mutation(message);
        if (['arcifyTabActionsContext', 'arcifySpaceActionsContext'].includes(message.action)) return Promise.resolve({ success: true, scope: null });
        if (message.action === 'arcifyBridgeStatus') return Promise.resolve({ success: true, status: { status: 'connected', peerId: PEER, capabilities: [] } });
        if (message.action === 'getActiveSpaceColor') return Promise.resolve({ success: true, color: 'purple' });
        return Promise.resolve({ success: true, results: [] });
    });
    await import('../../overlay.js');
});
afterEach(async () => {
    await dispatch({ action: 'closeSpotlight' }); await new Promise(resolve => setTimeout(resolve, 210));
    frameWindows.forEach(realm => realm.close()); document.body.replaceChildren();
    delete HTMLDialogElement.prototype.showModal; delete HTMLDialogElement.prototype.close; vi.restoreAllMocks();
});
async function open() { await dispatch({ action: 'activateSpotlight', mode: 'new-tab', tabUrl: 'https://same.test/', tabId: 9 }); await flush(); }
const mutations = () => calls.filter(message => message.action === 'arcifyArchiveReopen');
const navigation = () => calls.filter(message => message.action === 'spotlightHandleResult');

const rows = () => [...frame().querySelectorAll('[data-result-type="arcify-archive-action"]')];
const ack = () => nativeCallback({ type: 'arcify-archive-open', version: 1, requestId: nativeRequest.requestId, role: 'arcify', ok: true, displayed: true });
describe('Archive in the isolated overlay document', () => {
    it.each(['click', 'keydown'])('sends direct trusted native popup request from %s and keeps overlay open', async method => {
        await open(); const original = host(); type('open archive');
        if (method === 'keydown') fire(input(), 'keydown'); else fire(frame().querySelector('.arcify-spotlight-results'), 'click', { target: rows()[0] });
        expect(nativeRequest).toMatchObject({ type: 'arcify-archive-open', token: 'intent-1' });
        ack(); await flush(); expect(frame().querySelector('[role="status"]').textContent).toBe('Arcify Archive opened.');
        expect(host()).toBe(original); expect(shell().open).toBe(true); expect(navigation()).toHaveLength(0);
    });
    it('preserves same-URL twins and sends only the chosen entry after keyboard selection', async () => {
        await open(); type('same archived title'); expect(rows()).toHaveLength(2);
        expect(rows().map(row => row.dataset.archiveEntryId)).toEqual(['entry-a', 'entry-b']);
        fire(input(), 'keydown', { key: 'ArrowDown' }); expect(input().value).toBe('same archived title');
        fire(input(), 'keydown'); fire(input(), 'keydown'); await flush();
        expect(mutations()).toHaveLength(1); expect(mutations()[0].entryId).toBe('entry-b'); expect(navigation()).toHaveLength(0);
        expect(frame().querySelector('[role="status"]').textContent).toBe('Archived tab reopened in Home.');
        const { SpotlightMessageClient } = await import('../../shared/message-client.js');
        SpotlightMessageClient.reportError('Arcify paired: live workspace results.','discovery'); await flush();
        expect(frame().querySelector('[role="status"]').textContent).toBe('Archived tab reopened in Home.');
        type('next query');
        expect(frame().querySelector('[role="status"]').textContent).toBe('Arcify paired: live workspace results.');
        expect(mutations()).toHaveLength(1);
    });
    it('rejects synthetic page keyboard and click events', async () => {
        await open(); type('open archive'); input().dispatchEvent(new (frame().defaultView.KeyboardEvent)('keydown', { key: 'Enter', bubbles: true })); rows()[0].click(); await flush();
        expect(nativeRequest).toBeNull(); type('same archived title'); rows()[0].click(); await flush(); expect(mutations()).toHaveLength(0); expect(navigation()).toHaveLength(0);
    });
    it('keeps partial warnings visible and never routes failed actions to navigation', async () => {
        await open(); type('same archived title'); mutation.mockResolvedValue({ success: true, result: { ...archiveResult('entry-a'), status: 'partial', warning: 'Check Archive cleanup after reopening.' } });
        fire(input(), 'keydown'); await flush(); expect(frame().querySelector('[role="status"]').textContent).toBe('Check Archive cleanup after reopening.');
        expect(shell().open).toBe(true); expect(navigation()).toHaveLength(0); expect(mutations()).toHaveLength(1);
    });
    it('ignores late native ACK after closing the overlay and never retries', async () => {
        await open(); type('open archive'); fire(input(), 'keydown'); await dispatch({ action: 'closeSpotlight' }); ack(); await flush();
        expect(shell()?.open || false).toBe(false); expect(navigation()).toHaveLength(0);
        expect(chromeMock.runtime.sendMessage.mock.calls.filter(([message]) => typeof message === 'string')).toHaveLength(1);
    });
});
