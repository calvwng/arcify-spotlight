// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://example.com/"}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromeMock } from '../mocks/chrome.js';
import { JSDOM } from 'jsdom';
import './setup.js';

// Runs the real background, overlay, message client, bridge status, and search modules.
// Only Chrome transport/storage and native dialog/iframe platform boundaries are mocked.
// JSDOM does not implement dialogs: close queues its event as Chrome does, while all
// overlay construction, cleanup, focus, and the 200 ms teardown use real DOM/timers.
const peerId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const tab = { id: 42, windowId: 2, url: 'https://example.com/', active: true, title: 'Example' };
const sender = { id: chromeMock.runtime.id, tab, url: tab.url };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let backgroundListeners;
let contentListeners;
let externalListeners;
let registrationTarget;
let activeTab;
let nextRequest;
let messageClient;
let logicalSnapshot;
let frameWindows;
let hostKeyEvents;
let removeHostKeyListeners;
let tabEvents;
let currentDocumentId;
const missingReceiver = () => new Error('Could not establish connection. Receiving end does not exist.');
const shortcut = (name = 'toggleSpotlightNewTab', source = { ...activeTab }) =>
    chromeMock.commands.onCommand.addListener.mock.lastCall[0](name, source);
const emitTab = (name, ...args) => { for (const listener of [...tabEvents[name]]) listener(...args); };
async function reloadOverlayBundle() {
    vi.resetModules();
    registrationTarget = contentListeners;
    await import('../../overlay.js');
    ({ SpotlightMessageClient: messageClient } = await import('../../shared/message-client.js'));
}
function invalidateReceiver() { window.__arcifyLittleArcHeader?.dispose(); window.__arcifyPeek?.dispose(); contentListeners.length = 0; }

function dispatch(listeners, message, from) {
    return new Promise(resolve => {
        let pending = false;
        let answered = false;
        const sendResponse = response => { answered = true; resolve(response); };
        for (const listener of [...listeners]) {
            if (listener(message, from, sendResponse) === true) pending = true;
        }
        if (!pending && !answered) resolve(undefined);
    });
}

const launch = (overrides = {}) => dispatch(externalListeners, {
    type: 'arcify-bridge', version: 1, requestId: `launch-${++nextRequest}`,
    command: 'launch', windowId: 2, mode: 'new-tab', ...overrides
}, { id: peerId });
const activate = (overrides = {}) => dispatch(contentListeners, {
    action: 'activateSpotlight', mode: 'new-tab', tabUrl: tab.url, tabId: tab.id, ...overrides
}, { id: chromeMock.runtime.id });
const close = () => dispatch(contentListeners, { action: 'closeSpotlight' }, { id: chromeMock.runtime.id });
const host = () => document.getElementById('arcify-spotlight-host');
const dialog = () => host()?.shadowRoot.getElementById('arcify-spotlight-dialog');
const frameDocument = () => dialog()?.querySelector('iframe')?.contentDocument;
const input = () => frameDocument()?.querySelector('input');

function expectOpen() {
    expect(document.querySelectorAll('#arcify-spotlight-host')).toHaveLength(1);
    expect(dialog()?.open).toBe(true);
    expect(frameDocument().activeElement).toBe(input());
    expect(window.arcifySpotlightInjected).toBe(true);
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
}

async function restartBackground() {
    backgroundListeners.length = 0;
    externalListeners.length = 0;
    registrationTarget = backgroundListeners;
    vi.resetModules();
    await import('../../background.js');
    registrationTarget = contentListeners;
}

