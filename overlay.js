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
 * - Only injected on-demand for privacy - no persistent content script presence
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

// Dormant mode: Listen for activation message when loaded as content script
// Only set up listener if NOT already activated by legacy injection method
if (!window.arcifySpotlightTabMode) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === 'activateSpotlight') {
            // Set up activation variables exactly like legacy background script injection
            // These variables are used throughout the spotlight code for context
            window.arcifySpotlightTabMode = message.mode;
            window.arcifyCurrentTabUrl = message.tabUrl;
            window.arcifyCurrentTabId = message.tabId;

            // Instantly activate spotlight (no injection delay!)
            activateSpotlight(message.mode);
            sendResponse({ success: true });
        }
    });
}

/**
 * SHADOW DOM ISOLATION
 *
 * The overlay used to be appended straight to document.body with its <style> in
 * document.head, which left it fully exposed to the host page's cascade: element-type
 * selectors (the result rows are <button>), site rules that out-specify our bare class
 * selectors, and inherited properties (font, color) flowing in from html/body. Sites with
 * an opinionated design system -- Reddit, StackOverflow -- rendered a visibly different bar.
 *
 * Everything now lives in a shadow root, so page selectors cannot match our nodes at all,
 * and ':host { all: initial }' cuts off inheritance at the boundary.
 *
 * Consequence: document.getElementById() cannot see into the shadow tree. Every lookup of
 * our own DOM must go through the host element.
 */
const SPOTLIGHT_HOST_ID = 'arcify-spotlight-host';
const SPOTLIGHT_DIALOG_ID = 'arcify-spotlight-dialog';

function getExistingSpotlightDialog() {
    const host = document.getElementById(SPOTLIGHT_HOST_ID);
    return host && host.shadowRoot
        ? host.shadowRoot.getElementById(SPOTLIGHT_DIALOG_ID)
        : null;
}

