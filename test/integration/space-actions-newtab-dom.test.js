// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chromeMock } from '../mocks/chrome.js';
import './setup.js';
const PEER = 'a'.repeat(32), OWN = 'b'.repeat(32);
const ordinary = { type: 'history', title: 'Example', url: 'https://example.test', domain: 'example.test' };
const base = { peerId: PEER, generation: 'local-generation', context: { windowId: 2, spaceId: 'selected-space', bookmarkFolderId: 'root', pairingGeneration: 'peer-generation', sourceTabId: 9,
    tab: { id: 9, url: 'https://same.test/', title: 'Exact tab', section: 'today', bookmark: null } } };
const savedScope = () => { const scope = structuredClone(base); scope.context.tab.section = 'saved'; scope.context.tab.bookmark = { id: 'exact-pin', parentId: 'nested', title: 'Exact pin', url: 'https://same.test/' }; return scope; };
let page, scope, initialResults, eventSpy, listeners, mutation;
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const requests = action => chromeMock.runtime.sendMessage.mock.calls.filter(([message]) => message?.action === action);
const rows = () => [...page.resultsContainer.querySelectorAll('[data-result-type="arcify-space-action"]')];
const dialog = () => document.querySelector('[role="dialog"]');
function fire(target, name, extra = {}) {
    const event = { type: name, key: name === 'keydown' ? 'Enter' : undefined, button: 0, isTrusted: true, target, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra };
    eventSpy.mock.calls.forEach(([type, listener], i) => { if (type === name && eventSpy.mock.contexts[i] === target) listener(event); });
    return event;
}
function clickRow(row) { fire(page.resultsContainer, 'click', { target: row }); }
function type(value) { page.input.value = value; page.input.dispatchEvent(new Event('input', { bubbles: true })); }
const key = (key, extra = {}) => fire(page.input, 'keydown', { key, ...extra });
function promptKey(target, key, extra = {}) { return fire(dialog(), 'keydown', { target, key, ...extra }); }
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
    mutation = vi.fn(async message => ({ success: true, result: { command: message.command, ...(['switchSpace', 'moveCurrentTodayTab'].includes(message.command) ? { spaceId: message.fields.destination.spaceId, tabId: message.command === 'switchSpace' ? null : 9 } : message.command === 'createSpaceFolder' ? { folderId: 'created-folder' } : message.command === 'openSettings' ? { tabId: 99 } : { tabId: 9, bookmarkId: message.scope.context.tab?.bookmark?.id || 'new-pin' }) } }));
    chromeMock.runtime.sendMessage.mockImplementation(message => {
        if (message.action === 'arcifySpaceActionsContext') return Promise.resolve({ success: true, scope: structuredClone(scope) });
        if (message.action === 'arcifySpaceAction') return mutation(message);
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
async function open() { const { initializeSpotlight } = await import('../../newtab.js'); page = await initializeSpotlight(); await page.spaceActions.ready; await flush(); return page; }

describe('real newtab Space action UI', () => {
    it.each(['pin current tab', ''])('does not activate a replacement after the focused action disappears for %j', async query => {
        initialResults = []; await open(); type(query); await flush();
        rows()[0].focus(); scope = null; await page.spaceActions.prepare();
        expect(document.activeElement).toBe(page.input); expect(page.input.value).toBe(query);
        expect(page.selectionManager.getSelectedResult()).toBeNull();
        key('Enter'); expect(mutation).not.toHaveBeenCalled(); expect(requests('spotlightHandleResult')).toHaveLength(0);
        scope = structuredClone(base); await page.spaceActions.prepare();
        expect(page.selectionManager.getSelectedResult()).toBeNull();
        key('Enter'); expect(mutation).not.toHaveBeenCalled(); expect(requests('spotlightHandleResult')).toHaveLength(0);
    });
    it('offers only folder/settings on helper context, preserves normal empty-query selection, and uses labeled decorative icons', async () => {
        scope.context.tab = null; await open();
        expect(rows().map(row => row.textContent)).toEqual([expect.stringContaining('Open Arcify settings'), expect.stringContaining('Create folder')]);
        expect(page.selectionManager.getSelectedResult()).toEqual(ordinary);
        expect(rows().every(row => row.querySelector('img').alt === '')).toBe(true);
        expect(requests('arcifySpaceActionsContext')[0][0].tabId).toBe(9);
    });
    it('works standalone and hides old-peer/unavailable actions without disrupting web search', async () => {
        scope = null; await open(); type('create folder');
        expect(rows()).toHaveLength(0); expect(page.selectionManager.getSelectedResult().type).toBe('search-query');
        key('Enter'); expect(requests('spotlightHandleResult')).toHaveLength(1); expect(mutation).not.toHaveBeenCalled();
    });
    it('never defaults to an empty-query action or destructive action', async () => {
        scope = savedScope(); initialResults = []; await open();
        expect(rows().some(row => row.textContent.includes('Remove'))).toBe(true);
        expect(page.selectionManager.getSelectedResult()).toBeNull(); key('Enter');
        expect(dialog()).toBeNull(); expect(mutation).not.toHaveBeenCalled();
    });
    it('promotes fuzzy intent over retained web search and preserves explicit search through refresh', async () => {
        await open(); type('creat folde');
        expect(page.selectionManager.getSelectedResult().metadata.spaceAction.command).toBe('createSpaceFolder');
        expect(page.resultsContainer.querySelector('[data-result-type="search-query"]')).not.toBeNull();
        key('ArrowDown'); const input = page.input.value;
        await page.spaceActions.prepare();
        expect(page.selectionManager.getSelectedResult().type).toBe('search-query'); expect(page.input.value).toBe(input);
    });
    it.each(['folder documentation', 'https://settings.test/', 'qzxv'])('does not mistake unrelated %j for an action', async query => {
        await open(); type(query); expect(rows()).toHaveLength(0);
    });
    it.each(['unpin current tab', 'remove the saved pin', 'unpn current tab'])('recognizes safe removal intent %j', async query => {
        scope = savedScope(); await open(); type(query);
        expect(page.selectionManager.getSelectedResult()?.metadata?.spaceAction?.command).toBe('removeCurrentPin');
    });
    it.each(['create a folder', 'make new folder'])('recognizes folder intent %j', async query => {
        await open(); type(query); expect(page.selectionManager.getSelectedResult()?.metadata?.spaceAction?.command).toBe('createSpaceFolder');
    });
    it('does not turn ambiguous pin intent into removal', async () => {
        scope = savedScope(); await open(); type('pin'); expect(rows()).toHaveLength(0); type('unpin'); expect(rows()).toHaveLength(1);
    });
    it.each([{ isTrusted: false }, { repeat: true }, { isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { altKey: true }, { metaKey: true }])('rejects untrusted/repeated/composing/modifier activation %j', async extra => {
        await open(); type('pin current tab'); key('Enter', extra);
        rows()[0].click(); // Real synthetic DOM event must also fail at the delegated handler.
        await flush(); expect(mutation).not.toHaveBeenCalled(); expect(requests('spotlightHandleResult')).toHaveLength(0);
    });
    it.each(['pin current tab', 'open settings'])('runs %s once, keeping the helper open and navigation route untouched', async query => {
        await open(); type(query); key('Enter'); key('Enter'); await page.spaceActions.operation;
        expect(mutation).toHaveBeenCalledTimes(1); expect(requests('spotlightHandleResult')).toHaveLength(0);
        expect(window.close).not.toHaveBeenCalled(); expect(document.querySelector('[role="status"]').textContent).toMatch(/opened|saved/);
    });
    it('shows a labeled named-folder prompt, keeps its draft on refresh, and cancels without mutation', async () => {
        await open(); type('new folder'); key('Enter');
        const prompt = dialog(), name = prompt.querySelector('input'); name.value = 'Draft folder';
        expect(prompt.getAttribute('aria-labelledby')).toBe(prompt.querySelector('h2').id);
        expect(document.activeElement).toBe(name); expect(page.input.closest('.arcify-spotlight-input-wrapper').hidden).toBe(true);
        await page.spaceActions.prepare(); expect(name.value).toBe('Draft folder'); expect(dialog()).toBe(prompt);
        promptKey(name, 'Escape'); await page.spaceActions.operation;
        expect(dialog()).toBeNull(); expect(mutation).not.toHaveBeenCalled(); expect(page.input.value).toBe('new folder'); expect(document.activeElement).toBe(page.input);
        expect(page.input.closest('.arcify-spotlight-input-wrapper').hidden).toBe(false);
    });
    it('rejects synthetic prompt submission and blank names, then submits the trimmed name under the captured Space', async () => {
        await open(); type('new folder'); key('Enter');
        const name = dialog().querySelector('input'), confirm = dialog().querySelector('[data-action-confirm]');
        name.value = 'Reading'; confirm.click(); promptKey(name, 'Enter', { isTrusted: false }); await flush(); expect(mutation).not.toHaveBeenCalled();
        name.value = ' '; promptKey(name, 'Enter'); expect(dialog().querySelector('[role="alert"]').textContent).toContain('Enter a folder name');
        name.value = '  Reading  '; promptKey(name, 'Enter'); await page.spaceActions.operation;
        expect(mutation).toHaveBeenCalledTimes(1); expect(mutation.mock.calls[0][0]).toMatchObject({ command: 'createSpaceFolder', fields: { title: 'Reading' }, scope: { context: { spaceId: 'selected-space', bookmarkFolderId: 'root' } } });
        expect(window.close).not.toHaveBeenCalled();
    });
    it('gives Remove a safe Cancel focus; repeated Enter, IME, and synthetic confirmation cannot delete', async () => {
        scope = savedScope(); await open(); type('unpin'); key('Enter');
        const prompt = dialog(), cancel = prompt.querySelector('[data-action-cancel]'), confirm = prompt.querySelector('[data-action-confirm]');
        expect(document.activeElement).toBe(cancel); expect(prompt.textContent).toContain('Every live tab linked to this exact pin will stay open as Today');
        promptKey(cancel, 'Enter', { repeat: true }); promptKey(confirm, 'Enter', { isComposing: true }); confirm.click(); await flush();
        expect(dialog()).toBe(prompt); expect(mutation).not.toHaveBeenCalled();
        promptKey(cancel, 'Enter'); await page.spaceActions.operation;
        expect(dialog()).toBeNull(); expect(mutation).not.toHaveBeenCalled();
    });
    it('requires a separate trusted Remove choice and preserves the exact bookmark and tab IDs', async () => {
        scope = savedScope(); await open(); type('remove pin'); clickRow(rows()[0]);
        const confirm = dialog().querySelector('[data-action-confirm]'); confirm.focus(); promptKey(confirm, 'Enter'); await page.spaceActions.operation;
        expect(mutation).toHaveBeenCalledTimes(1);
        expect(mutation.mock.calls[0][0]).toMatchObject({ command: 'removeCurrentPin', fields: { confirmed: true }, scope: { context: { sourceTabId: 9, tab: { id: 9, bookmark: { id: 'exact-pin' } } } } });
        expect(requests('spotlightHandleResult')).toHaveLength(0); expect(window.close).not.toHaveBeenCalled();
    });
    it('retains a manually chosen action across unchanged refresh, but leaves no replacement selected after context drift', async () => {
        await open(); type('pin current tab'); key('ArrowUp'); const old = page.selectionManager.getSelectedResult(), draft = page.input.value;
        await page.spaceActions.prepare(); expect(page.selectionManager.getSelectedResult()).toEqual(old); expect(page.input.value).toBe(draft);
        scope.context.tab.title = 'Changed current tab'; await page.spaceActions.prepare();
        expect(page.selectionManager.getSelectedResult()).toBeNull(); expect(page.input.value).toBe(draft);
        page.spaceActions.invoke(old, { type: 'keydown', key: 'Enter', isTrusted: true }); await flush(); expect(mutation).not.toHaveBeenCalled();
    });
    it('keeps a prompted draft tied to old exact context so backend rejects drift instead of silently changing Space', async () => {
        await open(); type('new folder'); key('Enter'); const name = dialog().querySelector('input'); name.value = 'Draft';
        scope.context.spaceId = 'other-space'; await page.spaceActions.prepare();
        mutation.mockResolvedValue({ success: false, errorCode: 'STALE_CONTEXT', error: 'The selected Space changed.' });
        promptKey(name, 'Enter'); await page.spaceActions.operation;
        expect(mutation.mock.calls[0][0].scope.context.spaceId).toBe('selected-space');
        expect(document.querySelector('[role="status"]').textContent).toBe('The selected Space changed.'); expect(window.close).not.toHaveBeenCalled();
    });
    it('revokes prompts immediately on generation changes and ignores late old readiness', async () => {
        await open(); type('new folder'); key('Enter'); scope = null;
        listeners.forEach(listener => listener({ arcifyBridgePairingGeneration: { newValue: 'new-generation' } }, 'local'));
        expect(dialog()).toBeNull(); expect(rows()).toHaveLength(0); await page.spaceActions.ready; await page.spaceActions.operation;
        expect(mutation).not.toHaveBeenCalled(); expect(page.selectionManager.getSelectedResult()).toBeNull();
    });
    it('cancels a prompt even if an extension reload invalidated storage cleanup', async () => {
        await open(); type('new folder'); key('Enter');
        chromeMock.storage.onChanged.removeListener.mockImplementation(() => { throw new Error('Extension context invalidated'); });
        expect(() => page.spaceActions.dispose()).not.toThrow(); await page.spaceActions.operation;
        expect(dialog()).toBeNull(); expect(mutation).not.toHaveBeenCalled();
        chromeMock.storage.onChanged.removeListener.mockImplementation(() => {});
    });
    it('ignores a pending acknowledgement after pairing revocation', async () => {
        let resolve; mutation.mockImplementation(() => new Promise(r => resolve = r));
        await open(); type('pin current tab'); key('Enter'); scope = null;
        listeners.forEach(listener => listener({ arcifyBridgePairingGeneration: { newValue: 'new-generation' } }, 'local'));
        resolve({ success: true, result: { command: 'pinCurrentTab', tabId: 9, bookmarkId: 'new' } }); await page.spaceActions.operation;
        expect(document.querySelector('[role="status"]').textContent).not.toContain('Current tab saved');
    });
    it.each([undefined, { success: true, result: { command: 'pinCurrentTab', tabId: 10, bookmarkId: 'wrong-tab' } }, { success: false, error: 'Unauthorized', errorCode: 'UNAUTHORIZED' }])('never retries or navigates after unknown/invalid/refused result %j', async response => {
        mutation.mockResolvedValue(response); await open(); type('pin current tab'); key('Enter'); await page.spaceActions.operation;
        key('Enter', { repeat: true }); key('Enter'); await flush();
        expect(mutation).toHaveBeenCalledTimes(1); expect(requests('spotlightHandleResult')).toHaveLength(0); expect(window.close).not.toHaveBeenCalled();
        expect(page.selectionManager.getSelectedResult()).toBeNull(); expect(document.querySelector('.arcify-bridge-status').dataset.state).toBe('error');
    });
    it('bounds a lost response, never retries, and ignores its late success', async () => {
        vi.useFakeTimers(); let resolve; mutation.mockImplementation(() => new Promise(r => resolve = r));
        await open(); page.spaceActions.timeoutMs = 50; type('pin current tab'); key('Enter');
        await vi.advanceTimersByTimeAsync(51); await page.spaceActions.operation;
        expect(mutation).toHaveBeenCalledTimes(1); expect(document.querySelector('[role="status"]').textContent).toContain('did not confirm');
        resolve({ success: true, result: { command: 'pinCurrentTab', tabId: 9, bookmarkId: 'new' } }); await flush();
        expect(document.querySelector('[role="status"]').textContent).toContain('did not confirm'); expect(requests('spotlightHandleResult')).toHaveLength(0);
    });
});

const enableNavigation = () => { scope.navigation = { sourceUrl: scope.context.tab?.url || 'chrome://newtab/', inverted: false,
    destinations: [{ spaceId: 'target', bookmarkFolderId: 'target-root', name: 'Personal' }, { spaceId: 'other', bookmarkFolderId: 'other-root', name: 'Research' }] }; };
const destinationSelect = () => dialog()?.querySelector('[data-space-destination]');
describe('Space picker in the actual newtab document', () => {
    it.each([['switch space', 'switchSpace'], ['move current tab to another space', 'moveCurrentTodayTab'], ['swich space', 'switchSpace'], ['move tab', 'moveCurrentTodayTab']])('opens %s as an explicit destination picker with retained web search', async (query, command) => {
        enableNavigation(); await open(); type(query);
        expect(page.selectionManager.getSelectedResult()?.metadata.spaceAction.command).toBe(command);
        expect(page.resultsContainer.querySelector('[data-result-type="search-query"]')).not.toBeNull();
        key('Enter'); expect(destinationSelect()).not.toBeNull(); expect(destinationSelect().value).toBe('');
        expect(document.activeElement).toBe(destinationSelect()); expect(mutation).not.toHaveBeenCalled();
        promptKey(destinationSelect(), 'Enter'); await flush();
        expect(dialog().querySelector('[role="alert"]').textContent).toContain('Choose a destination'); expect(mutation).not.toHaveBeenCalled();
    });
    it.each([['switch space', 'switchSpace'], ['move current tab', 'moveCurrentTodayTab']])('requires a separate explicit target for %s and sends exact IDs once', async (query, command) => {
        enableNavigation(); await open(); type(query); key('Enter');
        const select = destinationSelect(); select.value = '1';
        promptKey(select, 'Enter', { repeat: true }); promptKey(select, 'Enter', { isComposing: true }); promptKey(select, 'Enter', { keyCode: 229 });
        dialog().querySelector('[data-action-confirm]').click(); await flush(); expect(mutation).not.toHaveBeenCalled();
        promptKey(select, 'Enter'); key('Enter', { repeat: true }); await page.spaceActions.operation;
        expect(mutation).toHaveBeenCalledTimes(1);
        expect(mutation.mock.calls[0][0]).toMatchObject({ command, fields: { destination: { spaceId: 'other', bookmarkFolderId: 'other-root' } } });
        expect(requests('spotlightHandleResult')).toHaveLength(0); expect(window.close).not.toHaveBeenCalled();
    });
    it('supports cancellation without losing typed query or moving focus to another browser tab', async () => {
        enableNavigation(); await open(); type('move tab'); key('Enter');
        destinationSelect().value = '0'; promptKey(destinationSelect(), 'Escape'); await page.spaceActions.operation;
        expect(dialog()).toBeNull(); expect(mutation).not.toHaveBeenCalled(); expect(page.input.value).toBe('move tab'); expect(document.activeElement).toBe(page.input);
    });
    it('disambiguates equal Space names by exact Space identity and ignores tampered values', async () => {
        enableNavigation(); scope.navigation.destinations[1].name = 'Personal'; await open(); type('switch space'); key('Enter');
        expect([...destinationSelect().options].map(option => option.textContent)).toEqual(['Choose a Space…', 'Personal (target)', 'Personal (other)']);
        destinationSelect().value = 'forged'; promptKey(destinationSelect(), 'Enter'); await flush();
        expect(mutation).not.toHaveBeenCalled(); expect(dialog()).not.toBeNull();
    });
    it('offers Switch but never Move for a helper and never defaults to an empty-query action', async () => {
        scope.context.tab = null; enableNavigation(); initialResults = []; await open();
        expect(rows().some(row => row.textContent.includes('Switch Space'))).toBe(true);
        expect(rows().some(row => row.textContent.includes('Move current'))).toBe(false);
        expect(page.selectionManager.getSelectedResult()).toBeNull(); key('Enter'); expect(dialog()).toBeNull();
    });
    it('hides both choices if there is no other valid existing Space', async () => {
        enableNavigation(); scope.navigation.destinations = []; await open();
        expect(rows().some(row => /Switch Space|Move current/.test(row.textContent))).toBe(false);
        type('move tab'); expect(page.selectionManager.getSelectedResult().type).toBe('search-query');
    });
    it('preserves explicitly selected web search and typed query through readiness refresh', async () => {
        enableNavigation(); await open(); type('switch space'); key('ArrowDown');
        expect(page.selectionManager.getSelectedResult().type).toBe('search-query'); const draft = page.input.value;
        await page.spaceActions.prepare(); expect(page.selectionManager.getSelectedResult().type).toBe('search-query'); expect(page.input.value).toBe(draft);
    });
    it('cancels the picker on pairing revocation before any dispatch', async () => {
        enableNavigation(); await open(); type('move tab'); key('Enter'); destinationSelect().value = '0'; scope = null;
        listeners.forEach(listener => listener({ arcifyBridgePeerId: { newValue: '' } }, 'local'));
        await page.spaceActions.operation; expect(dialog()).toBeNull(); expect(mutation).not.toHaveBeenCalled();
    });
    it('rejects a changed destination acknowledgement without replay or navigation', async () => {
        enableNavigation(); mutation.mockResolvedValue({ success: true, result: { command: 'moveCurrentTodayTab', tabId: 9, spaceId: 'replacement' } });
        await open(); type('move tab'); key('Enter'); destinationSelect().value = '0'; promptKey(destinationSelect(), 'Enter'); await page.spaceActions.operation;
        key('Enter'); await flush(); expect(mutation).toHaveBeenCalledTimes(1); expect(requests('spotlightHandleResult')).toHaveLength(0);
        expect(document.querySelector('[role="status"]').textContent).toContain('did not confirm'); expect(window.close).not.toHaveBeenCalled();
    });
});

describe('local Spotlight settings in production New Tab',()=>{
 it.each(['Spotlight settings','connection settings','pairing'])('opens existing options route unpaired for %s',async query=>{
  scope=null;chromeMock.storage.local.get.mockResolvedValue({});await open();type(query);await flush();
  expect(page.resultsContainer.querySelectorAll('[data-result-type="spotlight-settings-action"]')).toHaveLength(1);
  expect(page.selectionManager.getSelectedResult().type).toBe('spotlight-settings-action');key('Enter');await flush();
  expect(requests('arcifyBridgeOpenSettings')).toHaveLength(1);expect(requests('spotlightHandleResult')).toHaveLength(0);expect(mutation).not.toHaveBeenCalled();
 });
 it('paired settings has one Spotlight action plus distinct Arcify action',async()=>{await open();type('settings');await flush();expect(page.resultsContainer.querySelectorAll('[data-result-type="spotlight-settings-action"]')).toHaveLength(1);expect(rows().filter(r=>r.textContent.includes('Open Arcify settings'))).toHaveLength(1);type('Arcify settings');expect(page.resultsContainer.querySelector('[data-result-type="spotlight-settings-action"]')).toBeNull();});
});
