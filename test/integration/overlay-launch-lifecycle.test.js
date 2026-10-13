// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromeMock } from '../mocks/chrome.js';
import './setup.js';

// Runs the real background, overlay, message client, bridge status, and search modules.
// Only Chrome transport/storage and the native dialog platform boundary are mocked.
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
const input = () => dialog()?.querySelector('input');

function expectOpen() {
    expect(document.querySelectorAll('#arcify-spotlight-host')).toHaveLength(1);
    expect(dialog()?.open).toBe(true);
    expect(host().shadowRoot.activeElement).toBe(input());
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
    document.body.replaceChildren();
    delete window.arcifySpotlightTabMode;
    delete window.arcifySpotlightInjected;
    delete window.arcifyCurrentTabUrl;
    delete window.arcifyCurrentTabId;
    backgroundListeners = [];
    contentListeners = [];
    externalListeners = [];
    activeTab = { ...tab };
    nextRequest = 0;
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
    chromeMock.tabs.query.mockImplementation(async query => query.windowId && query.windowId !== 2 ? [] : [{ ...activeTab }]);
    chromeMock.tabs.sendMessage.mockImplementation((tabId, message) => tabId === tab.id
        ? dispatch(contentListeners, message, { id: chromeMock.runtime.id }) : Promise.resolve(undefined));
    chromeMock.runtime.sendMessage.mockImplementation((message, request, callback) => {
        if (message === peerId) {
            callback({
                type: 'arcify-bridge', version: 1, requestId: request.requestId,
                role: 'arcify', extensionId: peerId, ok: true,
                snapshot: { windowId: 2, activeSpaceId: null, capturedAt: Date.now(), spaces: [], tabs: [], bookmarks: [] }
            });
            return;
        }
        return dispatch(backgroundListeners, message, sender);
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
        expect(dialog().querySelector('.arcify-bridge-status')).not.toBeNull();
        expect(contentListeners).toHaveLength(2);
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
        expect(dialog().querySelector('[role="status"]').textContent).toContain('Still connected');
        expect(contentListeners).toHaveLength(2);
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
        expect(contentListeners).toHaveLength(2);
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
        expect(contentListeners).toHaveLength(2);
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
        expect(contentListeners).toHaveLength(2);
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
    const sidebarRow = () => dialog()?.querySelector('[data-result-type="arcify-sidebar-command"]');
    it('shows an ordinary unselected empty-query command and rejects synthetic click', async () => {
        enableSidebar(); await activate(); await vi.waitFor(() => expect(sidebarRow()).not.toBeNull());
        expect(sidebarRow().classList.contains('selected')).toBe(false);
        sidebarRow().click(); expect(sidebarCalls()).toHaveLength(0); expectOpen();
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
            expect(dialog().querySelector('[role="status"]').textContent).toBe('Arcify sidebar opened.');
            expectOpen();
        } finally { listenerSpy.mockRestore(); }
    });
});
