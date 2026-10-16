/**
 * New Tab Spotlight - Standalone spotlight page for new tab override
 * 
 * Purpose: Provides spotlight functionality on new tab page
 * Use Case: Fallback when spotlight cannot be injected (chrome:// URLs, restricted pages)
 * Architecture: Reuses shared spotlight modules in standalone page context
 */

import { SpotlightUtils } from './shared/ui-utilities.js';
import { SelectionManager } from './shared/selection-manager.js';
import { SpotlightMessageClient } from './shared/message-client.js';
import { SpotlightTabMode } from './shared/search-types.js';
import { SharedSpotlightLogic } from './shared/shared-component-logic.js';
import { Logger } from './logger.js';
import { mountBridgeStatus } from './shared/bridge-status-ui.js';
import { shouldCloseNewTab } from './shared/bridge-navigation-ui.js';
import { SidebarCommandController, isSidebarResult } from './shared/arcify-sidebar-command.js';
import { TabActionController, isTabActionResult } from './shared/arcify-tab-actions-ui.js';
import { SpaceActionController, isSpaceActionResult } from './shared/arcify-space-actions-ui.js';
import { mountLiveTabResults, isTabResultRemoved } from './shared/live-tab-results.js';
import { mountStartupSidebarSuggestion } from './shared/startup-sidebar-suggestion.js';
import { mountActiveNewTabReuse } from './shared/active-newtab-reuse.js';

// Initialize spotlight on page load
// Initialize spotlight on page load
document.addEventListener('DOMContentLoaded', async () => {
    const container = document.getElementById('spotlight-container');

    // Check if spotlight is enabled (controls both spotlight and custom new tab)
    const settings = await chrome.storage.sync.get({ enableSpotlight: true });

    if (!settings.enableSpotlight) {
        // Request background script to navigate to default new tab
        try {
            await chrome.runtime.sendMessage({
                action: 'navigateToDefaultNewTab'
            });
        } catch (error) {
            Logger.error('[NewTab] Error navigating to default new tab:', error);
        }
        return;
    }

    // If enabled, show container and initialize
    if (container) {
        container.style.visibility = 'visible';
    }
    await initializeSpotlight();
});

