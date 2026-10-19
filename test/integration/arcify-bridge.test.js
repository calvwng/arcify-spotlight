import { describe, it, expect, beforeEach, vi } from 'vitest';
import { chromeMock } from '../mocks/chrome.js';
import './setup.js';
import { shouldCloseNewTab } from '../../shared/bridge-navigation-ui.js';

const peerId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ownId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const sender = { id: ownId, tab: { id: 42, windowId: 2 }, url: 'https://example.com' };
const snapshot = windowId => ({
    windowId, activeSpaceId: 'work', capturedAt: Date.now(),
    spaces: [{ id: 'work', name: 'Work', color: 'blue', bookmarkFolderId: '10', tabIds: [42, 43], pinnedTabIds: [43], temporaryTabIds: [42] }],
    tabs: [
        { id: 42, windowId, title: 'Current', url: 'https://current.test', active: true, pinned: false, spaceId: 'work' },
        { id: 43, windowId, title: 'Example work', url: 'https://example.com', active: false, pinned: false, spaceId: 'work' }
    ],
    bookmarks: [{ id: 'closed-pin', spaceId: 'work', title: 'Example closed pin', url: 'https://example.com/closed', tabId: null }]
});

function respond(request, extra = {}) {
    return { type: 'arcify-bridge', version: 1, requestId: request.requestId, role: 'arcify', extensionId: peerId, ok: true, snapshot: snapshot(request.windowId), tabId: request.tabId || 50, ...extra };
}

function callInternal(message, from = sender) {
    return new Promise(resolve => chromeMock.runtime.onMessage.callListeners(message, from, resolve));
}
function callExternal(message, from = { id: peerId }) {
    return new Promise(resolve => chromeMock.runtime.onMessageExternal.callListeners(message, from, resolve));
}
const launch = (extra = {}) => ({ type: 'arcify-bridge', version: 1, requestId: 'test-request', command: 'launch', windowId: 2, mode: 'new-tab', ...extra });

beforeEach(async () => {
    chromeMock.storage.session ??= { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) };
    chromeMock.storage.local.get.mockImplementation(async key => key === 'arcifyBridgePeerId' ? { arcifyBridgePeerId: peerId } : {});
    chromeMock.storage.sync.get.mockResolvedValue({ enableSpotlight: true });
    chromeMock.runtime.sendMessage.mockImplementation((id, request, callback) => {
        if (id === peerId && callback) callback(respond(request));
        return Promise.resolve(undefined);
    });
    await import('../../background.js');
});

