// background-data-provider.js - Direct Chrome API implementation for background scripts

import { BaseDataProvider } from './base-data-provider.js';
import { AutocompleteProvider } from './autocomplete-provider.js';
import { BookmarkUtils } from '../../bookmark-utils.js';
import { Logger } from '../../logger.js';
import { FuseSearchService } from '../fuse-search-service.js';

const TAB_ACTIVITY_STORAGE_KEY = 'tabLastActivity';

export class BackgroundDataProvider extends BaseDataProvider {
    constructor({ excludeTabId = null, preserveTabIdentities = false } = {}) {
        super();
        this.excludeTabId = excludeTabId;
        this.preserveTabIdentities = preserveTabIdentities;
        this.autocompleteProvider = new AutocompleteProvider();
        // Mark this as a background provider for reliable detection in minified builds
        this.isBackgroundProvider = true;
    }
    
    // Only implement the small data fetchers using direct Chrome APIs
    
    async getOpenTabsData(query = '') {
        try {
            const [tabs, tabGroups] = await Promise.all([
                chrome.tabs.query({}),
                chrome.tabGroups.query({})
            ]);

            // Build groupId → {title, color} map
            const groupMap = new Map();
            for (const group of tabGroups) {
                groupMap.set(group.id, { title: group.title, color: group.color });
            }

            // Filter out tabs without required fields
            const validTabs = tabs.filter(tab => tab.title && tab.url && tab.id !== this.excludeTabId);

            // No query = return all valid tabs
            if (!query) {
                return validTabs.map(tab => {
                    const group = tab.groupId !== -1 ? groupMap.get(tab.groupId) : null;
                    if (group) {
                        tab.groupName = group.title || '';
                        tab.groupColor = group.color || null;
                    }
                    return tab;
                });
            }

            // Fuse.js fuzzy matching with title weighted 2x over URL
            const fuseResults = FuseSearchService.search(validTabs, query, {
                keys: [
                    { name: 'title', weight: 2 },
                    { name: 'url', weight: 1 }
                ]
            });

            const filteredTabs = fuseResults.map(result => {
                const tab = result.item;
                tab._matchScore = result.matchScore;
                const group = tab.groupId !== -1 ? groupMap.get(tab.groupId) : null;
                if (group) {
                    tab.groupName = group.title || '';
                    tab.groupColor = group.color || null;
                }
                return tab;
            });

            return filteredTabs;
        } catch (error) {
            Logger.error('[BackgroundDataProvider] Error querying tabs:', error);
            return [];
        }
    }

    deduplicateResults(results) {
        // Only a request-scoped standalone helper enables this exception. Its
        // remaining real tabs are separate destinations, even at an identical URL.
        // Ordinary overlay/native result deduplication keeps its existing behavior.
        if (!this.preserveTabIdentities) return super.deduplicateResults(results);
        const live = new Map();
        const ordinary = [];
        for (const result of results) {
            const id = result.metadata?.tabId;
            if (['open-tab', 'pinned-tab'].includes(result.type) && Number.isSafeInteger(id) && id > 0) {
                if (id === this.excludeTabId) continue;
                if (!live.has(id) || this.getResultPriority(result) > this.getResultPriority(live.get(id))) live.set(id, result);
            } else ordinary.push(result);
        }
        const urls = new Set([...live.values()].map(result => this.normalizeUrlForDeduplication(result.url)));
        return [...live.values(), ...super.deduplicateResults(ordinary.filter(result => !result.url || !urls.has(this.normalizeUrlForDeduplication(result.url))))];
    }

    async getRecentTabsData(limit = 5) {
        try {
            const [tabs, tabGroups] = await Promise.all([
                chrome.tabs.query({}),
                chrome.tabGroups.query({})
            ]);
            const storage = await chrome.storage.local.get([TAB_ACTIVITY_STORAGE_KEY]);
            const activityData = storage[TAB_ACTIVITY_STORAGE_KEY] || {};

            // Build groupId → {title, color} map
            const groupMap = new Map();
            for (const group of tabGroups) {
                groupMap.set(group.id, { title: group.title, color: group.color });
            }

            const recentTabs = tabs
                .filter(tab => tab.url && tab.title)
                .map(tab => {
                    const group = tab.groupId !== -1 ? groupMap.get(tab.groupId) : null;
                    return {
                        ...tab,
                        lastActivity: activityData[tab.id] || 0,
                        groupName: group?.title || null,
                        groupColor: group?.color || null
                    };
                })
                .sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0))
                .slice(0, limit);

