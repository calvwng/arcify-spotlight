// selection-manager.js - Shared selection management for spotlight components
// Consolidates identical SelectionManager implementations from overlay.js and popup.js

// Match the underlying choice, not mutable scores, labels, or enrichment fields.
export function resultIdentity(result) {
    if (!result) return null;
    const metadata = result.metadata || {};
    if (result.type === 'arcify-sidebar-command') return JSON.stringify([result.type, metadata.sidebarPeerId]);
    const owner = metadata.arcifyBridge;
    if (owner) return JSON.stringify(['arcify', owner.peerId, owner.windowId, owner.kind,
        ...(owner.kind === 'tab' ? [owner.tabId] : [owner.spaceId, owner.bookmarkId])]);
    if (['open-tab', 'pinned-tab'].includes(result.type) && metadata.tabId != null) return JSON.stringify(['tab', metadata.tabId]);
    if (metadata.tabId != null) return JSON.stringify([result.type, 'tab', metadata.tabId]);
    if (metadata.bookmarkId != null) return JSON.stringify([result.type, 'bookmark', metadata.bookmarkId]);
    if (metadata.query != null) return JSON.stringify([result.type, 'query', metadata.query, Boolean(metadata.isUrl)]);
    return JSON.stringify([result.type, result.url || '', result.url ? '' : result.title || '']);
}

export class SelectionManager {
    constructor(container, onSelectionChange = null, onNavigation = null) {
        this.container = container;
        this.selectedIndex = 0;
        this.results = [];
        this.onSelectionChange = onSelectionChange;
        this.onNavigation = onNavigation;
    }

    updateResults(newResults, { preserveSelection = false } = {}) {
        const previousIdentity = resultIdentity(this.getSelectedResult());
        this.results = newResults;
        this.selectedIndex = 0;
        if (preserveSelection) {
            // If a chosen result disappears, leave nothing selected rather than
            // silently changing the meaning of Enter during an async refresh.
            this.selectedIndex = previousIdentity === null ? -1
                : newResults.findIndex(result => resultIdentity(result) === previousIdentity);
        }
        this.updateVisualSelection();
        // Note: Callback is NOT triggered on initial load - only on explicit navigation
        // This prevents URL preview from overriding empty input on spotlight open
    }

    moveSelection(direction) {
        const oldIndex = this.selectedIndex;
        const maxIndex = this.results.length - 1;

        if (direction === 'down') {
            this.selectedIndex = Math.min(this.selectedIndex + 1, maxIndex);
        } else if (direction === 'up') {
            this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
        }

        this.updateVisualSelection();

        // Notify callback if selection changed
        if (this.onSelectionChange && oldIndex !== this.selectedIndex) {
            this.onSelectionChange(this.getSelectedResult(), this.selectedIndex);
        }
    }

    moveToFirst() {
        const oldIndex = this.selectedIndex;
        this.selectedIndex = 0;
        this.updateVisualSelection();

        // Notify callback if selection changed
        if (this.onSelectionChange && oldIndex !== this.selectedIndex) {
            this.onSelectionChange(this.getSelectedResult(), this.selectedIndex);
        }
    }

    moveToLast() {
        const oldIndex = this.selectedIndex;
        this.selectedIndex = Math.max(0, this.results.length - 1);
        this.updateVisualSelection();

        // Notify callback if selection changed
        if (this.onSelectionChange && oldIndex !== this.selectedIndex) {
            this.onSelectionChange(this.getSelectedResult(), this.selectedIndex);
        }
    }

    getSelectedResult() {
        return this.results[this.selectedIndex] || null;
    }

    updateVisualSelection() {
        const items = this.container.querySelectorAll('.arcify-spotlight-result-item');
        items.forEach((item, index) => {
            item.classList.toggle('selected', index === this.selectedIndex);
        });

        // Auto-scroll selected item into view
        if (items[this.selectedIndex]) {
            items[this.selectedIndex].scrollIntoView({
                behavior: 'smooth',
                block: 'nearest'
            });
        }
    }

    // Resolve the focused element in the container's own tree.
    // The overlay lives in a shadow root, where document.activeElement is the shadow
    // HOST -- never the input -- so a document-level lookup would fail the container
    // check every time. ShadowRoot has its own activeElement; fall back to document
    // for extension pages (and for test mocks without getRootNode).
    getActiveElement() {
        const root = typeof this.container.getRootNode === 'function'
            ? this.container.getRootNode()
            : null;
        return (root && root.activeElement) || document.activeElement;
    }

    // Enhanced keyboard navigation (can be extended with more features)
    handleKeyDown(event, skipContainerCheck = false) {
        if (!skipContainerCheck && !this.container.contains(this.getActiveElement())) {
            return false; // Not handling this event
        }

        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            // Navigation expresses intent even when the current row is already
            // at a boundary and the selection-change callback will not run.
            this.onNavigation?.();
        }

        switch (event.key) {
            case 'ArrowDown':
                event.preventDefault();
                event.stopPropagation();
                this.moveSelection('down');
                return true;

            case 'ArrowUp':
                event.preventDefault();
                event.stopPropagation();
                this.moveSelection('up');
                return true;

            case 'Home':
                event.preventDefault();
                event.stopPropagation();
                this.moveToFirst();
                return true;

            case 'End':
                event.preventDefault();
                event.stopPropagation();
                this.moveToLast();
                return true;

            default:
                return false; // Not handled
        }
    }
}
