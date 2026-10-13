// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromeMock } from '../mocks/chrome.js';
import { JSDOM } from 'jsdom';
import './setup.js';

// Runs the real background, overlay, message client, bridge status, and search modules.
// Only Chrome transport/storage and native dialog/iframe platform boundaries are mocked.
// JSDOM does not implement dialogs: close queues its event as Chrome does, while all
// overlay construction, cleanup, focus, and the 200 ms teardown use real DOM/timers.
const peerId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const tab = { id: 42, windowId: 2, url: 'https://example.com', active: true, title: 'Example' };
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
    delete window.arcifySpotlightTabMode;
    delete window.arcifySpotlightInjected;
    delete window.arcifyCurrentTabUrl;
    delete window.arcifyCurrentTabId;
    backgroundListeners = [];
    contentListeners = [];
    externalListeners = [];
    activeTab = { ...tab };
    nextRequest = 0; logicalSnapshot = null;
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
    chromeMock.runtime.onMessageExternal.addListener.mockImplementation(listener => externalListeners.push(listener));
    chromeMock.storage.local.get.mockImplementation(async key => key === 'arcifyBridgePeerId' ? { arcifyBridgePeerId: peerId } : {});
    chromeMock.storage.sync.get.mockResolvedValue({ enableSpotlight: true });
    chromeMock.tabs.get.mockImplementation(async () => ({ ...activeTab }));
    chromeMock.tabs.query.mockImplementation(async query => query.windowId && query.windowId !== 2 ? [] : [{ ...activeTab }]);
    chromeMock.tabs.sendMessage.mockImplementation((tabId, message) => tabId === tab.id
        ? dispatch(contentListeners, message, { id: chromeMock.runtime.id }) : Promise.resolve(undefined));
    chromeMock.runtime.sendMessage.mockImplementation((message, request, callback) => {
        if (message === peerId) {
            callback({
                type: 'arcify-bridge', version: 1, requestId: request.requestId,
                role: 'arcify', extensionId: peerId, ok: true,
                snapshot: logicalSnapshot?.(request.windowId) || { windowId: 2, activeSpaceId: null, capturedAt: Date.now(), spaces: [], tabs: [], bookmarks: [] }
            });
            return;
        }
        return dispatch(backgroundListeners, message, { ...sender, tab: activeTab });
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
    await close();
    // Let real queued close events/removal timers settle before the next module instance.
    await pause(220);
    document.body.replaceChildren();
    delete HTMLDialogElement.prototype.showModal;
    delete HTMLDialogElement.prototype.close;
    delete HTMLElement.prototype.scrollIntoView;
    delete chromeMock.storage.session;
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
        expect(contentListeners).toHaveLength(3); // Activation, close, and live-result listeners.
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
        expect(contentListeners).toHaveLength(3); // Activation, close, and live-result listeners.
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
        expect(contentListeners).toHaveLength(3); // Activation, close, and live-result listeners.
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
        expect(contentListeners).toHaveLength(3); // Activation, close, and live-result listeners.
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
        input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
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
        expect(contentListeners).toHaveLength(3); // Activation, close, and live-result listeners.
        expect(messageClient.errorListeners.size).toBe(1);
        await command('toggleSpotlightNewTab');
        await pause(220);
        expect(host()).toBeNull();
        expect(contentListeners).toHaveLength(1);
        expect(messageClient.errorListeners.size).toBe(0);
    });

    it('recovers a failed modal open with one helper and leaves no partial host or listeners', async () => {
        HTMLDialogElement.prototype.showModal = () => { throw new Error('Platform refused modal'); };
        expect((await launch()).ok).toBe(true);
        expect(host()).toBeNull();
        expect(contentListeners).toHaveLength(1);
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
        expect(contentListeners).toHaveLength(1);
        expect(messageClient.errorListeners.size).toBe(0);
    });
});
