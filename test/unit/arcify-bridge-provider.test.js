import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArcifyBridgeProvider } from '../../shared/data-providers/arcify-bridge-provider.js';
import { SearchResult, ResultType } from '../../shared/search-types.js';

const SHARED_URL = 'https://example.com/shared';
const PEER_ID = 'b'.repeat(32);

function snapshot(windowId = 11) {
    return {
        windowId, activeSpaceId: 'work', capturedAt: 1,
        spaces: [
            { id: 'work', name: 'Work', color: 'blue', tabIds: [21], pinnedTabIds: [21], temporaryTabIds: [] },
            { id: 'personal', name: 'Personal', color: 'green', tabIds: [22], pinnedTabIds: [], temporaryTabIds: [22] }
        ],
        tabs: [
            { id: 21, windowId, spaceId: 'work', title: 'Shared document', url: SHARED_URL, pinned: true, active: true },
            { id: 22, windowId, spaceId: 'personal', title: 'Shared document', url: SHARED_URL, pinned: false, active: false }
        ],
        bookmarks: [
            { id: '31', spaceId: 'work', title: 'Shared document', url: SHARED_URL, tabId: 21 },
            { id: '32', spaceId: 'work', title: 'Shared document', url: SHARED_URL, tabId: null },
            { id: '33', spaceId: 'personal', title: 'Shared document', url: SHARED_URL, tabId: null },
            { id: '34', spaceId: 'personal', title: 'Shared document copy', url: SHARED_URL, tabId: null }
        ]
    };
}