beforeEach(async () => {
    window.__arcifyLittleArcHeader?.dispose(); window.__arcifyPeek?.dispose();
    // JSDOM does not create iframe documents inside Shadow DOM. Supply only
    // that native boundary; the UI/events use a separate, real Document tree.
    const documents = new WeakMap();
    frameWindows = [];
    vi.spyOn(HTMLIFrameElement.prototype, 'contentDocument', 'get').mockImplementation(function () {
        if (!documents.has(this)) {
            const frameWindow = new JSDOM('<!doctype html><html><head></head><body></body></html>').window;
            frameWindow.HTMLElement.prototype.scrollIntoView = () => {};
            // Keep the direct trusted-handler test spy shared across both realms.
            frameWindow.EventTarget.prototype.addEventListener = EventTarget.prototype.addEventListener;
            frameWindows.push(frameWindow);
            documents.set(this, frameWindow.document);
        }
        return documents.get(this);
    });
    document.body.replaceChildren();
    delete window.__arcifySpotlightReceiverV1;
    window.history.replaceState({}, '', 'https://example.com/');
    delete window.arcifySpotlightTabMode;
    delete window.arcifySpotlightInjected;
    delete window.arcifyCurrentTabUrl;
    delete window.arcifyCurrentTabId;
    backgroundListeners = [];
    contentListeners = [];
    externalListeners = [];
    activeTab = { ...tab };
    nextRequest = 0; logicalSnapshot = null;
    currentDocumentId = 'source-document';
    tabEvents = {};
    for (const name of ['onUpdated', 'onDetached', 'onReplaced', 'onActivated', 'onRemoved']) {
        tabEvents[name] = [];
        chromeMock.tabs[name] = {
            addListener: vi.fn(listener => tabEvents[name].push(listener)),
            removeListener: vi.fn(listener => { tabEvents[name] = tabEvents[name].filter(value => value !== listener); })
        };
    }
    let session = {};
    chromeMock.storage.session = { get: vi.fn(async () => structuredClone(session)), set: vi.fn(async value => { Object.assign(session, structuredClone(value)); }) };
    chromeMock.windows.get.mockImplementation(async id => ({ id, type: 'normal', incognito: false }));
    chromeMock.runtime.onMessage.addListener.mockImplementation(listener => registrationTarget.push(listener));
    chromeMock.runtime.onMessage.removeListener.mockImplementation(listener => {
        for (const listeners of [backgroundListeners, contentListeners]) {
            const index = listeners.indexOf(listener);
            if (index !== -1) listeners.splice(index, 1);
        }
    });
    chromeMock.runtime.onMessage.hasListener.mockImplementation(listener => [...backgroundListeners, ...contentListeners].includes(listener));
    chromeMock.runtime.onMessageExternal.addListener.mockImplementation(listener => externalListeners.push(listener));
    chromeMock.storage.local.get.mockImplementation(async key => key === 'arcifyBridgePeerId' ? { arcifyBridgePeerId: peerId } : {});
    chromeMock.storage.sync.get.mockResolvedValue({ enableSpotlight: true });
    chromeMock.tabs.get.mockImplementation(async () => ({ ...activeTab }));
    chromeMock.tabs.query.mockImplementation(async query => query.windowId && query.windowId !== 2 ? [] : [{ ...activeTab }]);
    chromeMock.tabs.sendMessage.mockImplementation((tabId, message, options) => {
        if (tabId !== tab.id) return Promise.resolve(undefined);
        if (!contentListeners.length || (options?.documentId && options.documentId !== currentDocumentId))
            return Promise.reject(missingReceiver());
        return dispatch(contentListeners, message, { id: chromeMock.runtime.id });
    });
    chromeMock.scripting = { executeScript: vi.fn(async () => {
        await reloadOverlayBundle();
        return [{ frameId: 0, documentId: currentDocumentId }];
    }) };
    chromeMock.runtime.sendMessage.mockImplementation((message, request, callback) => {
        if (message === peerId) {
            callback({
                type: 'arcify-bridge', version: 1, requestId: request.requestId,
                role: 'arcify', extensionId: peerId, ok: true,
                snapshot: logicalSnapshot?.(request.windowId) || { windowId: 2, activeSpaceId: null, capturedAt: Date.now(), spaces: [], tabs: [], bookmarks: [] }
            });
            return;
        }
        return dispatch(backgroundListeners, message, { ...sender, tab: activeTab, frameId: 0,
            documentId: currentDocumentId, documentLifecycle: 'active', url: window.location.href });
    });
    HTMLDialogElement.prototype.showModal = function () {
        if (!this.isConnected) throw new DOMException('Dialog is disconnected', 'InvalidStateError');
        this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function () {
        if (!this.open) return;
        this.removeAttribute('open');
        setTimeout(() => this.dispatchEvent(new Event('close')), 0);
    };
    HTMLElement.prototype.scrollIntoView = () => {};
    // Install page capture listeners before the content-script module is injected.
    // Shadow retargeting makes ordinary input filtering see the host div instead.
    hostKeyEvents = [];
    removeHostKeyListeners = [];
    for (const target of [window, document]) {
        for (const capture of [true, false]) {
            for (const type of ['keydown', 'keypress', 'keyup']) {
                const listener = event => {
                    hostKeyEvents.push({ key: event.key, type, capture });
                    if (event.key === 'w' && event.target.tagName !== 'INPUT') event.preventDefault();
                };
                target.addEventListener(type, listener, capture);
                removeHostKeyListeners.push(() => target.removeEventListener(type, listener, capture));
            }
        }
    }
    registrationTarget = backgroundListeners;
    await import('../../background.js');
    registrationTarget = contentListeners;
    await import('../../overlay.js');
    ({ SpotlightMessageClient: messageClient } = await import('../../shared/message-client.js'));
});

afterEach(async () => {
    window.__arcifyLittleArcHeader?.dispose(); window.__arcifyPeek?.dispose();
    await close();
    // Let real queued close events/removal timers settle before the next module instance.
    await pause(220);
    document.body.replaceChildren();
    delete HTMLDialogElement.prototype.showModal;
    delete HTMLDialogElement.prototype.close;
    delete HTMLElement.prototype.scrollIntoView;
    delete chromeMock.storage.session;
    delete chromeMock.scripting;
    frameWindows.forEach(frameWindow => frameWindow.close());
    removeHostKeyListeners.forEach(remove => remove());
    vi.restoreAllMocks();
});

describe('paired launch real overlay lifecycle (mock Chrome/native dialog boundary)', () => {
    it('keeps an already-open tracked overlay visible, focused, and intact after teardown time', async () => {
        expect(await launch()).toMatchObject({ ok: true });
        const original = host();
        input().value = 'keep my query';
        input().blur();
        expect(await launch()).toMatchObject({ ok: true });
        expect(host()).toBe(original);
        expect(input().value).toBe('keep my query');
        expect(input().selectionStart).toBe(0);
        expect(input().selectionEnd).toBe('keep my query'.length);
        await pause(220);
        expectOpen();
        expect(frameDocument().querySelector('.arcify-bridge-status')).not.toBeNull();
        expect(contentListeners).toHaveLength(5); // Little Arc refresh, Peek probe, activation, close, and live-result listeners.
        expect(await dispatch(contentListeners, { type: 'arcifyPeekLiveProbe' }, { id: chromeMock.runtime.id }))
            .toMatchObject({ live: false, safe: false, action: null });
        expect(messageClient.errorListeners.size).toBe(1);
        expect(chromeMock.tabs.sendMessage.mock.calls.filter(([, message]) => message.action === 'closeSpotlight')).toHaveLength(0);
    });

    it('replaces a closing overlay before 200 ms without reviving its disposed UI or removing its replacement', async () => {
        await launch();
        const oldHost = host();
        const oldDialog = dialog();
        await close();
        expect(oldDialog.open).toBe(false);
        expect(messageClient.errorListeners.size).toBe(0);
        expect(await launch()).toMatchObject({ ok: true });
        expect(host()).not.toBe(oldHost);
        expect(oldHost.isConnected).toBe(false);
        // A queued native close event belonging to the disposed dialog is harmless.
        oldDialog.dispatchEvent(new Event('close'));
        await pause(220);
        expectOpen();
        messageClient.reportError('Still connected to the live status UI');
        expect(frameDocument().querySelector('[role="status"]').textContent).toContain('Still connected');
        expect(contentListeners).toHaveLength(5); // Little Arc refresh, Peek probe, activation, close, and live-result listeners.
        expect(messageClient.errorListeners.size).toBe(1);
    });

    it('ensures an existing overlay stays open after a real background-module restart loses tracking', async () => {
        await launch();
        const original = host();
        await restartBackground();
        expect(await launch()).toMatchObject({ ok: true });
        await pause(220);
        expect(host()).toBe(original);
        expectOpen();
        // A later tab switch proves the new worker has rebuilt its open-tab tracking.
        const [onActivated] = chromeMock.tabs.onActivated.addListener.mock.lastCall;
        await onActivated({ tabId: 43, windowId: 2 });
        expect(dialog().open).toBe(false);
    });

    it('serializes concurrent and repeated paired launches into one visible overlay', async () => {
        const responses = await Promise.all(Array.from({ length: 6 }, () => launch()));
        expect(responses.every(response => response.ok)).toBe(true);
        const original = host();
        const replay = { requestId: 'same-launch' };
        expect((await launch(replay)).ok).toBe(true);
        expect((await launch(replay)).ok).toBe(true);
        await pause(220);
        expect(host()).toBe(original);
        expectOpen();
        expect(contentListeners).toHaveLength(5); // Little Arc refresh, Peek probe, activation, close, and live-result listeners.
        expect(messageClient.errorListeners.size).toBe(1);
    });

    it('serializes direct concurrent content activations while initial creation is waiting on settings', async () => {
        let release;
        const colorSettings = new Promise(resolve => { release = resolve; });
        chromeMock.storage.sync.get.mockReturnValueOnce(colorSettings);
        const responses = [activate({ ensureOpen: true }), activate({ ensureOpen: true })];
        await pause(0);
        expect(host()).toBeNull();
        release({});
        expect(await Promise.all(responses)).toEqual([{ success: true, open: true }, { success: true, open: true }]);
        await pause(220);
        expectOpen();
        expect(contentListeners).toHaveLength(5); // Little Arc refresh, Peek probe, activation, close, and live-result listeners.
    });

    it('does not acknowledge paired launch before asynchronous real dialog creation completes', async () => {
        let release;
        const colorSettings = new Promise(resolve => { release = resolve; });
        chromeMock.storage.sync.get.mockImplementation(key => Array.isArray(key) ? colorSettings : Promise.resolve({ enableSpotlight: true }));
        let acknowledged = false;
        const response = launch().then(value => { acknowledged = true; return value; });
        await pause(0);
        expect(acknowledged).toBe(false);
        expect(host()).toBeNull();
        release({});
        expect((await response).ok).toBe(true);
        expectOpen();
    });

    it('applies a new launch mode to real search and action closures and refocuses the input', async () => {
        const listenerSpy = vi.spyOn(EventTarget.prototype, 'addEventListener');
        await launch({ mode: 'current-tab' });
        expect(input().value).toBe(tab.url);
        expect(input().placeholder).toBe('Search or enter URL...');
        const oldHost = host();
        await launch({ mode: 'new-tab' });
        expect(oldHost.isConnected).toBe(false);
        expect(input().value).toBe('');
        expect(input().placeholder).toContain('opens in new tab');
        expectOpen();
        input().value = 'https://target.test';
        input().dispatchEvent(new Event('input'));
        await vi.waitFor(() => expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
            action: 'getLocalSuggestions', query: 'https://target.test', mode: 'new-tab'
        })));
        // JSDOM cannot manufacture trusted events. Exercise the actual registered handler.
        listenerSpy.mock.calls.forEach(([name, listener], i) => {
            if (name === 'keydown' && listenerSpy.mock.contexts[i] === input()) listener({ type: 'keydown', key: 'Enter', target: input(), isTrusted: true, preventDefault() {}, stopPropagation() {} });
        });
        await vi.waitFor(() => expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
            action: 'spotlightHandleResult', mode: 'new-tab'
        })));
    });

    it('preserves normal shortcut toggle-close and rapid reopen without stale teardown or leaked listeners', async () => {
        const [command] = chromeMock.commands.onCommand.addListener.mock.lastCall;
        await command('toggleSpotlightNewTab');
        expectOpen();
        await command('toggleSpotlightNewTab');
        expect(dialog().open).toBe(false);
        await command('toggleSpotlightNewTab');
        await pause(220);
        expectOpen();
        expect(contentListeners).toHaveLength(5); // Little Arc refresh, Peek probe, activation, close, and live-result listeners.
        expect(messageClient.errorListeners.size).toBe(1);
        await command('toggleSpotlightNewTab');
        await pause(220);
        expect(host()).toBeNull();
        expect(contentListeners).toHaveLength(3);
        expect(messageClient.errorListeners.size).toBe(0);
    });

    it('recovers a failed modal open with one helper and leaves no partial host or listeners', async () => {
        HTMLDialogElement.prototype.showModal = () => { throw new Error('Platform refused modal'); };
        expect((await launch()).ok).toBe(true);
        expect(host()).toBeNull();
        expect(contentListeners).toHaveLength(3);
        expect(messageClient.errorListeners.size).toBe(0);
        expect(chromeMock.tabs.create).toHaveBeenCalledExactlyOnceWith({
            url: chromeMock.runtime.getURL('newtab.html'), active: true, windowId: 2
        });
    });

    it('serializes restricted-page fallback launches and reuses the newly active helper', async () => {
        activeTab.url = 'chrome://settings';
        chromeMock.tabs.create.mockImplementation(async options => {
            activeTab = { ...tab, id: 50, url: options.url };
            return activeTab;
        });
        const responses = await Promise.all([launch(), launch(), launch()]);
        expect(responses.every(response => response.ok)).toBe(true);
        expect(chromeMock.tabs.create).toHaveBeenCalledTimes(1);
        expect(host()).toBeNull();
    });
});

