import { describe, it, expect } from 'vitest';
import { validateSnapshot } from '../../shared/arcify-bridge.js';
import { ArcifyBridgeProvider } from '../../shared/data-providers/arcify-bridge-provider.js';

function snapshot() {
    return {
        windowId: 1, capturedAt: Date.now(), activeSpaceId: 'work',
        spaces: [
            { id: 'work', name: 'Work', color: 'blue', tabIds: [2, 1], pinnedTabIds: [2], temporaryTabIds: [1] },
            { id: 'home', name: 'Home', color: 'green', tabIds: [3], pinnedTabIds: [], temporaryTabIds: [3] }
        ],
        tabs: [1, 2, 3, 4, 5].map(id => ({ id, windowId: 1, title: `Tab ${id}`, url: 'https://example.com', active: id === 1, pinned: id === 4, spaceId: id < 3 ? 'work' : id === 3 ? 'home' : null })),
        bookmarks: [{ id: 'b', spaceId: 'work', title: 'Pin', url: 'https://example.com', tabId: 2 }]
    };
}

describe('snapshot membership integrity', () => {
    it('allows global favorites and unowned extension pages without workspace membership', () => {
        expect(validateSnapshot(snapshot(), 1)).toBeTruthy();
    });
    it.each([
        ['duplicate ordered ID', value => value.spaces[0].tabIds.push(2)],
        ['duplicate pinned ID', value => value.spaces[0].pinnedTabIds.push(2)],
        ['overlapping pin/temp membership', value => value.spaces[0].temporaryTabIds.push(2)],
        ['missing union member', value => { value.spaces[0].temporaryTabIds = []; }],
        ['foreign ownership', value => { value.tabs[1].spaceId = 'home'; }],
        ['unlisted owned tab', value => { value.tabs[4].spaceId = 'work'; }],
        ['null tab listed in a space', value => { value.tabs[0].spaceId = null; }],
        ['unknown tab in membership', value => { value.spaces[0].tabIds.push(99); value.spaces[0].temporaryTabIds.push(99); }],
        ['tab in two spaces', value => { value.spaces[1].tabIds.push(2); value.spaces[1].temporaryTabIds.push(2); }],
        ['bookmark wrong workspace', value => { value.bookmarks[0].spaceId = 'home'; }],
        ['bookmark bound to temporary tab', value => { value.bookmarks[0].tabId = 1; }]
    ])('rejects %s', (_name, mutate) => {
        const value = snapshot(); mutate(value);
        expect(() => validateSnapshot(value, 1)).toThrow();
    });
    it('validates partial bookmark warnings without invalidating live tabs', () => {
        const value = snapshot();
        value.warnings = [{ code: 'BOOKMARKS_UNAVAILABLE', spaceId: 'work', message: 'Folder unavailable.' }];
        expect(validateSnapshot(value, 1).tabs).toHaveLength(5);
        value.warnings[0].spaceId = 'missing';
        expect(() => validateSnapshot(value, 1)).toThrow();
    });
    it('preserves authoritative per-space order rather than native tab order', async () => {
        const provider = new ArcifyBridgeProvider(snapshot(), { autocompleteProvider: {} });
        expect((await provider.getOpenTabs()).map(result => result.metadata.tabId)).toEqual([2, 1, 3, 4, 5]);
    });
});
