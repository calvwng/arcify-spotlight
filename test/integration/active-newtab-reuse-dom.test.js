// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromeMock } from '../mocks/chrome.js';
import './setup.js';

// Real background/newtab/search/selection modules. Only Chrome transport, identity,
// storage and browser tabs are mocked. Actual browser transport is covered by CI.
const OWN = 'b'.repeat(32), PEER = 'a'.repeat(32);
const PROBE = 'spotlightNewTabReuseProbe', ACK = 'spotlightNewTabReuseAck';
const base = { id: 9, windowId: 2, active: true, incognito: false, url: 'chrome://newtab/' };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let background, renderers, external, registrationTarget, tabs, currentWindow, page, onProbe, onAck, peer;
let events;
const ownUrl = () => chromeMock.runtime.getURL('newtab.html');
function dispatch(listeners, message, sender) {
    return new Promise(resolve => {
        let pending = false, answered = false;
        const respond = value => { answered = true; resolve(value); };
        for (const listener of [...listeners]) if (listener(message, sender, respond) === true) pending = true;
        if (!pending && !answered) resolve(undefined);
    });
}
const rendererSender = () => ({ id: OWN, url: ownUrl(), tab: { ...tabs.get(9) }, frameId: 0, documentLifecycle: 'active' });
const command = (name = 'toggleSpotlightNewTab') => dispatch(background, { command: name }, rendererSender());
const shortcut = name => chromeMock.commands.onCommand.addListener.mock.lastCall[0](name || 'toggleSpotlightNewTab');
const launch = (requestId = crypto.randomUUID()) => dispatch(external, { type: 'arcify-bridge', version: 1,
    command: 'launch', requestId, windowId: 2, mode: 'new-tab' }, { id: PEER });
const emit = (name, ...args) => { for (const listener of events[name] || []) listener(...args); };

beforeEach(async () => {
    page = null; background = []; renderers = []; external = []; tabs = new Map([[9, { ...base }]]);
    currentWindow = 2; onProbe = null; onAck = null; peer = null; events = {};
    document.body.innerHTML = '<div id="spotlight-container"></div>';
    Object.defineProperty(document, 'URL', { configurable: true, value: ownUrl() });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    HTMLElement.prototype.scrollIntoView = vi.fn();
    for (const name of ['onUpdated', 'onDetached', 'onReplaced', 'onActivated', 'onRemoved']) {
        events[name] = [];
        chromeMock.tabs[name] = {
            addListener: vi.fn(listener => events[name].push(listener)),
            removeListener: vi.fn(listener => { events[name] = events[name].filter(value => value !== listener); })
        };
    }
    chromeMock.runtime.onMessage.addListener.mockImplementation(listener => registrationTarget.push(listener));
    chromeMock.runtime.onMessage.removeListener.mockImplementation(listener => {
        for (const listeners of [background, renderers]) {
            const index = listeners.indexOf(listener);
            if (index >= 0) listeners.splice(index, 1);
        }
    });
    chromeMock.runtime.onMessageExternal.addListener.mockImplementation(listener => external.push(listener));
    chromeMock.storage.sync.get.mockResolvedValue({ enableSpotlight: true });
    chromeMock.storage.local.get.mockImplementation(async key => key === 'arcifyBridgePeerId' && peer ? { arcifyBridgePeerId: peer } : {});
    chromeMock.tabs.query.mockImplementation(async query => [...tabs.values()].filter(tab =>
        (!query.active || tab.active) && (!query.windowId || tab.windowId === query.windowId) &&
        (!query.currentWindow || tab.windowId === currentWindow)).map(tab => ({ ...tab })));
    chromeMock.tabs.get.mockImplementation(async id => {
        if (!tabs.has(id)) throw new Error('Closed tab');
        return { ...tabs.get(id) };
    });
    chromeMock.tabs.getCurrent = vi.fn(async () => tabs.has(9) ? { ...tabs.get(9) } : undefined);
    chromeMock.tabs.create.mockImplementation(async options => {
        const windowId = options.windowId || currentWindow;
        for (const tab of tabs.values()) if (tab.windowId === windowId) tab.active = false;
        const tab = { id: 50 + tabs.size, windowId, active: true, url: options.url, incognito: false };
        tabs.set(tab.id, tab);
        return { ...tab };
    });
    chromeMock.windows.get.mockImplementation(async id => ({ id, type: 'normal', incognito: false }));
    chromeMock.runtime.sendMessage.mockImplementation((message, request, callback) => {
        if (message === PEER) {
            callback({ ...request, role: 'arcify', extensionId: PEER, ok: true,
                snapshot: { windowId: 2, capturedAt: Date.now(), activeSpaceId: null, spaces: [], tabs: [], bookmarks: [] } });
            return;
        }
        if (message.action === PROBE) return onProbe ? onProbe(message) : dispatch(renderers, message, { id: OWN, url: chromeMock.runtime.getURL('background.js') });
        if (message.action === ACK) return onAck ? onAck(message) : dispatch(background, message, rendererSender());
        return dispatch(background, message, rendererSender());
    });
    registrationTarget = background;
    await import('../../background.js');
    registrationTarget = renderers;
});
afterEach(async () => {
    page?.dispose();
    await pause(40); // Let mocked browser-event result invalidations settle.
    document.body.replaceChildren();
    delete HTMLElement.prototype.scrollIntoView;
    vi.restoreAllMocks();
    for (const name of ['onUpdated', 'onDetached', 'onReplaced']) delete chromeMock.tabs[name];
});
async function open() {
    const { initializeSpotlight } = await import('../../newtab.js');
    page = await initializeSpotlight();
    await page.sidebarCommand.ready; await page.startupSuggestion.ready; await pause(0);
    return page;
}
const expectNoTabMutation = () => {
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
    expect(chromeMock.tabs.update).not.toHaveBeenCalled();
    expect(chromeMock.windows.update).not.toHaveBeenCalled();
};