describe('paired sidebar real overlay DOM wiring', () => {
    function enableSidebar() {
        const original = chromeMock.runtime.sendMessage.getMockImplementation();
        chromeMock.runtime.sendMessage.mockImplementation((target, request, callback) => {
            if (target === peerId && request.type === 'arcify-sidebar') {
                callback({ ...request, role: 'arcify', ok: true });
                return;
            }
            if (target === peerId && request.command === 'hello') {
                return original(target, request, response => callback({ ...response, capabilities: ['openSidebar'] }));
            }
            return original(target, request, callback);
        });
    }
    const sidebarCalls = () => chromeMock.runtime.sendMessage.mock.calls.filter(([target, request]) => target === peerId && request?.type === 'arcify-sidebar');
    const sidebarRow = () => frameDocument()?.querySelector('[data-result-type="arcify-sidebar-command"]');
    it('shows an ordinary unselected empty-query command and rejects synthetic click', async () => {
        enableSidebar(); await activate(); await vi.waitFor(() => expect(sidebarRow()).not.toBeNull());
        expect(sidebarRow().classList.contains('selected')).toBe(false);
        sidebarRow().click(); expect(sidebarCalls()).toHaveLength(0); expectOpen();
    });
    it('ranks a fuzzy sidebar action first and invokes trusted Enter on the original event stack', async () => {
        const listenerSpy = vi.spyOn(EventTarget.prototype, 'addEventListener');
        try {
            enableSidebar(); await activate(); await vi.waitFor(() => expect(sidebarRow()).not.toBeNull());
            input().value = 'opn arcfi'; input().dispatchEvent(new Event('input', { bubbles: true }));
            const rows = [...frameDocument().querySelectorAll('[data-result-type]')];
            expect(rows.map(row => row.dataset.resultType)).toEqual(['arcify-sidebar-command', 'search-query']);
            expect(rows[0].classList.contains('selected')).toBe(true);
            expect(decodeURIComponent(rows[0].querySelector('img').getAttribute('src'))).toContain('M9 4v16');
            listenerSpy.mock.calls.forEach(([name, listener], i) => {
                if (name === 'keydown' && listenerSpy.mock.contexts[i] === input()) listener({ type: 'keydown', key: 'Enter', isTrusted: true, preventDefault() {}, stopPropagation() {} });
            });
            expect(sidebarCalls()).toHaveLength(1);
            expectOpen();
        } finally { listenerSpy.mockRestore(); }
    });
    it('keeps a manually selected web search through asynchronous action refreshes', async () => {
        enableSidebar(); await activate(); await vi.waitFor(() => expect(sidebarRow()).not.toBeNull());
        input().value = 'open arcify'; input().dispatchEvent(new Event('input', { bubbles: true }));
        input().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        expect(frameDocument().querySelector('.selected').dataset.resultType).toBe('search-query');
        await pause(200);
        expect(frameDocument().querySelector('.selected').dataset.resultType).toBe('search-query');
        expect(input().value).toBe('open arcify');
        expect(sidebarCalls()).toHaveLength(0);
    });
    it('promotes matched workspace activation while preserving standalone and URL search', async () => {
        await activate();
        const workspace = { type: 'arcify-space', title: 'Pair Work', metadata: { matchScore: 0.8,
            arcifyBridge: { kind: 'space', peerId, windowId: 2, spaceId: 'work' } } };
        const search = vi.spyOn(messageClient, 'getLocalSuggestions').mockResolvedValue([workspace]);
        try {
            input().value = 'pair wrok'; input().dispatchEvent(new Event('input', { bubbles: true }));
            await vi.waitFor(() => expect(frameDocument().querySelector('.selected')?.dataset.resultType).toBe('arcify-space'));
            expect(frameDocument().querySelector('[data-result-type="search-query"]')).not.toBeNull();
            input().value = 'https://arcify.com'; input().dispatchEvent(new Event('input', { bubbles: true }));
            expect(frameDocument().querySelector('.selected').dataset.resultType).toBe('url-suggestion');
            expect(sidebarRow()).toBeNull();
            input().value = 'opn arcfi'; input().dispatchEvent(new Event('input', { bubbles: true }));
            expect(frameDocument().querySelector('.selected').dataset.resultType).toBe('search-query');
        } finally { search.mockRestore(); }
    });
    it('calls the dedicated peer path synchronously from the real delegated click handler and keeps overlay visible', async () => {
        const listenerSpy = vi.spyOn(EventTarget.prototype, 'addEventListener');
        try {
            enableSidebar(); await activate(); await vi.waitFor(() => expect(sidebarRow()).not.toBeNull());
            const row = sidebarRow(), results = row.parentElement;
            listenerSpy.mock.calls.forEach(([name, listener], i) => {
                if (name === 'click' && listenerSpy.mock.contexts[i] === results) listener({ type: 'click', button: 0, target: row, isTrusted: true });
            });
            expect(sidebarCalls()).toHaveLength(1);
            expect(sidebarCalls()[0][1]).toEqual({ type: 'arcify-sidebar', version: 1, requestId: expect.any(String) });
            expect(chromeMock.runtime.sendMessage.mock.calls.some(([message]) => message?.action === 'spotlightHandleResult')).toBe(false);
            expect(frameDocument().querySelector('[role="status"]').textContent).toBe('Arcify sidebar opened.');
            expectOpen();
        } finally { listenerSpy.mockRestore(); }
    });
});


