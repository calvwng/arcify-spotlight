// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromeMock as api } from '../mocks/chrome.js';
import { createActiveNewTabReuse, mountActiveNewTabReuse, NEW_TAB_REUSE_PROBE, NEW_TAB_REUSE_ACK } from '../../shared/active-newtab-reuse.js';
import { installArcifySpaceActionMessages } from '../../shared/arcify-space-actions.js';
import './setup.js';
const PEER = 'a'.repeat(32);
let workers, renderers, target, reuse, renderer, uninstall, tab, ackTransform, onProbe, probes, external;
const helperSender = () => ({ id: api.runtime.id, url: api.runtime.getURL('newtab.html'), frameId: 0, documentLifecycle: 'active' });
const context = () => ({ windowId: 2, spaceId: 'space', bookmarkFolderId: 'root', pairingGeneration: 'peer', sourceTabId: 9, tab: null });
const snapshot = () => ({ windowId: 2, activeSpaceId: 'space', capturedAt: 1, spaces: [{ id: 'space', bookmarkFolderId: 'root', name: 'Space', color: 'purple', tabIds: [], pinnedTabIds: [], temporaryTabIds: [] }], tabs: [], bookmarks: [] });
function dispatch(listeners, message, sender) {
    return new Promise(resolve => {
        let pending = false, answered = false;
        for (const listener of [...listeners]) if (listener(message, sender, response => { answered = true; resolve(response); }) === true) pending = true;
        if (!pending && !answered) resolve();
    });
}
const request = message => dispatch(workers, { ...message, tabId: 9 }, helperSender());
beforeEach(() => {
    workers = []; renderers = []; probes = 0; external = []; ackTransform = (message, sender) => [message, sender]; onProbe = () => true;
    tab = { id: 9, windowId: 2, active: true, url: 'chrome://newtab/', status: 'complete', incognito: false };
    document.body.innerHTML = '<input value="keep draft"><button>Manual selection</button>';
    Object.defineProperty(document, 'URL', { configurable: true, value: api.runtime.getURL('newtab.html') });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    api.runtime.onMessage.addListener.mockImplementation(listener => target.push(listener));
    api.runtime.onMessage.removeListener.mockImplementation(listener => { for (const list of [workers, renderers]) { const index = list.indexOf(listener); if (index >= 0) list.splice(index, 1); } });
    api.storage.local.get.mockResolvedValue({ arcifyBridgePeerId: PEER, arcifyBridgePairingGeneration: 'local' });
    api.tabs.get.mockImplementation(async id => id === tab.id ? structuredClone(tab) : undefined);
    api.tabs.query.mockImplementation(async query => !query.windowId || query.windowId === tab.windowId ? [structuredClone(tab)] : []);
    api.tabs.getCurrent = vi.fn(async () => structuredClone(tab));
    api.runtime.sendMessage.mockImplementation((message, request, callback) => {
        if (message === PEER) {
            external.push(request);
            const fields = request.command === 'hello' ? { extensionId: PEER, capabilities: ['spaceActionsV1', 'globalFavoritesV1'] }
                : request.command === 'actionContext' ? { extensionId: PEER, actionContext: context() }
                : request.command === 'createSpaceFolder' ? { folderId: 'folder' } : { tabId: 23 };
            callback({ type: 'arcify-bridge', version: 1, requestId: request.requestId, role: 'arcify', ok: true, snapshot: snapshot(), ...fields }); return;
        }
        if (message.action === NEW_TAB_REUSE_PROBE) {
            probes++;
            return onProbe(message) === false ? Promise.resolve() : dispatch(renderers, message, { id: api.runtime.id, url: api.runtime.getURL('background.js') });
        }
        if (message.action === NEW_TAB_REUSE_ACK) {
            const [ack, sender] = ackTransform(message, helperSender());
            return dispatch(workers, ack, sender);
        }
        return Promise.resolve();
    });
    target = workers;
    reuse = createActiveNewTabReuse(api, 20);
    uninstall = installArcifySpaceActionMessages(api, { getPeerId: async () => PEER, timeoutMs: 50, serializeAction: action => action() }, {
        verifyHelper: source => reuse.reuseOrFallback(source, async () => false)
    });
    target = renderers;
    renderer = mountActiveNewTabReuse({ api, document });
});
afterEach(() => { renderer.dispose(); uninstall(); reuse.dispose(); });
const mutations = () => external.filter(message => ['createSpaceFolder', 'openSettings', 'pinCurrentTab', 'removeCurrentPin'].includes(message.command));
describe('real helper-alias nonce proof used by Space actions', () => {
    it.each(['createSpaceFolder', 'openSettings'])('authenticates no-sender.tab browser alias for %s without navigation or focus/draft changes', async command => {
        const input = document.querySelector('input'), selection = document.querySelector('button'); input.setSelectionRange(2, 6); selection.focus();
        const response = await request({ action: 'arcifySpaceActionsContext' });
        expect(response).toMatchObject({ success: true, scope: { context: { sourceTabId: 9, tab: null } } });
        const result = await request({ action: 'arcifySpaceAction', command, scope: response.scope, fields: command === 'createSpaceFolder' ? { title: 'Reading' } : {} });
        expect(result).toMatchObject({ success: true, result: { command } });
        expect(probes).toBe(4); expect(api.tabs.getCurrent).toHaveBeenCalledTimes(4); expect(mutations()).toHaveLength(1);
        expect(document.activeElement).toBe(selection); expect(input.value).toBe('keep draft'); expect(input.selectionStart).toBe(2); expect(input.selectionEnd).toBe(6);
        expect(api.tabs.create).not.toHaveBeenCalled(); expect(api.tabs.update).not.toHaveBeenCalled();
    });
    it.each(['nonce', 'URL', 'extension', 'tab', 'window', 'frame', 'document'])('rejects forged %s proof without companion mutation', async field => {
        ackTransform = (message, sender) => {
            if (field === 'nonce') message = { ...message, nonce: crypto.randomUUID() };
            if (field === 'URL') sender = { ...sender, url: 'https://same.test/' };
            if (field === 'extension') sender = { ...sender, id: PEER };
            if (field === 'tab') sender = { ...sender, tab: { id: 10, windowId: 2 } };
            if (field === 'window') message = { ...message, windowId: 3 };
            if (field === 'frame') sender = { ...sender, frameId: 1 };
            if (field === 'document') sender = { ...sender, documentLifecycle: 'pending_deletion' };
            return [message, sender];
        };
        expect(await request({ action: 'arcifySpaceActionsContext' })).toMatchObject({ success: false, errorCode: 'UNAUTHORIZED' });
        expect(mutations()).toHaveLength(0); expect(external).toHaveLength(0);
    });
    it('rejects another renderer on the same alias URL', async () => {
        api.tabs.getCurrent.mockResolvedValue({ ...tab, id: 10 });
        expect(await request({ action: 'arcifySpaceActionsContext' })).toMatchObject({ success: false, errorCode: 'UNAUTHORIZED' });
        expect(external).toHaveLength(0);
    });
    it.each([3, 4])('fails closed if mutation source verification %s times out before or after fresh context', async failAt => {
        const response = await request({ action: 'arcifySpaceActionsContext' }); expect(response.success).toBe(true);
        onProbe = () => probes !== failAt;
        expect(await request({ action: 'arcifySpaceAction', command: 'createSpaceFolder', scope: response.scope, fields: { title: 'Reading' } })).toMatchObject({ success: false, errorCode: 'UNAUTHORIZED' });
        expect(mutations()).toHaveLength(0); expect(api.tabs.create).not.toHaveBeenCalled(); expect(api.tabs.update).not.toHaveBeenCalled();
    });
    it('rejects navigation away-and-back during the helper proof', async () => {
        onProbe = () => { api.tabs.onUpdated.callListeners(9, { status: 'loading' }, tab); return true; };
        expect(await request({ action: 'arcifySpaceActionsContext' })).toMatchObject({ success: false, errorCode: 'UNAUTHORIZED' });
        expect(external).toHaveLength(0);
    });
    it('retains strict literal-helper validation without alias probes', async () => {
        tab.url = api.runtime.getURL('newtab.html');
        expect(await request({ action: 'arcifySpaceActionsContext' })).toMatchObject({ success: true }); expect(probes).toBe(0);
        tab.url = 'https://same.test/';
        expect(await request({ action: 'arcifySpaceActionsContext' })).toMatchObject({ success: false, errorCode: 'UNAUTHORIZED' });
    });
});