describe('Spotlight background bridge seams', () => {
    it('advertises additive startup capability without changing the v1 handshake', async () => {
        const response = await callExternal({ type: 'arcify-bridge', version: 1, requestId: 'hello-new', command: 'hello', windowId: 2 });
        expect(response).toMatchObject({ type: 'arcify-bridge', version: 1, role: 'spotlight', ok: true, capabilities: ['startupSuggestion', 'favoriteContinuityWitnessV1'] });
    });
    it('authenticates and validates a startup offer before relaying only to extension pages', async () => {
        chromeMock.tabs.get.mockResolvedValue({ id: 42, windowId: 2, active: true, url: chromeMock.runtime.getURL('newtab.html') });
        chromeMock.windows.get.mockResolvedValue({ id: 2, focused: true });
        chromeMock.runtime.sendMessage.mockImplementation(async message => ({ accepted: false, reason: 'user-interaction', requestId: message.requestId, tabId: message.tabId, windowId: message.windowId }));
        const message = { type: 'arcify-bridge', version: 1, requestId: 'startup-new', command: 'startupSuggestion', tabId: 42, windowId: 2 };
        expect(await callExternal(message)).toMatchObject({ ok: true, accepted: false, reason: 'user-interaction' });
        expect(chromeMock.tabs.sendMessage).not.toHaveBeenCalled();
        expect(await callExternal({ ...message, unexpected: true })).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
        expect(await callExternal(message, { id: peerId, url: 'https://untrusted.test/' })).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
    });
    it('searches a fresh snapshot in the caller window, including closed pins', async () => {
        const response = await callInternal({ action: 'getLocalSuggestions', query: 'example', mode: 'new-tab' });
        expect(response.success).toBe(true);
        expect(response.results.some(item => item.metadata?.arcifyBridge?.tabId === 43)).toBe(true);
        expect(response.results.some(item => item.metadata?.arcifyBridge?.bookmarkId === 'closed-pin')).toBe(true);
        expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(peerId, expect.objectContaining({ command: 'hello', windowId: 2 }), expect.any(Function));
        expect(chromeMock.storage.local.set).not.toHaveBeenCalled();
    });
    it('uses the source tab identity rather than a spoofed message tab ID', async () => {
        const response = await callInternal({ action: 'spotlightHandleResult', result: { type: 'url-suggestion', url: 'https://target.test' }, mode: 'current-tab', tabId: 999 });
        expect(response.success).toBe(true);
        expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(peerId, expect.objectContaining({ command: 'navigateTab', tabId: 42, windowId: 2 }), expect.any(Function));
        expect(chromeMock.tabs.update).not.toHaveBeenCalled();
    });
    it.each(['url-suggestion', 'search-query'])('launches %s into a newly selected empty workspace from the helper page', async type => {
        const helper = { ...sender, url: chromeMock.runtime.getURL('newtab.html') };
        let activeSpaceId = 'work';
        chromeMock.runtime.sendMessage.mockImplementation((id, request, callback) => {
            if (request.command === 'activateSpace') activeSpaceId = 'empty';
            const value = respond(request);
            value.snapshot.activeSpaceId = activeSpaceId;
            value.snapshot.spaces.push({ id: 'empty', name: 'Empty', color: 'green', tabIds: [], pinnedTabIds: [], temporaryTabIds: [] });
            if (request.command === 'activateSpace') delete value.tabId;
            callback(value);
        });
        const space = { type: 'arcify-space', metadata: { arcifyBridge: { kind: 'space', peerId, windowId: 2, spaceId: 'empty' } } };
        const activated = await callInternal({ action: 'spotlightHandleResult', result: space, mode: 'new-tab' }, helper);
        expect(activated.success).toBe(true);
        expect(shouldCloseNewTab(space, activated)).toBe(false);
        const result = type === 'search-query' ? { type, metadata: { query: 'next search' } } : { type, url: 'https://next.test' };
        const opened = await callInternal({ action: 'spotlightHandleResult', result, mode: 'current-tab' }, helper);
        expect(opened).toMatchObject({ success: true, bridge: true, tabId: 50, sourceTabId: 42 });
        expect(shouldCloseNewTab(result, opened)).toBe(true);
        expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(peerId, expect.objectContaining({ command: 'openTab', windowId: 2, url: type === 'search-query' ? 'about:blank' : 'https://next.test' }), expect.any(Function));
        expect(chromeMock.runtime.sendMessage.mock.calls.some(([, request]) => request.command === 'navigateTab')).toBe(false);
        expect(chromeMock.tabs.create).not.toHaveBeenCalled();
    });
    it('routes tab selections to Arcify in current-tab mode', async () => {
        const result = { type: 'open-tab', metadata: { tabId: 43, arcifyBridge: { kind: 'tab', peerId, tabId: 43, windowId: 2, spaceId: 'work' } } };
        expect((await callInternal({ action: 'spotlightHandleResult', result, mode: 'current-tab' })).success).toBe(true);
        expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(peerId, expect.objectContaining({ command: 'activateTab', tabId: 43, windowId: 2 }), expect.any(Function));
        expect(chromeMock.tabs.create).not.toHaveBeenCalled();
    });
    it('gets active accent from the authoritative workspace', async () => {
        expect(await callInternal({ action: 'getActiveSpaceColor' })).toMatchObject({ success: true, color: 'blue', groupName: 'Work' });
        expect(chromeMock.tabGroups.get).not.toHaveBeenCalled();
    });
    it('keeps configured connection errors visible and never falls back to native actions', async () => {
        chromeMock.runtime.sendMessage.mockImplementation((id, request, callback) => callback(respond(request, { ok: false, error: { code: 'UNAVAILABLE', message: 'Arcify unavailable' } })));
        const response = await callInternal({ action: 'spotlightHandleResult', result: { type: 'url-suggestion', url: 'https://target.test' }, mode: 'new-tab' });
        expect(response).toMatchObject({ success: false, error: 'Arcify unavailable' });
        expect(chromeMock.tabs.create).not.toHaveBeenCalled();
        expect(chromeMock.tabs.update).not.toHaveBeenCalled();
    });
    it('returns a configured search error instead of misleading standalone results', async () => {
        chromeMock.runtime.sendMessage.mockImplementation((id, request, callback) => callback(respond(request, { version: 2 })));
        const response = await callInternal({ action: 'getLocalSuggestions', query: 'example', mode: 'new-tab' });
        expect(response).toMatchObject({ success: false, results: [] });
    });
    it('preserves standalone native navigation when connection is disabled', async () => {
        chromeMock.storage.local.get.mockResolvedValue({});
        const response = await callInternal({ action: 'spotlightHandleResult', result: { type: 'url-suggestion', url: 'https://target.test' }, mode: 'new-tab' });
        expect(response.success).toBe(true);
        expect(chromeMock.tabs.create).toHaveBeenCalledExactlyOnceWith({ url: 'https://target.test' });
    });
    it('does not report success when pairing disappears between dispatch and action routing', async () => {
        chromeMock.storage.local.get.mockResolvedValueOnce({ arcifyBridgePeerId: peerId }).mockResolvedValue({});
        const response = await callInternal({ action: 'spotlightHandleResult', result: { type: 'url-suggestion', url: 'https://next.test' }, mode: 'new-tab' });
        expect(response.success).toBe(false);
        expect(response.error).toContain('disconnected');
        expect(chromeMock.tabs.create).not.toHaveBeenCalled();
        expect(chromeMock.tabs.update).not.toHaveBeenCalled();
    });
    it('rejects a stale paired result after disconnect instead of falling back to native navigation', async () => {
        chromeMock.storage.local.get.mockResolvedValue({});
        const result = { type: 'bookmark', url: 'https://example.com', metadata: { arcifyBridge: { kind: 'bookmark', peerId, bookmarkId: 'closed-pin', spaceId: 'work', windowId: 2 } } };
        const response = await callInternal({ action: 'spotlightHandleResult', result, mode: 'new-tab' });
        expect(response.success).toBe(false);
        expect(response.error).toContain('disconnected');
        expect(chromeMock.tabs.create).not.toHaveBeenCalled();
        expect(chromeMock.tabs.update).not.toHaveBeenCalled();
    });
    it('returns partial bookmark warnings while preserving live-tab search', async () => {
        chromeMock.runtime.sendMessage.mockImplementation((id, request, callback) => {
            const value = respond(request);
            value.snapshot.warnings = [{ code: 'BOOKMARKS_UNAVAILABLE', spaceId: 'work', message: 'Work bookmark folder is unavailable.' }];
            callback(value);
        });
        const response = await callInternal({ action: 'getLocalSuggestions', query: 'example', mode: 'new-tab' });
        expect(response.success).toBe(true);
        expect(response.warnings[0].code).toBe('BOOKMARKS_UNAVAILABLE');
        expect(response.results.some(result => result.metadata?.tabId === 43)).toBe(true);
        const status = await callInternal({ action: 'arcifyBridgeStatus' });
        expect(status.status.status).toBe('connected');
        expect(status.status.message).toContain('Work bookmark folder is unavailable.');
    });
    it('rejects peer changes from content scripts', async () => {
        const response = await callInternal({ action: 'arcifyBridgeConfigure', peerId: '' });
        expect(response.success).toBe(false);
        expect(chromeMock.storage.local.set).not.toHaveBeenCalled();
    });
    it('allows explicit disconnect from this extension’s options page', async () => {
        chromeMock.storage.local.set.mockImplementation(async ({ arcifyBridgePeerId }) => {
            chromeMock.storage.local.get.mockResolvedValue({ arcifyBridgePeerId });
        });
        const response = await callInternal({ action: 'arcifyBridgeConfigure', peerId: '' }, { id: ownId, url: chromeMock.runtime.getURL('options.html') });
        expect(response).toMatchObject({ success: true, status: { configured: false, status: 'disabled' } });
        expect(chromeMock.storage.local.set).toHaveBeenCalledExactlyOnceWith({ arcifyBridgePeerId: '', arcifyBridgePairingGeneration: expect.any(String) });
    });
    it('saves from options before reciprocal approval and connects on a later read-only refresh', async () => {
        const optionsSender = { id: ownId, url: chromeMock.runtime.getURL('options.html') };
        let storedId = '';
        chromeMock.storage.local.get.mockImplementation(async key => key === 'arcifyBridgePeerId' ? { arcifyBridgePeerId: storedId } : {});
        chromeMock.storage.local.set.mockImplementation(async ({ arcifyBridgePeerId }) => { storedId = arcifyBridgePeerId; });
        chromeMock.runtime.sendMessage.mockImplementationOnce((id, request, callback) => callback(respond(request, {
            ok: false, error: { code: 'UNAUTHORIZED', message: 'This extension is not paired with Arcify.' }
        })));

        const saved = await callInternal({ action: 'arcifyBridgeConfigure', peerId }, optionsSender);
        expect(saved).toMatchObject({ success: true, status: { configured: true, peerId, status: 'pending' } });
        expect(storedId).toBe(peerId);
        const refreshed = await callInternal({ action: 'arcifyBridgeStatus' }, optionsSender);
        expect(refreshed).toMatchObject({ success: true, status: { configured: true, peerId, status: 'connected' } });
        expect(chromeMock.storage.local.set).toHaveBeenCalledExactlyOnceWith({ arcifyBridgePeerId: peerId, arcifyBridgePairingGeneration: expect.any(String) });
    });
});

