import { snapshot as baseSnapshot, envelope, OWN, PEER, clone } from './split-actions.js';
export { envelope, OWN, PEER, clone };
export const source = { tabId: 9, windowId: 2, url: 'https://same.example/' };
export const transientScope = () => ({ peerId: PEER, generation: 'local', epoch: 0, viewId: 'view-id',
    context: { windowId: 2, sourceTabId: 9, sourceUrl: source.url, spaceId: 'space', bookmarkFolderId: 'root' } });
export const snapshot = () => baseSnapshot();
export const transientResult = () => ({ tabId: 20, transientWindowId: 3, token: 'transient-token' });
