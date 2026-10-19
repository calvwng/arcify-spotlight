// message-client.js - Shared message passing abstraction for spotlight components
// Consolidates chrome.runtime.sendMessage patterns from overlay.js and popup.js

import { Logger } from '../logger.js';

export class SpotlightMessageClient {
    static errorListeners = new Set();

    static onError(callback) {
        this.errorListeners.add(callback);
        return () => this.errorListeners.delete(callback);
    }

    static reportError(message, source = 'refresh') {
        for (const listener of this.errorListeners) listener(message || 'The request could not be completed.', source);
    }

    // Get suggestions from background script
    static async getSuggestions(query, mode, bridgeRefresh) {
        try {
            const message = {
                action: 'getSpotlightSuggestions',
                query: query.trim(),
                mode: mode,
                ...(bridgeRefresh ? { bridgeRefresh } : {})
            };

            const response = await chrome.runtime.sendMessage(message);

            if (response && response.success) {
                if (response.discoveryStatus) this.reportError(response.discoveryStatus, 'discovery');
                if (response.warnings?.length) this.reportError(`Some pinned bookmarks are unavailable. ${response.warnings.map(warning => warning.message).join(' ')}`);
                return response.results;
            } else {
                Logger.error('[SpotlightMessageClient] Get suggestions failed:', response?.error);
                this.reportError(response?.error);
                return [];
            }
        } catch (error) {
            Logger.error('[SpotlightMessageClient] Get suggestions error:', error);
            return [];
        }
    }

    // Get local suggestions only (fast, no autocomplete) - PERF-03 progressive rendering Phase 1
    static async getLocalSuggestions(query, mode, bridgeRefresh) {
        try {
            const response = await chrome.runtime.sendMessage({
                action: 'getLocalSuggestions',
                query: query.trim(),
                mode: mode,
                ...(bridgeRefresh ? { bridgeRefresh } : {})
            });
            if (response && response.success) {
                if (response.discoveryStatus) this.reportError(response.discoveryStatus, 'discovery');
                if (response.warnings?.length) this.reportError(`Some pinned bookmarks are unavailable. ${response.warnings.map(warning => warning.message).join(' ')}`);
                return response.results;
            } else {
                Logger.error('[SpotlightMessageClient] Get local suggestions failed:', response?.error);
                this.reportError(response?.error);
                return [];
            }
        } catch (error) {
            Logger.error('[SpotlightMessageClient] Get local suggestions error:', error);
            return [];
        }
    }

    // Get autocomplete suggestions only (slow, network) - PERF-03 progressive rendering Phase 2
    static async getAutocompleteSuggestions(query) {
        try {
            const response = await chrome.runtime.sendMessage({
                action: 'getAutocompleteSuggestions',
                query: query.trim()
            });
            if (response && response.success) {
                if (response.discoveryStatus) this.reportError(response.discoveryStatus, 'discovery');
                if (response.warnings?.length) this.reportError(`Some pinned bookmarks are unavailable. ${response.warnings.map(warning => warning.message).join(' ')}`);
                return response.results;
            } else {
                Logger.error('[SpotlightMessageClient] Get autocomplete suggestions failed:', response?.error);
                return [];
            }
        } catch (error) {
            Logger.error('[SpotlightMessageClient] Get autocomplete suggestions error:', error);
            return [];
        }
    }

    // Handle result action via message passing
    static async handleResult(result, mode) {
        return (await this.handleResultDetailed(result, mode)).success;
    }

    static async handleResultDetailed(result, mode) {
        try {
            const message = {
                action: 'spotlightHandleResult',
                result: result,
                mode: mode,
                tabId: window.arcifyCurrentTabId || null  // Include tab ID for optimization
            };

            const response = await chrome.runtime.sendMessage(message);

            if (!response || response.success === false) {
                Logger.error('[SpotlightMessageClient] Result action failed:', response?.error || 'No response');
                this.reportError(response?.error || 'The action was not confirmed. Check your tabs before trying again.', 'action');
                return { success: false, error: response?.error, errorCode: response?.errorCode };
            }
            return { ...response, success: true };
        } catch (error) {
            Logger.error('[SpotlightMessageClient] Error handling result action:', error);
            this.reportError('The action was not confirmed. Check your tabs before trying again.', 'action');
            return { success: false };
        }
    }


    // Get active space color and group name from background
    static async getActiveSpaceColor() {
        try {
            const response = await chrome.runtime.sendMessage({
                action: 'getActiveSpaceColor'
            });

            if (response && response.success && response.color) {
                return { color: response.color, groupName: response.groupName || null };
            } else {
                Logger.error('[SpotlightMessageClient] Failed to get active space color:', response?.error);
                return { color: 'purple', groupName: null };
            }
        } catch (error) {
            Logger.error('[SpotlightMessageClient] Error getting active space color:', error);
            return { color: 'purple', groupName: null };
        }
    }

    // Notify background that spotlight opened
    static notifyOpened() {
        try {
            chrome.runtime.sendMessage({ action: 'spotlightOpened' });
        } catch (error) {
            Logger.error('[SpotlightMessageClient] Error notifying spotlight opened:', error);
        }
    }

    // Notify background that spotlight closed
    static notifyClosed() {
        try {
            chrome.runtime.sendMessage({ action: 'spotlightClosed' });
        } catch (error) {
            Logger.error('[SpotlightMessageClient] Error notifying spotlight closed:', error);
        }
    }

    // Switch to tab (new-tab mode)
    static async switchToTab(tabId, windowId) {
        try {
            const response = await chrome.runtime.sendMessage({
                action: 'switchToTab',
                tabId: tabId,
                windowId: windowId
            });
            return response?.success === true;
        } catch (error) {
            Logger.error('[SpotlightMessageClient] Error switching to tab:', error);
            return false;
        }
    }

    // Navigate current tab
    static async navigateCurrentTab(url) {
        try {
            const response = await chrome.runtime.sendMessage({
                action: 'navigateCurrentTab',
                url: url
            });
            return response?.success === true;
        } catch (error) {
            Logger.error('[SpotlightMessageClient] Error navigating current tab:', error);
            return false;
        }
    }


    // Open new tab
    static async openNewTab(url) {
        try {
            const response = await chrome.runtime.sendMessage({
                action: 'openNewTab',
                url: url
            });
            return response?.success === true;
        } catch (error) {
            Logger.error('[SpotlightMessageClient] Error opening new tab:', error);
            return false;
        }
    }

    // Perform search
    static async performSearch(query, mode) {
        try {
            const response = await chrome.runtime.sendMessage({
                action: 'performSearch',
                query: query,
                mode: mode
            });
            return response?.success === true;
        } catch (error) {
            Logger.error('[SpotlightMessageClient] Error performing search:', error);
            return false;
        }
    }

    // Setup message listener for global close commands
    static setupGlobalCloseListener(onCloseCallback) {
        const messageListener = (message) => {
            if (message.action === 'closeSpotlight') {
                onCloseCallback();
            }
        };

        chrome.runtime.onMessage.addListener(messageListener);

        // Return cleanup function
        return () => {
            chrome.runtime.onMessage.removeListener(messageListener);
        };
    }
}
