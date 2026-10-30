// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chromeMock } from '../mocks/chrome.js';
import './setup.js';
const PEER = 'a'.repeat(32);
const ordinary = { type: 'history', title: 'Example', url: 'https://example.test', domain: 'example.test' };
const base = { peerId: PEER, generation: 'local-generation', context: { windowId: 2, spaceId: 'selected-space', bookmarkFolderId: 'root', pairingGeneration: 'peer-generation', sourceTabId: 9,
    tab: { id: 9, url: 'https://same.test/', title: 'Exact tab', section: 'today', bookmark: null, alias: '', muted: false } } };
const savedScope = () => { const scope = structuredClone(base); scope.context.tab.section = 'saved'; scope.context.tab.bookmark = { id: 'exact-pin', parentId: 'nested', title: 'Exact pin', url: 'https://same.test/' }; return scope; };
let page, scope, initialResults, eventSpy, listeners, mutation;
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
const requests = action => chromeMock.runtime.sendMessage.mock.calls.filter(([message]) => message?.action === action);
const rows = () => [...page.resultsContainer.querySelectorAll('[data-result-type="arcify-tab-action"]')];
const dialog = () => document.querySelector('.arcify-tab-action-prompt');
function fire(target, name, extra = {}) {
    // jsdom cannot manufacture trusted DOM events. Invoke the actual registered
    // handlers with browser-attested fields; synthetic .click()/dispatchEvent
    // tests below independently exercise the untrusted browser event path.
    const event = { type: name, key: name === 'keydown' ? 'Enter' : undefined, button: 0, isTrusted: true, target, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra };
    eventSpy.mock.calls.forEach(([type, listener], i) => { if (type === name && eventSpy.mock.contexts[i] === target) listener(event); }); return event;
}
function type(value) { page.input.value = value; page.input.dispatchEvent(new Event('input', { bubbles: true })); }
const key = (key, extra = {}) => fire(page.input, 'keydown', { key, ...extra });
const promptKey = (target, key, extra = {}) => fire(dialog(), 'keydown', { target, key, ...extra });
const selectedCommand = () => page.selectionManager.getSelectedResult()?.metadata?.tabAction?.command;
function validResult(message) {
    const context = message.scope.context, fields = message.fields;
    return { command: message.command, ...(message.command === 'renameCurrentTab' ? { tabId: 9, bookmarkId: context.tab.bookmark?.id || null, title: fields.title }
        : message.command === 'editCurrentPinUrl' ? { tabId: 9, bookmarkId: context.tab.bookmark.id, url: fields.url }
        : message.command === 'duplicateCurrentTab' ? { tabId: 11 }
        : message.command === 'copyCurrentLink' ? { tabId: 9, copied: true, url: context.tab.url }
        : { tabId: 9, muted: fields.muted }) };
}
beforeEach(() => {
    document.body.innerHTML = '<div id="spotlight-container"></div>';
    Object.defineProperty(document, 'URL', { configurable: true, value: chromeMock.runtime.getURL('newtab.html') });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    HTMLElement.prototype.scrollIntoView = vi.fn();
    chromeMock.tabs.getCurrent = vi.fn().mockResolvedValue({ id: 9, windowId: 2, url: chromeMock.runtime.getURL('newtab.html') });
    chromeMock.storage.local.get.mockResolvedValue({ arcifyBridgePeerId: PEER, arcifyBridgePairingGeneration: 'local-generation' });
    listeners = [];
    chromeMock.storage.onChanged.addListener.mockImplementation(listener => listeners.push(listener));
    chromeMock.storage.onChanged.removeListener.mockImplementation(listener => { listeners = listeners.filter(item => item !== listener); });
    scope = structuredClone(base); initialResults = [ordinary];
    mutation = vi.fn(async message => ({ success: true, result: validResult(message) }));
    chromeMock.runtime.sendMessage.mockImplementation(message => {
        if (message.action === 'arcifyTabActionsContext') return Promise.resolve({ success: true, scope: structuredClone(scope) });
        if (message.action === 'arcifyTabAction') return mutation(message);
        if (message.action === 'arcifySpaceActionsContext') return Promise.resolve({ success: true, scope: null });
        if (message.action === 'arcifyBridgeStatus') return Promise.resolve({ success: true, status: { status: scope ? 'connected' : 'disabled', peerId: PEER, capabilities: [] } });
        if (message.action === 'getActiveSpaceColor') return Promise.resolve({ success: true, color: 'purple' });
        if (message.action === 'getSpotlightSuggestions') return Promise.resolve({ success: true, results: initialResults });
        if (message.action === 'getLocalSuggestions') return Promise.resolve({ success: true, results: [ordinary] });
        if (message.action === 'getAutocompleteSuggestions') return Promise.resolve({ success: true, results: [] });
        return Promise.resolve({ success: true });
    });
    eventSpy = vi.spyOn(EventTarget.prototype, 'addEventListener');
    vi.spyOn(window, 'close').mockImplementation(() => {});
});
afterEach(() => { page?.dispose(); page = null; vi.restoreAllMocks(); vi.useRealTimers(); delete HTMLElement.prototype.scrollIntoView; });
async function open() { const { initializeSpotlight } = await import('../../newtab.js'); page = await initializeSpotlight(); await page.tabActions.ready; await flush(); return page; }

