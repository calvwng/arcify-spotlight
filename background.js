import { installFavoriteWitness } from './shared/favorite-witness.js';
import { WITNESS_CAPABILITY } from './shared/favorite-witness-protocol.js';
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
import { installArcifyArchiveMessages } from './shared/arcify-archive-actions.js';
import { installArcifyTabActionMessages } from './shared/arcify-tab-actions.js';
import { installArcifySpaceActionMessages } from './shared/arcify-space-actions.js';
import { BRIDGE_TYPE, isExtensionId, isWindowId, trustedSender, validateRequest, responseFor } from './shared/arcify-bridge-protocol.js';
import { ArcifyBridgeProvider } from './shared/data-providers/arcify-bridge-provider.js';
import { handleBridgeResult } from './shared/arcify-bridge-actions.js';
import { offerStartupSidebarSuggestion } from './shared/startup-sidebar-suggestion.js';
import { LIVE_TAB_CONTEXT, createLiveOverlayRegistry, createArcifyResultUpdates, installLiveTabResultUpdates } from './shared/live-tab-results.js';
import { createActiveNewTabReuse, isBrowserNewTabAlias, isSameActiveTab } from './shared/active-newtab-reuse.js';
import { boundedOverlayDelivery, captureOverlayCommand, installOverlayRecoveryValidation, isMissingOverlayReceiver, recoverOverlayReceiver } from './shared/overlay-recovery.js';

installFavoriteWitness(chrome, arcifyBridge.favoriteWitness);
const activeNewTabReuse = createActiveNewTabReuse(chrome);
installOverlayRecoveryValidation(chrome);
installArcifySpaceActionMessages(chrome, arcifyBridge, {
    verifyHelper: tab => activeNewTabReuse.reuseOrFallback(tab, async () => false)
});
installArcifyTabActionMessages(chrome, arcifyBridge, {
    verifyHelper: tab => activeNewTabReuse.reuseOrFallback(tab, async () => false)
});
installArcifyArchiveMessages(chrome, arcifyBridge, {
    verifyHelper: tab => activeNewTabReuse.reuseOrFallback(tab, async () => false)
});

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
    assertRefreshScope(message, peerId);
    const sourceTabId = sender.tab?.id ?? message.tabId;
    const helperTabId = isNewTabSender(sender) && Number.isSafeInteger(sourceTabId) && sourceTabId > 0 ? sourceTabId : null;
    if (!peerId) {
        if (!helperTabId) return backgroundSearchEngine;
        const provider = new BackgroundDataProvider({ excludeTabId: helperTabId, preserveTabIdentities: true });
        provider.autocompleteProvider = backgroundDataProvider.autocompleteProvider;
        return new SearchEngine(provider);
    }
    const context = await bridgeContext(message, sender);
    assertRefreshScope(message, peerId, context.windowId);
    const snapshot = await arcifyBridge.snapshot(context.windowId, peerId);
    if (!snapshot) throw new Error('Arcify was disconnected. Search again.');
    // The exact calling helper is already visible. Other same-URL/title tabs are
    // independent choices and remain searchable. Never guess from the active tab.
    const excludeTabId = helperTabId ? context.tabId : null;
    return new SearchEngine(new ArcifyBridgeProvider(snapshot, backgroundDataProvider, peerId, { excludeTabId }));
}

// A logical invalidation remains paired throughout its entire fresh read. A
// revocation between UI validation and search must not switch to native results.
function assertRefreshScope(message, peerId, windowId) {
    const scope = message.bridgeRefresh;
    if (scope === undefined) return;
    if (!scope || typeof scope !== 'object' || Array.isArray(scope) ||
        Object.keys(scope).some(key => !['peerId', 'windowId'].includes(key)) ||
        !isExtensionId(scope.peerId) || !isWindowId(scope.windowId) ||
        scope.peerId !== peerId || (windowId !== undefined && scope.windowId !== windowId)) {
        throw Object.assign(new Error('Arcify connection or window changed. Search again.'), { code: 'DISCONNECTED' });
    }
}