export async function initializeSpotlight() {
    const container = document.getElementById('spotlight-container');

    // Start with default color - will update asynchronously
    let activeSpaceColor = 'purple';
    let activeGroupName = null; // Active tab group name for Arcify context

    // CSS styles with default accent color
    const accentColorDefinitions = await SpotlightUtils.getAccentColorCSS(activeSpaceColor);
    const spotlightCSS = `
        ${accentColorDefinitions}
        
        /* Smooth transitions for color changes */
        :root {
            transition: --spotlight-accent-color 0.3s ease,
                       --spotlight-accent-color-15 0.3s ease,
                       --spotlight-accent-color-20 0.3s ease,
                       --spotlight-accent-color-80 0.3s ease;
        }
        
        .arcify-spotlight-wrapper {
            background: #2D2D2D;
            border-radius: 12px;
            border: 1px solid rgba(255, 255, 255, 0.1);
            padding: 0;
            color: #ffffff;
            position: relative;
            overflow: hidden;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
            animation: spotlight-appear 0.3s ease-out;
        }

        @keyframes spotlight-appear {
            from {
                opacity: 0;
                transform: scale(0.95);
            }
            to {
                opacity: 1;
                transform: scale(1);
            }
        }

        .arcify-spotlight-input-wrapper {
            display: flex;
            align-items: center;
            padding: 12px 24px 12px 20px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        }

        .arcify-spotlight-search-icon {
            width: 20px;
            height: 20px;
            margin-right: 12px;
            opacity: 0.6;
            flex-shrink: 0;
        }

        .arcify-spotlight-input {
            flex: 1;
            background: transparent;
            border: none;
            color: #ffffff;
            font-size: 18px;
            line-height: 24px;
            padding: 8px 0;
            outline: none;
            font-weight: 400;
        }

        .arcify-spotlight-input::placeholder {
            color: rgba(255, 255, 255, 0.5);
        }

        .arcify-spotlight-results {
            max-height: 270px;
            overflow-y: auto;
            padding: 8px 0;
            scroll-behavior: smooth;
            scrollbar-width: none;
            -ms-overflow-style: none;
        }

        .arcify-spotlight-results::-webkit-scrollbar {
            display: none;
        }

        .arcify-spotlight-result-item {
            display: flex;
            align-items: center;
            padding: 12px 24px 12px 20px;
            min-height: 44px;
            cursor: pointer;
            transition: background-color 0.15s ease;
            border: none;
            background: none;
            width: 100%;
            text-align: left;
            color: inherit;
            font-family: inherit;
        }

        .arcify-spotlight-result-item:hover,
        .arcify-spotlight-result-item:focus {
            background: var(--spotlight-accent-color-15);
            outline: none;
        }

        .arcify-spotlight-result-item.selected {
            background: var(--spotlight-accent-color-20);
        }

        .arcify-spotlight-result-favicon {
            width: 20px;
            height: 20px;
            margin-right: 12px;
            border-radius: 4px;
            flex-shrink: 0;
        }

        .arcify-spotlight-result-content {
            flex: 1;
            min-width: 0;
            min-height: 32px;
            display: flex;
            flex-direction: column;
            justify-content: center;
        }

        .arcify-spotlight-result-title {
            font-size: 14px;
            font-weight: 500;
            color: #ffffff;
            margin: 0 0 2px 0;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .arcify-spotlight-result-url {
            font-size: 12px;
            color: rgba(255, 255, 255, 0.6);
            margin: 0;
            display: flex;
            align-items: center;
            gap: 6px;
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
        }

        .arcify-spotlight-result-url:empty {
            display: none;
        }

        /* Space chip - inline with URL */
        .arcify-spotlight-result-url-text {
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            min-width: 0;
        }

        .arcify-space-chip {
            display: inline-flex;
            align-items: center;
            padding: 1px 8px;
            border-radius: 9999px;
            font-size: 10px;
            font-weight: 500;
            line-height: 16px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            max-width: 140px;
            flex-shrink: 0;
        }

        .arcify-spotlight-result-action {
            font-size: 12px;
            color: var(--spotlight-accent-color-80);
            margin-left: 12px;
            flex-shrink: 0;
        }

        .arcify-spotlight-loading {
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 24px;
            color: rgba(255, 255, 255, 0.6);
        }

        .arcify-spotlight-empty {
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 24px;
            color: rgba(255, 255, 255, 0.6);
            font-size: 14px;
        }

        @media (max-width: 640px) {
            .arcify-spotlight-input {
                font-size: 16px;
            }
        }
    `;

    // Create and inject styles
    const styleSheet = document.createElement('style');
    styleSheet.id = 'arcify-spotlight-styles';
    styleSheet.textContent = spotlightCSS;
    document.head.appendChild(styleSheet);

    // Create spotlight UI
    container.innerHTML = `
        <div class="arcify-spotlight-wrapper" data-testid="spotlight-overlay">
            <div class="arcify-spotlight-input-wrapper">
                <svg class="arcify-spotlight-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="11" cy="11" r="8"></circle>
                    <path d="m21 21-4.35-4.35"></path>
                </svg>
                <input
                    type="text"
                    class="arcify-spotlight-input"
                    data-testid="spotlight-input"
                    placeholder="Search or enter URL (opens in new tab)..."
                    spellcheck="false"
                    autocomplete="off"
                    autocorrect="off"
                    autocapitalize="off"
                >
            </div>
            <div class="arcify-spotlight-results" data-testid="spotlight-results">
                <div class="arcify-spotlight-loading" data-testid="spotlight-loading">Loading...</div>
            </div>
        </div>
    `;

    // Get references to key elements
    const input = container.querySelector('.arcify-spotlight-input');
    const resultsContainer = container.querySelector('.arcify-spotlight-results');
    const bridgeStatus = mountBridgeStatus(resultsContainer.parentElement);
    let actionPending = false;
    let disposed = false;
    let initialResultsReady = false;
    let manuallySelected = false;
    let selectionInvalidated = false;
    let startupSuggestion;
    let sidebarCommand;
    let spaceActions;
    let tabActions;

    // Initialize spotlight state
    let currentResults = [];
    let typedQuery = ''; // Genuine input only; keyboard URL/title previews do not change the search.
    let instantSuggestion = null;
    let asyncSuggestions = [];
    let searchQueryId = 0; // Query generation counter for stale response protection (PERF-03)

    // Send get suggestions message to background script
    // Use 'current-tab' mode so navigation happens in the current tab (the new tab page itself)
    async function sendGetSuggestionsMessage(query, mode, bridgeRefresh) {
        return await SpotlightMessageClient.getSuggestions(query, mode, bridgeRefresh);
    }

    // Handle result action via message passing
    // Use 'current-tab' mode so navigation happens in the current tab (the new tab page itself)
    async function handleResultActionViaMessage(result, mode) {
        return await SpotlightMessageClient.handleResultDetailed(result, mode);
    }

    // URL preview callback - updates input value with selected result URL
    const handleSelectionChange = (result, index) => {
        selectionInvalidated = false;
        manuallySelected = true;
        startupSuggestion?.cancel();
        if (isSidebarResult(result) || isSpaceActionResult(result) || isTabActionResult(result)) return;
        if (result && result.metadata && result.metadata.query) {
            // For search/autocomplete suggestions, use the query
            input.value = result.metadata.query;
        } else if (result && result.url) {
            input.value = result.url;
        } else if (result && result.title) {
            input.value = result.title;
        } else {
            input.value = '';
        }
    };

    const selectionManager = new SelectionManager(resultsContainer, handleSelectionChange, () => {
        manuallySelected = true;
        selectionInvalidated = false;
        startupSuggestion?.cancel();
    });
    sidebarCommand = new SidebarCommandController({ newTab: true, showError: bridgeStatus.showError, showSuccess: bridgeStatus.showSuccess, onChange: () => { if (!sidebarCommand?.peerId) startupSuggestion?.cancel(); updateDisplay(); } });
    startupSuggestion = mountStartupSidebarSuggestion({ document, input, controller: sidebarCommand,
        isReady: () => initialResultsReady && !disposed,
        select: () => { manuallySelected = false; updateDisplay(); },
        clearSelection: () => { manuallySelected = false; selectionManager.selectedIndex = -1; selectionManager.updateVisualSelection(); } });
    spaceActions = new SpaceActionController({ parent: resultsContainer.parentElement, input, newTab: true, showError: bridgeStatus.showError, showSuccess: bridgeStatus.showSuccess, onChange: () => updateDisplay() });
    tabActions = new TabActionController({ parent: resultsContainer.parentElement, input, newTab: true, showError: bridgeStatus.showError, showSuccess: bridgeStatus.showSuccess, onChange: () => updateDisplay() });
    const liveResults = mountLiveTabResults({
        isActive: () => !disposed,
        onInvalidate: removedTabIds => {
            searchQueryId++;
            if (isTabResultRemoved(selectionManager.getSelectedResult(), removedTabIds)) selectionInvalidated = true;
            asyncSuggestions = asyncSuggestions.filter(result => !isTabResultRemoved(result, removedTabIds));
            updateDisplay();
        },
        onRefresh: bridgeRefresh => { spaceActions.ready = spaceActions.prepare(); tabActions.ready = tabActions.prepare(); return typedQuery ? handleAsyncSearch(bridgeRefresh) : loadInitialResults(bridgeRefresh); }
    });
    const activeNewTabReuse = mountActiveNewTabReuse({ isReady: () => !disposed && container.isConnected });
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        searchQueryId++;
        startupSuggestion.dispose();
        sidebarCommand.dispose();
        spaceActions.dispose();
        tabActions.dispose();
        liveResults.dispose();
        activeNewTabReuse.dispose();
        bridgeStatus.dispose();
    };
    window.addEventListener('pagehide', dispose, { once: true });

    // Load initial results
    // Use 'current-tab' mode since we're on the new tab page itself
    async function loadInitialResults(bridgeRefresh) {
        const queryId = ++searchQueryId;
        try {
            instantSuggestion = null;
            const results = await sendGetSuggestionsMessage('', 'current-tab', bridgeRefresh);
            if (disposed || queryId !== searchQueryId || typedQuery) return;
            initialResultsReady = true;
            asyncSuggestions = results || [];
            updateDisplay();
        } catch (error) {
            if (disposed || queryId !== searchQueryId || typedQuery) return;
            initialResultsReady = true;
            Logger.error('[NewTab Spotlight] Error loading initial results:', error);
            instantSuggestion = null;
            asyncSuggestions = [];
            displayEmptyState();
        }
    }

    // Handle instant suggestion update (no debouncing)
    function handleInstantInput() {
        if (disposed) return;
        searchQueryId++; // Cancel in-flight results as soon as the input changes.
        typedQuery = input.value.trim();
        const query = typedQuery;
        asyncSuggestions = []; // Never promote or activate stale matches for a new query.

        if (!query) {
            instantSuggestion = null;
            asyncSuggestions = [];
            updateDisplay();
            loadInitialResults();
            return;
        }

        instantSuggestion = SpotlightUtils.generateInstantSuggestion(query);
        updateDisplay();
    }

    // Handle async search (debounced) - Two-phase progressive rendering (PERF-03)
    // Phase 1: Local results render immediately (~10-50ms)
    // Phase 2: Autocomplete appends when ready (~200-500ms)
    // Stale queries are discarded via query generation counter
    async function handleAsyncSearch(bridgeRefresh) {
        if (disposed) return;
        const query = typedQuery;
        const queryId = ++searchQueryId;

        if (!query) {
            asyncSuggestions = [];
            updateDisplay();
            return;
        }

        try {
            // Phase 1: Local results (fast)
            const localResults = await SpotlightMessageClient.getLocalSuggestions(query, 'current-tab', bridgeRefresh);
            if (disposed || queryId !== searchQueryId) return; // Stale query -- discard
            asyncSuggestions = localResults || [];
            updateDisplay();

            // Phase 2: Autocomplete results (slow, network)
            const autocompleteResults = await SpotlightMessageClient.getAutocompleteSuggestions(query);
            if (disposed || queryId !== searchQueryId) return; // Stale query -- discard

            if (autocompleteResults && autocompleteResults.length > 0) {
                const allResults = await SpotlightMessageClient.getSuggestions(query, 'current-tab', bridgeRefresh);
                if (disposed || queryId !== searchQueryId) return; // Stale query -- discard
                asyncSuggestions = allResults || [];
                updateDisplay();
            }
        } catch (error) {
            Logger.error('[NewTab Spotlight] Search error:', error);
            if (queryId === searchQueryId) {
                asyncSuggestions = [];
                updateDisplay();
            }
        }
    }

    // Combine instant and async suggestions with deduplication
    function combineResults() {
        const command = sidebarCommand?.result(typedQuery);
        return SharedSpotlightLogic.combineResults(instantSuggestion, asyncSuggestions, {
            actions: [...(command ? [command] : []), ...(spaceActions?.results(typedQuery) || []), ...(tabActions?.results(typedQuery) || [])], query: typedQuery,
            preferredAction: startupSuggestion?.selected ? command : null
        });
    }

    // Update the display with combined results
    function updateDisplay() {
        if (disposed) return;
        const previousResults = currentResults;
        const previous = selectionManager.getSelectedResult();
        if (isSidebarResult(previous) && !sidebarCommand?.peerId || isSpaceActionResult(previous) && !spaceActions?.matches(previous) || isTabActionResult(previous) && !tabActions?.matches(previous)) selectionInvalidated = true;
        currentResults = combineResults();
        selectionManager.updateResults(currentResults, { preserveSelection: manuallySelected });
        if (!manuallySelected && !typedQuery && !startupSuggestion?.selected && (isSidebarResult(currentResults[0]) || isSpaceActionResult(currentResults[0]) || isTabActionResult(currentResults[0]))) selectionManager.selectedIndex = -1;
        // A failed/revoked command or removed tab must not expose another action to
        // held Enter or a later async refresh. Fresh input/navigation can select again.
        if (selectionInvalidated) selectionManager.selectedIndex = -1;

        if (currentResults.length === 0) {
            displayEmptyState(previousResults);
            return;
        }

        // Use 'new-tab' mode for display so OPEN_TAB shows "Switch to Tab"
        if (SharedSpotlightLogic.updateResultsDisplay(resultsContainer, previousResults, currentResults, 'new-tab', activeGroupName, input)) {
            selectionInvalidated = true;
            selectionManager.selectedIndex = -1;
        }
        selectionManager.updateVisualSelection();
    }

    // Display empty state
    function displayEmptyState(previousResults = currentResults) {
        if (disposed) return;
        if (SharedSpotlightLogic.updateResultsDisplay(resultsContainer, previousResults, [], 'new-tab', activeGroupName, input)) selectionInvalidated = true;
        currentResults = [];
        instantSuggestion = null;
        asyncSuggestions = [];
        selectionManager.updateResults([]);
        if (selectionInvalidated) selectionManager.selectedIndex = -1;
    }

    // Create the base input handler once (with debouncing)
    const baseInputHandler = SharedSpotlightLogic.createInputHandler(
        handleInstantInput,
        () => handleAsyncSearch(),
        150
    );

    // Input events are actual query changes; URL previews only assign .value.
    input.addEventListener('input', (e) => {
        selectionInvalidated = false;
        manuallySelected = false;
        startupSuggestion.cancel();
        // Programmatic .value previews do not fire input; every input event is a query change.
        baseInputHandler(e);
    });

    // Handle result selection
    async function handleResultAction(result, event) {
        if (spaceActions.pending || tabActions.pending) return;
        if (sidebarCommand.invoke(result, event)) return;
        if (spaceActions.invoke(result, event)) return;
        if (tabActions.invoke(result, event)) return;
        startupSuggestion.cancel();
        if (!result) {
            Logger.error('[NewTab Spotlight] No result provided');
            return;
        }

        try {
            // For tab results, use 'new-tab' mode to switch to existing tab
            // For other results, use 'current-tab' mode to navigate this page
            if (actionPending) return;
            actionPending = true;
            const isTabSwitch = (result.type === 'open-tab' || result.type === 'pinned-tab' || Boolean(result.metadata?.arcifyBridge));
            const mode = isTabSwitch ? 'new-tab' : 'current-tab';
            const response = await handleResultActionViaMessage(result, mode);
            if (!response.success) liveResults.handleActionFailure(result, response);

            // Close this new tab page after switching to another tab
            if (shouldCloseNewTab(result, response)) {
                window.close();
            }
        } catch (error) {
            Logger.error('[NewTab Spotlight] Error in result action:', error);
            bridgeStatus.showError(error.message);
        } finally {
            actionPending = false;
        }
    }

    // Keyboard navigation
    input.addEventListener('keydown', SharedSpotlightLogic.createKeyDownHandler(
        selectionManager,
        (selected, event) => handleResultAction(selected, event),
        () => { } // No escape handler needed on new tab page
    ));

    // Handle clicks on results
    SharedSpotlightLogic.setupResultClickHandling(
        resultsContainer,
        (result, index, event) => {
            if ((isSidebarResult(result) || isSpaceActionResult(result) || isTabActionResult(result)) && event?.isTrusted !== true) return;
            selectionInvalidated = false;
            manuallySelected = true;
            selectionManager.selectedIndex = index;
            selectionManager.updateVisualSelection();
            startupSuggestion.cancel();
            return handleResultAction(result, event);
        },
        () => currentResults
    );

    // Focus input immediately
    input.focus();

    // Load initial results and update color asynchronously
    (async () => {
        try {
            // Update active space color and group name asynchronously
            const { color: realActiveSpaceColor, groupName } = await SpotlightMessageClient.getActiveSpaceColor();
            activeGroupName = groupName;
            if (realActiveSpaceColor !== activeSpaceColor) {
                const newColorDefinitions = await SpotlightUtils.getAccentColorCSS(realActiveSpaceColor);
                const styleElement = document.querySelector('#arcify-spotlight-styles');
                if (styleElement) {
                    const colorRegex = /:root\s*{([^}]*)}/;
                    const currentCSS = styleElement.textContent;
                    const newColorMatch = newColorDefinitions.match(colorRegex);
                    if (newColorMatch) {
                        const updatedCSS = currentCSS.replace(colorRegex, newColorMatch[0]);
                        styleElement.textContent = updatedCSS;
                    }
                }
            }
        } catch (error) {
            Logger.error('[NewTab Spotlight] Error updating active space color:', error);
        }

        // Load initial results
        if (!disposed && !input.value.trim()) loadInitialResults();
    })();
    return { dispose, sidebarCommand, spaceActions, tabActions, startupSuggestion, selectionManager, input, resultsContainer };
}