describe('paired reverse launch', () => {
    it('launches overlay only in the explicitly requested window', async () => {
        chromeMock.tabs.query.mockImplementation(async query => query.windowId === 2 ? [{ id: 42, windowId: 2, url: 'https://example.com' }] : []);
        chromeMock.tabs.sendMessage.mockResolvedValue({ success: true });
        expect(await callExternal(launch())).toMatchObject({ ok: true, role: 'spotlight', requestId: 'test-request' });
        expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(42, expect.objectContaining({ action: 'activateSpotlight', mode: 'new-tab' }));
        expect(chromeMock.tabs.query.mock.calls.every(([query]) => query.windowId === 2)).toBe(true);
        expect(chromeMock.tabs.create).not.toHaveBeenCalled();
    });
    it('falls back to the extension new-tab page in the same requested window', async () => {
        chromeMock.tabs.query.mockResolvedValue([{ id: 42, windowId: 2, url: 'chrome://settings' }]);
        expect((await callExternal(launch())).ok).toBe(true);
        expect(chromeMock.tabs.create).toHaveBeenCalledExactlyOnceWith({ url: chromeMock.runtime.getURL('newtab.html'), active: true, windowId: 2 });
    });
    it('does not create a fallback tab when Spotlight has been disabled', async () => {
        chromeMock.storage.sync.get.mockResolvedValue({ enableSpotlight: false });
        expect(await callExternal(launch())).toMatchObject({ ok: false, error: { code: 'LAUNCH_FAILED' } });
        expect(chromeMock.tabs.create).not.toHaveBeenCalled();
    });
    it.each([
        { id: 'cccccccccccccccccccccccccccccccc' },
        { id: peerId, url: 'https://example.com' },
        { id: peerId, origin: 'https://example.com' }
    ])('rejects unpaired or web-origin callers before browser access', async from => {
        expect(await callExternal(launch(), from)).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
        expect(chromeMock.windows.get).not.toHaveBeenCalled();
        expect(chromeMock.tabs.query).not.toHaveBeenCalled();
    });
    it.each([
        { version: 2 }, { command: 'snapshot' }, { windowId: -1 }, { mode: 'invalid' }, { extraField: 'no' }
    ])('rejects malformed/unsupported reverse requests', async change => {
        expect((await callExternal(launch(change))).ok).toBe(false);
        expect(chromeMock.tabs.create).not.toHaveBeenCalled();
        expect(chromeMock.tabs.sendMessage).not.toHaveBeenCalled();
    });
    it('replays an identical launch ID without opening a second helper tab', async () => {
        chromeMock.tabs.query.mockResolvedValue([{ id: 42, windowId: 2, url: 'chrome://settings' }]);
        const [first, second] = await Promise.all([callExternal(launch()), callExternal(launch())]);
        expect(first.ok).toBe(true); expect(second.ok).toBe(true);
        expect(chromeMock.tabs.create).toHaveBeenCalledTimes(1);
        expect(await callExternal(launch({ mode: 'current-tab' }))).toMatchObject({ ok: false, error: { code: 'REQUEST_ID_REUSED' } });
    });
    it('reuses the active helper page for different launch IDs', async () => {
        const helper = { id: 42, windowId: 2, active: true, url: chromeMock.runtime.getURL('newtab.html') };
        chromeMock.tabs.query.mockResolvedValue([helper]);
        chromeMock.tabs.get.mockResolvedValue(helper);
        expect((await callExternal(launch())).ok).toBe(true);
        expect((await callExternal(launch({ requestId: 'next-id' }))).ok).toBe(true);
        expect(chromeMock.tabs.create).not.toHaveBeenCalled();
        expect(chromeMock.tabs.sendMessage).not.toHaveBeenCalled();
    });
    it('serializes concurrent launches before checking the active helper', async () => {
        let currentUrl = 'chrome://settings';
        let currentId = 42;
        const current = () => ({ id: currentId, windowId: 2, active: true, url: currentUrl });
        chromeMock.tabs.query.mockImplementation(async () => [current()]);
        chromeMock.tabs.get.mockImplementation(async () => current());
        chromeMock.tabs.create.mockImplementation(async options => { currentUrl = options.url; currentId = 50; return current(); });
        const results = await Promise.all([callExternal(launch()), callExternal(launch({ requestId: 'next-id' }))]);
        expect(results.every(result => result.ok)).toBe(true);
        expect(chromeMock.tabs.create).toHaveBeenCalledTimes(1);
    });
    it('hello identifies Spotlight without opening UI', async () => {
        const request = launch({ command: 'hello' }); delete request.mode;
        expect(await callExternal(request)).toMatchObject({ ok: true, role: 'spotlight', extensionId: ownId });
        expect(chromeMock.tabs.create).not.toHaveBeenCalled();
        expect(chromeMock.tabs.sendMessage).not.toHaveBeenCalled();
    });
});