async function validateCompletedRefresh(message, sender) {
    if (message.bridgeRefresh === undefined) return;
    const context = await bridgeContext(message, sender);
    // Browser-attested sender.tab belongs to dispatch time; the surface may move
    // while its snapshot/search is awaited. Check its live identity once more.
    const tab = await chrome.tabs.get(context.tabId);
    if (!isWindowId(tab?.windowId)) throw new Error('The source tab is no longer available.');
    assertRefreshScope(message, await arcifyBridge.getPeerId(), tab.windowId);
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
function pairedLaunch(message, peerId) {
    const key = `${peerId}:${message.requestId}`;
    const signature = JSON.stringify([message.windowId, message.mode]);
    const existing = recentLaunches.get(key);
    if (existing) {
        if (existing.signature !== signature) throw Object.assign(new Error('Request ID was already used for another launch.'), { code: 'REQUEST_ID_REUSED' });
        return existing.promise;
    }
    const promise = Promise.resolve().then(async () => {
        if (await arcifyBridge.getPeerId() !== peerId) throw Object.assign(new Error('Arcify pairing changed.'), { code: 'UNAUTHORIZED' });
        return injectSpotlightScript(message.mode, message.windowId, { ensureOpen: true, expectedPeerId: peerId });
    });
    recentLaunches.set(key, { signature, promise });
    // Bounded lifetime-local replay guard, not a persistent browsing log.
    if (recentLaunches.size > 100) recentLaunches.delete(recentLaunches.keys().next().value);
    return promise;
}

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
    if (message?.type !== BRIDGE_TYPE) return false;
    (async () => {
        try {
            const peerId = await arcifyBridge.getPeerId();
            if (!trustedSender(sender, peerId)) throw Object.assign(new Error('Pair this Arcify extension in Spotlight settings first.'), { code: 'UNAUTHORIZED' });
            validateRequest(message, ['hello', 'launch', 'startupSuggestion', 'invalidate']);
            let targetWindow;
            try { targetWindow = await chrome.windows.get(message.windowId); }
            catch (error) {
                if (message.command !== 'invalidate') throw error;
                throw Object.assign(new Error('The Arcify result window is no longer available.'), { code: 'INVALID_WINDOW' });
            }
            if (message.command === 'invalidate') {
                if (targetWindow?.id !== message.windowId || targetWindow.incognito || targetWindow.type !== 'normal' ||
                    (sender.tab && sender.tab.windowId !== message.windowId)) {
                    throw Object.assign(new Error('Invalid Arcify result window.'), { code: 'INVALID_WINDOW' });
                }
                if (await arcifyBridge.getPeerId() !== peerId) throw Object.assign(new Error('Arcify pairing changed.'), { code: 'UNAUTHORIZED' });
                arcifyResultUpdates.invalidate(message.windowId, peerId);
            }
            if (message.command === 'launch') {
                const opened = await pairedLaunch(message, peerId);
                if (!opened) throw Object.assign(new Error('Spotlight is disabled or could not open.'), { code: 'LAUNCH_FAILED' });
            }
            const startupResult = message.command === 'startupSuggestion'
                ? await offerStartupSidebarSuggestion(chrome, arcifyBridge, message, peerId) : undefined;
            sendResponse(responseFor(message, 'spotlight', { ok: true, extensionId: chrome.runtime.id,
                ...(message.command === 'hello' ? { capabilities: ['startupSuggestion', WITNESS_CAPABILITY] } : {}),
                ...(startupResult || {}) }));
        } catch (error) {
            sendResponse(responseFor(message, 'spotlight', { ok: false, error: { code: error.code || 'FAILED', message: error.message } }));
        }
    })();
    return true;
});


// Track tabs that have spotlight open for efficient closing
const spotlightOpenTabs = createLiveOverlayRegistry(chrome);
installLiveTabResultUpdates(chrome, () => spotlightOpenTabs.getIds());
const arcifyResultUpdates = createArcifyResultUpdates(chrome, () => spotlightOpenTabs.getIds(), () => arcifyBridge.getPeerId());