describe('paired logical invalidation through the real overlay transport', () => {
    const invalidate = windowId => dispatch(externalListeners, { type: 'arcify-bridge', version: 1,
        requestId: `logical-${++nextRequest}`, command: 'invalidate', windowId }, { id: peerId });
    const row = () => frameDocument()?.querySelector('[data-result-type="open-tab"]');
    let spaceName;
    beforeEach(() => {
        spaceName = 'Home';
        logicalSnapshot = windowId => ({ windowId, activeSpaceId: 'home', capturedAt: Date.now(),
            spaces: [{ id: 'home', name: spaceName, color: 'red', tabIds: [tab.id], pinnedTabIds: [], temporaryTabIds: [tab.id] }],
            tabs: [{ ...activeTab, windowId, pinned: false, spaceId: 'home' }], bookmarks: [] });
    });
    it('refreshes a logical-only space change after worker restart while preserving selection and raw query', async () => {
        await activate(); await vi.waitFor(() => expect(row()?.textContent).toContain('Home'));
        input().value = 'Exam'; input().dispatchEvent(new Event('input', { bubbles: true }));
        await vi.waitFor(() => expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ action: 'getLocalSuggestions', query: 'Exam' })));
        await pause(20); input().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        expect(row().classList.contains('selected')).toBe(true); expect(input().value).toBe(tab.url);
        const original = host(); await restartBackground();
        spaceName = 'Work renamed'; expect(await invalidate(2)).toMatchObject({ ok: true });
        await vi.waitFor(() => expect(row().textContent).toContain('Work renamed'));
        expect(host()).toBe(original); expect(row().classList.contains('selected')).toBe(true); expect(input().value).toBe(tab.url);
        expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(42, { action: 'spotlightArcifyResultsChanged', windowId: 2, peerId });
        expect(chromeMock.runtime.sendMessage.mock.calls.filter(([m]) => m?.action === 'getLocalSuggestions').every(([m]) => m.query === 'Exam')).toBe(true);
        expect(chromeMock.storage.session.set.mock.calls.every(([value]) => Object.keys(value).every(key => key === 'spotlightVisibleOverlayTabIds'))).toBe(true);
        expect(chromeMock.tabs.group).not.toHaveBeenCalled(); expect(chromeMock.tabs.update).not.toHaveBeenCalled();
    });
    it('re-resolves an overlay that moved windows and ignores queued invalidations from its old window', async () => {
        await activate(); await vi.waitFor(() => expect(row()?.textContent).toContain('Home'));
        chromeMock.tabs.query.mockImplementation(async query => !query.windowId || query.windowId === activeTab.windowId ? [{ ...activeTab }] : []);
        activeTab.windowId = 3; spaceName = 'New window';
        await invalidate(2); await pause(130); expect(row().textContent).toContain('Home');
        await invalidate(3); await vi.waitFor(() => expect(row().textContent).toContain('New window'));
        expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(42, { action: 'spotlightArcifyResultsChanged', windowId: 3, peerId });
        expectOpen();
    });
});


