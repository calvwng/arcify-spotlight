import { beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeBrowserPageUrl } from '../../shared/browser-page-url.js';
import { isSafeUrl } from '../../shared/arcify-bridge-protocol.js';
import { SpotlightUtils } from '../../shared/ui-utilities.js';
import { SearchEngine } from '../../shared/search-engine.js';
import { AutocompleteProvider } from '../../shared/data-providers/autocomplete-provider.js';
import { handleBridgeResult } from '../../shared/arcify-bridge-actions.js';

const allowed = [
    'chrome://settings', 'chrome://settings/', 'chrome://settings/appearance',
    'chrome://settings/searchEngines', 'chrome://history/', 'chrome://downloads',
    'chrome://bookmarks/?id=123', 'chrome://extensions/', 'chrome://version',
    'chrome://newtab/', 'chrome://new-tab-page/'
];
const blocked = [
    'chrome://quit', 'chrome://restart/', 'chrome://crash', 'chrome://hang', 'chrome://flags',
    'chrome://settings/reset', 'chrome://settings/clearBrowserData', 'chrome://settings/../quit',
    'chrome://settings/%2e%2e/quit', 'chrome://%73ettings/', 'chrome://settings.evil/',
    'chrome://settings@evil/', 'chrome://user@settings/', 'chrome://settings:80/',
    'chrome:settings', 'chrome:/settings', 'chrome:///settings', ' chrome://settings',
    'chrome://settings\n', 'chrome://settings\\privacy', 'chrome://settings#quit',
    'chrome://settings/?url=chrome://quit', 'chrome://bookmarks/?id=1&extra=2'
];
describe('explicit browser-page URLs', () => {
    for (const chromeUrl of allowed) {
        for (const value of [chromeUrl, chromeUrl.replace('chrome:', 'helium:')]) {
            it(`offers canonical native navigation for ${value}`, () => {
                expect(normalizeBrowserPageUrl(value)).toBe(chromeUrl);
                expect(isSafeUrl(value)).toBe(true);
                expect(SpotlightUtils.generateInstantSuggestion(value)).toMatchObject({ type: 'url-suggestion', url: chromeUrl });
            });
        }
    }
    for (const chromeUrl of blocked) {
        for (const value of [chromeUrl, chromeUrl.replace('chrome:', 'helium:')]) {
            it(`rejects internal ambiguity or command ${JSON.stringify(value)}`, () => {
                expect(normalizeBrowserPageUrl(value)).toBeNull();
                expect(isSafeUrl(value)).toBe(false);
            });
        }
    }
    it('does not send explicit browser-page input to autocomplete fetch', async () => {
        const provider = new AutocompleteProvider();
        const fetchSuggestions = vi.spyOn(provider, 'fetchAutocompleteSuggestions');
        for (const query of ['chrome://settings', 'helium://settings', 'chrome://quit', 'chrome:']) {
            expect(await provider.getAutocompleteSuggestions(query)).toEqual([]);
        }
        expect(fetchSuggestions).not.toHaveBeenCalled();
    });
});

describe('browser-page dispatch', () => {
    let engine, bridge;
    const peer = 'a'.repeat(32), context = { tabId: 42, windowId: 2 };
    beforeEach(() => {
        engine = new SearchEngine({ isBackgroundProvider: true });
        bridge = {
            getPeerId: vi.fn(async () => peer), serializeAction: fn => fn(),
            snapshot: vi.fn(), request: vi.fn(async () => ({ tabId: 42 }))
        };
    });
    it.each(['current-tab', 'new-tab'])('uses native tabs API for standalone %s', async mode => {
        await engine.handleResultAction({ type: 'url-suggestion', url: 'helium://settings' }, mode, 42);
        if (mode === 'new-tab') expect(chrome.tabs.create).toHaveBeenCalledExactlyOnceWith({ url: 'chrome://settings' });
        else expect(chrome.tabs.update).toHaveBeenCalledExactlyOnceWith(42, { url: 'chrome://settings' });
        expect(chrome.search.query).not.toHaveBeenCalled();
    });
    it.each(['current-tab', 'new-tab'])('uses authenticated Arcify navigation for paired %s', async mode => {
        await handleBridgeResult(bridge, chrome, { type: 'url-suggestion', url: 'helium://settings' }, mode, context);
        expect(bridge.request).toHaveBeenCalledExactlyOnceWith(mode === 'new-tab' ? 'openTab' : 'navigateTab', 2,
            mode === 'new-tab' ? { url: 'chrome://settings' } : { tabId: 42, url: 'chrome://settings' }, peer);
        expect(bridge.snapshot).not.toHaveBeenCalled();
        expect(chrome.search.query).not.toHaveBeenCalled();
        expect(chrome.tabs.create).not.toHaveBeenCalled();
        expect(chrome.tabs.update).not.toHaveBeenCalled();
    });
    it('rejects forbidden URLs before any standalone or paired native mutation', async () => {
        for (const url of [...blocked, 'javascript:alert(1)', 'data:text/html,test', 'chrome-extension://' + peer + '/options.html']) {
            const result = { type: 'url-suggestion', url };
            await expect(engine.handleResultAction(result, 'new-tab', 42)).rejects.toThrow();
            await expect(handleBridgeResult(bridge, chrome, result, 'new-tab', context)).rejects.toThrow();
        }
        expect(bridge.request).not.toHaveBeenCalled();
        expect(chrome.tabs.create).not.toHaveBeenCalled();
        expect(chrome.tabs.update).not.toHaveBeenCalled();
        expect(chrome.search.query).not.toHaveBeenCalled();
    });
});
