/**
 * Spotlight Overlay - Content script implementation of command bar interface
 * 
 * Purpose: Primary spotlight implementation injected into web pages as content script
 * Key Functions: Real-time search across tabs/bookmarks/history, instant suggestions, keyboard navigation
 * Architecture: Self-contained IIFE bundle with embedded UI and shared spotlight modules
 * 
 * Critical Notes:
 * - Injected by background script with automatic popup fallback for restricted URLs
 * - Bundled as single file via Vite for content script compatibility (no ES6 imports)
 * - Dormant receiver is installed at document_start; command recovery reinjects it on demand
 * - Uses modal dialog with backdrop blur for non-intrusive overlay experience
 * - Handles URL prefill, tab ID injection, and optimized navigation for current-tab mode
 */

import { SpotlightUtils } from './shared/ui-utilities.js';
import { SelectionManager } from './shared/selection-manager.js';
import { SpotlightMessageClient } from './shared/message-client.js';
import { SpotlightTabMode } from './shared/search-types.js';
import { SharedSpotlightLogic } from './shared/shared-component-logic.js';
import { Logger } from './logger.js';
import { mountBridgeStatus } from './shared/bridge-status-ui.js';
import { SidebarCommandController, isSidebarResult } from './shared/arcify-sidebar-command.js';
import { SpaceActionController, isSpaceActionResult } from './shared/arcify-space-actions-ui.js';
import { mountLiveTabResults, isTabResultRemoved } from './shared/live-tab-results.js';
import { createOverlaySurface, containOverlayFocus, isComposingKey } from './shared/overlay-surface.js';
import { installOverlayReceiver, markOverlayHost } from './shared/overlay-receiver.js';
import { boundedOverlayDelivery } from './shared/overlay-recovery.js';

/**
 * DORMANT CONTENT SCRIPT ARCHITECTURE
 * 
 * Problem: Traditional script injection via chrome.scripting.executeScript() causes 1-2s delays
 * on slow-loading pages because it waits for the page's resources to load before injection.
 * 
 * Solution: Pre-inject spotlight as a dormant content script that loads immediately when the
 * page starts (document_start), then activate it instantly via messaging when needed.
 * 
 * Benefits:
 * - Eliminates injection delay: 1-2s → 50-100ms (20-40x faster)
 * - No blocking on page load resources (images, stylesheets, etc.)
 * - Instant activation via lightweight message passing
 * - Graceful fallback to legacy injection for compatibility
 */

// Both manifest loading and command recovery install the same dormant singleton.
// Legacy mode globals are data only; reinjection never opens a dialog by itself.
// The modal shell uses Shadow DOM for CSS isolation; its input document uses a
// frame for keyboard isolation. See shared/overlay-surface.js for event ordering.
let activeOverlay = null;
let activationQueue = Promise.resolve();
let overlayReceiver;

function activateSpotlight(spotlightTabMode = 'current-tab', options = {}) {
    const activation = activationQueue.catch(() => {}).then(() => activateSpotlightNow(spotlightTabMode, options));
    activationQueue = activation;
    return activation;
}

