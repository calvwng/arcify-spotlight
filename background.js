/**
 * Spotlight Background Service Worker (Manifest V3)
 *
 * Purpose: Manages spotlight extension lifecycle, message passing, and Chrome API access
 * Key Functions: Spotlight injection/fallback, tab searching, bookmarks/history access
 * Architecture: Service worker that handles all Chrome API calls for spotlight functionality
 */

import { SearchEngine } from './shared/search-engine.js';
import { BackgroundDataProvider } from './shared/data-providers/background-data-provider.js';
import { Logger } from './logger.js';
import { getSettings } from './utils.js';
import { arcifyProvider } from './shared/data-providers/arcify-provider.js';
import { BookmarkUtils } from './bookmark-utils.js';
import { arcifyBridge } from './shared/arcify-bridge.js';
import { BRIDGE_TYPE, trustedSender, validateRequest, responseFor } from './shared/arcify-bridge-protocol.js';
import { ArcifyBridgeProvider } from './shared/data-providers/arcify-bridge-provider.js';
import { handleBridgeResult } from './shared/arcify-bridge-actions.js';

// === Arcify Cache Event Listeners ===
// MV3 REQUIREMENT: Register synchronously at top level for service worker restart handling
// These listeners invalidate the URL-to-space cache when bookmarks change

chrome.bookmarks.onCreated.addListener((id, bookmark) => {
    // Invalidate cache when any bookmark is created
    // The rebuild will determine if it's in Arcify folder
    arcifyProvider.invalidateCache();
    BookmarkUtils.invalidateBookmarkCache();
});

chrome.bookmarks.onRemoved.addListener((id, removeInfo) => {
    arcifyProvider.invalidateCache();
    BookmarkUtils.invalidateBookmarkCache();
});

chrome.bookmarks.onMoved.addListener((id, moveInfo) => {
    arcifyProvider.invalidateCache();
    BookmarkUtils.invalidateBookmarkCache();
});

chrome.bookmarks.onChanged.addListener((id, changeInfo) => {
    arcifyProvider.invalidateCache();
    BookmarkUtils.invalidateBookmarkCache();
});

// Import batching to prevent cache thrashing during bulk operations
chrome.bookmarks.onImportBegan.addListener(() => {
    arcifyProvider.isImporting = true;
});

chrome.bookmarks.onImportEnded.addListener(() => {
    arcifyProvider.isImporting = false;
    if (arcifyProvider.pendingInvalidation) {
        arcifyProvider.pendingInvalidation = false;
        arcifyProvider.invalidateCache();
    }
    BookmarkUtils.invalidateBookmarkCache();
});

// Enum for spotlight tab modes
const SpotlightTabMode = {
    CURRENT_TAB: 'current-tab',
    NEW_TAB: 'new-tab'
};

// Create a single SearchEngine instance with BackgroundDataProvider
const backgroundDataProvider = new BackgroundDataProvider();
const backgroundSearchEngine = new SearchEngine(backgroundDataProvider);

// Context stays request-scoped: two windows may search at the same time.
async function bridgeContext(message, sender) {
    const tabId = sender.tab?.id ?? message.tabId;
    if (Number.isSafeInteger(sender.tab?.windowId) && sender.tab.windowId > 0) {
        return { tabId, windowId: sender.tab.windowId };
    }
    if (Number.isSafeInteger(tabId)) {
        const tab = await chrome.tabs.get(tabId);
        if (tab?.windowId > 0) return { tabId: tab.id, windowId: tab.windowId };
    }
    // Extension pages without sender.tab may resolve their current window only.
    if (sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(''))) {
        const window = await chrome.windows.getLastFocused();
        const [tab] = await chrome.tabs.query({ active: true, windowId: window.id });
        return { tabId: tab?.id, windowId: window.id };
    }
    throw new Error('Cannot identify this browser window. Reopen Spotlight and try again.');
}

async function searchEngineForSender(message, sender) {
    const peerId = await arcifyBridge.getPeerId();
    if (!peerId) return backgroundSearchEngine;
    const context = await bridgeContext(message, sender);
    const snapshot = await arcifyBridge.snapshot(context.windowId, peerId);
    if (!snapshot) throw new Error('Arcify was disconnected. Search again.');
    return new SearchEngine(new ArcifyBridgeProvider(snapshot, backgroundDataProvider, peerId));
}

