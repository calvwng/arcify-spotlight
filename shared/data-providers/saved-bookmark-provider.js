import { BackgroundDataProvider } from './background-data-provider.js';
import { SearchResult, ResultType } from '../search-types.js';
import { FuseSearchService } from '../fuse-search-service.js';

// One tree per request, never persisted. No URL-to-live-identity inference.
export function readSavedTree(tree) {
    const roots = [], all = [], seen = new Set();
    const visit = (nodes, ancestorIds = [], names = []) => {
        for (const node of nodes || []) {
            if (!node || typeof node.id !== 'string' || seen.has(node.id)) continue;
            seen.add(node.id);
            const folder = !node.url;
            if (folder && node.title === 'Arcify') roots.push(node);
            all.push({ node, ancestorIds, path: [...names, node.title || node.url || 'Untitled folder'].join(' / ') });
            if (folder) visit(node.children, [...ancestorIds, node.id], [...names, node.title || 'Untitled folder']);
        }
    };
    visit(tree);
    if (roots.length !== 1) return { entries: [], ordinary: all.filter(x => x.node.url), status: roots.length ? 'ambiguous' : 'missing' };
    const root = roots[0], entries = [], ids = new Set();
    const collect = (nodes, path, ancestorIds) => {
        for (const node of nodes || []) {
            if (!node || typeof node.id !== 'string' || ids.has(node.id)) continue;
            ids.add(node.id);
            const folder = !node.url;
            entries.push({ node, ancestorIds, path: [...path, node.title || (folder ? 'Untitled folder' : node.url)].join(' / '), folder });
            if (folder) collect(node.children, [...path, node.title || 'Untitled folder'], [...ancestorIds, node.id]);
        }
    };
    collect(root.children, ['Arcify'], [...all.find(x => x.node === root).ancestorIds, root.id]);
    return { entries, ordinary: all.filter(x => x.node.url && !ids.has(x.node.id)), status: 'ready' };
}

export class SavedBookmarkProvider extends BackgroundDataProvider {
    constructor(options = {}) {
        super(options);
        this.unavailable = Boolean(options.unavailable);
        this.treePromise = null;
    }
    async savedTree() {
        if (!this.treePromise) this.treePromise = chrome.bookmarks.getTree().then(readSavedTree)
            .catch(() => ({ entries: [], ordinary: [], status: 'unavailable' }));
        return this.treePromise;
    }
    async discoveryStatus() {
        const { status } = await this.savedTree();
        return `Saved-bookmark fallback (${status}). ${this.unavailable ? 'Arcify connection unavailable; saved results open ordinary bookmark URLs, without Space routing.' : 'Standalone navigation; folder labels are saved context, not live Spaces.'}`;
    }
    async getPinnedTabSuggestions() { return []; }
    async getBookmarksData() { return []; }
    async enrichWithArcifyInfo(results) { return results; }
    async getBookmarkSuggestions(query) {
        const tree = await this.savedTree();
        const candidates = [
            ...tree.entries.map(({ node, path, folder, ancestorIds }) => ({
                id: node.id, title: node.title || node.url || 'Untitled folder', path,
                url: folder ? `chrome://bookmarks/?id=${encodeURIComponent(node.id)}` : node.url,
                saved: { id: node.id, path, folder, ancestorIds, peerId: this.discoveryPeerId || null }
            })),
            ...tree.ordinary.map(({ node, path, ancestorIds }) => ({ ...node, fallback: { id: node.id, path, ancestorIds, folder: false, peerId: this.discoveryPeerId || null } }))
        ];
        return FuseSearchService.search(candidates, query, { keys: [
            { name: 'title', weight: 2 }, { name: 'url', weight: 1 }, { name: 'path', weight: 1 }
        ] }).map(({ item, matchScore }) => new SearchResult({
            type: ResultType.BOOKMARK, title: item.title, url: item.url,
            metadata: { bookmarkId: item.id, matchScore, bookmarkFallback: item.saved || item.fallback, ...(item.saved ? { savedBookmark: item.saved } : {}) }
        }));
    }
    deduplicateResults(results) {
        const saved = new Map(), ordinary = [];
        for (const result of results) {
            const owner = result.metadata?.savedBookmark;
            if (owner) { if (!saved.has(owner.id)) saved.set(owner.id, result); }
            else ordinary.push(result);
        }
        const urls = new Set([...saved.values()].map(result => this.normalizeUrlForDeduplication(result.url)));
        return [...super.deduplicateResults(ordinary.filter(result =>
            ['open-tab', 'pinned-tab'].includes(result.type) || !urls.has(this.normalizeUrlForDeduplication(result.url)))), ...saved.values()];
    }
}

// Re-read before navigation: a moved/deleted/renamed result must be searched again.
export async function validateSavedResult(result, peerId) {
    const owner = result.metadata?.bookmarkFallback || result.metadata?.savedBookmark;
    if (!owner) return;
    if ((peerId || null) !== owner.peerId || result.metadata?.arcifyBridge || result.type !== ResultType.BOOKMARK)
        throw new Error('Arcify connection changed. Search again.');
    const tree = readSavedTree(await chrome.bookmarks.getTree());
    const candidates = result.metadata?.savedBookmark ? tree.entries : tree.ordinary;
    const entry = candidates.find(({ node }) => node.id === owner.id);
    const url = entry?.folder ? `chrome://bookmarks/?id=${encodeURIComponent(entry.node.id)}` : entry?.node.url;
    if (!entry || entry.path !== owner.path || Boolean(entry.folder) !== owner.folder || JSON.stringify(entry.ancestorIds) !== JSON.stringify(owner.ancestorIds) || url !== result.url)
        throw new Error('Saved bookmark changed. Search again before selecting it.');
}
