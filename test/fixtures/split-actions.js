export const OWN = 'a'.repeat(32), PEER = 'b'.repeat(32);
export const clone = value => structuredClone(value);
export const source = { tabId: 9, windowId: 2 };
export const descriptor = (id = 9, index = id - 9, splitViewId = -1) => ({ id, url: 'https://same.example/', title: 'Same title', index, groupId: 4, pinned: false, splitViewId });
export const splitScope = (paired = false) => ({ peerId: PEER, generation: 'local', epoch: 0,
    context: { windowId: 2, spaceId: 'space', bookmarkFolderId: 'root', pairingGeneration: 'peer', sourceTabId: 9,
        tab: descriptor(9, 0, paired ? 7 : -1), pair: paired ? [descriptor(9, 0, 7), descriptor(10, 1, 7)] : [] },
    targets: paired ? [] : [descriptor(10, 1), descriptor(11, 2)] });
export const snapshot = (scope = splitScope()) => ({ windowId: 2, activeSpaceId: 'space', capturedAt: 1,
    spaces: [{ id: 'space', name: 'Work', color: 'purple', bookmarkFolderId: 'root', tabIds: [9, 10, 11], pinnedTabIds: [], temporaryTabIds: [9, 10, 11] }],
    tabs: [9, 10, 11].map(id => ({ id, windowId: 2, spaceId: 'space', title: [scope.context.tab, ...scope.context.pair, ...scope.targets].find(tab => tab?.id === id)?.title || 'Same title', url: 'https://same.example/', active: id === scope.context.sourceTabId, pinned: false })), bookmarks: [], favorites: [] });
export const envelope = extra => ({ type: 'arcify-bridge', version: 1, requestId: 'test', role: 'arcify', ok: true, ...extra });
export const splitResult = (command = 'createSplitView', scope = splitScope(), target = scope.targets[0]) => ({
    action: command === 'createSplitView' ? 'create' : 'end', windowId: 2, spaceId: 'space', sourceTabId: scope.context.sourceTabId,
    tabIds: (command === 'createSplitView' ? [scope.context.tab, target].sort((a, b) => a.index - b.index) : scope.context.pair).map(tab => tab.id),
    splitViewId: command === 'createSplitView' ? 7 : -1, reordered: command === 'createSplitView' && Math.abs(scope.context.tab.index - target.index) !== 1
});