function isNewTabSender(sender) {
    return sender.id === chrome.runtime.id && sender.url?.split(/[?#]/)[0] === chrome.runtime.getURL('newtab.html');
}

function isOptionsSender(sender) {
    return sender.id === chrome.runtime.id && sender.url?.split(/[?#]/)[0] === chrome.runtime.getURL('options.html');
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!['arcifyBridgeStatus', 'arcifyBridgeConfigure', 'arcifyBridgeOpenSettings'].includes(message.action)) return false;
    (async () => {
        try {
            if (message.action === 'arcifyBridgeOpenSettings') {
                await chrome.runtime.openOptionsPage();
                sendResponse({ success: true });
                return;
            }
            if (message.action === 'arcifyBridgeConfigure') {
                if (!isOptionsSender(sender)) throw new Error('Change the connection only from Spotlight settings.');
                await arcifyBridge.configure(message.peerId);
            }
            if (!await arcifyBridge.getPeerId()) {
                sendResponse({ success: true, status: await arcifyBridge.status() });
                return;
            }
            const context = await bridgeContext(message, sender);
            sendResponse({ success: true, status: await arcifyBridge.status(context.windowId) });
        } catch (error) {
            sendResponse({ success: false, error: error.message, errorCode: error.code });
        }
    })();
    return true;
});

// All extensions may reach the manifest endpoint; only the paired ID may use it.
const recentLaunches = new Map();
const launchQueues = new Map();
function pairedLaunch(message, peerId) {
    const key = `${peerId}:${message.requestId}`;
    const signature = JSON.stringify([message.windowId, message.mode]);
    const existing = recentLaunches.get(key);
    if (existing) {
        if (existing.signature !== signature) throw Object.assign(new Error('Request ID was already used for another launch.'), { code: 'REQUEST_ID_REUSED' });
        return existing.promise;
    }
    const previous = launchQueues.get(message.windowId) || Promise.resolve();
    const promise = previous.catch(() => {}).then(async () => {
        if (await arcifyBridge.getPeerId() !== peerId) throw Object.assign(new Error('Arcify pairing changed.'), { code: 'UNAUTHORIZED' });
        return injectSpotlightScript(message.mode, message.windowId);
    });
    launchQueues.set(message.windowId, promise);
    recentLaunches.set(key, { signature, promise });
    // Bounded lifetime-local replay guard, not a persistent browsing log.
    if (recentLaunches.size > 100) recentLaunches.delete(recentLaunches.keys().next().value);
    promise.finally(() => { if (launchQueues.get(message.windowId) === promise) launchQueues.delete(message.windowId); }).catch(() => {});
    return promise;
}

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
    if (message?.type !== BRIDGE_TYPE) return false;
    (async () => {
        try {
            const peerId = await arcifyBridge.getPeerId();
            if (!trustedSender(sender, peerId)) throw Object.assign(new Error('Pair this Arcify extension in Spotlight settings first.'), { code: 'UNAUTHORIZED' });
            validateRequest(message, ['hello', 'launch']);
            await chrome.windows.get(message.windowId);
            if (message.command === 'launch') {
                const opened = await pairedLaunch(message, peerId);
                if (!opened) throw Object.assign(new Error('Spotlight is disabled or could not open.'), { code: 'LAUNCH_FAILED' });
            }
            sendResponse(responseFor(message, 'spotlight', { ok: true, extensionId: chrome.runtime.id }));
        } catch (error) {
            sendResponse(responseFor(message, 'spotlight', { ok: false, error: { code: error.code || 'FAILED', message: error.message } }));
        }
    })();
    return true;
});


// Track tabs that have spotlight open for efficient closing
const spotlightOpenTabs = new Set();