// Main spotlight activation function. Bridge launches ensure visibility; shortcuts toggle.
async function activateSpotlightNow(spotlightTabMode, options) {
    if (options.expectedUrl !== undefined && options.expectedUrl !== window.location.href)
        throw Object.assign(new Error('The source document changed.'), { changed: true });
    if (activeOverlay && !activeOverlay.host.isConnected) activeOverlay.dispose();
    const stale = activeOverlay ? null : overlayReceiver.prepareRecovery(options);
    window.arcifySpotlightTabMode = spotlightTabMode;
    if ('tabUrl' in options) window.arcifyCurrentTabUrl = options.tabUrl;
    if ('tabId' in options) window.arcifyCurrentTabId = options.tabId;

    if (activeOverlay) {
        if (options.recovery) await overlayReceiver.validateRecovery(options);
        if (activeOverlay.dialog.open && !options.ensureOpen) {
            activeOverlay.close();
            return { open: false };
        }
        if (activeOverlay.dialog.open && activeOverlay.mode === spotlightTabMode) {
            activeOverlay.focus();
            SpotlightMessageClient.notifyOpened();
            return { open: true };
        }
        // A closed instance has already disposed its status/listeners. Replace it,
        // canceling its removal timer, rather than reviving an incomplete dialog.
        // Rebuild for mode changes too, so search and action closures use the new mode.
        activeOverlay.dispose();
    }

    // Start with default color - will update asynchronously
    let activeSpaceColor = 'purple'; // Default fallback
    let activeGroupName = null; // Active tab group name for Arcify context

    // CSS styles with default accent color (will be updated)
    // The UI owns a separate document; accent variables belong on its root.
    const colors = SpotlightUtils.getAccentColorCSS(activeSpaceColor, ':root');
    const accentColorDefinitions = await (options.recovery ? boundedOverlayDelivery(colors) : colors);
    if (options.recovery) await overlayReceiver.validateRecovery(options);
    // Read only after the awaited settings call; the stale dialog remains usable
    // while waiting. No await occurs between this snapshot and modal replacement.
    const recoveredDraft = stale?.readDraft();
    const spotlightCSS = `
        html, body { margin: 0; padding: 0; background: transparent; }
        body { overflow-x: hidden; }
        .arcify-spotlight-container {
            background: #2D2D2D;
            border-radius: 12px;
            border: 1px solid rgba(255, 255, 255, 0.1);
            padding: 0;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            color: #ffffff;
            position: relative;
            overflow: hidden;
        }

        #arcify-spotlight-content .arcify-spotlight-input-wrapper {
            display: flex;
            align-items: center;
            padding: 12px 24px 12px 20px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        }

        #arcify-spotlight-content .arcify-spotlight-search-icon {
            width: 20px;
            height: 20px;
            margin-right: 12px;
            opacity: 0.6;
            flex-shrink: 0;
        }

        #arcify-spotlight-content .arcify-spotlight-input {
            flex: 1 !important;
            background: transparent !important;
            background-color: transparent !important;
            background-image: none !important;
            border: none !important;
            border-style: none !important;
            border-width: 0 !important;
            border-color: transparent !important;
            color: #ffffff !important;
            font-size: 18px !important;
            line-height: 24px !important;
            padding: 8px 0 !important;
            margin: 0 !important;
            outline: none !important;
            outline-style: none !important;
            outline-width: 0 !important;
            font-weight: 400 !important;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
            box-shadow: none !important;
            border-radius: 0 !important;
            appearance: none !important;
            -webkit-appearance: none !important;
            -moz-appearance: none !important;
            text-indent: 0 !important;
            text-shadow: none !important;
            vertical-align: baseline !important;
            text-decoration: none !important;
            box-sizing: border-box !important;
        }

        #arcify-spotlight-content .arcify-spotlight-input::placeholder {
            color: rgba(255, 255, 255, 0.5) !important;
            opacity: 1 !important;
        }

        #arcify-spotlight-content .arcify-spotlight-input:focus {
            outline: none !important;
            outline-style: none !important;
            outline-width: 0 !important;
            border: none !important;
            box-shadow: none !important;
            background: transparent !important;
            background-color: transparent !important;
        }

        .arcify-spotlight-results {
            max-height: 270px;
            overflow-y: auto;
            padding: 8px 0;
            scroll-behavior: smooth;
            scrollbar-width: none; /* Firefox */
            -ms-overflow-style: none; /* IE and Edge */
        }

        .arcify-spotlight-results::-webkit-scrollbar {
            display: none; /* Chrome, Safari and Opera */
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
            #arcify-spotlight-content .arcify-spotlight-input {
                font-size: 16px !important;
            }
        }
    `;

    const surface = createOverlaySurface(spotlightCSS, accentColorDefinitions, `
        <div class="arcify-spotlight-container">
            <div class="arcify-spotlight-input-wrapper">
                <svg class="arcify-spotlight-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="11" cy="11" r="8"></circle>
                    <path d="m21 21-4.35-4.35"></path>
                </svg>
                <input
                    type="text"
                    aria-label="Search or enter URL"
                    class="arcify-spotlight-input"
                    data-testid="spotlight-input"
                    placeholder="${spotlightTabMode === SpotlightTabMode.NEW_TAB ? 'Search or enter URL (opens in new tab)...' : 'Search or enter URL...'}"
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
    `);
    const { host, dialog, content, frameDocument, accentStyleSheet } = surface;
    markOverlayHost(host, chrome.runtime.id);
    const input = content.querySelector('.arcify-spotlight-input');
    const resultsContainer = content.querySelector('.arcify-spotlight-results');
    const bridgeStatus = mountBridgeStatus(resultsContainer.parentElement);
    let actionPending = false;
    let sidebarCommand;
    let spaceActions;
    let manuallySelected = false;
    let selectionInvalidated = false;
    let spotlightClosed = false;
    let removalTimer = null;
    let prefillTimer = null;

    // Initialize spotlight state
    let currentResults = [];
    let typedQuery = ''; // Genuine input only; keyboard URL/title previews do not change the search.
    let instantSuggestion = null; // The real-time first suggestion
    let asyncSuggestions = []; // Debounced suggestions from background
    let searchQueryId = 0; // Query generation counter for stale response protection (PERF-03)

    // Send get suggestions message to background script using shared client
    async function sendGetSuggestionsMessage(query, mode, bridgeRefresh) {
        return await SpotlightMessageClient.getSuggestions(query, mode, bridgeRefresh);
    }

    // Handle result action via message passing using shared client (with tab ID optimization)
    async function handleResultActionViaMessage(result, mode) {
        return await SpotlightMessageClient.handleResultDetailed(result, mode);
    }


    // URL preview callback - updates input value with selected result URL
    const handleSelectionChange = (result, index) => {
        selectionInvalidated = false;
        manuallySelected = true;
        if (isSidebarResult(result) || isSpaceActionResult(result)) return;
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
    });
    sidebarCommand = new SidebarCommandController({ showError: bridgeStatus.showError, showSuccess: bridgeStatus.showSuccess, onChange: () => updateDisplay() });
    spaceActions = new SpaceActionController({ parent: resultsContainer.parentElement, input, showError: bridgeStatus.showError, showSuccess: bridgeStatus.showSuccess, onChange: () => updateDisplay() });
    const liveResults = mountLiveTabResults({
        isActive: () => !spotlightClosed,
        onInvalidate: removedTabIds => {
            searchQueryId++;
            if (isTabResultRemoved(selectionManager.getSelectedResult(), removedTabIds)) selectionInvalidated = true;
            asyncSuggestions = asyncSuggestions.filter(result => !isTabResultRemoved(result, removedTabIds));
            updateDisplay();
        },
        onRefresh: bridgeRefresh => { spaceActions.ready = spaceActions.prepare(); return typedQuery ? handleAsyncSearch(bridgeRefresh) : loadInitialResults(bridgeRefresh); }
    });

    // Load initial results
    async function loadInitialResults(bridgeRefresh) {
        if (spotlightClosed) return;
        const queryId = ++searchQueryId;
        try {
            // Clear instant suggestion when loading initial results
            instantSuggestion = null;

            const mode = spotlightTabMode === SpotlightTabMode.NEW_TAB ? 'new-tab' : 'current-tab';
            const results = await sendGetSuggestionsMessage('', mode, bridgeRefresh);
            if (spotlightClosed || queryId !== searchQueryId || typedQuery) return;
            asyncSuggestions = results || [];
            updateDisplay();
        } catch (error) {
            if (spotlightClosed || queryId !== searchQueryId || typedQuery) return;
            Logger.error('[Spotlight] Error loading initial results:', error);
            instantSuggestion = null;
            asyncSuggestions = [];
            displayEmptyState();
        }
    }

    // Pre-fill URL in current-tab mode
    if (recoveredDraft) {
        input.value = recoveredDraft.value;
        typedQuery = input.value.trim();
        prefillTimer = setTimeout(() => { handleInstantInput(); handleAsyncSearch(); }, 10);
    } else if (spotlightTabMode === SpotlightTabMode.CURRENT_TAB && window.arcifyCurrentTabUrl) {
        input.value = window.arcifyCurrentTabUrl;
        prefillTimer = setTimeout(() => {
            handleInstantInput();
            handleAsyncSearch();
        }, 10);
    } else {
        // Initial results will be loaded asynchronously after UI appears (Phase 2 optimization)
        displayEmptyState();
    }

    // Handle instant suggestion update (no debouncing)
    function handleInstantInput() {
        if (spotlightClosed) return;
        searchQueryId++;
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

        // Generate instant suggestion based on current input
        instantSuggestion = SpotlightUtils.generateInstantSuggestion(query);
        updateDisplay();
    }

    // Handle async search (debounced) - Two-phase progressive rendering (PERF-03)
    // Phase 1: Local results render immediately (~10-50ms)
    // Phase 2: Autocomplete appends when ready (~200-500ms)
    // Stale queries are discarded via query generation counter
    async function handleAsyncSearch(bridgeRefresh) {
        if (spotlightClosed) return;
        const query = typedQuery;
        const queryId = ++searchQueryId;

        if (!query) {
            asyncSuggestions = [];
            updateDisplay();
            return;
        }

        try {
            const mode = spotlightTabMode === SpotlightTabMode.NEW_TAB ? 'new-tab' : 'current-tab';

            // Phase 1: Local results (fast, ~10-50ms)
            const localResults = await SpotlightMessageClient.getLocalSuggestions(query, mode, bridgeRefresh);
            if (queryId !== searchQueryId) return; // Stale query -- discard
            asyncSuggestions = localResults || [];
            updateDisplay();

            // Phase 2: Autocomplete results (slow, ~200-500ms network)
            const autocompleteResults = await SpotlightMessageClient.getAutocompleteSuggestions(query);
            if (queryId !== searchQueryId) return; // Stale query -- discard

            if (autocompleteResults && autocompleteResults.length > 0) {
                // Merge autocomplete with local results using the original all-in-one path
                // for proper deduplication, scoring, and sorting
                const allResults = await SpotlightMessageClient.getSuggestions(query, mode, bridgeRefresh);
                if (queryId !== searchQueryId) return; // Stale query -- discard
                asyncSuggestions = allResults || [];
                updateDisplay();
            }
        } catch (error) {
            Logger.error('[Spotlight] Search error:', error);
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
            actions: [...(command ? [command] : []), ...(spaceActions?.results(typedQuery) || [])], query: typedQuery
        });
    }

    // Update the display with combined results
    function updateDisplay() {
        if (spotlightClosed) return;
        const previous = selectionManager.getSelectedResult();
        if (isSidebarResult(previous) && !sidebarCommand?.peerId || isSpaceActionResult(previous) && !spaceActions?.matches(previous)) selectionInvalidated = true;
        currentResults = combineResults();
        selectionManager.updateResults(currentResults, { preserveSelection: manuallySelected });
        if (!manuallySelected && !typedQuery && (isSidebarResult(currentResults[0]) || isSpaceActionResult(currentResults[0]))) selectionManager.selectedIndex = -1;
        // A failed/revoked command or removed tab must not expose another action to
        // held Enter or a later async refresh. Fresh input/navigation can select again.
        if (selectionInvalidated) selectionManager.selectedIndex = -1;

        if (currentResults.length === 0) {
            displayEmptyState();
            return;
        }

        const mode = spotlightTabMode === SpotlightTabMode.NEW_TAB ? 'new-tab' : 'current-tab';
        SharedSpotlightLogic.updateResultsDisplay(resultsContainer, [], currentResults, mode, activeGroupName);
        selectionManager.updateVisualSelection();
    }



    // Display empty state
    function displayEmptyState() {
        resultsContainer.innerHTML = '<div class="arcify-spotlight-empty">Start typing to search tabs, bookmarks, and history</div>';
        currentResults = [];
        instantSuggestion = null;
        asyncSuggestions = [];
        selectionManager.updateResults([]);
    }


    // Create the base input handler once (with debouncing)
    const baseInputHandler = SharedSpotlightLogic.createInputHandler(
        handleInstantInput,    // instant update (zero latency)
        () => handleAsyncSearch(),     // async update (debounced by SearchEngine)
        150                    // debounce delay in ms
    );

    // Input events are actual query changes; URL previews only assign .value.
    input.addEventListener('input', (e) => {
        selectionInvalidated = false;
        manuallySelected = false;
        // Programmatic .value previews do not fire input; every input event is a query change.
        baseInputHandler(e);
    });

    // Handle result selection
    async function handleResultAction(result, event) {
        if (spaceActions.pending) return;
        if (sidebarCommand.invoke(result, event)) return;
        if (spaceActions.invoke(result, event)) return;
        if (!result) {
            Logger.error('[Spotlight] No result provided');
            return;
        }

        try {
            const mode = spotlightTabMode === SpotlightTabMode.NEW_TAB ? 'new-tab' : 'current-tab';

            if (actionPending) return;
            actionPending = true;
            // Keep errors visible and avoid repeated Enter/clicks while an action is pending.
            const response = await handleResultActionViaMessage(result, mode);
            if (response.success) closeSpotlight();
            else liveResults.handleActionFailure(result, response);
        } catch (error) {
            Logger.error('[Spotlight] Error in result action:', error);
            bridgeStatus.showError(error.message);
        } finally {
            actionPending = false;
        }
    }

    // Keyboard navigation
    const handleKeyDown = SharedSpotlightLogic.createKeyDownHandler(
        selectionManager,
        (selected, event) => handleResultAction(selected, event),
        () => closeSpotlight()
    );
    input.addEventListener('keydown', event => {
        if (isComposingKey(event) || event.ctrlKey || event.metaKey || event.altKey) return;
        // Preserve native range selection; Shift+Tab is handled at the frame boundary.
        if (event.shiftKey && ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        handleKeyDown(event);
    });
    const removeFocusContainment = containOverlayFocus(frameDocument, closeSpotlight);

    // Handle clicks on results
    SharedSpotlightLogic.setupResultClickHandling(
        resultsContainer,
        (result, index, event) => {
            if ((isSidebarResult(result) || isSpaceActionResult(result)) && event?.isTrusted !== true) return;
            selectionInvalidated = false;
            manuallySelected = true;
            selectionManager.selectedIndex = index;
            selectionManager.updateVisualSelection();
            return handleResultAction(result, event);
        },
        () => currentResults // function that returns current results
    );

    // Close spotlight function
    function closeSpotlight(invalidated = false) {
        if (spotlightClosed) return;
        spotlightClosed = true;
        searchQueryId++;
        clearTimeout(prefillTimer);
        // Invalidated extension APIs may throw during cleanup. Still retire all
        // DOM/timer ownership; never notify a new worker about the old surface.
        for (const cleanup of [removeGlobalCloseListener, removeFocusContainment,
            () => surface.dispose(), () => sidebarCommand.dispose(), () => spaceActions.dispose(),
            () => liveResults.dispose(), () => bridgeStatus.dispose(), () => dialog.close()]) {
            try { cleanup(); } catch (error) { Logger.log('Overlay cleanup after invalidation:', error); }
        }
        if (invalidated !== true) SpotlightMessageClient.notifyClosed();

        removalTimer = setTimeout(disposeSpotlight, 200);
    }

    function disposeSpotlight(invalidated = false) {
        closeSpotlight(invalidated);
        clearTimeout(removalTimer);
        dialog.removeEventListener('close', closeSpotlight);
        // This instance owns only its host. An old close event/timer must never
        // remove or change tracking for a newer, reopened instance.
        host.remove();
        if (activeOverlay?.host === host) {
            activeOverlay = null;
            if (overlayReceiver.ownsGlobals()) window.arcifySpotlightInjected = false;
        }
    }

    function focusSpotlight() {
        input.focus();
        input.select();
        input.scrollLeft = 0;
    }

    // Handle backdrop clicks
    dialog.addEventListener('click', (e) => {
        if (e.target === dialog) {
            closeSpotlight();
        }
    });

    dialog.addEventListener('close', closeSpotlight);

    // Listen for global close messages from background script
    const removeGlobalCloseListener = SpotlightMessageClient.setupGlobalCloseListener(closeSpotlight);

    activeOverlay = { host, dialog, mode: spotlightTabMode, close: closeSpotlight, dispose: disposeSpotlight, focus: focusSpotlight };
    window.arcifySpotlightInjected = true;

    // Show dialog and focus input
    try {
        // Check again after asynchronous style/settings work, before any modal.
        if (options.expectedUrl !== undefined && options.expectedUrl !== window.location.href)
            throw Object.assign(new Error('The source document changed.'), { changed: true });
        dialog.showModal();
        surface.resize();
        if (stale?.retire() === false) throw new Error('The existing Spotlight receiver is still live.');
    } catch (error) {
        disposeSpotlight();
        throw error;
    }

    // Notify background that spotlight opened in this tab
    SpotlightMessageClient.notifyOpened();

    // Focus input immediately (no delay needed)
    focusSpotlight();
    if (recoveredDraft) input.setSelectionRange(recoveredDraft.start, recoveredDraft.end, recoveredDraft.direction);

    /**
     * PHASE 2: NON-BLOCKING INITIALIZATION OPTIMIZATIONS
     * 
     * Problem: Blocking on async operations (color fetch, initial results) delays UI appearance
     * 
     * Solution: Show UI immediately, then update asynchronously in background
     * - UI appears instantly with default purple color
     * - Real space color loads and smoothly transitions via CSS
     * - Initial results load progressively after UI is visible
     * 
     * Benefits: Additional 20-50ms improvement in perceived performance
     */

    // Async Phase 2 improvements: Update color and load initial results non-blocking
    (async () => {
        try {
            // Update active space color and group name asynchronously (non-blocking)
            const { color: realActiveSpaceColor, groupName } = await SpotlightMessageClient.getActiveSpaceColor();
            if (spotlightClosed) return;
            activeGroupName = groupName;
            if (realActiveSpaceColor !== activeSpaceColor) {
                // Update CSS variables by replacing the dedicated accent stylesheet
                // wholesale -- no regex surgery on the main sheet.
                accentStyleSheet.textContent =
                    await SpotlightUtils.getAccentColorCSS(realActiveSpaceColor, ':root');
            }
        } catch (error) {
            Logger.error('[Spotlight] Error updating active space color:', error);
        }

        // Load initial results after color update (if input is still empty)
        if (!spotlightClosed && !input.value.trim()) {
            loadInitialResults();
        }
    })();

    return { open: true };
}

// Register once per live isolated-world runtime. Re-evaluating the bundle is
// intentionally inert when this receiver already exists, preserving its draft.
overlayReceiver = installOverlayReceiver({
    activate: activateSpotlight,
    disposeInvalidated: () => activeOverlay?.dispose(true)
});