            return recentTabs;
        } catch (error) {
            Logger.error('[BackgroundDataProvider] Error getting recent tabs:', error);
            return [];
        }
    }

    async getBookmarksData(query) {
        try {
            // Get all bookmarks from cache (fast after first call)
            const allBookmarks = await BookmarkUtils.getAllBookmarks();

            // Exclude Arcify folder bookmarks from regular search
            let arcifyFolderId = null;
            try {
                const arcifyFolder = await BookmarkUtils.findArcifyFolder();
                if (arcifyFolder) {
                    arcifyFolderId = arcifyFolder.id;
                }
            } catch (error) {
                // Ignore if Arcify folder doesn't exist
            }

            const searchableBookmarks = arcifyFolderId
                ? allBookmarks.filter(b => !BookmarkUtils.isUnderArcifyFolder(b, arcifyFolderId))
                : allBookmarks;

            // Use Fuse.js for fuzzy matching (replaces Chrome's substring-only search)
            const fuseResults = FuseSearchService.search(searchableBookmarks, query, {
                keys: [
                    { name: 'title', weight: 2 },
                    { name: 'url', weight: 1 }
                ]
            });

            // Map back to the expected bookmark format with matchScore
            return fuseResults.map(result => ({
                ...result.item,
                _matchScore: result.matchScore
            }));
        } catch (error) {
            Logger.error('[BackgroundDataProvider] Error getting bookmarks with Fuse:', error);
            return [];
        }
    }

    async getHistoryData(query) {
        try {
            // Use Chrome's history search for retrieval (respects recency natively)
            const historyItems = await chrome.history.search({
                text: query,
                maxResults: 20, // Fetch more to allow Fuse.js to re-rank and filter
                startTime: Date.now() - (7 * 24 * 60 * 60 * 1000) // Last 7 days
            });

            if (!historyItems || historyItems.length === 0) return [];

            // Apply Fuse.js scoring to Chrome's results for match quality
            const fuseResults = FuseSearchService.search(historyItems, query, {
                keys: [
                    { name: 'title', weight: 2 },
                    { name: 'url', weight: 1 }
                ]
            });

            // Map back with matchScore attached
            // Items that Chrome returned but Fuse.js didn't match get filtered out
            // (they were probably very loose substring matches)
            return fuseResults.slice(0, 10).map(result => ({
                ...result.item,
                _matchScore: result.matchScore
            }));
        } catch (error) {
            Logger.error('[BackgroundDataProvider] Error getting history:', error);
            return [];
        }
    }

    async getTopSitesData() {
        try {
            const topSites = await chrome.topSites.get();
            return topSites;
        } catch (error) {
            Logger.error('[BackgroundDataProvider] Error getting top sites:', error);
            return [];
        }
    }

    async getAutocompleteData(query) {
        try {
            return await this.autocompleteProvider.getAutocompleteSuggestions(query);
        } catch (error) {
            Logger.error('[BackgroundDataProvider] Error getting autocomplete data:', error);
            return [];
        }
    }

    async getPinnedTabsData(query = '') {
        Logger.log('[BackgroundDataProvider] getPinnedTabsData called with query:', query);
        try {
            // Get spaces from storage
            const storage = await chrome.storage.local.get('spaces');
            const spaces = storage.spaces || [];
            Logger.log('[BackgroundDataProvider] Found spaces:', spaces.length, spaces.map(s => s.name));

            // Get current tabs
            const tabs = await chrome.tabs.query({});
            Logger.log('[BackgroundDataProvider] Found tabs:', tabs.length);

            // Get Arcify folder structure using robust method
            const arcifyFolder = await BookmarkUtils.findArcifyFolder();
            if (!arcifyFolder) {
                Logger.log('[BackgroundDataProvider] No Arcify folder found');
                return [];
            }
            Logger.log('[BackgroundDataProvider] Found Arcify folder:', arcifyFolder.id);

            const spaceFolders = await chrome.bookmarks.getChildren(arcifyFolder.id);
            Logger.log('[BackgroundDataProvider] Found space folders:', spaceFolders.length, spaceFolders.map(f => f.title));

            // Collect ALL pinned tab candidates first (no query filtering in loop)
            const allCandidates = [];

            // Process each space folder
            for (const spaceFolder of spaceFolders) {
                const space = spaces.find(s => s.name === spaceFolder.title);
                Logger.log('[BackgroundDataProvider] Processing space folder:', spaceFolder.title, 'found space:', !!space);
                if (!space) continue;

                // Get all bookmarks in this space folder (recursively)
                const bookmarks = await BookmarkUtils.getBookmarksFromFolderRecursive(spaceFolder.id);
                Logger.log('[BackgroundDataProvider] Found bookmarks in', spaceFolder.title, ':', bookmarks.length);

                for (const bookmark of bookmarks) {
                    // Check if there's a matching open tab
                    const matchingTab = BookmarkUtils.findTabByUrl(tabs, bookmark.url);
                    Logger.log('[BackgroundDataProvider] Processing bookmark:', bookmark.title, 'matching tab:', !!matchingTab);

                    const pinnedTab = {
                        ...bookmark,
                        spaceId: space.id,
                        spaceName: space.name,
                        spaceColor: space.color,
                        tabId: matchingTab?.id || null,
                        isActive: !!matchingTab
                    };
                    Logger.log('[BackgroundDataProvider] Adding pinned tab:', pinnedTab);
                    allCandidates.push(pinnedTab);
                }
            }

            // Apply Fuse.js filtering if query is provided
            if (query) {
                const fuseResults = FuseSearchService.search(allCandidates, query, {
                    keys: [
                        { name: 'title', weight: 2 },
                        { name: 'url', weight: 1 }
                    ]
                });

                const filteredPinnedTabs = fuseResults.map(result => {
                    const pinnedTab = result.item;
                    pinnedTab._matchScore = result.matchScore;
                    return pinnedTab;
                });

                Logger.log('[BackgroundDataProvider] Returning', filteredPinnedTabs.length, 'pinned tabs (filtered by query)');
                return filteredPinnedTabs;
            }

            Logger.log('[BackgroundDataProvider] Returning', allCandidates.length, 'pinned tabs');
            return allCandidates;
        } catch (error) {
            Logger.error('[BackgroundDataProvider] Error getting pinned tabs data:', error);
            return [];
        }
    }


}