// Close spotlight in tracked tabs only
async function closeSpotlightInTrackedTabs(windowId = null) {
    try {
        const targetIds = windowId ? new Set((await chrome.tabs.query({ windowId })).map(tab => tab.id)) : null;
        const closePromises = Array.from(spotlightOpenTabs).filter(id => !targetIds || targetIds.has(id)).map(tabId =>
            chrome.tabs.sendMessage(tabId, { action: 'closeSpotlight' }).catch(() => {
                spotlightOpenTabs.delete(tabId);
            })
        );
        await Promise.all(closePromises);
        if (!targetIds) spotlightOpenTabs.clear();
        else for (const id of targetIds) spotlightOpenTabs.delete(id);
    } catch (error) {
        Logger.error('[Background] Error closing spotlight in tracked tabs:', error);
    }
}

// Helper function to check if a URL supports content script injection
function supportsContentScripts(url) {
    if (!url) return false;

    const restrictedPatterns = [
        /^chrome:\/\//,
        /^chrome-extension:\/\//,
        /^edge:\/\//,
        /^about:/,
        /^moz-extension:\/\//,
        /^vivaldi:\/\//,
        /^brave:\/\//,
        /^opera:\/\//
    ];

    for (const pattern of restrictedPatterns) {
        if (pattern.test(url)) {
            return false;
        }
    }

    return true;
}

// Helper function to activate spotlight via content script messaging
async function injectSpotlightScript(spotlightTabMode, windowId = null) {
    try {
        // Check if spotlight is enabled
        const settings = await getSettings();
        if (!settings.enableSpotlight) {
            Logger.log("Spotlight is disabled in settings.");
            if (windowId) return false;

            if (spotlightTabMode === SpotlightTabMode.NEW_TAB) {
                Logger.log("Opening default new tab instead of spotlight new tab.");
                try {
                    await chrome.tabs.create({ url: 'chrome://new-tab-page/', ...(windowId ? { windowId } : {}) });
                } catch (e) {
                    await chrome.tabs.create({ url: 'chrome-search://local-ntp/local-ntp.html', ...(windowId ? { windowId } : {}) });
                }
            } else {
                Logger.log("Aborting spotlight injection.");
            }
            return;
        }

        // First, close any existing spotlights in tracked tabs
        await closeSpotlightInTrackedTabs(windowId);

        // Get the active tab
        const [tab] = await chrome.tabs.query({ active: true, ...(windowId ? { windowId } : { currentWindow: true }) });
        if (tab) {
            // Reuse an already-open Spotlight fallback rather than multiplying helper tabs.
            if (tab.url?.split(/[?#]/)[0] === chrome.runtime.getURL('newtab.html')) return true;
            if (!supportsContentScripts(tab.url)) {
                Logger.log("Tab URL doesn't support content scripts, opening custom new tab directly:", tab.url);
                return await fallbackToChromeTabs(spotlightTabMode, windowId);
            }

            try {
                const response = await chrome.tabs.sendMessage(tab.id, {
                    action: 'activateSpotlight',
                    mode: spotlightTabMode,
                    tabUrl: tab.url,
                    tabId: tab.id
                });

                if (response && response.success) {
                    chrome.runtime.sendMessage({
                        action: 'spotlightOpened',
                        mode: spotlightTabMode
                    });
                    return true;
                }
                return await fallbackToChromeTabs(spotlightTabMode, windowId);
            } catch (messageError) {
                Logger.log("Content script messaging failed, using new tab fallback:", messageError);
                return await fallbackToChromeTabs(spotlightTabMode, windowId);
            }
        }
    } catch (error) {
        Logger.log("All spotlight activation methods failed, using Chrome tab fallback:", error);
        return await fallbackToChromeTabs(spotlightTabMode, windowId);
    }
}

// Helper function for Chrome tab fallback when spotlight injection fails
async function fallbackToChromeTabs(spotlightTabMode, windowId = null) {
    try {
        await closeSpotlightInTrackedTabs(windowId);

        Logger.log(`Falling back to custom new tab page for mode: ${spotlightTabMode}`);
        await chrome.tabs.create({ url: chrome.runtime.getURL('newtab.html'), active: true, ...(windowId ? { windowId } : {}) });
        Logger.log("Spotlight failed - opened custom new tab with spotlight interface");
        return true;

    } catch (chromeTabError) {
        Logger.error("Error with Chrome tab fallback:", chromeTabError);
    }
}

// Listen for commands
chrome.commands.onCommand.addListener(async function (command) {
    if (command === "toggleSpotlight") {
        await injectSpotlightScript(SpotlightTabMode.CURRENT_TAB);
    } else if (command === "toggleSpotlightNewTab") {
        await injectSpotlightScript(SpotlightTabMode.NEW_TAB);
    }
});

// Listen for messages from the content script
chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
    // IMPORTANT: This listener must NOT be async. An async listener returns a Promise
    // (truthy), which Chrome interprets as "I will call sendResponse later", stealing
    // the response channel from other listeners and breaking message passing.
    if (request.command === "toggleSpotlight") {
        injectSpotlightScript(SpotlightTabMode.CURRENT_TAB);
    } else if (request.command === "toggleSpotlightNewTab") {
        injectSpotlightScript(SpotlightTabMode.NEW_TAB);
    }
});

// Track tab activation to close spotlights
chrome.tabs.onActivated.addListener(async (activeInfo) => {
    await closeSpotlightInTrackedTabs();
});

// Clean up spotlight tracking for closed tabs
chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
    if (spotlightOpenTabs.has(tabId)) {
        spotlightOpenTabs.delete(tabId);
    }
});