describe('overlay keyboard document isolation', () => {
    const key = (target, type, value, extra = {}) => {
        const event = new KeyboardEvent(type, { key: value, bubbles: true, composed: true, cancelable: true, ...extra });
        target.dispatchEvent(event);
        return event;
    };
    it('demonstrates why a shadow-root bubble stop cannot beat an earlier host capture handler', () => {
        const shadowHost = document.createElement('div');
        document.body.append(shadowHost);
        const shadow = shadowHost.attachShadow({ mode: 'open' });
        const oldInput = document.createElement('input');
        shadow.append(oldInput);
        shadow.addEventListener('keydown', event => event.stopPropagation());
        expect(key(oldInput, 'keydown', 'w').defaultPrevented).toBe(true);
        expect(hostKeyEvents.filter(event => event.capture)).toHaveLength(2);
    });
    it('keeps w, keypress and keyup out of earlier host capture and bubble handlers across reopen', async () => {
        for (let i = 0; i < 3; i++) {
            await activate();
            for (const type of ['keydown', 'keypress', 'keyup']) {
                expect(key(input(), type, 'w').defaultPrevented).toBe(false);
            }
            expect(hostKeyEvents).toEqual([]);
            // JSDOM has no native text editing; real trusted typing is covered in CI.
            input().value = 'window';
            input().dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            expect(input().value).toBe('window');
            expect(frameDocument().querySelector('[data-result-type="search-query"]')).not.toBeNull();
            const oldDocument = frameDocument();
            const oldInput = input();
            expect(key(input(), 'keydown', 'Escape').defaultPrevented).toBe(true);
            expect(dialog().open).toBe(false);
            await activate();
            // A closed document must no longer have a document-level Escape hook.
            key(oldDocument.body, 'keydown', 'Escape');
            expectOpen();
            expect(oldInput.isConnected).toBe(true); // Separate mocked native document remains until teardown.
            await close();
        }
        await pause(220);
        expect(host()).toBeNull();
        const pageButton = document.createElement('button');
        document.body.append(pageButton);
        expect(key(pageButton, 'keydown', 'w').defaultPrevented).toBe(true);
        expect(hostKeyEvents).toHaveLength(4); // Host shortcuts resume normally.
    });
    it('leaves native modifier editing/browser keys and IME keys uncanceled without invoking actions', async () => {
        await activate();
        input().value = 'window';
        input().dispatchEvent(new Event('input', { bubbles: true }));
        chromeMock.runtime.sendMessage.mockClear();
        for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
            for (const value of ['a', 'c', 'v', 'x', 'z', 'w', 'ArrowLeft', 'Home', 'Enter', 'Escape']) {
                expect(key(input(), 'keydown', value, modifiers).defaultPrevented).toBe(false);
            }
        }
        for (const value of ['ArrowUp', 'ArrowDown', 'Home', 'End']) {
            expect(key(input(), 'keydown', value, { shiftKey: true }).defaultPrevented).toBe(false);
        }
        for (const extra of [{ isComposing: true }, { keyCode: 229 }]) {
            for (const value of ['Enter', 'Escape', 'ArrowDown', 'ArrowUp']) {
                expect(key(input(), 'keydown', value, extra).defaultPrevented).toBe(false);
            }
        }
        expect(hostKeyEvents).toEqual([]);
        expect(chromeMock.runtime.sendMessage.mock.calls.some(([message]) => message?.action === 'spotlightHandleResult')).toBe(false);
        expectOpen();
    });
    it('closes Escape from a focused settings button and cleans up on failed frame creation', async () => {
        await activate();
        const settings = frameDocument().querySelector('.arcify-bridge-status button');
        settings.focus();
        expect(key(settings, 'keydown', 'Escape').defaultPrevented).toBe(true);
        expect(dialog().open).toBe(false);
        await pause(220);
        vi.spyOn(HTMLIFrameElement.prototype, 'contentDocument', 'get').mockReturnValue(null);
        expect(await activate()).toMatchObject({ success: false });
        expect(host()).toBeNull();
        expect(contentListeners).toHaveLength(3);
        expect(messageClient.errorListeners.size).toBe(0);
    });
});

