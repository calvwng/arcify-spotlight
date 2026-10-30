export const OWN = 'a'.repeat(32), PEER = 'b'.repeat(32);
export const clone = value => structuredClone(value);
export const source = { tabId: 9, windowId: 2 };
export const archiveScope = () => ({ peerId: PEER, generation: 'local', context: { windowId: 2, spaceId: 'work', bookmarkFolderId: 'work-root', sourceTabId: 9,
    sourceUrl: 'https://source.example/', pairingGeneration: 'remote' }, viewId: 'view-1', openIntent: 'intent-1', entries: [
    { entryId: 'entry-a', title: 'Same archived title', url: 'https://same.example/', spaceId: 'work', bookmarkFolderId: 'work-root', archivedAt: 1 },
    { entryId: 'entry-b', title: 'Same archived title', url: 'https://same.example/', spaceId: 'home', bookmarkFolderId: 'home-root', archivedAt: 2 }
] });
export const spaceNames = [{ spaceId: 'work', name: 'Work' }, { spaceId: 'home', name: 'Home' }];
export function snapshot(reopenedSpace = null) {
    return { windowId: 2, activeSpaceId: reopenedSpace || 'work', capturedAt: 1,
        spaces: spaceNames.map(({ spaceId: id, name }) => ({ id, name, color: 'purple', bookmarkFolderId: `${id}-root`,
            tabIds: [...(id === 'work' ? [9] : []), ...(id === reopenedSpace ? [11] : [])], pinnedTabIds: [],
            temporaryTabIds: [...(id === 'work' ? [9] : []), ...(id === reopenedSpace ? [11] : [])] })),
        tabs: [{ id: 9, windowId: 2, spaceId: 'work', title: 'Source', url: 'https://source.example/', active: !reopenedSpace, pinned: false },
            ...(reopenedSpace ? [{ id: 11, windowId: 2, spaceId: reopenedSpace, title: 'Same archived title', url: 'https://same.example/', active: true, pinned: false }] : [])], bookmarks: [] };
}
export const envelope = extra => ({ type: 'arcify-bridge', version: 1, requestId: 'test', role: 'arcify', ok: true, ...extra });
export const archiveResult = (entryId = 'entry-b') => ({ entryId, tabId: 11, spaceId: entryId === 'entry-b' ? 'home' : 'work', windowId: 2, consumed: true, status: 'reopened', warning: null });
