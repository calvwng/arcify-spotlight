// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromeMock } from '../mocks/chrome.js';
import { splitScope, PEER } from '../fixtures/split-actions.js';
import './setup.js';
let page;
beforeEach(() => {
    document.body.innerHTML = '<div id="spotlight-container"></div>';
    Object.defineProperty(document, 'URL', { configurable: true, value: chromeMock.runtime.getURL('newtab.html') });
    HTMLElement.prototype.scrollIntoView = vi.fn(); chromeMock.tabs.getCurrent = vi.fn().mockResolvedValue({ id: 9 });
    chromeMock.storage.local.get.mockResolvedValue({ arcifyBridgePeerId: PEER, arcifyBridgePairingGeneration: 'local' });
    chromeMock.runtime.sendMessage.mockImplementation(async message => {
        // Even a mistakenly offered valid Split context cannot target another tab.
        if (message.action === 'arcifySplitActionsContext') return { success: true, scope: splitScope() };
        if (['arcifyTabActionsContext', 'arcifySpaceActionsContext', 'arcifyArchiveContext'].includes(message.action)) return { success: true, scope: null };
        if (message.action === 'arcifyBridgeStatus') return { success: true, status: { status: 'connected', peerId: PEER, capabilities: [] } };
        return { success: true, results: [] };
    });
});
afterEach(() => { page?.dispose(); page = null; vi.restoreAllMocks(); delete HTMLElement.prototype.scrollIntoView; });
describe('Split on the real helper/newtab renderer', () => {
    it.each(['split', 'end split', 'split tab'])('does not offer or dispatch %s and never guesses prior tab', async query => {
        const { initializeSpotlight } = await import('../../newtab.js'); page = await initializeSpotlight(); await page.splitActions.ready;
        page.input.value = query; page.input.dispatchEvent(new Event('input', { bubbles: true }));
        expect(page.resultsContainer.querySelector('[data-result-type="arcify-split-action"]')).toBeNull();
        expect(chromeMock.runtime.sendMessage.mock.calls.some(([message]) => ['arcifySplitActionsContext', 'arcifySplitAction'].includes(message.action))).toBe(false);
        expect(chromeMock.tabs.query).not.toHaveBeenCalled();
    });
});