describe('keyboard-command stale receiver recovery through actual background and overlay modules', () => {
    it('recovers after extension reload once, dormant until exact-document ensure-open, despite legacy globals', async () => {
        invalidateReceiver();
        window.arcifySpotlightTabMode = 'current-tab';
        window.arcifySpotlightInjected = true;
        const inject = chromeMock.scripting.executeScript.getMockImplementation();
        chromeMock.scripting.executeScript.mockImplementation(async options => {
            const result = await inject(options);
            expect(host()).toBeNull(); // Loading the bundle itself never opens.
            return result;
        });
        await shortcut();
        expectOpen();
        expect(chromeMock.scripting.executeScript).toHaveBeenCalledExactlyOnceWith({
            target: { tabId: 42, frameIds: [0] }, world: 'ISOLATED', files: ['overlay.js'], injectImmediately: true
        });
        const opens = chromeMock.tabs.sendMessage.mock.calls.filter(([, message]) => message.action === 'activateSpotlight');
        expect(opens).toHaveLength(2);
        expect(opens[0]).toEqual([42, expect.objectContaining({ ensureOpen: false, expectedUrl: tab.url }), { frameId: 0 }]);
        expect(opens[1]).toEqual([42, expect.objectContaining({ ensureOpen: true, recovery: true,
            tabId: 42, tabUrl: tab.url, expectedUrl: tab.url, mode: 'new-tab' }), { documentId: 'source-document' }]);
        expect(contentListeners).toHaveLength(5);
    });

    it('replaces a marked invalidated surface only after opening and preserves its input draft/range', async () => {
        await activate();
        input().value = 'unfinished query';
        input().setSelectionRange(3, 8, 'backward');
        const oldHost = host();
        invalidateReceiver();
        await shortcut();
        expectOpen();
        expect(host()).not.toBe(oldHost);
        expect(oldHost.isConnected).toBe(false);
        expect(input().value).toBe('unfinished query');
        expect([input().selectionStart, input().selectionEnd, input().selectionDirection]).toEqual([3, 8, 'backward']);
        await pause(220);
        expectOpen();
        expect(input().value).toBe('unfinished query');
        expect(contentListeners).toHaveLength(5);
        expect(messageClient.errorListeners.size).toBe(1);
    });

    it.each(['switch', 'detach'])('cancels recovery when source %s occurs during awaited renderer initialization', async change => {
        invalidateReceiver();
        let release; const styles = new Promise(resolve => { release = resolve; });
        chromeMock.storage.sync.get.mockImplementation(key => Array.isArray(key) ? styles : Promise.resolve({ enableSpotlight: true }));
        const recovery = shortcut(); await pause(0);
        if (change === 'switch') { activeTab.id = 77; emitTab('onActivated', { tabId: 77, windowId: 2 }); }
        else emitTab('onDetached', 42, { oldWindowId: 2 });
        release({}); await recovery;
        expect(host()).toBeNull(); expect(chromeMock.tabs.create).not.toHaveBeenCalled();
        expect(chromeMock.scripting.executeScript).toHaveBeenCalledOnce();
    });

    it('cancels an outstanding recovery capability after a worker restart and allows a fresh deliberate command', async () => {
        invalidateReceiver();
        let release; const styles = new Promise(resolve => { release = resolve; });
        chromeMock.storage.sync.get.mockImplementation(key => Array.isArray(key) ? styles : Promise.resolve({ enableSpotlight: true }));
        const recovery = shortcut(); await pause(0);
        await restartBackground(); release({}); await recovery;
        expect(host()).toBeNull(); expect(chromeMock.tabs.create).not.toHaveBeenCalled();
        chromeMock.storage.sync.get.mockResolvedValue({ enableSpotlight: true });
        await shortcut(); expectOpen(); expect(chromeMock.scripting.executeScript).toHaveBeenCalledOnce();
    });

    it('captures the latest stranded draft after awaited styles, including edits while recovery is pending', async () => {
        await activate(); input().value = 'before recovery';
        const oldHost = host(); invalidateReceiver();
        let release; const styles = new Promise(resolve => { release = resolve; });
        chromeMock.storage.sync.get.mockImplementation(key => Array.isArray(key) ? styles : Promise.resolve({ enableSpotlight: true }));
        const recovery = shortcut(); await pause(0);
        expect(host()).toBe(oldHost);
        input().value = 'edited while recovery waited'; input().setSelectionRange(7, 12, 'forward');
        release({}); await recovery;
        expectOpen(); expect(input().value).toBe('edited while recovery waited');
        expect([input().selectionStart, input().selectionEnd, input().selectionDirection]).toEqual([7, 12, 'forward']);
    });

    it('recovers a marked orphan across isolated-world replacement without a surviving registry', async () => {
        await activate(); input().value = 'keep across worlds';
        const oldHost = host();
        invalidateReceiver(); delete window.__arcifySpotlightReceiverV1;
        await shortcut();
        expectOpen(); expect(input().value).toBe('keep across worlds'); expect(oldHost.isConnected).toBe(false);
    });

    it('leaves legacy/unmarked drafts intact rather than guessing ownership during the first upgrade', async () => {
        await activate(); input().value = 'legacy draft';
        const original = host();
        original.removeAttribute('data-arcify-spotlight-owner');
        invalidateReceiver();
        await shortcut();
        expect(host()).toBe(original); expect(input().value).toBe('legacy draft');
        expect(document.querySelectorAll('#arcify-spotlight-host')).toHaveLength(1);
        expect(chromeMock.tabs.create).toHaveBeenCalledOnce();
    });

    it('retains an invalidated draft if replacement modal creation fails', async () => {
        await activate(); input().value = 'still recoverable';
        const original = host(); invalidateReceiver();
        HTMLDialogElement.prototype.showModal = () => { throw new Error('Modal unavailable'); };
        await shortcut();
        expect(host()).toBe(original); expect(input().value).toBe('still recoverable');
        expect(document.querySelectorAll('#arcify-spotlight-host')).toHaveLength(1);
        expect(chromeMock.tabs.create).toHaveBeenCalledOnce();
    });

    it('reuses a live receiver during duplicate bundle evaluation without extra listeners, modal or draft reset', async () => {
        await activate(); input().value = 'live draft';
        const original = host();
        await reloadOverlayBundle(); await reloadOverlayBundle();
        expect(host()).toBe(original); expect(input().value).toBe('live draft'); expect(contentListeners).toHaveLength(5);
        await activate({ ensureOpen: true });
        expectOpen(); expect(input().value).toBe('live draft');
    });

    it('serializes concurrent commands: one repair, then ordinary toggle semantics', async () => {
        invalidateReceiver();
        await Promise.all([shortcut(), shortcut()]);
        expect(chromeMock.scripting.executeScript).toHaveBeenCalledOnce();
        expect(chromeMock.tabs.create).not.toHaveBeenCalled();
        await pause(220);
        expect(host()).toBeNull(); expect(contentListeners).toHaveLength(3);
    });

    it.each(['The message port closed before a response was received.', 'Overlay delivery timed out.', 'Unexpected transport failure'])
    ('never reinjects or creates/closes a helper after uncertain delivery: %s', async error => {
        const send = chromeMock.tabs.sendMessage.getMockImplementation();
        chromeMock.tabs.sendMessage.mockImplementation(async (...args) => {
            if (args[1].action === 'activateSpotlight') {
                await send(...args); input().value = 'delivery succeeded; response lost';
                throw new Error(error);
            }
            return send(...args);
        });
        await shortcut();
        expectOpen(); expect(input().value).toBe('delivery succeeded; response lost');
        expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
        expect(chromeMock.tabs.sendMessage.mock.calls.filter(([, message]) => message.action === 'closeSpotlight')).toHaveLength(0);
    });

    it('does not interpret a lost/undefined acknowledgement as proof that the overlay failed', async () => {
        const send = chromeMock.tabs.sendMessage.getMockImplementation();
        chromeMock.tabs.sendMessage.mockImplementation(async (...args) => { await send(...args); return undefined; });
        await shortcut(); expectOpen(); expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
    });

    it.each(['before injection', 'after injection'])('abandons same-URL reload %s without reopening or fallback', async phase => {
        invalidateReceiver();
        const navigate = () => { currentDocumentId = 'new-document'; emitTab('onUpdated', 42, { status: 'loading' }); };
        if (phase === 'before injection') chromeMock.tabs.sendMessage.mockImplementation(async () => { navigate(); throw missingReceiver(); });
        else {
            const inject = chromeMock.scripting.executeScript.getMockImplementation();
            chromeMock.scripting.executeScript.mockImplementation(async options => { const result = await inject(options); navigate(); return result; });
        }
        await shortcut();
        expect(chromeMock.scripting.executeScript).toHaveBeenCalledTimes(phase === 'before injection' ? 0 : 1);
        expect(host()).toBeNull(); expect(chromeMock.tabs.create).not.toHaveBeenCalled();
    });

    it('targets the returned document, never a later same-URL document even before its navigation event arrives', async () => {
        invalidateReceiver();
        const send = chromeMock.tabs.sendMessage.getMockImplementation();
        chromeMock.tabs.sendMessage.mockImplementation(async (...args) => {
            if (args[2]?.documentId) currentDocumentId = 'replacement-document';
            return send(...args);
        });
        await shortcut();
        expect(chromeMock.scripting.executeScript).toHaveBeenCalledOnce();
        expect(host()).toBeNull(); expect(chromeMock.tabs.create).not.toHaveBeenCalled();
        expect(chromeMock.tabs.sendMessage.mock.calls.filter(([, message]) => message.recovery)).toHaveLength(1);
    });

    it('checks the receiver URL again after asynchronous creation work without clearing a stranded draft', async () => {
        invalidateReceiver();
        const send = chromeMock.tabs.sendMessage.getMockImplementation();
        chromeMock.tabs.sendMessage.mockImplementation(async (...args) => {
            if (args[1].recovery) window.history.replaceState({}, '', '/new-document');
            return send(...args);
        });
        await shortcut(); expect(host()).toBeNull(); expect(chromeMock.tabs.create).not.toHaveBeenCalled();
    });

    it.each(['switch', 'detach', 'replace', 'remove', 'move', 'url', 'pending'])
    ('abandons changed source context (%s) after missing receiver', async change => {
        invalidateReceiver();
        chromeMock.tabs.sendMessage.mockImplementation(async () => {
            if (change === 'switch') { activeTab.id = 77; emitTab('onActivated', { tabId: 77, windowId: 2 }); }
            if (change === 'detach') emitTab('onDetached', 42, { oldWindowId: 2 });
            if (change === 'replace') emitTab('onReplaced', 77, 42);
            if (change === 'remove') emitTab('onRemoved', 42, {});
            if (change === 'move') activeTab.windowId = 3;
            if (change === 'url') activeTab.url = 'https://example.com/other';
            if (change === 'pending') activeTab.pendingUrl = 'https://example.com/other';
            throw missingReceiver();
        });
        await shortcut();
        expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
        expect(chromeMock.tabs.create).not.toHaveBeenCalled(); expect(host()).toBeNull();
    });

    it.each(['chrome://settings/', 'chrome-extension://other/page', 'file:///test.html', 'data:text/html,hi',
        'blob:https://example.com/id', 'https://chromewebstore.google.com/detail/test', 'https://chrome.google.com/webstore/detail/test'])
    ('uses the helper without injection on forbidden source %s', async url => {
        invalidateReceiver(); activeTab.url = url;
        await shortcut();
        expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
        expect(chromeMock.tabs.create).toHaveBeenCalledExactlyOnceWith({ url: chromeMock.runtime.getURL('newtab.html'), active: true, windowId: 2 });
    });

    it('keeps the browser-attested command tab/window rather than following a newly focused window', async () => {
        invalidateReceiver();
        chromeMock.tabs.query.mockImplementation(async query => query.currentWindow
            ? [{ id: 99, windowId: 9, active: true, url: 'https://other.test/' }]
            : [{ ...activeTab }]);
        await shortcut(); expectOpen();
        expect(chromeMock.scripting.executeScript.mock.calls[0][0].target.tabId).toBe(42);
    });

    it('falls back once after an injection denial, without repeating commands against the old source', async () => {
        invalidateReceiver();
        chromeMock.scripting.executeScript.mockRejectedValue(new Error('Cannot access this page.'));
        chromeMock.tabs.create.mockImplementation(async options => {
            activeTab = { ...tab, id: 50, url: options.url }; return activeTab;
        });
        await Promise.all([shortcut(), shortcut()]);
        expect(chromeMock.scripting.executeScript).toHaveBeenCalledOnce();
        expect(chromeMock.tabs.create).toHaveBeenCalledOnce();
    });

    it.each(['paired launch', 'internal message'])('does not borrow activeTab authorization from %s', async source => {
        invalidateReceiver();
        if (source === 'paired launch') expect(await launch()).toMatchObject({ ok: true });
        else expect(await dispatch(backgroundListeners, { command: 'toggleSpotlightNewTab' }, sender)).toEqual({ success: true });
        expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
        expect(chromeMock.tabs.create).toHaveBeenCalledOnce();
    });

    it('recovers standalone Spotlight without requiring an Arcify peer', async () => {
        chromeMock.storage.local.get.mockResolvedValue({});
        await restartBackground(); invalidateReceiver();
        await shortcut(); expectOpen();
        input().value = 'standalone'; input().dispatchEvent(new Event('input', { bubbles: true }));
        expect(frameDocument().querySelector('[data-result-type="search-query"]')).not.toBeNull();
        expect(frameDocument().querySelector('[data-result-type="arcify-sidebar-command"]')).toBeNull();
    });
});
