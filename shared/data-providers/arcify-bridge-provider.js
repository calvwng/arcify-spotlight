/** A request-scoped, read-only view of Arcify's authoritative snapshot. */
import { BackgroundDataProvider } from './background-data-provider.js';
import { SearchResult, ResultType } from '../search-types.js';
import { FuseSearchService } from '../fuse-search-service.js';

export class ArcifyBridgeProvider extends BackgroundDataProvider {
    constructor(snapshot, nativeProvider, peerId = null, { excludeTabId = null } = {}) {
        super();
        this.snapshot = snapshot;
        this.peerId = peerId;
        this.excludeTabId = excludeTabId;
        this.autocompleteProvider = nativeProvider.autocompleteProvider;
        this.spaces = new Map(snapshot.spaces.map(space => [space.id, space]));
    }

    metadata(kind, item) {
        const space = this.spaces.get(item.spaceId);
        return {
            isArcify: Boolean(space), spaceId: item.spaceId, spaceName: space?.name,
            spaceColor: space?.color, windowId: this.snapshot.windowId,
            arcifyBridge: { kind, peerId: this.peerId, windowId: this.snapshot.windowId, spaceId: item.spaceId,
                ...(kind === 'tab' ? { tabId: item.id } : kind === 'bookmark' ? { bookmarkId: item.id } : {}) }
        };
    }

    filter(items, query) {
        if (!query) return items;
        return FuseSearchService.search(items, query, {
            keys: [{ name: 'title', weight: 2 }, { name: 'url', weight: 1 }, { name: 'metadata.spaceName', weight: 1 }]
        }).map(({ item, matchScore }) => { item.metadata.matchScore = matchScore; return item; });
    }

    async getOpenTabs(query = '') {
        const tabById = new Map(this.snapshot.tabs.map(tab => [tab.id, tab]));
        const orderedIds = this.snapshot.spaces.flatMap(space => space.tabIds);
        const listed = new Set(orderedIds);
        const orderedTabs = [...orderedIds.map(id => tabById.get(id)), ...this.snapshot.tabs.filter(tab => !listed.has(tab.id))];
        const results = orderedTabs.filter(tab => tab?.url && tab.id !== this.excludeTabId).map(tab => new SearchResult({
            type: tab.pinned ? ResultType.PINNED_TAB : ResultType.OPEN_TAB,
            title: tab.title || tab.url, url: tab.url,
            metadata: { ...this.metadata('tab', tab), tabId: tab.id, windowId: tab.windowId,
                groupName: this.spaces.get(tab.spaceId)?.name || null }
        }));
        return this.filter(results, query);
    }

    async getPinnedTabsData() { return []; }

    async getBookmarkSuggestions(query) {
        const native = await super.getBookmarkSuggestions(query);
        const knownBookmarks = new Set(this.snapshot.bookmarks.map(item => item.id));
        const ordinary = native.filter(result => !knownBookmarks.has(result.metadata.bookmarkId));
        const bookmarks = this.snapshot.bookmarks.map(item => new SearchResult({
            type: ResultType.BOOKMARK, title: item.title || item.url, url: item.url,
            metadata: { ...this.metadata('bookmark', item), bookmarkId: item.id, tabId: item.tabId }
        }));
        const spaces = this.snapshot.spaces.map(space => new SearchResult({
            type: 'arcify-space', title: space.name, url: '',
            metadata: this.metadata('space', { spaceId: space.id })
        }));
        return [...ordinary, ...this.filter([...bookmarks, ...spaces], query)];
    }

    // Do not infer workspace ownership from bookmark folders, URLs, or group names.
    async enrichWithArcifyInfo(results) { return results; }

    deduplicateResults(results) {
        const bridge = [];
        const ordinary = [];
        const seen = new Set();
        const matchedBookmarkTabs = new Set(results.filter(result => result.metadata?.arcifyBridge?.kind === 'bookmark' && result.metadata.tabId).map(result => result.metadata.tabId));
        for (const result of results) {
            const owner = result.metadata?.arcifyBridge;
            if (!owner) {
                // The paired launcher is a control surface, already represented by
                // the gesture-safe command. Hide only this exact helper suggestion;
                // saved bookmark data, unrelated extension pages and names are intact.
                const helperUrl = this.peerId && `chrome-extension://${this.peerId}/startup-launcher.html`;
                if (helperUrl && result.url?.split(/[?#]/)[0] === helperUrl) continue;
                ordinary.push(result); continue;
            }
            if (owner.kind === 'tab' && matchedBookmarkTabs.has(owner.tabId)) continue;
            const key = `${owner.kind}:${owner.spaceId}:${owner.tabId ?? owner.bookmarkId ?? ''}`;
            if (!seen.has(key)) { seen.add(key); bridge.push(result); }
        }
        // Display-only URL deduplication suppresses generic history/top-site/bookmark
        // suggestions already represented by an authoritative identity. Never use this
        // URL set to assign ownership or collapse distinct bridge choices.
        const representedUrls = new Set(bridge.filter(result => result.url)
            .map(result => this.normalizeUrlForDeduplication(result.url)));
        const remainingOrdinary = ordinary.filter(result => !result.url ||
            !representedUrls.has(this.normalizeUrlForDeduplication(result.url)));
        return [...bridge, ...super.deduplicateResults(remainingOrdinary)];
    }

    calculateRelevanceScore(result, query) {
        return super.calculateRelevanceScore(result.type === 'arcify-space'
            ? { ...result, type: ResultType.OPEN_TAB } : result, query);
    }
}
