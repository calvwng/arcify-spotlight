import { it, expect, beforeEach, vi } from 'vitest';
import { chromeMock } from '../mocks/chrome.js';
import './setup.js';
import { shouldCloseNewTab } from '../../shared/bridge-navigation-ui.js';

const PEER = 'a'.repeat(32), SELF = 'b'.repeat(32);
const event = () => { const listeners = new Set(); return { addListener: vi.fn(f => listeners.add(f)), removeListener: vi.fn(f => listeners.delete(f)), fire(...args) { for (const f of listeners) f(...args); } }; };
let tab, sender, requests, holdHello, releaseHello, afterDispatch, capabilities, sourceReplies;
const snapshot = () => ({ windowId: 2, activeSpaceId: 'work', capturedAt: 1,
    spaces: [{ id: 'work', name: 'Work', color: 'blue', tabIds: [42, 50], pinnedTabIds: [], temporaryTabIds: [42, 50] }],
    tabs: [{ ...tab, windowId: 2, spaceId: 'work', title: 'Helper' },
        { id: 50, windowId: 2, spaceId: 'work', title: 'Target', url: 'https://target.test/', active: false, pinned: false }], bookmarks: [] });
const select = (result = { type: 'url-suggestion', url: 'https://target.test/' }) => new Promise(resolve => chromeMock.runtime.onMessage.callListeners({ action: 'spotlightHandleResult',
    result, mode: 'current-tab' }, sender, resolve));
beforeEach(async () => {
    requests = []; holdHello = false; releaseHello = null; afterDispatch = null; capabilities = ['helperSourceV1']; sourceReplies = [];
    chromeMock.runtime.getURL.mockImplementation(path => `chrome-extension://${SELF}/${path}`);
    tab = { id: 42, windowId: 2, url: chromeMock.runtime.getURL('newtab.html'), active: true, pinned: false, incognito: false, status: 'complete' };
    sender = { id: SELF, tab: structuredClone(tab), url: tab.url, frameId: 0, documentLifecycle: 'active' };
    for (const name of ['onUpdated', 'onRemoved', 'onDetached', 'onReplaced', 'onActivated']) chromeMock.tabs[name] = event();
    chromeMock.windows.onRemoved = event(); chromeMock.storage.onChanged = event();
    chromeMock.tabs.remove = vi.fn(async () => {});
    chromeMock.storage.session = { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) };
    chromeMock.storage.local.get.mockImplementation(async () => ({ arcifyBridgePeerId: PEER }));
    chromeMock.tabs.get.mockImplementation(async () => structuredClone(tab));
    chromeMock.windows.get.mockResolvedValue({ id: 2, type: 'normal', focused: true, incognito: false });
    chromeMock.runtime.sendMessage.mockImplementation((_id, request, callback) => {
        if (_id !== PEER) return;
        requests.push(request);
        const respond = () => callback({ type: 'arcify-bridge', version: 1, role: 'arcify', requestId: request.requestId,
            ok: true, extensionId: PEER, snapshot: snapshot(), capabilities, tabId: 50 });
        if (request.command === 'hello' && holdHello) { releaseHello = respond; return; }
        if (['openTab', 'activateTab'].includes(request.command)) {
            chromeMock.runtime.onMessageExternal.callListeners({ type: 'arcify-helper-source', ...request.helperSource, windowId: 2 }, { id: PEER }, reply => {
                sourceReplies.push(reply); afterDispatch?.(); respond();
            });
        } else respond();
    });
    await import('../../background.js');
});
it.each([`chrome-extension://${SELF}/newtab.html`, 'chrome://newtab', 'chrome://newtab/'])('keeps generic helper opening from native %s in selected Space and validates dismissal', async nativeUrl => {
    tab.url = nativeUrl; sender.tab.url = nativeUrl;
    const response = await select();
    expect(response).toMatchObject({ success: true, command: 'openTab', helperDismissalHandled: true });
    expect(requests.find(r => r.command === 'openTab')).toMatchObject({ windowId: 2, helperSource: { tabId: 42, url: sender.url, nativeUrl } });
    expect(sourceReplies).toEqual([{ live: true }]);
    expect(chromeMock.tabs.remove).toHaveBeenCalledExactlyOnceWith(42);
    expect(shouldCloseNewTab({}, response)).toBe(false);
});
it.each(['chrome://newtab', 'chrome://newtab/'])('activates an existing tab then dismisses its now-inactive native helper %s', async nativeUrl => {
    tab.url = nativeUrl; sender.tab.url = nativeUrl;
    afterDispatch = () => { tab.active = false; chromeMock.tabs.onActivated.fire({ tabId: 50, windowId: 2 }); };
    const response = await select({ type: 'open-tab', metadata: { tabId: 50 } });
    expect(response).toMatchObject({ success: true, command: 'activateTab', tabId: 50, helperDismissalHandled: true });
    expect(sourceReplies).toEqual([{ live: true }]);
    expect(chromeMock.tabs.remove).toHaveBeenCalledExactlyOnceWith(42);
});
it.each(['move', 'move-back', 'same-url-navigation'])('rejects helper %s during hello before mutation or dismissal', async kind => {
    holdHello = true;
    const pending = select(); await vi.waitFor(() => expect(releaseHello).toBeTypeOf('function'));
    if (kind === 'same-url-navigation') chromeMock.tabs.onUpdated.fire(42, { status: 'loading' });
    else { tab.windowId = 3; chromeMock.tabs.onDetached.fire(42, { oldWindowId: 2 }); if (kind === 'move-back') tab.windowId = 2; }
    releaseHello();
    expect(await pending).toMatchObject({ success: false, errorCode: 'STALE_HELPER_SOURCE' });
    expect(requests.every(r => r.command === 'hello')).toBe(true); expect(chromeMock.tabs.remove).not.toHaveBeenCalled();
});
it('captures the source before waiting in the action queue', async () => {
    holdHello = true;
    const first = select(); await vi.waitFor(() => expect(releaseHello).toBeTypeOf('function'));
    const second = select();
    tab.windowId = 3; chromeMock.tabs.onDetached.fire(42, { oldWindowId: 2 });
    holdHello = false; releaseHello();
    expect(await first).toMatchObject({ success: false, errorCode: 'STALE_HELPER_SOURCE' });
    expect(await second).toMatchObject({ success: false });
    expect(requests.every(r => r.command === 'hello')).toBe(true); expect(chromeMock.tabs.remove).not.toHaveBeenCalled();
});
it('does not dismiss a helper moved after dispatch while awaiting its receipt', async () => {
    afterDispatch = () => { tab.windowId = 3; chromeMock.tabs.onDetached.fire(42, { oldWindowId: 2 }); };
    expect(await select()).toMatchObject({ success: false, errorCode: 'STALE_HELPER_SOURCE' });
    expect(requests.filter(r => r.command === 'openTab')).toHaveLength(1); expect(chromeMock.tabs.remove).not.toHaveBeenCalled();
});
it('fails closed on an old peer without replaying or native fallback', async () => {
    capabilities = [];
    expect(await select()).toMatchObject({ success: false, errorCode: 'UNSUPPORTED' });
    expect(requests.every(r => r.command === 'hello')).toBe(true);
    expect(chromeMock.tabs.remove).not.toHaveBeenCalled(); expect(chromeMock.tabs.create).not.toHaveBeenCalled();
});