describe('saved-bookmark fallback background lifecycle', () => {
    const tree = () => [{ id: '0', children: [{ id: 'a', title: 'Arcify', children: [
        { id: 's', title: 'Saved Work', children: [{ id: 'saved', title: 'Example saved', url: 'https://saved.test/' }] }
    ] }] }];
    const search = () => callInternal({ action: 'getLocalSuggestions', query: 'example', mode: 'new-tab' });
    const select = row => callInternal({ action: 'spotlightHandleResult', result: row, mode: 'new-tab' });
    it('discovers offline, reconnects authoritatively and rejects both kinds of stale choices', async () => {
        let peer = '';
        chromeMock.storage.local.get.mockImplementation(async () => ({ arcifyBridgePeerId: peer }));
        chromeMock.bookmarks.getTree.mockResolvedValue(tree());
        const standalone = await search();
        const saved = standalone.results.find(row => row.metadata?.savedBookmark);
        expect(saved.metadata.savedBookmark.id).toBe('saved');
        expect(standalone.discoveryStatus).toContain('Standalone');
        peer = peerId;
        expect(await select(saved)).toMatchObject({ success: false });
        const connected = await search();
        expect(connected.results.some(row => row.metadata?.savedBookmark)).toBe(false);
        const paired = connected.results.find(row => row.metadata?.arcifyBridge);
        peer = '';
        expect(await select(paired)).toMatchObject({ success: false });
        const fresh = (await search()).results.find(row => row.metadata?.savedBookmark);
        expect(await select(fresh)).toMatchObject({ success: true });
        expect(chromeMock.tabs.create).toHaveBeenCalledExactlyOnceWith({ url: 'https://saved.test/' });
    });
    it.each(['UNAVAILABLE', 'TIMEOUT', 'UNAUTHORIZED'])('allows a fresh explicit ordinary selection during %s without paired mutation', async code => {
        chromeMock.bookmarks.getTree.mockResolvedValue(tree());
        chromeMock.runtime.sendMessage.mockImplementation((id, request, callback) => callback(respond(request, { ok:false, error:{ code, message:'Unavailable fixture' } })));
        const response = await search();
        expect(response.success).toBe(true);
        expect(response.discoveryStatus).toContain('connection unavailable');
        const saved = response.results.find(row => row.metadata?.savedBookmark);
        expect(await select(saved)).toMatchObject({ success:true });
        expect(chromeMock.tabs.create).toHaveBeenCalledExactlyOnceWith({ url:'https://saved.test/' });
        chromeMock.tabs.create.mockClear();
        chromeMock.storage.local.get.mockResolvedValue({});
        expect(await select(saved)).toMatchObject({ success:false });
        expect(chromeMock.tabs.create).not.toHaveBeenCalled();
        expect(chromeMock.tabs.update).not.toHaveBeenCalled();
    });
    it('rejects pairing changes during a tree read and refreshes imports/reorders without cached trees', async () => {
        let peer = '';
        chromeMock.storage.local.get.mockImplementation(async () => ({ arcifyBridgePeerId:peer }));
        chromeMock.bookmarks.getTree.mockImplementationOnce(async () => { peer=peerId; return tree(); });
        expect(await search()).toMatchObject({ success:false, results:[] });
        peer=''; chromeMock.bookmarks.getTree.mockResolvedValue(tree());
        const first = await search();
        const changed = tree(); changed[0].children[0].children[0].children[0].title='Example imported';
        chromeMock.bookmarks.getTree.mockResolvedValue(changed);
        const second = await search();
        expect(second.results.find(row => row.metadata?.savedBookmark).title).toBe('Example imported');
        expect(await select(first.results.find(row => row.metadata?.savedBookmark))).toMatchObject({ success:false });
    });
});