describe('active New Tab alias reuse through real production modules', () => {
    it('reuses from the first command, preserves DOM/query/caret/selection and never focuses', async () => {
        await open();
        page.input.value = 'unfinished query';
        page.input.dispatchEvent(new Event('input', { bubbles: true }));
        await pause(180);
        page.input.setSelectionRange(2, 8, 'backward');
        page.input.blur(); // Browser omnibox itself is outside JSDOM; focus calls are asserted here.
        const input = page.input, container = document.getElementById('spotlight-container');
        const selected = page.selectionManager.getSelectedResult(), markup = container.innerHTML;
        const focus = vi.spyOn(HTMLElement.prototype, 'focus'), close = vi.spyOn(window, 'close');
        chromeMock.tabs.getCurrent.mockClear();
        expect(await command()).toEqual({ success: true });
        expect(await command()).toEqual({ success: true });
        expect(chromeMock.tabs.getCurrent).toHaveBeenCalledTimes(2);
        expect(document.getElementById('spotlight-container')).toBe(container);
        expect(container.innerHTML).toBe(markup); expect(page.input).toBe(input);
        expect(input.value).toBe('unfinished query');
        expect([input.selectionStart, input.selectionEnd, input.selectionDirection]).toEqual([2, 8, 'backward']);
        expect(page.selectionManager.getSelectedResult()).toBe(selected);
        expect(focus).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
        expectNoTabMutation();
        expect(chromeMock.tabs.sendMessage).not.toHaveBeenCalled();
    });
    it('uses the same read-only route for the real Chrome command handler and concurrent runtime/paired launches', async () => {
        peer = PEER; await open();
        await Promise.all([shortcut(), command(), launch(), shortcut('toggleSpotlight'), command('toggleSpotlight')]);
        expectNoTabMutation();
        expect(chromeMock.runtime.sendMessage.mock.calls.filter(([message]) => message?.action === PROBE)).toHaveLength(5);
    });
    it('authenticates extension-page acknowledgements without sender.tab via fresh getCurrent evidence', async () => {
        await open();
        onAck = message => dispatch(background, message, { id: OWN, url: ownUrl() });
        expect(await command()).toEqual({ success: true }); expectNoTabMutation();
    });
    it('requires a new live renderer acknowledgement after a worker restart', async () => {
        await open(); await command();
        background.length = 0; external.length = 0; registrationTarget = background;
        vi.resetModules(); await import('../../background.js'); registrationTarget = renderers;
        expect(await command()).toEqual({ success: true });
        expectNoTabMutation();
        page.dispose();
        expect(await command()).toEqual({ success: true });
        expect(chromeMock.tabs.create).toHaveBeenCalledTimes(1);
    });
    it.each(['missing-renderer', 'other-provider', 'broadcast-response'])('keeps normal fallback for %s and serializes repeated commands', async scenario => {
        if (scenario === 'other-provider') Object.defineProperty(document, 'URL', { configurable: true, value: 'chrome-extension://other/newtab.html' });
        if (scenario === 'broadcast-response') onProbe = message => Promise.resolve({ ...message, action: ACK });
        if (scenario === 'other-provider') await open();
        const replies = await Promise.all([command(), command(), command(), command()]);
        expect(replies.every(reply => reply.success)).toBe(true);
        expect(chromeMock.tabs.create).toHaveBeenCalledExactlyOnceWith({ url: ownUrl(), active: true, windowId: 2 });
    });
    it.each([
        ['nonce', (message, sender) => [{ ...message, nonce: crypto.randomUUID() }, sender]],
        ['tab', (message, sender) => [{ ...message, tabId: 10 }, sender]],
        ['window', (message, sender) => [{ ...message, windowId: 3 }, sender]],
        ['sender ID', (message, sender) => [message, { ...sender, id: PEER }]],
        ['sender URL', (message, sender) => [message, { ...sender, url: 'https://example.test/' }]],
        ['sender tab', (message, sender) => [message, { ...sender, tab: { ...sender.tab, id: 10 } }]],
        ['sender window', (message, sender) => [message, { ...sender, tab: { ...sender.tab, windowId: 3 } }]],
        ['subframe', (message, sender) => [message, { ...sender, frameId: 1 }]],
        ['stale document', (message, sender) => [message, { ...sender, documentLifecycle: 'pending_deletion' }]]
    ])('rejects wrong %s proof without accepting another page', async (_label, change) => {
        await open();
        onAck = message => dispatch(background, ...change(message, rendererSender()));
        expect(await command()).toEqual({ success: true });
        expect(chromeMock.tabs.create).toHaveBeenCalledTimes(1);
    });
    it.each(['pending', 'loading', 'moved', 'inactive', 'different-tab', 'missing', 'wrong-url'])('does not trust renderer getCurrent %s', async change => {
        await open();
        chromeMock.tabs.getCurrent.mockResolvedValue(change === 'missing' ? undefined : { ...base,
            ...(change === 'pending' ? { pendingUrl: 'https://next.test' } : {}),
            ...(change === 'loading' ? { status: 'loading' } : {}),
            ...(change === 'moved' ? { windowId: 3 } : {}),
            ...(change === 'inactive' ? { active: false } : {}),
            ...(change === 'different-tab' ? { id: 10 } : {}),
            ...(change === 'wrong-url' ? { url: 'https://example.test' } : {}) });
        expect(await command()).toEqual({ success: true });
        expect(chromeMock.tabs.create).toHaveBeenCalledTimes(1);
    });
    it.each(['pending', 'loading', 'navigated', 'moved', 'switched', 'closed', 'incognito-changed', 'away-and-back'])('aborts %s source during acknowledgement, without creating fallback', async change => {
        await open();
        onAck = message => {
            const source = tabs.get(9);
            if (change === 'pending') source.pendingUrl = 'https://next.test/';
            if (change === 'loading') source.status = 'loading';
            if (change === 'navigated') source.url = 'https://next.test/';
            if (change === 'moved') source.windowId = 3;
            if (change === 'switched') source.active = false;
            if (change === 'closed') tabs.delete(9);
            if (change === 'incognito-changed') source.incognito = true;
            if (change === 'away-and-back') emit('onUpdated', 9, { status: 'loading' }, source);
            return dispatch(background, message, { id: OWN, url: ownUrl() });
        };
        expect(await command()).toEqual({ success: false }); expectNoTabMutation();
    });
    it('rejects initially pending alias and pending explicit helper before any probe', async () => {
        tabs.get(9).pendingUrl = 'https://next.test/';
        expect(await command()).toEqual({ success: false });
        tabs.get(9).url = ownUrl();
        expect(await command()).toEqual({ success: false });
        expect(chromeMock.runtime.sendMessage.mock.calls.filter(([message]) => message?.action === PROBE)).toHaveLength(0);
        expectNoTabMutation();
    });
    it('rejects already-loading alias and explicit helper even without a pending URL', async () => {
        await open(); tabs.get(9).status = 'loading';
        expect(await command()).toEqual({ success: false });
        tabs.get(9).url = ownUrl();
        expect(await command()).toEqual({ success: false });
        expect(chromeMock.runtime.sendMessage.mock.calls.filter(([message]) => message?.action === PROBE)).toHaveLength(0);
        expectNoTabMutation();
    });
    it('checks the final active query for loading even if tabs.get and events missed it', async () => {
        await open();
        const query = chromeMock.tabs.query.getMockImplementation();
        let acknowledged = false;
        onAck = message => { acknowledged = true; return dispatch(background, message, rendererSender()); };
        chromeMock.tabs.query.mockImplementation(async args => (await query(args)).map(tab =>
            acknowledged ? { ...tab, status: 'loading' } : tab));
        expect(await command()).toEqual({ success: false }); expectNoTabMutation();
    });
    it('never lets an expired nonce acknowledge a later command', async () => {
        await open();
        let oldAck;
        onAck = message => { oldAck ||= message; return Promise.resolve(); };
        expect(await command()).toEqual({ success: true });
        // The user returns to the original alias. Replay its expired proof during a new probe.
        for (const tab of tabs.values()) tab.active = tab.id === 9;
        onAck = () => dispatch(background, oldAck, rendererSender());
        expect(await command()).toEqual({ success: true });
        expect(chromeMock.tabs.create).toHaveBeenCalledTimes(2);
        const nonces = chromeMock.runtime.sendMessage.mock.calls.filter(([message]) => message?.action === PROBE).map(([message]) => message.nonce);
        expect(new Set(nonces).size).toBe(2);
    });
    it('ignores bad acknowledgement noise but still accepts the correlated live renderer', async () => {
        await open();
        onAck = async message => {
            await dispatch(background, { ...message, tabId: 123 }, rendererSender());
            return dispatch(background, message, rendererSender());
        };
        expect(await command()).toEqual({ success: true }); expectNoTabMutation();
    });
    it.each([
        { id: PEER, url: 'chrome-extension://other/background.js' },
        { id: OWN, url: 'https://example.test/' },
        { id: OWN, url: chromeMock.runtime.getURL('options.html') },
        { id: OWN, tab: { id: 9, windowId: 2 } }
    ])('renderer ignores probes from another caller %j', async sender => {
        await open();
        onProbe = message => dispatch(renderers, message, sender);
        expect(await command()).toEqual({ success: true });
        expect(chromeMock.runtime.sendMessage.mock.calls.filter(([message]) => message?.action === ACK)).toHaveLength(0);
        expect(chromeMock.tabs.create).toHaveBeenCalledTimes(1);
    });
    it('does not use a late getCurrent read after the real page is disposed', async () => {
        await open();
        let release; chromeMock.tabs.getCurrent.mockImplementation(() => new Promise(resolve => { release = resolve; }));
        const pending = command();
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        page.dispose(); release({ ...base });
        expect(await pending).toEqual({ success: true });
        expect(chromeMock.runtime.sendMessage.mock.calls.filter(([message]) => message?.action === ACK)).toHaveLength(0);
        expect(chromeMock.tabs.create).toHaveBeenCalledTimes(1);
    });
    it('never switches to or removes an inactive helper in this or another window', async () => {
        tabs.set(10, { id: 10, windowId: 2, active: false, url: ownUrl() });
        tabs.set(30, { id: 30, windowId: 3, active: true, url: ownUrl() });
        expect(await command()).toEqual({ success: true });
        expect(chromeMock.tabs.create).toHaveBeenCalledExactlyOnceWith({ url: ownUrl(), active: true, windowId: 2 });
        expect(tabs.get(10)).toMatchObject({ active: false, windowId: 2 });
        expect(tabs.get(30)).toMatchObject({ active: true, windowId: 3 });
        expect(chromeMock.tabs.update).not.toHaveBeenCalled();
        expect(chromeMock.windows.update).not.toHaveBeenCalled();
    });
    it('keeps invalidation alive through fallback teardown, including navigation away and back', async () => {
        const query = chromeMock.tabs.query.getMockImplementation();
        chromeMock.tabs.query.mockImplementation(async args => {
            // Fallback overlay teardown queries the whole window after probe timeout.
            if (args.windowId === 2 && !args.active) emit('onUpdated', 9, { status: 'loading' }, tabs.get(9));
            return query(args);
        });
        expect(await command()).toEqual({ success: false }); expectNoTabMutation();
    });
    it.each([
        ['onActivated', { tabId: 10, windowId: 2 }],
        ['onDetached', 9, { oldWindowId: 2 }],
        ['onRemoved', 9, { windowId: 2 }],
        ['onReplaced', 10, 9],
        ['onUpdated', 9, { url: 'https://next.test/' }]
    ])('remembers %s even if the source snapshot returns to its original identity', async (event, ...args) => {
        await open();
        onAck = message => {
            emit(event, ...args);
            return dispatch(background, message, rendererSender());
        };
        expect(await command()).toEqual({ success: false }); expectNoTabMutation();
    });
    it('does not invalidate the source for unrelated window/tab events', async () => {
        await open();
        onAck = message => {
            emit('onActivated', { tabId: 30, windowId: 3 });
            emit('onDetached', 30); emit('onRemoved', 30); emit('onReplaced', 31, 30);
            emit('onUpdated', 30, { status: 'loading' }, { windowId: 3 });
            return dispatch(background, message, rendererSender());
        };
        expect(await command()).toEqual({ success: true }); expectNoTabMutation();
    });
    it('does not multiply a newly created helper whose document is still pending', async () => {
        chromeMock.tabs.create.mockImplementation(async options => {
            tabs.get(9).active = false;
            const helper = { id: 50, windowId: 2, active: true, url: '', pendingUrl: options.url };
            tabs.set(50, helper); return { ...helper };
        });
        const replies = await Promise.all([command(), command(), command()]);
        expect(replies).toEqual([{ success: true }, { success: false }, { success: false }]);
        expect(chromeMock.tabs.create).toHaveBeenCalledTimes(1);
    });
    it('captures shortcut origin before its queue waits even if a different window becomes current', async () => {
        let release; const wait = new Promise(resolve => { release = resolve; });
        const create = chromeMock.tabs.create.getMockImplementation();
        chromeMock.tabs.create.mockImplementation(async options => { await wait; return create(options); });
        const first = command();
        await vi.waitFor(() => expect(chromeMock.tabs.create).toHaveBeenCalledTimes(1));
        const second = command(); await pause(0);
        tabs.set(30, { id: 30, windowId: 3, active: true, url: 'chrome://settings' });
        currentWindow = 3; release();
        expect(await first).toEqual({ success: true }); expect(await second).toEqual({ success: true });
        expect(chromeMock.tabs.create).toHaveBeenCalledExactlyOnceWith({ url: ownUrl(), active: true, windowId: 2 });
        expect(tabs.get(30).active).toBe(true);
    });
    it('rechecks paired authorization after waiting behind another launch', async () => {
        peer = PEER;
        let release; const wait = new Promise(resolve => { release = resolve; });
        const create = chromeMock.tabs.create.getMockImplementation();
        chromeMock.tabs.create.mockImplementation(async options => { await wait; return create(options); });
        const first = command();
        await vi.waitFor(() => expect(chromeMock.tabs.create).toHaveBeenCalledTimes(1));
        const paired = launch(); await pause(0); peer = null; release();
        expect(await first).toEqual({ success: true });
        expect(await paired).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
        expect(chromeMock.tabs.create).toHaveBeenCalledTimes(1);
    });
});
