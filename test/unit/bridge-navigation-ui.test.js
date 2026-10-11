import { describe, it, expect } from 'vitest';
import { shouldCloseNewTab } from '../../shared/bridge-navigation-ui.js';

describe('safe new-tab helper dismissal', () => {
    it('keeps an empty-space switch open so closing cannot activate an older workspace', () => {
        expect(shouldCloseNewTab({ type: 'arcify-space' }, { success: true, bridge: true, command: 'activateSpace', sourceTabId: 42 })).toBe(false);
    });
    it('closes only after a confirmed switch to a distinct tab', () => {
        expect(shouldCloseNewTab({ type: 'arcify-space' }, { success: true, bridge: true, tabId: 43, sourceTabId: 42 })).toBe(true);
        expect(shouldCloseNewTab({ type: 'open-tab' }, { success: true, bridge: true, tabId: 42, sourceTabId: 42 })).toBe(false);
    });
    it('keeps errors and unconfirmed outcomes visible', () => {
        expect(shouldCloseNewTab({ type: 'open-tab' }, { success: false, tabId: 43 })).toBe(false);
        expect(shouldCloseNewTab({ type: 'open-tab' }, undefined)).toBe(false);
        expect(shouldCloseNewTab({ type: 'open-tab' }, { success: true, bridge: true, tabId: 43 })).toBe(false);
    });
    it('preserves standalone successful tab switching and URL navigation', () => {
        expect(shouldCloseNewTab({ type: 'open-tab' }, { success: true })).toBe(true);
        expect(shouldCloseNewTab({ type: 'pinned-tab' }, { success: true })).toBe(true);
        expect(shouldCloseNewTab({ type: 'history' }, { success: true })).toBe(false);
    });
});