// Main message listener for spotlight operations
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'openNewTab') {
        chrome.tabs.create({ url: message.url });
        sendResponse({ success: true });
        return false;
    } else if (message.action === 'navigateToDefaultNewTab') {
        (async () => {
            try {
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (tab && tab.url && tab.url.includes('newtab.html')) {
                    try {
                        await chrome.tabs.update(tab.id, { url: 'chrome://new-tab-page/' });
                    } catch (e) {
                        await chrome.tabs.update(tab.id, { url: 'chrome-search://local-ntp/local-ntp.html' });
                    }
                }
                sendResponse({ success: true });
            } catch (error) {
                Logger.error('[Background] Error navigating to default new tab:', error);
                sendResponse({ success: false, error: error.message });
            }
        })();
        return true;
    } else if (message.action === 'switchToTab') {
        (async () => {
            try {
                await chrome.tabs.update(message.tabId, { active: true });
                await chrome.windows.update(message.windowId, { focused: true });
                sendResponse({ success: true });
            } catch (error) {
                Logger.error('[Background] Error switching to tab:', error);
                sendResponse({ success: false, error: error.message });
            }
        })();
        return true;
    } else if (message.action === 'navigateCurrentTab') {
        (async () => {
            try {
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (tab) {
                    await chrome.tabs.update(tab.id, { url: message.url });
                }
                sendResponse({ success: true });
            } catch (error) {
                Logger.error('[Background] Error navigating current tab:', error);
                sendResponse({ success: false, error: error.message });
            }
        })();
        return true;
    } else if (message.action === 'searchTabs') {
        (async () => {
            try {
                const tabs = await chrome.tabs.query({});
                const query = message.query?.toLowerCase() || '';
                const filteredTabs = tabs.filter(tab => {
                    if (!tab.title || !tab.url) return false;
                    if (!query) return true;
                    return tab.title.toLowerCase().includes(query) ||
                        tab.url.toLowerCase().includes(query);
                });
                sendResponse({ success: true, tabs: filteredTabs });
            } catch (error) {
                Logger.error('[Background] Error searching tabs:', error);
                sendResponse({ success: false, error: error.message });
            }
        })();
        return true;
    } else if (message.action === 'searchBookmarks') {
        (async () => {
            try {
                const bookmarks = await chrome.bookmarks.search(message.query);
                const filteredBookmarks = bookmarks.filter(bookmark => bookmark.url);
                sendResponse({ success: true, bookmarks: filteredBookmarks });
            } catch (error) {
                Logger.error('[Background] Error searching bookmarks:', error);
                sendResponse({ success: false, error: error.message });
            }
        })();
        return true;
    } else if (message.action === 'searchHistory') {
        (async () => {
            try {
                const historyItems = await chrome.history.search({
                    text: message.query,
                    maxResults: 10,
                    startTime: Date.now() - (7 * 24 * 60 * 60 * 1000)
                });
                sendResponse({ success: true, history: historyItems });
            } catch (error) {
                Logger.error('[Background] Error searching history:', error);
                sendResponse({ success: false, error: error.message });
            }
        })();
        return true;
    } else if (message.action === 'getTopSites') {
        (async () => {
            try {
                const topSites = await chrome.topSites.get();
                sendResponse({ success: true, topSites: topSites });
            } catch (error) {
                Logger.error('[Background] Error getting top sites:', error);
                sendResponse({ success: false, error: error.message });
            }
        })();
        return true;
    } else if (message.action === 'getAutocomplete') {
        (async () => {
            try {
                const dataProvider = backgroundSearchEngine.dataProvider;
                const suggestions = await dataProvider.getAutocompleteData(message.query);
                sendResponse({ success: true, suggestions: suggestions });
            } catch (error) {
                Logger.error('[Background] Error getting autocomplete suggestions:', error);
                sendResponse({ success: false, error: error.message, suggestions: [] });
            }
        })();
        return true;
    } else if (message.action === 'getPinnedTabs') {
        Logger.log('[Background] Received getPinnedTabs message:', message);
        (async () => {
            try {
                const dataProvider = backgroundSearchEngine.dataProvider;
                Logger.log('[Background] Getting pinned tabs from data provider...');
                const pinnedTabs = await dataProvider.getPinnedTabsData(message.query);
                Logger.log('[Background] Sending pinned tabs response:', pinnedTabs.length, 'tabs');
                sendResponse({ success: true, pinnedTabs: pinnedTabs });
            } catch (error) {
                Logger.error('[Background] Error getting pinned tabs:', error);
                sendResponse({ success: false, error: error.message, pinnedTabs: [] });
            }
        })();
        return true;
    } else if (message.action === 'getActiveSpaceColor') {
        (async () => {
            try {
                if (await arcifyBridge.getPeerId()) {
                    const context = await bridgeContext(message, sender);
                    const snapshot = await arcifyBridge.snapshot(context.windowId);
                    const activeSpace = snapshot.spaces.find(space => space.id === snapshot.activeSpaceId);
                    sendResponse({ success: true, color: activeSpace?.color || 'purple', groupName: activeSpace?.name || null });
                    return;
                }
                const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

                // Check if tab exists and is in a group
                if (!activeTab || !activeTab.groupId || activeTab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) {
                    sendResponse({ success: true, color: 'purple', groupName: null });
                    return;
                }

                // Fetch color directly from Tab Groups API
                try {
                    const group = await chrome.tabGroups.get(activeTab.groupId);
                    sendResponse({ success: true, color: group.color || 'purple', groupName: group.title || null });
                } catch (groupError) {
                    // Group may have been closed or API unavailable
                    Logger.error('[Background] Error fetching tab group:', groupError);
                    sendResponse({ success: true, color: 'purple', groupName: null });
                }
            } catch (error) {
                Logger.error('[Background] Error getting active space color:', error);
                sendResponse({ success: false, error: error.message, color: 'purple', groupName: null });
            }
        })();
        return true;
    } else if (message.action === 'performSearch') {
        (async () => {
            try {
                const disposition = message.mode === SpotlightTabMode.NEW_TAB ? 'NEW_TAB' : 'CURRENT_TAB';
                await chrome.search.query({
                    text: message.query,
                    disposition: disposition
                });
                sendResponse({ success: true });
            } catch (error) {
                Logger.error('[Background] Error performing search:', error);
                sendResponse({ success: false, error: error.message });
            }
        })();
        return true;
    } else if (message.action === 'getSpotlightSuggestions') {
        (async () => {
            try {
                const query = message.query.trim();
                // Use immediate path for all queries (PERF-02: single debounce layer)
                // The UI-layer debounce (150ms in SharedSpotlightLogic.createInputHandler) is the only debounce point.
                // getSpotlightSuggestionsUsingCache() is retained in SearchEngine for backward compatibility
                // but is no longer called from the main message handler path.
                const engine = await searchEngineForSender(message, sender);
                const results = await engine.getSpotlightSuggestionsImmediate(
                    query, message.mode
                );
                sendResponse({ success: true, results: results, ...(engine.dataProvider.snapshot?.warnings?.length ? { warnings: engine.dataProvider.snapshot.warnings } : {}) });
            } catch (error) {
                Logger.error('[Background] Error getting spotlight suggestions:', error);
                sendResponse({ success: false, error: error.message, results: [] });
            }
        })();
        return true;
    } else if (message.action === 'getLocalSuggestions') {
        (async () => {
            try {
                const query = message.query.trim();
                const engine = await searchEngineForSender(message, sender);
                const results = await engine.getLocalSuggestionsImmediate(
                    query, message.mode
                );
                sendResponse({ success: true, results: results, ...(engine.dataProvider.snapshot?.warnings?.length ? { warnings: engine.dataProvider.snapshot.warnings } : {}) });
            } catch (error) {
                Logger.error('[Background] Error getting local suggestions:', error);
                sendResponse({ success: false, error: error.message, results: [] });
            }
        })();
        return true;
    } else if (message.action === 'getAutocompleteSuggestions') {
        (async () => {
            try {
                const query = message.query.trim();
                const results = query
                    ? await backgroundDataProvider.getAutocompleteSuggestions(query)
                    : [];
                sendResponse({ success: true, results: results });
            } catch (error) {
                Logger.error('[Background] Error getting autocomplete suggestions:', error);
                sendResponse({ success: false, error: error.message, results: [] });
            }
        })();
        return true;
    } else if (message.action === 'spotlightHandleResult') {
        (async () => {
            try {
                if (!message.result || !message.result.type || !message.mode) {
                    throw new Error('Invalid spotlight result message');
                }

                const tabId = (sender.tab && sender.tab.id) ? sender.tab.id : message.tabId;
                const peerId = await arcifyBridge.getPeerId();
                if (!peerId && message.result.metadata?.arcifyBridge) throw new Error('Arcify was disconnected. Search again before selecting this result.');
                if (peerId) {
                    const context = await bridgeContext(message, sender);
                    // The extension helper is a launcher, so new navigation belongs to Arcify's
                    // newly active space rather than the helper's previous membership.
                    const mode = isNewTabSender(sender) ? SpotlightTabMode.NEW_TAB : message.mode;
                    const action = await handleBridgeResult(arcifyBridge, chrome, message.result, mode, context);
                    if (!action?.handled) throw new Error('Arcify was disconnected before the action. Search again.');
                    sendResponse({ success: true, bridge: true, command: action.command, tabId: action.tabId, sourceTabId: context.tabId });
                    return;
                } else {
                    await backgroundSearchEngine.handleResultAction(message.result, message.mode, tabId);
                }
                sendResponse({ success: true });
            } catch (error) {
                Logger.error('[Background] Error handling spotlight result:', error);
                sendResponse({ success: false, error: error.message });
            }
        })();
        return true;
    } else if (message.action === 'spotlightOpened') {
        if (sender.tab && sender.tab.id) {
            spotlightOpenTabs.add(sender.tab.id);
        }
        arcifyProvider.invalidateCache();
        return false;
    } else if (message.action === 'spotlightClosed') {
        if (sender.tab && sender.tab.id) {
            spotlightOpenTabs.delete(sender.tab.id);
        }
        return false;
    } else if (message.action === 'activatePinnedTab') {
        // Forward pinned tab activation to Arcify extension if installed
        // This allows Spotlight to work with Arcify's pinned tabs
        sendResponse({ success: false, error: 'Use a fresh Spotlight result to activate an Arcify pin.' });
        return false;
    } else if (message.action === 'getArcifySpaceForUrl') {
        // Return Arcify space info for a URL - O(1) lookup via cached Map
        (async () => {
            try {
                const spaceInfo = await arcifyProvider.getSpaceForUrl(message.url);
                sendResponse({ success: true, spaceInfo: spaceInfo });
            } catch (error) {
                Logger.error('[Background] Error getting Arcify space for URL:', error);
                sendResponse({ success: false, error: error.message, spaceInfo: null });
            }
        })();
        return true; // Keep channel open for async response
    }

    return false;
});

chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install' || details.reason === 'update') {
        chrome.tabs.create({ url: 'installation-onboarding.html' });
    }
});