describe('Arcify bridge snapshot provider', () => {
    let api;
    let native;
    let provider;

    beforeEach(() => {
        api = {
            storage: { local: { get: vi.fn().mockResolvedValue({ spaces: [{ name: 'Wrong', color: 'red' }] }), set: vi.fn() } },
            tabs: { query: vi.fn().mockResolvedValue([]) },
            tabGroups: { query: vi.fn().mockResolvedValue([]) }
        };
        vi.stubGlobal('chrome', api);
        native = { autocompleteProvider: { getAutocompleteSuggestions: vi.fn().mockResolvedValue([]) } };
        provider = new ArcifyBridgeProvider(snapshot(), native, PEER_ID);
        vi.spyOn(provider, 'getBookmarksData').mockResolvedValue([]);
    });

    afterEach(() => { vi.unstubAllGlobals(); });

    it('uses authoritative tab and workspace IDs, names, and colors from the snapshot', async () => {
        const tabs = await provider.getOpenTabs();
        expect(tabs).toHaveLength(2);
        expect(tabs[0]).toMatchObject({
            type: ResultType.PINNED_TAB,
            metadata: {
                isArcify: true, tabId: 21, windowId: 11, spaceId: 'work', spaceName: 'Work', spaceColor: 'blue',
                arcifyBridge: { kind: 'tab', peerId: PEER_ID, windowId: 11, spaceId: 'work', tabId: 21 }
            }
        });
        expect(tabs[1].metadata.spaceId).toBe('personal');
        expect(api.tabs.query).not.toHaveBeenCalled();
        expect(api.storage.local.get).not.toHaveBeenCalled();
        expect(api.storage.local.set).not.toHaveBeenCalled();
    });

    it('keeps independent providers scoped to their own browser windows', async () => {
        const otherSnapshot = snapshot(12);
        otherSnapshot.spaces[0].name = 'Second window';
        otherSnapshot.tabs[0].id = 101;
        otherSnapshot.spaces[0].tabIds = [101];
        otherSnapshot.spaces[0].pinnedTabIds = [101];
        otherSnapshot.bookmarks[0].tabId = 101;
        const other = new ArcifyBridgeProvider(otherSnapshot, native, PEER_ID);
        const [first, second] = await Promise.all([provider.getOpenTabs(), other.getOpenTabs()]);

        expect(first.every(item => item.metadata.windowId === 11 && item.metadata.arcifyBridge.windowId === 11)).toBe(true);
        expect(second.every(item => item.metadata.windowId === 12 && item.metadata.arcifyBridge.windowId === 12)).toBe(true);
        expect(first[0].metadata.spaceName).toBe('Work');
        expect(second[0].metadata.spaceName).toBe('Second window');
        expect((await provider.getOpenTabs())[0].metadata.tabId).toBe(21);
        expect(api.storage.local.set).not.toHaveBeenCalled();
    });

    it('preserves identical URLs across spaces and separate bookmark IDs', async () => {
        const tabs = await provider.getOpenTabs();
        const bookmarks = await provider.getBookmarkSuggestions('');
        const results = provider.deduplicateResults([...tabs, ...bookmarks]);
        const shared = results.filter(result => result.url === SHARED_URL);

        expect(shared).toHaveLength(5);
        expect(shared.filter(result => result.metadata.arcifyBridge.kind === 'tab')).toHaveLength(1);
        expect(shared.filter(result => result.metadata.arcifyBridge.kind === 'bookmark').map(result => result.metadata.bookmarkId)).toEqual(['31', '32', '33', '34']);
    });

    it('deduplicates repeated bridge identities without merging distinct workspace results', async () => {
        const tabs = await provider.getOpenTabs();
        const results = provider.deduplicateResults([...tabs, tabs[0], tabs[1]]);
        expect(results).toHaveLength(2);
        expect(results.map(result => result.metadata.arcifyBridge.tabId)).toEqual([21, 22]);
    });

    it('keeps both live and closed pinned bookmark aliases searchable as bookmark actions', async () => {
        const bookmarks = await provider.getBookmarkSuggestions('');
        expect(bookmarks.find(result => result.metadata.bookmarkId === '31')).toMatchObject({
            type: ResultType.BOOKMARK,
            metadata: { arcifyBridge: { kind: 'bookmark', windowId: 11, spaceId: 'work', bookmarkId: '31' } }
        });
        expect(bookmarks.find(result => result.metadata.bookmarkId === '32')).toMatchObject({
            type: ResultType.BOOKMARK,
            metadata: { arcifyBridge: { kind: 'bookmark', windowId: 11, spaceId: 'work', bookmarkId: '32' } }
        });
        expect(await provider.getPinnedTabsData()).toEqual([]);
    });

    it.each(['QuarterlyBudgetOriginal', 'saved-budget'])('finds a navigated pin by its saved bookmark alias (%s)', async (query) => {
        provider.snapshot.bookmarks[0].title = 'QuarterlyBudgetOriginal';
        provider.snapshot.bookmarks[0].url = 'https://finance.example.org/saved-budget';
        provider.snapshot.tabs[0].title = 'VacationGalleryLive';
        provider.snapshot.tabs[0].url = 'https://photos.example.net/current-album';
        const tabs = await provider.getOpenTabs(query);
        const bookmarks = await provider.getBookmarkSuggestions(query);
        const results = provider.deduplicateResults([...tabs, ...bookmarks]);
        const saved = results.find(result => result.metadata.bookmarkId === '31');

        expect(saved).toMatchObject({
            title: 'QuarterlyBudgetOriginal', url: 'https://finance.example.org/saved-budget',
            metadata: { arcifyBridge: { kind: 'bookmark', bookmarkId: '31', spaceId: 'work', windowId: 11 } }
        });
    });

    it('prefers the saved bookmark route when a query matches both its alias and linked live tab', async () => {
        const tabs = await provider.getOpenTabs('shared');
        const bookmarks = await provider.getBookmarkSuggestions('shared');
        for (const input of [[...tabs, ...bookmarks], [...bookmarks, ...tabs]]) {
            const results = provider.deduplicateResults(input);
            expect(results.some(result => result.metadata.arcifyBridge?.kind === 'tab' && result.metadata.tabId === 21)).toBe(false);
            expect(results.filter(result => result.metadata.bookmarkId === '31')).toHaveLength(1);
            expect(results.some(result => result.metadata.arcifyBridge?.kind === 'tab' && result.metadata.tabId === 22)).toBe(true);
        }
    });

    it('keeps the live tab route when only the navigated destination matches', async () => {
        provider.snapshot.bookmarks[0].title = 'QuarterlyBudgetOriginal';
        provider.snapshot.bookmarks[0].url = 'https://finance.example.org/saved-budget';
        provider.snapshot.tabs[0].title = 'VacationGalleryLive';
        provider.snapshot.tabs[0].url = 'https://photos.example.net/current-album';
        const tabs = await provider.getOpenTabs('VacationGalleryLive');
        const bookmarks = await provider.getBookmarkSuggestions('VacationGalleryLive');
        const results = provider.deduplicateResults([...tabs, ...bookmarks]);

        expect(results.find(result => result.metadata.tabId === 21)).toMatchObject({
            title: 'VacationGalleryLive',
            metadata: { arcifyBridge: { kind: 'tab', tabId: 21, spaceId: 'work' } }
        });
        expect(results.some(result => result.metadata.bookmarkId === '31')).toBe(false);
    });

    it('exposes spaces as explicit bridge actions, including spaces with the same name', async () => {
        provider.snapshot.spaces[1].name = 'Work';
        const results = provider.deduplicateResults(await provider.getBookmarkSuggestions(''));
        const spaces = results.filter(result => result.type === 'arcify-space');
        expect(spaces).toHaveLength(2);
        expect(spaces.map(result => result.metadata.arcifyBridge)).toEqual([
            { kind: 'space', peerId: PEER_ID, windowId: 11, spaceId: 'work' },
            { kind: 'space', peerId: PEER_ID, windowId: 11, spaceId: 'personal' }
        ]);
    });

    it('removes duplicate native bookmark IDs while retaining unrelated native bookmarks at the same URL', async () => {
        provider.getBookmarksData.mockResolvedValue([
            { id: '31', title: 'Old native title', url: SHARED_URL },
            { id: '32', title: 'Wrong native metadata', url: SHARED_URL },
            { id: 'native-1', title: 'Ordinary bookmark', url: SHARED_URL }
        ]);
        const results = await provider.getBookmarkSuggestions('');
        expect(results.filter(result => result.metadata.bookmarkId === '32')).toHaveLength(1);
        expect(results.find(result => result.metadata.bookmarkId === '32').metadata.spaceName).toBe('Work');
        const ordinary = results.find(result => result.metadata.bookmarkId === 'native-1');
        expect(ordinary).toBeDefined();
        expect(ordinary.metadata.arcifyBridge).toBeUndefined();
        expect(ordinary.metadata.isArcify).toBeUndefined();
    });

    it('suppresses URL-only duplicates while preserving every distinct authoritative choice', async () => {
        const tabs = await provider.getOpenTabs();
        const bookmarks = await provider.getBookmarkSuggestions('shared');
        const ordinary = [
            new SearchResult({ type: ResultType.HISTORY, title: 'History duplicate', url: 'http://www.example.com/shared/#section' }),
            new SearchResult({ type: ResultType.TOP_SITE, title: 'Top site duplicate', url: SHARED_URL }),
            new SearchResult({ type: ResultType.BOOKMARK, title: 'Native bookmark duplicate', url: SHARED_URL, metadata: { bookmarkId: 'native' } }),
            new SearchResult({ type: ResultType.HISTORY, title: 'Distinct query', url: SHARED_URL + '?view=other' }),
            new SearchResult({ type: ResultType.HISTORY, title: 'Unrelated', url: 'https://other.example.org' })
        ];
        const identities = provider.deduplicateResults([...tabs, ...bookmarks]);
        for (const input of [[...ordinary, ...tabs, ...bookmarks], [...tabs, ...bookmarks, ...ordinary]]) {
            const results = provider.deduplicateResults(input);
            expect(results.filter(result => result.metadata.arcifyBridge)).toEqual(identities);
            expect(results.filter(result => !result.metadata.arcifyBridge).map(result => result.title)).toEqual(['Distinct query', 'Unrelated']);
        }
        expect(ordinary[0].metadata.arcifyBridge).toBeUndefined();
        expect(ordinary[2].metadata).toEqual({ bookmarkId: 'native' });
    });

    it('does not infer ownership for unowned tabs or ordinary results that share a URL', async () => {
        provider.snapshot.tabs.push({ id: 23, windowId: 11, spaceId: null, title: 'Unowned tab', url: SHARED_URL, pinned: false, active: false });
        const tab = (await provider.getOpenTabs()).find(result => result.metadata.tabId === 23);
        expect(tab.metadata.isArcify).toBe(false);
        expect(tab.metadata.spaceId).toBeNull();
        expect(tab.metadata.spaceName).toBeUndefined();
        const ordinary = [new SearchResult({ type: ResultType.HISTORY, title: 'History', url: SHARED_URL })];
        expect(await provider.enrichWithArcifyInfo(ordinary)).toBe(ordinary);
        expect(ordinary[0].metadata).toEqual({});
        expect(api.storage.local.get).not.toHaveBeenCalled();
        expect(api.storage.local.set).not.toHaveBeenCalled();
    });

    it('omits generic URL destinations unsupported by paired navigation without changing saved data', () => {
        const helper = `chrome-extension://${PEER_ID}/startup-launcher.html`;
        const hidden = [
            [ResultType.HISTORY, helper + '?source=startup'],
            [ResultType.BOOKMARK, helper + '#start'],
            [ResultType.TOP_SITE, helper + '/'],
            [ResultType.HISTORY, `chrome-extension://${'c'.repeat(32)}/startup-launcher.html`],
            [ResultType.BOOKMARK, `chrome-extension://${PEER_ID}/options.html`],
            [ResultType.URL_SUGGESTION, 'javascript:alert(1)'],
            [ResultType.AUTOCOMPLETE_SUGGESTION, 'data:text/html,hello']
        ].map(([type, url], index) => new SearchResult({
            type, title: 'Open Arcify sidebar', url, metadata: { bookmarkId: `ordinary-${index}`, isUrl: true }
        }));
        const supported = ['https://example.test/launcher', 'http://example.test/other',
            'file:///tmp/notes.txt', 'chrome://settings/', 'about:blank'].map((url, index) => new SearchResult({
            type: ResultType.BOOKMARK, title: 'Open Arcify sidebar', url, metadata: { bookmarkId: `supported-${index}` }
        }));
        const authoritative = new SearchResult({ type: ResultType.BOOKMARK, title: 'Saved authoritative identity', url: helper,
            metadata: { bookmarkId: 'saved', arcifyBridge: { kind: 'bookmark', peerId: PEER_ID, windowId: 11, spaceId: 'work', bookmarkId: 'saved' } } });
        const input = [...hidden, ...supported, authoritative];
        const before = structuredClone(input);
        expect(provider.deduplicateResults(input)).toEqual([authoritative, ...supported]);
        expect(input).toEqual(before);
        expect(api.storage.local.set).not.toHaveBeenCalled();
        const unpaired = new ArcifyBridgeProvider(snapshot(), native);
        expect(unpaired.deduplicateResults([hidden[0]])).toEqual([hidden[0]]);
    });

    it('keeps extension live-tab identities, query search and trusted commands independently of URL navigation', async () => {
        const extensionUrl = `chrome-extension://${PEER_ID}/options.html`;
        provider.snapshot.tabs[0].url = extensionUrl;
        provider.snapshot.tabs[1].url = extensionUrl;
        const authoritative = await provider.getOpenTabs();
        expect(provider.deduplicateResults(authoritative)).toEqual(authoritative);
        const generic = [
            new SearchResult({ type: ResultType.OPEN_TAB, title: 'Live extension page', url: extensionUrl, metadata: { tabId: 21 } }),
            new SearchResult({ type: ResultType.PINNED_TAB, title: 'Live favorite', url: extensionUrl + '?favorite', metadata: { tabId: 22 } }),
            new SearchResult({ type: ResultType.SEARCH_QUERY, title: 'Search extension address', url: extensionUrl + '?search', metadata: { query: extensionUrl } }),
            new SearchResult({ type: ResultType.AUTOCOMPLETE_SUGGESTION, title: 'Search suggestion', url: extensionUrl + '?query', metadata: { isUrl: false, query: extensionUrl } }),
            new SearchResult({ type: 'arcify-sidebar-command', title: 'Open Arcify sidebar', url: '' })
        ];
        expect(provider.deduplicateResults(generic)).toEqual(generic);
    });

    it.each(['getLocalSuggestions', 'getSpotlightSuggestions'])('filters current-peer helper URL variants across the %s pipeline', async method => {
        const helper = `chrome-extension://${PEER_ID}/startup-launcher.html`;
        provider.getBookmarksData.mockResolvedValue([
            { id: 'helper', title: 'Open Arcify sidebar', url: helper + '/' },
            { id: 'web', title: 'Open Arcify sidebar', url: 'https://example.test/sidebar' }
        ]);
        vi.spyOn(provider, 'getHistoryData').mockResolvedValue([
            { title: 'Open Arcify sidebar', url: `chrome-extension://${PEER_ID}/dist/startup-launcher.html` },
            { title: 'Open Arcify sidebar', url: helper + '?source=startup#start' }
        ]);
        vi.spyOn(provider, 'getTopSitesData').mockResolvedValue([]);
        const results = await provider[method]('open');
        expect(results.some(result => result.url.startsWith('chrome-extension:'))).toBe(false);
        expect(results.some(result => result.metadata.bookmarkId === 'web')).toBe(true);
        expect(api.storage.local.set).not.toHaveBeenCalled();
    });

    it('supports matching workspace names without mutating or caching the snapshot', async () => {
        const before = structuredClone(provider.snapshot);
        const results = await provider.getOpenTabs('personal');
        expect(results.some(result => result.metadata.spaceId === 'personal')).toBe(true);
        expect(provider.snapshot).toEqual(before);
        expect(api.storage.local.set).not.toHaveBeenCalled();
        expect(provider.autocompleteProvider).toBe(native.autocompleteProvider);
    });
});