describe('tabActionsV1 in the real new-tab renderer', () => {
    it.each([null, { ...base, context: { ...base.context, tab: null } }])('hides all current-tab actions for absent/helper context without disturbing ordinary search: %j', async unavailable => {
        scope = unavailable; await open(); expect(rows()).toHaveLength(0); expect(page.selectionManager.getSelectedResult()).toEqual(ordinary);
        type('duplicate tab'); expect(rows()).toHaveLength(0); expect(page.selectionManager.getSelectedResult().type).toBe('search-query');
    });
    it.each(['wrong-tab', 'unexpected-field', 'invalid-url', 'invalid-muted'])('hides malformed context %s while keeping ordinary results usable', async failure => {
        if (failure === 'wrong-tab') scope.context.tab.id = 10;
        if (failure === 'unexpected-field') scope.context.tab.extra = true;
        if (failure === 'invalid-url') scope.context.tab.url = 'javascript:alert(1)';
        if (failure === 'invalid-muted') scope.context.tab.muted = 'false';
        await open(); expect(rows()).toHaveLength(0); expect(page.selectionManager.getSelectedResult()).toEqual(ordinary);
    });
    it('does not guess a last-focused or active tab when getCurrent cannot attest the helper', async () => {
        chromeMock.tabs.getCurrent.mockResolvedValue(null); await open();
        expect(rows()).toHaveLength(0); expect(requests('arcifyTabActionsContext')).toHaveLength(0);
        expect(chromeMock.windows.getLastFocused).not.toHaveBeenCalled(); expect(chromeMock.windows.getCurrent).not.toHaveBeenCalled();
    });
    it('offers tab commands without selecting an empty-query command or treating its icon as content', async () => {
        initialResults = []; await open(); expect(rows().length).toBeGreaterThan(0);
        expect(rows().every(row => row.querySelector('img').alt === '')).toBe(true);
        expect(page.selectionManager.getSelectedResult()).toBeNull(); key('Enter'); expect(mutation).not.toHaveBeenCalled();
        expect(requests('arcifyTabActionsContext')[0][0].tabId).toBe(9);
    });
    it.each([['renam tab', 'renameCurrentTab'], ['duplcate current tab', 'duplicateCurrentTab'], ['copy curent link', 'copyCurrentLink'], ['mute current tab', 'setCurrentTabMuted']])('recognizes fuzzy command %j as %s while retaining web search', async (query, command) => {
        await open(); type(query); expect(selectedCommand()).toBe(command);
        expect(page.resultsContainer.querySelector('[data-result-type="search-query"]')).not.toBeNull();
    });
    it.each(['duplicate documentation', 'https://rename.test/', 'qzxv'])('does not misinterpret unrelated input %j', async query => {
        await open(); type(query); expect(rows()).toHaveLength(0);
    });
    it('preserves manual web search selection and typed draft across unchanged readiness refresh', async () => {
        await open(); type('duplcate tab'); expect(selectedCommand()).toBe('duplicateCurrentTab'); key('ArrowDown');
        const draft = page.input.value; expect(page.selectionManager.getSelectedResult().type).toBe('search-query');
        await page.tabActions.prepare(); expect(page.selectionManager.getSelectedResult().type).toBe('search-query'); expect(page.input.value).toBe(draft);
    });
    it('preserves the typed fuzzy query when keyboard selection returns from search to a tab command', async () => {
        await open(); type('duplcate tab'); key('ArrowDown'); expect(page.selectionManager.getSelectedResult().type).toBe('search-query');
        key('ArrowUp'); expect(selectedCommand()).toBe('duplicateCurrentTab'); expect(page.input.value).toBe('duplcate tab');
        await page.tabActions.prepare(); expect(page.input.value).toBe('duplcate tab'); expect(selectedCommand()).toBe('duplicateCurrentTab');
    });
    it('does not let a synthetic row click replace the user’s manually selected web search', async () => {
        await open(); type('duplicate tab'); key('ArrowDown'); const selected = page.selectionManager.getSelectedResult(), draft = page.input.value;
        expect(selected.type).toBe('search-query'); rows()[0].click(); await flush();
        expect(page.selectionManager.getSelectedResult()).toEqual(selected); expect(page.input.value).toBe(draft); expect(mutation).not.toHaveBeenCalled();
    });
    it.each([{ isTrusted: false }, { repeat: true }, { isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { altKey: true }, { metaKey: true }])('rejects untrusted/held/IME/modifier activation %j', async extra => {
        await open(); type('duplicate tab'); key('Enter', extra); rows()[0].click();
        page.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await flush();
        expect(mutation).not.toHaveBeenCalled(); expect(requests('spotlightHandleResult')).toHaveLength(0);
    });
    it.each(['duplicate tab', 'copy link', 'mute tab'])('executes %s once and keeps the current surface and navigation untouched', async query => {
        await open(); type(query); key('Enter'); key('Enter'); await page.tabActions.operation;
        expect(mutation).toHaveBeenCalledTimes(1); expect(requests('spotlightHandleResult')).toHaveLength(0); expect(window.close).not.toHaveBeenCalled();
        const completion={ 'duplicate tab':'Tab duplicated in Today.', 'copy link':'Current link copied.', 'mute tab':'Current tab muted.' }[query];
        expect(document.querySelector('[role="status"]').textContent).toBe(completion);
        const { SpotlightMessageClient } = await import('../../shared/message-client.js');
        SpotlightMessageClient.reportError('Arcify paired: live workspace results.','discovery'); await flush();
        expect(document.querySelector('[role="status"]').textContent).toBe(completion);
        type('next query');
        expect(document.querySelector('[role="status"]').textContent).toBe('Arcify paired: live workspace results.');
        expect(mutation).toHaveBeenCalledTimes(1);
    });
    it('changes mute intent from captured state and never lets mute text unmute an already-muted tab', async () => {
        scope.context.tab.muted = true; await open(); type('unmute tab'); expect(selectedCommand()).toBe('setCurrentTabMuted');
        key('Enter'); await page.tabActions.operation; expect(mutation.mock.calls[0][0].fields).toEqual({ muted: false });
    });
    it('opens an accessible rename prompt, preserves its draft during refresh, and Escape restores query and focus', async () => {
        await open(); type('rename tab'); key('Enter'); const prompt = dialog(), name = prompt.querySelector('[data-tab-action-input]'); name.value = 'Draft name';
        expect(prompt.getAttribute('role')).toBe('dialog'); expect(prompt.getAttribute('aria-labelledby')).toBe(prompt.querySelector('h2').id);
        expect(document.activeElement).toBe(name); expect(page.input.closest('.arcify-spotlight-input-wrapper').hidden).toBe(true);
        await page.tabActions.prepare(); expect(dialog()).toBe(prompt); expect(name.value).toBe('Draft name');
        const event = promptKey(name, 'Escape'); await page.tabActions.operation;
        expect(event.stopPropagation).toHaveBeenCalled(); expect(dialog()).toBeNull(); expect(mutation).not.toHaveBeenCalled();
        expect(page.input.value).toBe('rename tab'); expect(document.activeElement).toBe(page.input); expect(page.input.closest('.arcify-spotlight-input-wrapper').hidden).toBe(false);
    });
    it('traps keyboard focus within the prompt and treats a fresh Enter on Cancel as cancellation', async () => {
        await open(); type('rename tab'); key('Enter');
        const name = dialog().querySelector('[data-tab-action-input]'), cancel = dialog().querySelector('[data-action-cancel]'), confirm = dialog().querySelector('[data-action-confirm]');
        promptKey(name, 'Tab', { shiftKey: true }); expect(document.activeElement).toBe(confirm);
        promptKey(confirm, 'Tab'); expect(document.activeElement).toBe(name);
        cancel.focus(); promptKey(cancel, 'Enter'); await page.tabActions.operation;
        expect(dialog()).toBeNull(); expect(mutation).not.toHaveBeenCalled(); expect(page.input.value).toBe('rename tab'); expect(document.activeElement).toBe(page.input);
    });
    it('does not submit a rename under held Enter, synthetic confirmation, or IME', async () => {
        await open(); type('rename tab'); key('Enter'); const name = dialog().querySelector('[data-tab-action-input]'); name.value = 'Draft';
        promptKey(name, 'Enter', { repeat: true }); promptKey(name, 'Enter', { isComposing: true }); dialog().querySelector('[data-action-confirm]').click();
        await flush(); expect(mutation).not.toHaveBeenCalled(); expect(dialog()).not.toBeNull();
        promptKey(name, 'Enter'); await page.tabActions.operation; expect(mutation).toHaveBeenCalledTimes(1);
    });
    it('trims a Today alias and allows explicit blank reset without navigation', async () => {
        scope.context.tab.alias = 'Old alias'; await open(); type('rename tab'); key('Enter'); const name = dialog().querySelector('[data-tab-action-input]');
        expect(name.value).toBe('Old alias'); name.value = '   '; promptKey(name, 'Enter'); await page.tabActions.operation;
        expect(mutation.mock.calls[0][0]).toMatchObject({ command: 'renameCurrentTab', fields: { title: '' }, scope: { context: { sourceTabId: 9, tab: { id: 9, alias: 'Old alias' } } } });
        expect(requests('spotlightHandleResult')).toHaveLength(0);
    });
    it('rejects saved-pin blank/control/overlong titles and submits a trimmed name with the captured exact bookmark', async () => {
        scope = savedScope(); await open(); type('rename tab'); key('Enter'); const name = dialog().querySelector('[data-tab-action-input]');
        expect(name.value).toBe('Exact pin');
        for (const value of [' ', 'x\u0000y', 'x'.repeat(257)]) { name.value = value; promptKey(name, 'Enter'); expect(dialog()).not.toBeNull(); expect(mutation).not.toHaveBeenCalled(); }
        name.value = '  Reading  '; promptKey(name, 'Enter'); await page.tabActions.operation;
        expect(mutation.mock.calls[0][0]).toMatchObject({ command: 'renameCurrentTab', fields: { title: 'Reading' }, scope: { context: { sourceTabId: 9, tab: { bookmark: { id: 'exact-pin', parentId: 'nested' } } } } });
    });
    it('offers URL editing only for saved pins and validates an explicit complete URL before dispatch', async () => {
        scope = savedScope(); await open(); type('edit pin url'); expect(selectedCommand()).toBe('editCurrentPinUrl'); key('Enter');
        const url = dialog().querySelector('[data-tab-action-input]'); expect(url.value).toBe('https://same.test/');
        for (const value of ['', 'example.test', 'https:example.test', 'javascript:alert(1)', 'https://example.test/' + 'x'.repeat(16384)]) { url.value = value; promptKey(url, 'Enter'); expect(dialog()).not.toBeNull(); expect(mutation).not.toHaveBeenCalled(); }
        url.value = '  https://new.test/path?q=1#part  '; promptKey(url, 'Enter'); await page.tabActions.operation;
        expect(mutation.mock.calls[0][0]).toMatchObject({ command: 'editCurrentPinUrl', fields: { url: 'https://new.test/path?q=1#part' }, scope: { context: { tab: { id: 9, bookmark: { id: 'exact-pin' } } } } });
    });
    it('normalizes a complete entered URL before dispatch so the exact acknowledgement matches Chrome bookmark storage', async () => {
        scope = savedScope(); await open(); type('edit pin url'); key('Enter');
        const url = dialog().querySelector('[data-tab-action-input]'); url.value = '  HTTPS://New.Example  ';
        promptKey(url, 'Enter'); await page.tabActions.operation;
        expect(mutation.mock.calls[0][0]).toMatchObject({ command: 'editCurrentPinUrl', fields: { url: 'https://new.example/' } });
        expect(requests('spotlightHandleResult')).toHaveLength(0); expect(window.close).not.toHaveBeenCalled();
    });
    it('hides saved-pin URL editing for Today context', async () => {
        await open(); type('edit pin url'); expect(rows()).toHaveLength(0); expect(mutation).not.toHaveBeenCalled();
    });
    it('keeps captured prompt identity on drift so backend can refuse rather than rename a different same-URL pin', async () => {
        scope = savedScope(); await open(); type('rename tab'); key('Enter'); const name = dialog().querySelector('[data-tab-action-input]'); name.value = 'Draft';
        scope.context.tab.bookmark.id = 'same-url-other-pin'; await page.tabActions.prepare(); mutation.mockResolvedValue({ success: false, errorCode: 'STALE_CONTEXT', error: 'The current pin changed.' });
        promptKey(name, 'Enter'); await page.tabActions.operation;
        expect(mutation.mock.calls[0][0].scope.context.tab.bookmark.id).toBe('exact-pin'); expect(document.querySelector('[role="status"]').textContent).toBe('The current pin changed.');
    });
    it('invalidates a manually selected stale action without choosing replacement navigation', async () => {
        await open(); type('duplicate tab'); key('ArrowUp'); const previous = page.selectionManager.getSelectedResult(), draft = page.input.value;
        await page.tabActions.prepare(); expect(page.selectionManager.getSelectedResult()).toEqual(previous);
        scope.context.tab.alias = 'Changed alias'; await page.tabActions.prepare(); expect(page.selectionManager.getSelectedResult()).toBeNull(); expect(page.input.value).toBe(draft);
        page.tabActions.invoke(previous, { type: 'keydown', key: 'Enter', isTrusted: true }); await flush(); expect(mutation).not.toHaveBeenCalled();
    });
    it('cancels prompts immediately on pairing change and rejects late old context readiness', async () => {
        await open(); type('rename tab'); key('Enter'); scope = null;
        listeners.forEach(listener => listener({ arcifyBridgePairingGeneration: { newValue: 'new-generation' } }, 'local'));
        expect(dialog()).toBeNull(); expect(rows()).toHaveLength(0); await page.tabActions.ready; await page.tabActions.operation;
        expect(mutation).not.toHaveBeenCalled(); expect(page.selectionManager.getSelectedResult()).toBeNull();
    });
    it('ignores a late context response from the old pairing after a newer read has hidden actions', async () => {
        await open(); const original = chromeMock.runtime.sendMessage.getMockImplementation(); let resolveOld, pending = true;
        chromeMock.runtime.sendMessage.mockImplementation(message => message.action === 'arcifyTabActionsContext' && pending
            ? (pending = false, new Promise(resolve => resolveOld = resolve)) : original(message));
        const oldRead = page.tabActions.prepare(); scope = null;
        listeners.forEach(listener => listener({ arcifyBridgePairingGeneration: { newValue: 'new-generation' } }, 'local'));
        await page.tabActions.ready; expect(rows()).toHaveLength(0);
        resolveOld({ success: true, scope: structuredClone(base) }); await oldRead;
        expect(rows()).toHaveLength(0); expect(page.tabActions.scope).toBeNull();
    });
    it('ignores pending old success after pairing revocation', async () => {
        let resolve; mutation.mockImplementation(() => new Promise(r => resolve = r));
        await open(); type('duplicate tab'); key('Enter'); scope = null;
        listeners.forEach(listener => listener({ arcifyBridgePeerId: { newValue: null } }, 'local'));
        resolve({ success: true, result: { command: 'duplicateCurrentTab', tabId: 11 } }); await page.tabActions.operation;
        expect(document.querySelector('[role="status"]').textContent).not.toMatch(/duplicated/i);
    });
    it.each([undefined, { success: true, result: { command: 'duplicateCurrentTab', tabId: 9 } }, { success: true, result: { command: 'duplicateCurrentTab', tabId: 11, unexpected: true } }, { success: false, error: 'Unauthorized', errorCode: 'UNAUTHORIZED' }])('never retries or navigates after unknown/invalid/refused acknowledgement %j', async response => {
        mutation.mockResolvedValue(response); await open(); type('duplicate tab'); key('Enter'); await page.tabActions.operation;
        key('Enter', { repeat: true }); key('Enter'); await flush();
        expect(mutation).toHaveBeenCalledTimes(1); expect(requests('spotlightHandleResult')).toHaveLength(0); expect(window.close).not.toHaveBeenCalled();
        expect(page.selectionManager.getSelectedResult()).toBeNull(); expect(document.querySelector('.arcify-bridge-status').dataset.state).toBe('error');
    });
    it('bounds lost acknowledgements, never retries, and ignores a late success', async () => {
        vi.useFakeTimers(); let resolve; mutation.mockImplementation(() => new Promise(r => resolve = r));
        await open(); page.tabActions.timeoutMs = 50; type('duplicate tab'); key('Enter'); await vi.advanceTimersByTimeAsync(51); await page.tabActions.operation;
        expect(mutation).toHaveBeenCalledTimes(1); expect(document.querySelector('[role="status"]').textContent).toContain('did not confirm');
        resolve({ success: true, result: { command: 'duplicateCurrentTab', tabId: 11 } }); await flush();
        expect(document.querySelector('[role="status"]').textContent).toContain('did not confirm'); expect(requests('spotlightHandleResult')).toHaveLength(0);
    });
    it('disposes an open prompt safely even after extension context invalidates storage cleanup', async () => {
        await open(); type('rename tab'); key('Enter'); chromeMock.storage.onChanged.removeListener.mockImplementation(() => { throw new Error('Extension context invalidated'); });
        expect(() => page.tabActions.dispose()).not.toThrow(); await page.tabActions.operation;
        expect(dialog()).toBeNull(); expect(mutation).not.toHaveBeenCalled(); chromeMock.storage.onChanged.removeListener.mockImplementation(() => {});
    });
});