describe('explicit unavailable bookmark selection versus paired replay', () => {
    it('never retries an uncertain paired mutation but permits a new fallback selection', async () => {
        let offline=false; let mutations=0;
        chromeMock.bookmarks.getTree.mockResolvedValue([{id:'root',children:[{id:'a',title:'Arcify',children:[{id:'saved',title:'Example saved',url:'https://saved.test/'}]}]}]);
        chromeMock.runtime.sendMessage.mockImplementation((id,request,callback)=>{
            if (!['hello','snapshot'].includes(request.command)) { mutations++; offline=true; callback(respond(request,{ok:false,error:{code:'TIMEOUT',message:'Uncertain paired result'}})); }
            else callback(respond(request,offline?{ok:false,error:{code:'UNAVAILABLE',message:'Offline'}}:{}));
        });
        const search=()=>callInternal({action:'getLocalSuggestions',query:'example',mode:'new-tab'});
        const select=row=>callInternal({action:'spotlightHandleResult',result:row,mode:'new-tab'});
        const paired=(await search()).results.find(row=>row.metadata?.arcifyBridge?.kind==='bookmark');
        expect(await select(paired)).toMatchObject({success:false,errorCode:'TIMEOUT'});
        expect(chromeMock.tabs.create).not.toHaveBeenCalled();
        const fallback=(await search()).results.find(row=>row.metadata?.bookmarkFallback);
        expect(await select(fallback)).toMatchObject({success:true});
        expect(mutations).toBe(1);
        expect(chromeMock.tabs.create).toHaveBeenCalledExactlyOnceWith({url:'https://saved.test/'});
    });
    it('keeps ordinary bookmark fallback useful for ambiguous roots and rejects a recovered peer', async () => {
        chromeMock.bookmarks.getTree.mockResolvedValue([{id:'a',title:'Arcify',children:[{id:'one',title:'Example ordinary',url:'https://ordinary.test/'}]},{id:'b',title:'Arcify',children:[]}]);
        chromeMock.runtime.sendMessage.mockImplementation((id,request,callback)=>callback(respond(request,{ok:false,error:{code:'UNAVAILABLE',message:'Offline'}})));
        const response=await callInternal({action:'getLocalSuggestions',query:'example',mode:'new-tab'});
        const row=response.results.find(x=>x.metadata?.bookmarkFallback);
        expect(row.metadata.savedBookmark).toBeUndefined();
        expect(response.discoveryStatus).toContain('ambiguous');
        expect(await callInternal({action:'spotlightHandleResult',result:row,mode:'new-tab'})).toMatchObject({success:true});
        chromeMock.tabs.create.mockClear();
        chromeMock.runtime.sendMessage.mockImplementation((id,request,callback)=>callback(respond(request)));
        expect(await callInternal({action:'spotlightHandleResult',result:row,mode:'new-tab'})).toMatchObject({success:false,error:expect.stringContaining('reconnected')});
        expect(chromeMock.tabs.create).not.toHaveBeenCalled();
    });
});