// Main spotlight activation function
async function activateSpotlight(spotlightTabMode = 'current-tab') {

    // Handle toggle functionality for existing spotlight
    // (must find the dialog through the host -- a miss here would build a second overlay)
    const existingDialog = getExistingSpotlightDialog();
    if (existingDialog) {
        if (existingDialog.open) {
            existingDialog.close();
        } else {
            existingDialog.showModal();

            // Notify background that spotlight opened in this tab
            SpotlightMessageClient.notifyOpened();

            const input = existingDialog.querySelector('.arcify-spotlight-input');
            if (input) {
                input.focus();
                input.select();
                input.scrollLeft = 0;
            }
        }
        return;
    }

    // Mark as injected only when creating new dialog
    window.arcifySpotlightInjected = true;

    // Start with default color - will update asynchronously
    let activeSpaceColor = 'purple'; // Default fallback
    let activeGroupName = null; // Active tab group name for Arcify context

    // CSS styles with default accent color (will be updated)
    // ':host' -- not ':root' -- because these are injected into the shadow root, where
    // ':root' matches nothing and every var() below would silently resolve to empty.
    const accentColorDefinitions = await SpotlightUtils.getAccentColorCSS(activeSpaceColor, ':host');
    const spotlightCSS = `
        /*
            Cut inheritance off at the shadow boundary. Shadow DOM blocks page SELECTORS
            from matching our nodes, but inherited properties (font-family, color,
            letter-spacing, text-transform...) still cross the boundary via the host.

            '!important' is required, not defensive: the host is an ordinary page node, and
            for normal declarations the outer page's rules beat ':host'. That order reverses
            for important declarations, so this is what actually wins.

            'display: contents' keeps the host boxless, so layout matches the old
            append-to-body behaviour exactly.
        */
        :host {
            all: initial !important;
            display: contents !important;
        }

        #arcify-spotlight-dialog {
            margin: 0;
            position: fixed;
            /* Not fully centered but this looks better than 50vh */
            top: calc(35vh);
            left: 50%;
            transform: translateX(-50%);
            border: none;
            padding: 0;
            background: transparent;
            border-radius: 12px;
            width: 650px;
            max-width: 90vw;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
        }

        #arcify-spotlight-dialog::backdrop {
            background: transparent;
        }

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

        #arcify-spotlight-dialog .arcify-spotlight-input-wrapper {
            display: flex;
            align-items: center;
            padding: 12px 24px 12px 20px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        }

        #arcify-spotlight-dialog .arcify-spotlight-search-icon {
            width: 20px;
            height: 20px;
            margin-right: 12px;
            opacity: 0.6;
            flex-shrink: 0;
        }

        /* 
            Specific CSS directives to override styling on specific pages (stackoverflow, chrome docs).
            Otherwise the spotlight bar has a white background and some other weird UI.
        */
        #arcify-spotlight-dialog .arcify-spotlight-input {
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

        #arcify-spotlight-dialog .arcify-spotlight-input::placeholder {
            color: rgba(255, 255, 255, 0.5) !important;
            opacity: 1 !important;
        }

        #arcify-spotlight-dialog .arcify-spotlight-input:focus {
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

        #arcify-spotlight-dialog {
            animation: arcify-spotlight-show 0.2s ease-out;
        }

        @keyframes arcify-spotlight-show {
            from {
                opacity: 0;
                transform: translateX(-50%) scale(0.95);
            }
            to {
                opacity: 1;
                transform: translateX(-50%) scale(1);
            }
        }

        @media (max-width: 640px) {
            #arcify-spotlight-dialog {
                width: 95vw;
                margin: 20px auto;
            }
            
            #arcify-spotlight-dialog .arcify-spotlight-input {
                font-size: 16px !important;
            }
        }
    `;

    // Create the shadow host. Styles and markup go inside the shadow root, never into
    // document.head / document.body (see SHADOW DOM ISOLATION above).
    const host = document.createElement('div');
    host.id = SPOTLIGHT_HOST_ID;
    // Same reset as ':host', applied inline as a second line of defence: an inline
    // '!important' declaration is the strongest author-level rule, so page CSS matching
    // the host (div {}, * {}) cannot feed inherited values into the shadow tree.
    host.setAttribute('style', 'all: initial !important; display: contents !important;');

    // Must stay 'open': the e2e suite reaches the overlay through host.shadowRoot.
    const shadow = host.attachShadow({ mode: 'open' });

    const styleSheet = document.createElement('style');
    styleSheet.id = 'arcify-spotlight-styles';
    styleSheet.textContent = spotlightCSS;
    shadow.appendChild(styleSheet);

    // Accent colors get their own <style> so the async color update can replace the whole
    // element. The old code regex-patched the ':root {...}' block inside the main sheet;
    // that regex would now match the ':host' reset rule instead and eat it.
    const accentStyleSheet = document.createElement('style');
    accentStyleSheet.id = 'arcify-spotlight-accent-styles';
    accentStyleSheet.textContent = accentColorDefinitions;
    shadow.appendChild(accentStyleSheet);

    // Create spotlight dialog
    const dialog = document.createElement('dialog');
    dialog.id = SPOTLIGHT_DIALOG_ID;
    dialog.setAttribute('data-testid', 'spotlight-overlay');

    dialog.innerHTML = `
        <div class="arcify-spotlight-container">
            <div class="arcify-spotlight-input-wrapper">
                <svg class="arcify-spotlight-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="11" cy="11" r="8"></circle>
                    <path d="m21 21-4.35-4.35"></path>
                </svg>
                <input
                    type="text"
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
    `;

    shadow.appendChild(dialog);
    // showModal() later requires the dialog to be connected -- the host must be in the
    // document before then, and appending it here keeps that ordering obvious.
    document.body.appendChild(host);

    // Get references to key elements
    const input = dialog.querySelector('.arcify-spotlight-input');
    const resultsContainer = dialog.querySelector('.arcify-spotlight-results');
    const bridgeStatus = mountBridgeStatus(resultsContainer.parentElement);
    let actionPending = false;

    // Initialize spotlight state
    let currentResults = [];
    let instantSuggestion = null; // The real-time first suggestion
    let asyncSuggestions = []; // Debounced suggestions from background
    let searchQueryId = 0; // Query generation counter for stale response protection (PERF-03)

    // Send get suggestions message to background script using shared client
    async function sendGetSuggestionsMessage(query, mode) {
        return await SpotlightMessageClient.getSuggestions(query, mode);
    }

    // Handle result action via message passing using shared client (with tab ID optimization)
    async function handleResultActionViaMessage(result, mode) {
        return await SpotlightMessageClient.handleResult(result, mode);
    }


    // Flag to track selection-driven input changes (should not trigger search)
    let isSelectionDrivenChange = false;

    // URL preview callback - updates input value with selected result URL
    const handleSelectionChange = (result, index) => {
        isSelectionDrivenChange = true;
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
        // Flag will be checked and reset by the input handler
    };

    const selectionManager = new SelectionManager(resultsContainer, handleSelectionChange);

    // Load initial results
    async function loadInitialResults() {
        try {
            // Clear instant suggestion when loading initial results
            instantSuggestion = null;

            const mode = spotlightTabMode === SpotlightTabMode.NEW_TAB ? 'new-tab' : 'current-tab';
            const results = await sendGetSuggestionsMessage('', mode);
            asyncSuggestions = results || [];
            updateDisplay();
        } catch (error) {
            Logger.error('[Spotlight] Error loading initial results:', error);
            instantSuggestion = null;
            asyncSuggestions = [];
            displayEmptyState();
        }
    }

    // Pre-fill URL in current-tab mode
    if (spotlightTabMode === SpotlightTabMode.CURRENT_TAB && window.arcifyCurrentTabUrl) {
        input.value = window.arcifyCurrentTabUrl;
        setTimeout(() => {
            handleInstantInput();
            handleAsyncSearch();
        }, 10);
    } else {
        // Initial results will be loaded asynchronously after UI appears (Phase 2 optimization)
        displayEmptyState();
    }

    // Handle instant suggestion update (no debouncing)
    function handleInstantInput() {
        const query = input.value.trim();

        if (!query) {
            instantSuggestion = null;
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
    async function handleAsyncSearch() {
        const query = input.value.trim();
        const queryId = ++searchQueryId;

        if (!query) {
            asyncSuggestions = [];
            updateDisplay();
            return;
        }

        try {
            const mode = spotlightTabMode === SpotlightTabMode.NEW_TAB ? 'new-tab' : 'current-tab';

            // Phase 1: Local results (fast, ~10-50ms)
            const localResults = await SpotlightMessageClient.getLocalSuggestions(query, mode);
            if (queryId !== searchQueryId) return; // Stale query -- discard
            asyncSuggestions = localResults || [];
            updateDisplay();

            // Phase 2: Autocomplete results (slow, ~200-500ms network)
            const autocompleteResults = await SpotlightMessageClient.getAutocompleteSuggestions(query);
            if (queryId !== searchQueryId) return; // Stale query -- discard

            if (autocompleteResults && autocompleteResults.length > 0) {
                // Merge autocomplete with local results using the original all-in-one path
                // for proper deduplication, scoring, and sorting
                const allResults = await SpotlightMessageClient.getSuggestions(query, mode);
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
        return SharedSpotlightLogic.combineResults(instantSuggestion, asyncSuggestions);
    }

    // Update the display with combined results
    function updateDisplay() {
        currentResults = combineResults();
        selectionManager.updateResults(currentResults);

        if (currentResults.length === 0) {
            displayEmptyState();
            return;
        }

        const mode = spotlightTabMode === SpotlightTabMode.NEW_TAB ? 'new-tab' : 'current-tab';
        SharedSpotlightLogic.updateResultsDisplay(resultsContainer, [], currentResults, mode, activeGroupName);
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
        handleAsyncSearch,     // async update (debounced by SearchEngine)
        150                    // debounce delay in ms
    );

    // Input event handler - skip search for selection-driven changes
    input.addEventListener('input', (e) => {
        if (isSelectionDrivenChange) {
            // Reset flag and skip search - this was a selection preview update
            isSelectionDrivenChange = false;
            return;
        }
        // User typed something - trigger search
        baseInputHandler(e);
    });

    // Handle result selection
    async function handleResultAction(result) {
        if (!result) {
            Logger.error('[Spotlight] No result provided');
            return;
        }

        try {
            const mode = spotlightTabMode === SpotlightTabMode.NEW_TAB ? 'new-tab' : 'current-tab';

            if (actionPending) return;
            actionPending = true;
            // Keep errors visible and avoid repeated Enter/clicks while an action is pending.
            const success = await handleResultActionViaMessage(result, mode);
            if (success) closeSpotlight();
        } catch (error) {
            Logger.error('[Spotlight] Error in result action:', error);
            bridgeStatus.showError(error.message);
        } finally {
            actionPending = false;
        }
    }

    // Keyboard navigation
    input.addEventListener('keydown', SharedSpotlightLogic.createKeyDownHandler(
        selectionManager,                      // SelectionManager for navigation
        (selected) => handleResultAction(selected),  // Enter handler
        () => closeSpotlight(),               // Escape handler
        // true                                 // container focus check enabled for overlay mode
    ));

    // Handle clicks on results
    SharedSpotlightLogic.setupResultClickHandling(
        resultsContainer,
        (result, index) => handleResultAction(result), // adapter: only pass result to existing handler
        () => currentResults // function that returns current results
    );

    // Close spotlight function
    let spotlightClosed = false;
    function closeSpotlight() {
        if (spotlightClosed) return;
        spotlightClosed = true;
        bridgeStatus.dispose();
        dialog.close();

        SpotlightMessageClient.notifyClosed();

        setTimeout(() => {
            // Removing the host takes the dialog and both stylesheets with it.
            if (host.parentNode) {
                host.parentNode.removeChild(host);
                window.arcifySpotlightInjected = false;
            }
        }, 200);
    }

    // Handle backdrop clicks
    dialog.addEventListener('click', (e) => {
        if (e.target === dialog) {
            closeSpotlight();
        }
    });

    dialog.addEventListener('close', closeSpotlight);

    // Listen for global close messages from background script
    SpotlightMessageClient.setupGlobalCloseListener(() => {
        const existingDialog = getExistingSpotlightDialog();
        if (existingDialog && existingDialog.open) {
            closeSpotlight();
        }
    });

    // Show dialog and focus input
    dialog.showModal();

    // Notify background that spotlight opened in this tab
    SpotlightMessageClient.notifyOpened();

    // Focus input immediately (no delay needed)
    input.focus();
    input.select();
    input.scrollLeft = 0;

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
            activeGroupName = groupName;
            if (realActiveSpaceColor !== activeSpaceColor) {
                // Update CSS variables by replacing the dedicated accent stylesheet
                // wholesale -- no regex surgery on the main sheet.
                accentStyleSheet.textContent =
                    await SpotlightUtils.getAccentColorCSS(realActiveSpaceColor, ':host');
            }
        } catch (error) {
            Logger.error('[Spotlight] Error updating active space color:', error);
        }

        // Load initial results after color update (if input is still empty)
        if (!input.value.trim()) {
            loadInitialResults();
        }
    })();

}

/**
 * LEGACY INJECTION COMPATIBILITY
 * 
 * Why this is needed: The old injection method sets window.arcifySpotlightTabMode before
 * loading this script. If that variable exists, we know we were injected the old way
 * and should activate immediately (not wait for a message).
 * 
 * This ensures backward compatibility and provides a fallback when the dormant
 * content script fails (e.g., on chrome:// URLs where content scripts don't run).
 */

// If activated by background script injection (legacy mode), run immediately
if (window.arcifySpotlightTabMode) {
    activateSpotlight(window.arcifySpotlightTabMode);
}