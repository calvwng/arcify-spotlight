import { FuseSearchService } from './fuse-search-service.js';

export const FOLDER_RESULT_TYPE = 'bookmark-folder-action';
export function flattenFolders(tree) {
    const folders = [];
    const visit = (nodes, ancestors = []) => {
        for (const node of nodes || []) {
            if (node.url) continue;
            const path = [...ancestors, node.title || 'Bookmarks'];
            if (node.id !== '0') folders.push({ id: node.id, title: node.title || 'Bookmarks', path: path.join(' / ') });
            visit(node.children, node.id === '0' ? ancestors : path);
        }
    };
    visit(tree);
    return folders;
}
export function folderResults(folders, query) {
    const explicitFolderIntent = /^(?:(?:open|browse|show|manage|op|ope)\s+|folder\s+)/i.test(query.trim());
    const text = query.trim().replace(/^(?:open|browse|show|manage|op|ope)\s+/i, '').replace(/^folder\s+/i, '').trim();
    if (text.length < 2 || text.length > 160) return [];
    return FuseSearchService.search(folders, text, { keys: [{ name: 'title', weight: 3 }, { name: 'path', weight: 1 }] }).slice(0, 8)
        .map(({ item, matchScore }) => ({ type: FOLDER_RESULT_TYPE, title: `Browse ${item.title}`, url: '', domain: '',
            metadata: { folder: item, matchScore, explicitFolderIntent } }));
}

/** Local-only bookmark reads and explicit navigation. Never bulk-open or mutate a folder. */
export function installFolderMessages(api, { openBookmark, resolveSource } = {}) {
    api.runtime.onMessage.addListener((message, sender, respond) => {
        if (message?.action !== 'spotlightFolders') return false;
        (async () => {
            if (sender.id !== api.runtime.id || sender.tab?.incognito) throw new Error('Folder browsing is unavailable in this context.');
            const source = resolveSource ? await resolveSource(message, sender) : { windowId: sender.tab?.windowId };
            if (message.command === 'list') return { folders: flattenFolders(await api.bookmarks.getTree()) };
            if (typeof message.id !== 'string' || !/^\d+$/.test(message.id)) throw new Error('Invalid folder.');
            const [folder] = await api.bookmarks.get(message.id);
            if (!folder || folder.url) throw new Error('This folder no longer exists. Search again.');
            if (message.command === 'children') return { folder, children: await api.bookmarks.getChildren(folder.id) };
            if (message.command === 'manage') {
                await api.tabs.create({ url: `chrome://bookmarks/?id=${encodeURIComponent(folder.id)}`, ...(source.windowId ? { windowId: source.windowId } : {}) });
                return {};
            }
            if (message.command === 'openBookmark') {
                const [bookmark] = await api.bookmarks.get(message.bookmarkId);
                if (!bookmark?.url || bookmark.parentId !== folder.id || !/^(https?:|file:|chrome:)/i.test(bookmark.url)) throw new Error('This bookmark changed or cannot be opened here.');
                if (openBookmark && await openBookmark(bookmark, message, sender)) return {};
                await api.tabs.create({ url: bookmark.url, ...(source.windowId ? { windowId: source.windowId } : {}) });
                return {};
            }
            throw new Error('Unknown folder action.');
        })().then(result => respond({ success: true, ...result }), error => respond({ success: false, error: error.message }));
        return true;
    });
}
