import { describe, it, expect, vi } from 'vitest';
import { ArcifyTabActionsClient, installArcifyTabActionMessages } from '../../shared/arcify-tab-actions.js';
import { validateTabActionContext, validateTabActionPayload, validateTabActionResult } from '../../shared/arcify-tab-actions-protocol.js';
const OWN = 'a'.repeat(32), PEER = 'b'.repeat(32);
const clone = value => structuredClone(value);
const source = { tabId: 9, windowId: 2 };
const base = { windowId: 2, spaceId: 'space', bookmarkFolderId: 'root', pairingGeneration: 'arcify-generation', sourceTabId: 9,
    tab: { id: 9, url: 'https://same.example/', title: 'Example', section: 'today', bookmark: null, alias: '', muted: false } };
const saved = context => { context.tab.section = 'saved'; context.tab.bookmark = { id: 'exact-bookmark', parentId: 'nested', title: 'Example', url: 'https://same.example/' }; return context; };
function snapshot(context = base, duplicate = false) {
    const pin = context.tab?.section === 'saved', ids = duplicate ? [9, 10, 11] : [9, 10];
    return { windowId: 2, activeSpaceId: 'space', capturedAt: 1,
        spaces: [{ id: 'space', name: 'Work', color: 'purple', bookmarkFolderId: 'root', tabIds: ids, pinnedTabIds: pin ? [9] : [], temporaryTabIds: pin ? [10] : ids }],
        tabs: ids.map(id => ({ id, windowId: 2, spaceId: 'space', title: context.tab?.title || 'Example', url: context.tab?.url || 'https://same.example/', active: id === (duplicate ? 11 : 9), pinned: false })),
        bookmarks: pin ? [{ id: context.tab.bookmark.id, spaceId: 'space', title: context.tab.bookmark.title, url: context.tab.bookmark.url, tabId: 9 }] : [] };
}
const envelope = extra => ({ type: 'arcify-bridge', version: 1, requestId: 'test', role: 'arcify', ok: true, ...extra });
function fixture() {
    const stored = { arcifyBridgePeerId: PEER, arcifyBridgePairingGeneration: 'spotlight-generation' };
    const state = { context: clone(base), capabilities: ['globalFavoritesV1', 'spaceActionsV1', 'tabActionsV1'] };
    const api = { storage: { local: { get: vi.fn(async () => clone(stored)) } }, runtime: { id: OWN, getURL: path => `chrome-extension://${OWN}/${path}`, onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
        tabs: { get: vi.fn(async id => ({ id, windowId: 2, active: true, url: 'https://same.example/' })), query: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
        windows: { getLastFocused: vi.fn(), getCurrent: vi.fn() }, bookmarks: { update: vi.fn() } };
    const bridge = { getPeerId: vi.fn(async () => stored.arcifyBridgePeerId || null), timeoutMs: 20, serializeAction: action => action() };
    const send = vi.fn(async (peerId, command, payload) => {
        if (command === 'hello') return envelope({ extensionId: PEER, capabilities: state.capabilities, snapshot: snapshot(state.context) });
        if (command === 'tabActionContext') return envelope({ extensionId: PEER, tabActionContext: clone(state.context), snapshot: snapshot(state.context) });
        const result = command === 'renameCurrentTab' ? { tabId: 9, bookmarkId: state.context.tab.bookmark?.id || null, title: payload.title }
            : command === 'editCurrentPinUrl' ? { tabId: 9, bookmarkId: state.context.tab.bookmark.id, url: payload.url }
            : command === 'duplicateCurrentTab' ? { tabId: 11 }
            : command === 'copyCurrentLink' ? { tabId: 9, copied: true, url: state.context.tab.url }
            : { tabId: 9, muted: payload.muted };
        return envelope({ ...result, snapshot: snapshot(state.context, command === 'duplicateCurrentTab') });
    });
    return { state, stored, api, bridge, send, client: new ArcifyTabActionsClient(api, bridge, send) };
}
const mutations = f => f.send.mock.calls.filter(([, command]) => !['hello', 'tabActionContext'].includes(command));
const fieldsFor = command => command === 'renameCurrentTab' ? { title: 'Named tab' } : command === 'editCurrentPinUrl' ? { url: 'https://new.example/path' } : command === 'setCurrentTabMuted' ? { muted: true } : {};
const commands = ['renameCurrentTab', 'editCurrentPinUrl', 'duplicateCurrentTab', 'copyCurrentLink', 'setCurrentTabMuted'];

describe('optional exact tabActionsV1 adapter', () => {
    it.each(commands)('freshly reads exact identity before %s without native fallback', async command => {
        const f = fixture(); if (command !== 'duplicateCurrentTab') saved(f.state.context); const scope = await f.client.read(source);
        await expect(f.client.execute(source, scope, command, fieldsFor(command))).resolves.toMatchObject({ command });
        expect(f.send.mock.calls.map(([, name]) => name)).toEqual(['hello', 'tabActionContext', 'hello', 'tabActionContext', command]);
        expect(mutations(f)[0][2]).toMatchObject({ context: f.state.context, windowId: 2, ...fieldsFor(command) });
        expect(mutations(f)[0][2].supportedFeatures).toContain('tabActionsV1');
        expect(f.api.tabs.update).not.toHaveBeenCalled(); expect(f.api.tabs.create).not.toHaveBeenCalled(); expect(f.api.tabs.remove).not.toHaveBeenCalled();
        expect(f.api.bookmarks.update).not.toHaveBeenCalled(); expect(f.api.windows.getLastFocused).not.toHaveBeenCalled(); expect(f.api.tabs.query).not.toHaveBeenCalled();
    });
    it('addresses saved metadata by exact bookmark ID even when another tab shares its URL', async () => {
        const f = fixture(); saved(f.state.context); const scope = await f.client.read(source);
        await f.client.execute(source, scope, 'editCurrentPinUrl', { url: 'https://new.example/' });
        expect(mutations(f)[0][2].context.tab).toMatchObject({ id: 9, bookmark: { id: 'exact-bookmark', parentId: 'nested' } });
    });
    it('copies the exact live URL when a saved pin has navigated away from its saved address', async () => {
        const f = fixture(); saved(f.state.context); f.state.context.tab.url = 'https://live.example/elsewhere#fragment';
        const scope = await f.client.read(source);
        await expect(f.client.execute(source, scope, 'copyCurrentLink', {})).resolves.toEqual({ command: 'copyCurrentLink', tabId: 9, copied: true, url: 'https://live.example/elsewhere#fragment' });
        expect(mutations(f)[0][2].context.tab.bookmark.url).toBe('https://same.example/');
    });
    it('rechecks browser source immediately before dispatch and fails closed when that check rejects', async () => {
        const f = fixture(), scope = await f.client.read(source), beforeDispatch = vi.fn(async () => { throw Object.assign(new Error('The source tab moved.'), { code: 'STALE_CONTEXT' }); });
        await expect(f.client.execute(source, scope, 'duplicateCurrentTab', {}, beforeDispatch)).rejects.toHaveProperty('code', 'STALE_CONTEXT');
        expect(beforeDispatch).toHaveBeenCalledTimes(1); expect(mutations(f)).toHaveLength(0);
    });
    it.each(['spaceId', 'bookmarkFolderId', 'pairingGeneration', 'sourceTabId', 'url', 'title', 'alias', 'muted', 'bookmarkId', 'bookmarkParentId'])('rejects context drift in %s before dispatch', async field => {
        const f = fixture(); saved(f.state.context); const scope = await f.client.read(source);
        if (['url', 'title', 'alias'].includes(field)) f.state.context.tab[field] += 'changed';
        else if (field === 'muted') f.state.context.tab.muted = true;
        else if (field === 'bookmarkId') f.state.context.tab.bookmark.id = 'same-url-different-id';
        else if (field === 'bookmarkParentId') f.state.context.tab.bookmark.parentId = 'other-folder';
        else if (field === 'sourceTabId') f.state.context.sourceTabId = 10;
        else f.state.context[field] = 'changed';
        await expect(f.client.execute(source, scope, 'renameCurrentTab', { title: 'Draft' })).rejects.toBeTruthy(); expect(mutations(f)).toHaveLength(0);
    });
    it.each([undefined, [], ['globalFavoritesV1'], ['spaceActionsV1']])('does not expose actions without independent tabActionsV1 capability: %j', async capabilities => {
        const f = fixture(); f.state.capabilities = capabilities;
        expect(await f.client.read(source)).toBeNull(); expect(mutations(f)).toHaveLength(0);
    });
    it('falls back only through read-only hello negotiation when an older peer rejects the feature marker', async () => {
        const f = fixture(), original = f.send.getMockImplementation();
        f.send.mockImplementation(async (peer, command, payload) => {
            if (payload.supportedFeatures) throw Object.assign(new Error('Unexpected request field.'), { code: 'INVALID_REQUEST' });
            f.state.capabilities = []; return original(peer, command, payload);
        });
        expect(await f.client.read(source)).toBeNull(); expect(f.send.mock.calls.map(([, command]) => command)).toEqual(['hello', 'hello', 'hello']);
        expect(mutations(f)).toHaveLength(0);
    });
    it.each(commands)('rejects helper context for %s without inferring a previous tab', async command => {
        const f = fixture(), scope = { peerId: PEER, generation: 'spotlight-generation', context: { ...clone(base), tab: null } };
        await expect(f.client.execute(source, scope, command, fieldsFor(command))).rejects.toBeTruthy();
        expect(mutations(f)).toHaveLength(0); expect(f.api.tabs.query).not.toHaveBeenCalled(); expect(f.api.windows.getLastFocused).not.toHaveBeenCalled();
    });
    it.each(['TIMEOUT', 'INVALID_REQUEST', 'UNAUTHORIZED', 'UNAVAILABLE'])('never replays or falls back after a dispatched %s failure', async code => {
        const f = fixture(), scope = await f.client.read(source), original = f.send.getMockImplementation();
        f.send.mockImplementation((peer, command, ...args) => command === 'duplicateCurrentTab' ? Promise.reject(Object.assign(new Error('Unknown result'), { code })) : original(peer, command, ...args));
        await expect(f.client.execute(source, scope, 'duplicateCurrentTab', {})).rejects.toHaveProperty('code', code);
        expect(mutations(f)).toHaveLength(1); expect(f.api.tabs.create).not.toHaveBeenCalled();
    });
    it.each(['arcifyBridgePeerId', 'arcifyBridgePairingGeneration'])('revokes in-flight context after %s changes', async key => {
        const f = fixture(), original = f.send.getMockImplementation();
        f.send.mockImplementation(async (...args) => { const response = await original(...args); if (args[1] === 'tabActionContext') f.stored[key] = key.endsWith('PeerId') ? '' : 'new-generation'; return response; });
        await expect(f.client.read(source)).rejects.toHaveProperty('code', 'DISCONNECTED'); expect(mutations(f)).toHaveLength(0);
    });
    it('does not accept an old acknowledgement after pairing generation changes', async () => {
        const f = fixture(), scope = await f.client.read(source), original = f.send.getMockImplementation();
        f.send.mockImplementation(async (...args) => { const response = await original(...args); if (args[1] === 'setCurrentTabMuted') f.stored.arcifyBridgePairingGeneration = 'new'; return response; });
        await expect(f.client.execute(source, scope, 'setCurrentTabMuted', { muted: true })).rejects.toHaveProperty('code', 'DISCONNECTED'); expect(mutations(f)).toHaveLength(1);
    });
    it.each([
        ['renameCurrentTab', { tabId: 10, bookmarkId: null, title: 'Named tab' }],
        ['renameCurrentTab', { tabId: 9, bookmarkId: null, title: 'Wrong title' }],
        ['duplicateCurrentTab', { tabId: 9 }],
        ['duplicateCurrentTab', { tabId: 10 }],
        ['copyCurrentLink', { tabId: 9, copied: false, url: base.tab.url }],
        ['copyCurrentLink', { tabId: 9, copied: true, url: 'https://other.example/' }],
        ['setCurrentTabMuted', { tabId: 9, muted: false }],
        ['setCurrentTabMuted', { tabId: 9, muted: true, unexpected: true }]
    ])('rejects invalid exact acknowledgement for %s: %j without replay', async (command, response) => {
        const f = fixture(), scope = await f.client.read(source), original = f.send.getMockImplementation();
        f.send.mockImplementation((peer, name, ...args) => name === command ? envelope({ snapshot: snapshot(), ...response }) : original(peer, name, ...args));
        await expect(f.client.execute(source, scope, command, fieldsFor(command))).rejects.toHaveProperty('code', 'INVALID_RESPONSE'); expect(mutations(f)).toHaveLength(1);
    });
    it.each(['missing-tab', 'other-space', 'saved-pin', 'favorite', 'wrong-window', 'native-pinned', 'wrong-folder'])('rejects duplicate acknowledgement snapshot with %s instead of exact new Today ownership', async failure => {
        const f = fixture(), scope = await f.client.read(source), original = f.send.getMockImplementation();
        const after = snapshot(base, true), space = after.spaces[0], duplicate = after.tabs.find(tab => tab.id === 11);
        if (failure === 'missing-tab') { after.tabs.pop(); space.tabIds = [9, 10]; space.temporaryTabIds = [9, 10]; }
        if (failure === 'other-space') {
            space.tabIds = [9, 10]; space.temporaryTabIds = [9, 10]; duplicate.spaceId = 'other';
            after.spaces.push({ id: 'other', name: 'Other', color: 'blue', bookmarkFolderId: 'other-root', tabIds: [11], pinnedTabIds: [], temporaryTabIds: [11] });
        }
        if (failure === 'saved-pin') {
            space.temporaryTabIds = [9, 10]; space.pinnedTabIds = [11];
            after.bookmarks = [{ id: 'other-pin', spaceId: 'space', title: 'Example', url: base.tab.url, tabId: 11 }];
        }
        if (failure === 'favorite') {
            space.tabIds = [9, 10]; space.temporaryTabIds = [9, 10]; duplicate.spaceId = null;
            after.favorites = [{ id: 'favorite', title: 'Example', url: base.tab.url, sourceBookmarkId: null, tabId: 11 }];
        }
        if (failure === 'wrong-window') duplicate.windowId = 3;
        if (failure === 'native-pinned') duplicate.pinned = true;
        if (failure === 'wrong-folder') space.bookmarkFolderId = 'other-root';
        f.send.mockImplementation((peer, command, ...args) => command === 'duplicateCurrentTab' ? envelope({ tabId: 11, snapshot: after }) : original(peer, command, ...args));
        await expect(f.client.execute(source, scope, 'duplicateCurrentTab', {})).rejects.toHaveProperty('code', 'INVALID_RESPONSE'); expect(mutations(f)).toHaveLength(1);
        expect(f.api.tabs.create).not.toHaveBeenCalled();
    });
    it('rejects unknown and overriding fields before dispatch', async () => {
        const f = fixture(), scope = await f.client.read(source);
        for (const fields of [{ context: scope.context }, { tabId: 10 }, { muted: true }, { url: base.tab.url }]) await expect(f.client.execute(source, scope, 'duplicateCurrentTab', fields)).rejects.toHaveProperty('code', 'INVALID_REQUEST');
        expect(mutations(f)).toHaveLength(0);
    });
});

describe('tab-action input and exact-result contracts', () => {
    it('allows Today alias reset but requires a saved-pin title', () => {
        expect(() => validateTabActionPayload('renameCurrentTab', { context: clone(base), title: '' })).not.toThrow();
        expect(() => validateTabActionPayload('renameCurrentTab', { context: saved(clone(base)), title: '' })).toThrow();
    });
    it.each([' x', 'x ', 'x\n', 'x\u0000y', 'x'.repeat(257)])('rejects untrimmed/control/overlong title %j', title => {
        expect(() => validateTabActionPayload('renameCurrentTab', { context: clone(base), title })).toThrow();
    });
    it.each(['', 'example.com', '//example.com', 'https:example.com', 'https://', ' https://example.com', 'https://example.com ', 'https://example.com/\npath', 'javascript:alert(1)', 'data:text/html,hello', 'https://example.com/' + 'x'.repeat(16384)])('rejects unsupported or incomplete URL %j', url => {
        expect(() => validateTabActionPayload('editCurrentPinUrl', { context: saved(clone(base)), url })).toThrow();
    });
    it.each(['https://EXAMPLE.com', 'HTTPS://new.example/', 'https://example.com', 'https://example.com/a/../b'])('requires canonical URL payload %j so persisted and acknowledged values remain exact', url => {
        expect(() => validateTabActionPayload('editCurrentPinUrl', { context: saved(clone(base)), url })).toThrow();
    });
    it('rejects URL editing for Today tabs, saved-pin duplication, and nonboolean mute requests', () => {
        expect(() => validateTabActionPayload('duplicateCurrentTab', { context: saved(clone(base)) })).toThrow();
        expect(() => validateTabActionPayload('editCurrentPinUrl', { context: clone(base), url: 'https://new.example/' })).toThrow();
        for (const muted of [0, 1, 'true', null]) expect(() => validateTabActionPayload('setCurrentTabMuted', { context: clone(base), muted })).toThrow();
    });
    it('validates exact saved bookmark ID and input echo in acknowledgements', () => {
        const context = saved(clone(base)), fields = { url: 'https://new.example/' };
        const valid = { command: 'editCurrentPinUrl', tabId: 9, bookmarkId: 'exact-bookmark', url: fields.url };
        expect(() => validateTabActionResult('editCurrentPinUrl', valid, context, fields)).not.toThrow();
        for (const patch of [{ bookmarkId: 'same-url-other-pin' }, { url: base.tab.url }, { tabId: 10 }, { extra: true }]) expect(() => validateTabActionResult('editCurrentPinUrl', { ...valid, ...patch }, context, fields)).toThrow();
    });
    it('rejects malformed nested identity, metadata, alias, and mute state', () => {
        for (const change of [context => context.extra = true, context => context.tab.id = 10, context => context.tab.url = 'javascript:alert(1)', context => context.tab.section = 'favorite', context => context.tab.alias = null, context => context.tab.alias = 'x\n', context => context.tab.muted = 'false', context => context.sourceTabId = 0]) {
            const context = clone(base); change(context); expect(() => validateTabActionContext(context, 2, 9)).toThrow();
        }
    });
});

describe('isolated tab-action local-message boundary', () => {
    it('rejects unknown local fields before any source lookup or dispatch', async () => {
        const f = fixture(); installArcifyTabActionMessages(f.api, f.bridge);
        const listener = f.api.runtime.onMessage.addListener.mock.calls[0][0], respond = vi.fn();
        expect(listener({ action: 'spotlightHandleResult' }, {}, respond)).toBe(false);
        expect(listener({ action: 'arcifyTabAction', command: 'duplicateCurrentTab', scope: {}, fields: {}, surprise: true }, { id: OWN }, respond)).toBe(true);
        await vi.waitFor(() => expect(respond).toHaveBeenCalledWith(expect.objectContaining({ success: false, errorCode: 'INVALID_REQUEST' })));
        expect(f.api.tabs.get).not.toHaveBeenCalled(); expect(f.api.tabs.query).not.toHaveBeenCalled(); expect(f.api.windows.getLastFocused).not.toHaveBeenCalled();
    });
    it.each([{ id: OWN, url: `chrome-extension://${OWN}/newtab.html` }, { id: OWN, tab: { id: 9, windowId: 2 }, frameId: 1 }, { id: PEER, tab: { id: 9, windowId: 2 } }])('rejects missing source, subframe, or foreign sender without active/last-focused lookup: %j', async sender => {
        const f = fixture(); installArcifyTabActionMessages(f.api, f.bridge);
        const listener = f.api.runtime.onMessage.addListener.mock.calls[0][0], respond = vi.fn();
        listener({ action: 'arcifyTabActionsContext' }, sender, respond);
        await vi.waitFor(() => expect(respond).toHaveBeenCalledWith(expect.objectContaining({ success: false, errorCode: 'UNAUTHORIZED' })));
        expect(f.api.tabs.query).not.toHaveBeenCalled(); expect(f.api.windows.getLastFocused).not.toHaveBeenCalled(); expect(f.api.windows.getCurrent).not.toHaveBeenCalled();
    });
});
