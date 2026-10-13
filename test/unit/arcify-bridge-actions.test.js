import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleBridgeResult } from '../../shared/arcify-bridge-actions.js';

const peerId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const context = { windowId: 2, tabId: 20 };
const snapshot = { windowId: 2, tabs: [{ id: 20, windowId: 2 }, { id: 21, windowId: 2 }], spaces: [] };
let bridge;
let api;
beforeEach(() => {
    bridge = {
        getPeerId: vi.fn().mockResolvedValue(peerId), snapshot: vi.fn().mockResolvedValue(snapshot),
        request: vi.fn().mockResolvedValue({ tabId: 25 }), serializeAction: callback => callback()
    };
    api = { search: { query: vi.fn().mockResolvedValue(undefined) }, tabs: { get: vi.fn().mockResolvedValue({ id: 20, windowId: 2 }), create: vi.fn(), update: vi.fn() } };
});
const owned = (kind, values = {}) => ({ type: 'bookmark', url: 'https://example.com', metadata: { arcifyBridge: { kind, peerId, windowId: 2, spaceId: 'work', ...values } } });

describe('authoritative Arcify action routing', () => {
    it('leaves standalone actions to the upstream router when not configured', async () => {
        bridge.getPeerId.mockResolvedValue(null);
        expect(await handleBridgeResult(bridge, api, {}, 'new-tab', context)).toBe(false);
        expect(bridge.snapshot).not.toHaveBeenCalled();
    });
    it('rejects old paired results when integration is disabled', async () => {
        bridge.getPeerId.mockResolvedValue(null);
        await expect(handleBridgeResult(bridge, api, owned('bookmark', { bookmarkId: 'pin' }), 'new-tab', context)).rejects.toMatchObject({ code: 'STALE_RESULT' });
        expect(bridge.request).not.toHaveBeenCalled();
    });
    it.each(['current-tab', 'new-tab'])('activates the same owned tab in %s mode', async mode => {
        await handleBridgeResult(bridge, api, owned('tab', { tabId: 21 }), mode, context);
        expect(bridge.request).toHaveBeenCalledExactlyOnceWith('activateTab', 2, { tabId: 21 }, peerId);
        expect(bridge.snapshot).toHaveBeenCalledExactlyOnceWith(2, peerId);
    });
    it('opens closed pins by workspace and bookmark identity rather than URL', async () => {
        await handleBridgeResult(bridge, api, owned('bookmark', { bookmarkId: 'pin-1' }), 'current-tab', context);
        expect(bridge.request).toHaveBeenCalledExactlyOnceWith('openBookmark', 2, { spaceId: 'work', bookmarkId: 'pin-1' }, peerId);
    });
    it('activates workspaces by ID', async () => {
        await handleBridgeResult(bridge, api, owned('space'), 'new-tab', context);
        expect(bridge.request).toHaveBeenCalledExactlyOnceWith('activateSpace', 2, { spaceId: 'work' }, peerId);
    });
    it('navigates only the caller tab, preserving its workspace', async () => {
        await handleBridgeResult(bridge, api, { type: 'history', url: 'https://example.com' }, 'current-tab', context);
        expect(bridge.request).toHaveBeenCalledExactlyOnceWith('navigateTab', 2, { tabId: 20, url: 'https://example.com' }, peerId);
    });
    it('opens ordinary new tabs in Arcify’s active workspace', async () => {
        await handleBridgeResult(bridge, api, { type: 'url-suggestion', url: 'https://example.com' }, 'new-tab', context);
        expect(bridge.request).toHaveBeenCalledExactlyOnceWith('openTab', 2, { url: 'https://example.com' }, peerId);
    });
    it.each(['current-tab', 'new-tab'])('rejects unsupported generic navigation in %s mode before dispatch', async mode => {
        for (const type of ['history', 'bookmark', 'top-site', 'url-suggestion', 'autocomplete-suggestion']) {
            for (const url of [`chrome-extension://${peerId}/startup-launcher.html`,
                `chrome-extension://${peerId}/startup-launcher.html/`,
                `chrome-extension://${peerId}/dist/startup-launcher.html`,
                'javascript:alert(1)', 'data:text/html,hello', 'https://example.test/' + 'x'.repeat(16384)]) {
                await expect(handleBridgeResult(bridge, api, { type, url, metadata: { isUrl: true } }, mode, context))
                    .rejects.toMatchObject({ code: 'UNSUPPORTED_URL', message: expect.stringContaining('cannot be opened through the Arcify connection') });
            }
        }
        expect(bridge.request).not.toHaveBeenCalled();
        expect(api.tabs.create).not.toHaveBeenCalled();
        expect(api.tabs.update).not.toHaveBeenCalled();
        expect(api.search.query).not.toHaveBeenCalled();
    });
    it.each(['http://example.test/', 'https://example.test/', 'file:///tmp/notes.txt', 'chrome://settings/', 'about:blank'])('retains supported generic navigation to %s', async url => {
        await handleBridgeResult(bridge, api, { type: 'bookmark', url }, 'new-tab', context);
        expect(bridge.request).toHaveBeenCalledExactlyOnceWith('openTab', 2, { url }, peerId);
    });
    it.each(['open-tab', 'pinned-tab'])('activates a live extension %s by identity rather than rejecting its URL', async type => {
        const url = `chrome-extension://${peerId}/options.html`;
        for (const result of [
            { ...owned('tab', { tabId: 21 }), type, url },
            { type, url, metadata: { tabId: 21 } }
        ]) {
            await expect(handleBridgeResult(bridge, api, result, 'current-tab', context))
                .resolves.toMatchObject({ handled: true, command: 'activateTab' });
        }
        expect(bridge.request).toHaveBeenCalledTimes(2);
        expect(bridge.request).toHaveBeenLastCalledWith('activateTab', 2, { tabId: 21 }, peerId);
    });
    it('leaves authoritative saved pins to Arcify for fresh bookmark validation', async () => {
        const result = { ...owned('bookmark', { bookmarkId: 'pin-1' }), url: `chrome-extension://${peerId}/options.html` };
        await handleBridgeResult(bridge, api, result, 'new-tab', context);
        expect(bridge.request).toHaveBeenCalledExactlyOnceWith('openBookmark', 2, { spaceId: 'work', bookmarkId: 'pin-1' }, peerId);
    });
    it('leaves standalone extension URL navigation to the upstream router', async () => {
        bridge.getPeerId.mockResolvedValue(null);
        expect(await handleBridgeResult(bridge, api, { type: 'history', url: `chrome-extension://${peerId}/options.html` }, 'new-tab', context)).toBe(false);
        expect(bridge.snapshot).not.toHaveBeenCalled();
        expect(bridge.request).not.toHaveBeenCalled();
    });
    it.each(['search-query', 'autocomplete-suggestion'])('uses Chrome default search engine for %s', async type => {
        await handleBridgeResult(bridge, api, { type, metadata: { query: 'hello world' } }, 'new-tab', context);
        expect(bridge.request).toHaveBeenCalledExactlyOnceWith('openTab', 2, { url: 'about:blank' }, peerId);
        expect(api.search.query).toHaveBeenCalledExactlyOnceWith({ text: 'hello world', tabId: 25 });
    });
    it('validates current-tab search against fresh Arcify state without blanking the page', async () => {
        await handleBridgeResult(bridge, api, { type: 'search-query', metadata: { query: 'hello' } }, 'current-tab', context);
        expect(bridge.snapshot).toHaveBeenCalledExactlyOnceWith(2, peerId);
        expect(api.tabs.get).toHaveBeenCalledExactlyOnceWith(20);
        expect(bridge.request).not.toHaveBeenCalled();
        expect(api.tabs.update).not.toHaveBeenCalled();
        expect(api.search.query).toHaveBeenCalledExactlyOnceWith({ text: 'hello', tabId: 20 });
    });
    it('rejects a stale tab result rather than creating a duplicate', async () => {
        await expect(handleBridgeResult(bridge, api, owned('tab', { tabId: 99 }), 'new-tab', context)).rejects.toMatchObject({ code: 'STALE_RESULT' });
        expect(bridge.request).not.toHaveBeenCalled();
    });
    it('rejects results from another window', async () => {
        await expect(handleBridgeResult(bridge, api, owned('tab', { tabId: 21, windowId: 3 }), 'new-tab', context)).rejects.toMatchObject({ code: 'WRONG_WINDOW' });
        expect(bridge.request).not.toHaveBeenCalled();
    });
    it('rejects results from a previously paired peer', async () => {
        await expect(handleBridgeResult(bridge, api, owned('tab', { tabId: 21, peerId: 'cccccccccccccccccccccccccccccccc' }), 'new-tab', context)).rejects.toMatchObject({ code: 'STALE_RESULT' });
        expect(bridge.request).not.toHaveBeenCalled();
    });
    it('does not retry or perform native navigation after an uncertain timeout', async () => {
        bridge.request.mockRejectedValue(Object.assign(new Error('Uncertain'), { code: 'TIMEOUT' }));
        await expect(handleBridgeResult(bridge, api, owned('bookmark', { bookmarkId: 'b' }), 'new-tab', context)).rejects.toMatchObject({ code: 'TIMEOUT' });
        expect(bridge.request).toHaveBeenCalledTimes(1);
        expect(api.tabs.create).not.toHaveBeenCalled();
        expect(api.tabs.update).not.toHaveBeenCalled();
    });
    it('does not dispatch commands when fresh snapshot fetch fails', async () => {
        bridge.snapshot.mockRejectedValue(new Error('Disconnected'));
        await expect(handleBridgeResult(bridge, api, owned('tab', { tabId: 21 }), 'new-tab', context)).rejects.toThrow('Disconnected');
        expect(bridge.request).not.toHaveBeenCalled();
    });
    it('rejects disabled connection while a queued action was waiting', async () => {
        bridge.getPeerId.mockResolvedValueOnce(peerId).mockResolvedValue(null);
        await expect(handleBridgeResult(bridge, api, owned('tab', { tabId: 21 }), 'new-tab', context)).rejects.toMatchObject({ code: 'DISCONNECTED' });
    });
    it('requires a returned search tab ID before calling chrome.search', async () => {
        bridge.request.mockResolvedValue({});
        await expect(handleBridgeResult(bridge, api, { type: 'search-query', metadata: { query: 'hello' } }, 'new-tab', context)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
        expect(api.search.query).not.toHaveBeenCalled();
    });
    it('rejects invalid mode and missing URL/query before mutation', async () => {
        await expect(handleBridgeResult(bridge, api, {}, 'invalid', context)).rejects.toMatchObject({ code: 'INVALID_MODE' });
        await expect(handleBridgeResult(bridge, api, { type: 'history' }, 'new-tab', context)).rejects.toMatchObject({ code: 'INVALID_URL' });
        await expect(handleBridgeResult(bridge, api, { type: 'search-query' }, 'new-tab', context)).rejects.toMatchObject({ code: 'INVALID_QUERY' });
        expect(bridge.request).not.toHaveBeenCalled();
    });
});
