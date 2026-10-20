// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { SharedSpotlightLogic } from '../../shared/shared-component-logic.js';
import { SelectionManager } from '../../shared/selection-manager.js';

// Exercise the actual renderer in its own document, as used by the overlay.
// Native Tab movement remains covered by paired real-Chrome case 24.
let realm, doc, input, container, settings;
const search = { type: 'search-query', title: 'Search for "w window"', url: '', metadata: { query: 'w window' } };
const tab = id => ({ type: 'open-tab', title: 'Same address', url: 'https://same.test/', metadata: { tabId: id } });
const render = (before, after) => SharedSpotlightLogic.updateResultsDisplay(container, before, after, 'new-tab', null, input);
beforeEach(() => {
    realm = new JSDOM('<!doctype html><html><body><input value="w window"><div id="results"></div><button id="settings">Connection settings</button></body></html>').window;
    doc = realm.document; input = doc.querySelector('input'); container = doc.getElementById('results'); settings = doc.getElementById('settings');
    realm.HTMLElement.prototype.scrollIntoView = () => {};
});
afterEach(() => { realm.close(); vi.restoreAllMocks(); });

describe('focused result refresh in the isolated document', () => {
    it('keeps the identical focused result through a no-op asynchronous render', () => {
        render([], [search]);
        const original = container.querySelector('button'); original.focus();
        expect(doc.activeElement).toBe(original);
        expect(render([search], [structuredClone(search)])).toBe(false);
        expect(original.isConnected).toBe(false);
        expect(doc.activeElement).toBe(container.querySelector('button'));
        expect(input.value).toBe('w window');
    });
    it('restores exact identity after reorder without changing manual selection or the input draft', () => {
        const one = tab(1), two = tab(2), manager = new SelectionManager(container);
        render([], [one, two]); manager.updateResults([one, two]); manager.selectedIndex = 1;
        input.setSelectionRange(2, 5); container.querySelectorAll('button')[1].focus();
        manager.updateResults([two, one], { preserveSelection: true });
        render([one, two], [two, one]); manager.updateVisualSelection();
        expect(doc.activeElement.dataset.index).toBe('0');
        expect(manager.getSelectedResult()).toBe(two);
        expect([input.value, input.selectionStart, input.selectionEnd]).toEqual(['w window', 2, 5]);
    });
    it.each([{ next: [tab(2)] }, { next: [] }])('falls back to the input when the focused identity disappears: $next', ({ next }) => {
        const one = tab(1); render([], [one]); container.querySelector('button').focus();
        expect(render([one], next)).toBe(true);
        expect(doc.activeElement).toBe(input);
        expect(input.value).toBe('w window');
    });
    it('does not guess among duplicate replacement identities', () => {
        render([], [search]); container.querySelector('button').focus();
        expect(render([search], [search, structuredClone(search)])).toBe(true);
        expect(doc.activeElement).toBe(input);
    });
    it.each(['input', 'settings', 'body'])('does not steal focus from %s', target => {
        render([], [search]);
        if (target === 'input') input.focus();
        if (target === 'settings') settings.focus();
        const active = doc.activeElement;
        expect(render([search], [search, tab(2)])).toBe(false);
        expect(doc.activeElement).toBe(active);
    });
    it('does not reclaim a frame or browser document that no longer owns focus', () => {
        render([], [search]); container.querySelector('button').focus();
        vi.spyOn(doc, 'hasFocus').mockReturnValue(false);
        const focus = vi.spyOn(realm.HTMLElement.prototype, 'focus');
        expect(render([search], [search])).toBe(false);
        expect(focus).not.toHaveBeenCalled();
    });
});