// Close spotlight in tracked tabs only
async function closeSpotlightInTrackedTabs(windowId = null, exceptTabId = null) {
    try {
        const targetIds = windowId ? new Set((await chrome.tabs.query({ windowId })).map(tab => tab.id)) : null;
        const closingIds = Array.from(await spotlightOpenTabs.getIds()).filter(id => id !== exceptTabId && (!targetIds || targetIds.has(id)));
        const closePromises = closingIds.map(tabId =>
            chrome.tabs.sendMessage(tabId, { action: 'closeSpotlight' }).catch(() => {
                spotlightOpenTabs.remove([tabId]);
            })
        );
        await Promise.all(closePromises);
        await spotlightOpenTabs.remove(closingIds);
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

// All entry points share the same per-window queue. Resolve a shortcut's origin
// before waiting, so changing focused windows cannot retarget a queued command.
const activationQueues = new Map();
async function injectSpotlightScript(spotlightTabMode, windowId = null, { ensureOpen = false, expectedPeerId = null, keyboardCommand = false, commandTab } = {}) {
    const allowDisabledFallback = windowId === null;
    // activeTab belongs to THIS extension's browser-dispatched command. A peer
    // launch or an internal message must never borrow or manufacture that grant.
    const commandGuard = keyboardCommand ? captureOverlayCommand(chrome, commandTab) : null;
    const commandSource = commandGuard ? await commandGuard.resolve() : null;
    if (commandGuard && !commandSource) { commandGuard.dispose(); return false; }
    if (commandSource) windowId = commandSource.windowId;
    if (windowId === null) {
        try {
            const [source] = await chrome.tabs.query({ active: true, currentWindow: true });
            windowId = source?.windowId;
        } catch { return false; }
    }
    if (!isWindowId(windowId)) { commandGuard?.dispose(); return false; }
    const previous = activationQueues.get(windowId) || Promise.resolve();
    const promise = previous.catch(() => {}).then(async () => {
        if (expectedPeerId && await arcifyBridge.getPeerId() !== expectedPeerId)
            throw Object.assign(new Error('Arcify pairing changed.'), { code: 'UNAUTHORIZED' });
        if (commandGuard && !await commandGuard.isCurrent()) return false;
        return activateSpotlightInWindow(spotlightTabMode, windowId, { ensureOpen, allowDisabledFallback, commandSource, commandGuard });
    });
    activationQueues.set(windowId, promise);
    promise.finally(() => { commandGuard?.dispose(); if (activationQueues.get(windowId) === promise) activationQueues.delete(windowId); }).catch(() => {});
    return promise;
}

// Helper function to activate spotlight via content script messaging
async function activateSpotlightInWindow(spotlightTabMode, windowId, { ensureOpen, allowDisabledFallback, commandSource, commandGuard }) {
    const isCurrent = commandGuard ? () => commandGuard.isCurrent() : null;
    const fallback = () => fallbackToChromeTabs(spotlightTabMode, windowId, isCurrent);
    try {
        // Check if spotlight is enabled
        const settings = await getSettings();
        if (!settings.enableSpotlight) {
            Logger.log("Spotlight is disabled in settings.");
            if (!allowDisabledFallback || (isCurrent && !await isCurrent())) return false;

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

        // Get the active tab
        const tab = commandSource || (await chrome.tabs.query({ active: true, ...(windowId ? { windowId } : { currentWindow: true }) }))[0];
        if (commandGuard && !await isCurrent()) return false;
        if (tab) {
            // tabs.create may finish before its new helper has committed. Do not
            // multiply it while loading, or interfere with a user navigation to it.
            if (tab.pendingUrl?.split(/[?#]/)[0] === chrome.runtime.getURL('newtab.html')) return false;
            // Reuse only the active source. Do this before any overlay teardown and
            // never focus/reinitialize the document or overwrite an omnibox draft.
            if (tab.url?.split(/[?#]/)[0] === chrome.runtime.getURL('newtab.html'))
                return await isSameActiveTab(chrome, tab);
            if (isBrowserNewTabAlias(tab.url)) {
                return await activeNewTabReuse.reuseOrFallback(tab,
                    isCurrent => fallbackToChromeTabs(spotlightTabMode, windowId, isCurrent));
            }
            // Let the target content script own its lifecycle. Closing it here races its
            // delayed teardown and also prevents the normal shortcut from toggling it.
            await closeSpotlightInTrackedTabs(windowId, tab.id);
            if (commandGuard && !await isCurrent()) return false;
            if (!supportsContentScripts(tab.url)) {
                Logger.log("Tab URL doesn't support content scripts, opening custom new tab directly:", tab.url);
                return await fallback();
            }

            const message = {
                action: 'activateSpotlight', mode: spotlightTabMode, ensureOpen,
                tabUrl: tab.url, tabId: tab.id, ...(commandGuard ? { expectedUrl: tab.url } : {})
            };
            try {
                const response = await boundedOverlayDelivery(commandGuard
                    ? chrome.tabs.sendMessage(tab.id, message, { frameId: 0 })
                    : chrome.tabs.sendMessage(tab.id, message));
                if (commandGuard && !await isCurrent()) return false;
                if (response?.success) {
                    if (response.open !== false) await spotlightOpenTabs.add(tab.id);
                    else await spotlightOpenTabs.remove([tab.id]);
                    return true;
                }
                // No acknowledgement is not proof of failure: it may have opened.
                return response?.success === false && !response.changed ? await fallback() : false;
            } catch (messageError) {
                if (!isMissingOverlayReceiver(messageError)) {
                    Logger.log('Overlay delivery is uncertain; leaving the current surface alone:', messageError);
                    return false;
                }
                if (commandGuard) {
                    const result = await recoverOverlayReceiver(chrome, tab, commandGuard, message);
                    if (result.status === 'opened') {
                        await spotlightOpenTabs.add(tab.id);
                        return true;
                    }
                    if (result.status !== 'fallback') return false;
                }
                return await fallback();
            }
        }
    } catch (error) {
        Logger.log("All spotlight activation methods failed, using Chrome tab fallback:", error);
        return await fallback();
    }
}

// Helper function for Chrome tab fallback when spotlight injection fails
async function fallbackToChromeTabs(spotlightTabMode, windowId = null, isCurrent = null) {
    try {
        if (isCurrent && !await isCurrent()) return false;
        await closeSpotlightInTrackedTabs(windowId);
        if (isCurrent && !await isCurrent()) return false;

        Logger.log(`Falling back to custom new tab page for mode: ${spotlightTabMode}`);
        await chrome.tabs.create({ url: chrome.runtime.getURL('newtab.html'), active: true, ...(windowId ? { windowId } : {}) });
        Logger.log("Spotlight failed - opened custom new tab with spotlight interface");
        return true;

    } catch (chromeTabError) {
        Logger.error("Error with Chrome tab fallback:", chromeTabError);
    }
}

// Listen for commands
chrome.commands.onCommand.addListener(async function (command, tab) {
    if (command === "toggleSpotlight") {
        await injectSpotlightScript(SpotlightTabMode.CURRENT_TAB, null, { keyboardCommand: true, commandTab: tab });
    } else if (command === "toggleSpotlightNewTab") {
        await injectSpotlightScript(SpotlightTabMode.NEW_TAB, null, { keyboardCommand: true, commandTab: tab });
    }
});

// Listen for messages from the content script
chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
    // IMPORTANT: This listener must NOT be async. An async listener returns a Promise
    // (truthy), which Chrome interprets as "I will call sendResponse later", stealing
    // the response channel from other listeners and breaking message passing.
    const mode = request.command === 'toggleSpotlight' ? SpotlightTabMode.CURRENT_TAB
        : request.command === 'toggleSpotlightNewTab' ? SpotlightTabMode.NEW_TAB : null;
    if (!mode) return false;
    injectSpotlightScript(mode).then(opened => sendResponse({ success: opened === true }),
        () => sendResponse({ success: false }));
    return true;
});

// Track tab activation to close spotlights
chrome.tabs.onActivated.addListener(async (activeInfo) => {
    await closeSpotlightInTrackedTabs();
});

// Clean up spotlight tracking for closed tabs
chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
    await spotlightOpenTabs.remove([tabId]);
});

// Main message listener for spotlight operations
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === LIVE_TAB_CONTEXT) {
        if (sender.id !== chrome.runtime.id) return false;
        (async () => {
            try {
                const peerId = await arcifyBridge.getPeerId();
                const context = await bridgeContext(message, sender);
                if (await arcifyBridge.getPeerId() !== peerId) return sendResponse({ success: false });
                sendResponse({ success: true, windowId: context.windowId, sourceTabId: context.tabId, allWindows: !peerId, peerId });
            } catch { sendResponse({ success: false }); }
        })();
        return true;
    } else if (message.action === 'openNewTab') {
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
                await validateCompletedRefresh(message, sender);
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
                await validateCompletedRefresh(message, sender);
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
                sendResponse({ success: false, error: error.message, errorCode: error.code });
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
            spotlightOpenTabs.remove([sender.tab.id]);
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
