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
        const { SpotlightMessageClient } = await import('../../shared/message-client.js');
        page.input.focus(); const selected=page.selectionManager.getSelectedResult();
        SpotlightMessageClient.reportError('Arcify paired: live workspace results.','discovery'); await flush();
        expect(document.querySelector('[role="status"]').textContent).toBe('Archived tab reopened in Home.');
        expect(document.activeElement).toBe(page.input); expect(page.selectionManager.getSelectedResult()).toBe(selected);
        type('next query');
        expect(document.querySelector('[role="status"]').textContent).toBe('Arcify paired: live workspace results.');
        expect(mutation).toHaveBeenCalledOnce();
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

describe('Archive automatic default during passive refresh', () => {
    it('suspends Open Archive while its token rotates and restores the same automatic action with the fresh token', async () => {
        await open(); type('open archive'); page.input.focus();
        expect(page.selectionManager.getSelectedResult()?.metadata.archiveAction.command).toBe('openArchive');
        const send=chromeMock.runtime.sendMessage.getMockImplementation(); let finish;
        chromeMock.runtime.sendMessage.mockImplementation((...args)=>args[0]?.action==='arcifyArchiveContext'
            ? new Promise(resolve=>{finish=resolve;}) : send(...args));
        const refresh=page.archiveActions.prepare();
        expect(page.selectionManager.getSelectedResult()).toBeNull(); key('Enter'); expect(externalRequest).toBeUndefined();
        scope.viewId='view-2'; scope.openIntent='intent-2'; finish({success:true,scope:clone(scope),spaceNames:clone(spaceNames)});
        await refresh;
        expect(page.selectionManager.getSelectedResult()?.metadata.archiveAction.command).toBe('openArchive');
        expect(page.selectionManager.getSelectedResult()?.metadata.archiveAction.scope.openIntent).toBe('intent-2');
        expect(page.input.value).toBe('open archive'); expect(document.activeElement).toBe(page.input);
        key('Enter',{repeat:true}); expect(externalRequest).toBeUndefined();
        key('Enter'); expect(externalRequest?.token).toBe('intent-2'); ack(); await page.archiveActions.operation;
        key('Enter',{repeat:true}); expect(calls('spotlightHandleResult')).toHaveLength(0);
    });
});

describe('Archive refresh safety boundaries', () => {
    it.each(['failed','changed-space','revoked','manual','focused','after-invocation'])('keeps %s selection invalidated after refreshed rows arrive', async kind => {
        await open(); type('open archive');
        if(kind==='manual') key('ArrowUp');
        if(kind==='focused') rows()[0].focus();
        if(kind==='after-invocation') { key('Enter'); ack(); await page.archiveActions.operation; }
        if(kind==='changed-space') scope.context.spaceId='home';
        if(kind==='revoked') storageListeners.forEach(listener=>listener({arcifyBridgePairingGeneration:{newValue:'revoked'}},'local'));
        if(kind==='failed') scope=null;
        await page.archiveActions.prepare();
        expect(page.selectionManager.getSelectedResult()).toBeNull();
        const count=calls('spotlightHandleResult').length;
        const nativeCount=chromeMock.runtime.sendMessage.mock.calls.filter(([target])=>typeof target==='string').length;
        key('Enter',{repeat:true}); key('Enter');
        expect(calls('spotlightHandleResult')).toHaveLength(count);
        expect(chromeMock.runtime.sendMessage.mock.calls.filter(([target])=>typeof target==='string')).toHaveLength(nativeCount);
        expect(mutation).not.toHaveBeenCalled();
        if(kind!=='after-invocation')expect(externalRequest).toBeUndefined();
    });
    it('keeps overlapping passive reads empty until the latest fresh scope wins', async () => {
        await open();type('open archive');const send=chromeMock.runtime.sendMessage.getMockImplementation(), finishes=[];
        chromeMock.runtime.sendMessage.mockImplementation((...args)=>args[0]?.action==='arcifyArchiveContext'?new Promise(resolve=>finishes.push(resolve)):send(...args));
        const first=page.archiveActions.prepare(),second=page.archiveActions.prepare();
        const stale=clone(scope);stale.openIntent='stale-intent';finishes[0]({success:true,scope:stale,spaceNames:clone(spaceNames)});await first;
        expect(page.selectionManager.getSelectedResult()).toBeNull();
        const fresh=clone(scope);fresh.viewId='fresh-view';fresh.openIntent='latest-intent';finishes[1]({success:true,scope:fresh,spaceNames:clone(spaceNames)});await second;
        expect(page.selectionManager.getSelectedResult()?.metadata.archiveAction.scope.openIntent).toBe('latest-intent');
    });
});
