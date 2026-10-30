import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SelectionManager } from '../../shared/selection-manager.js';

describe('SelectionManager', () => {
    let manager;
    let mockContainer;
    let selectionCallback;
    let mockItems;

    beforeEach(() => {
        // Create mock DOM items with required methods
        mockItems = [
            { classList: { toggle: vi.fn() }, scrollIntoView: vi.fn() },
            { classList: { toggle: vi.fn() }, scrollIntoView: vi.fn() },
            { classList: { toggle: vi.fn() }, scrollIntoView: vi.fn() },
        ];

        mockContainer = {
            querySelectorAll: vi.fn().mockReturnValue(mockItems),
            contains: vi.fn().mockReturnValue(true)
        };

        selectionCallback = vi.fn();
        manager = new SelectionManager(mockContainer, selectionCallback);
        manager.updateResults([{ id: 1 }, { id: 2 }, { id: 3 }]);
    });

    describe('moveSelection', () => {
        describe('down movement', () => {
            it('moves selection from 0 to 1 when moving down', () => {
                expect(manager.selectedIndex).toBe(0);
                manager.moveSelection('down');
                expect(manager.selectedIndex).toBe(1);
            });

            it('calls callback with result and new index when moving down', () => {
                manager.moveSelection('down');
                expect(selectionCallback).toHaveBeenCalledWith({ id: 2 }, 1);
            });

            it('clamps at maximum index when at last item', () => {
                manager.selectedIndex = 2;
                manager.moveSelection('down');
                expect(manager.selectedIndex).toBe(2);
            });

            it('does not call callback when clamped at maximum', () => {
                manager.selectedIndex = 2;
                selectionCallback.mockClear();
                manager.moveSelection('down');
                expect(selectionCallback).not.toHaveBeenCalled();
            });
        });

        describe('up movement', () => {
            it('moves selection from 2 to 1 when moving up', () => {
                manager.selectedIndex = 2;
                manager.moveSelection('up');
                expect(manager.selectedIndex).toBe(1);
            });

            it('calls callback with result and new index when moving up', () => {
                manager.selectedIndex = 2;
                selectionCallback.mockClear();
                manager.moveSelection('up');
                expect(selectionCallback).toHaveBeenCalledWith({ id: 2 }, 1);
            });

            it('clamps at minimum index (cannot go below 0)', () => {
                expect(manager.selectedIndex).toBe(0);
                manager.moveSelection('up');
                expect(manager.selectedIndex).toBe(0);
            });

            it('does not call callback when clamped at minimum', () => {
                selectionCallback.mockClear();
                manager.moveSelection('up');
                expect(selectionCallback).not.toHaveBeenCalled();
            });
        });
    });

    describe('moveToFirst', () => {
        it('moves selection to first item (index 0)', () => {
            manager.selectedIndex = 2;
            manager.moveToFirst();
            expect(manager.selectedIndex).toBe(0);
        });

        it('calls callback when selection changes', () => {
            manager.selectedIndex = 2;
            selectionCallback.mockClear();
            manager.moveToFirst();
            expect(selectionCallback).toHaveBeenCalledWith({ id: 1 }, 0);
        });

        it('does not call callback when already at first item', () => {
            expect(manager.selectedIndex).toBe(0);
            selectionCallback.mockClear();
            manager.moveToFirst();
            expect(selectionCallback).not.toHaveBeenCalled();
        });
    });

    describe('moveToLast', () => {
        it('moves selection to last item', () => {
            expect(manager.selectedIndex).toBe(0);
            manager.moveToLast();
            expect(manager.selectedIndex).toBe(2);
        });

        it('calls callback when selection changes', () => {
            selectionCallback.mockClear();
            manager.moveToLast();
            expect(selectionCallback).toHaveBeenCalledWith({ id: 3 }, 2);
        });

        it('does not call callback when already at last item', () => {
            manager.selectedIndex = 2;
            selectionCallback.mockClear();
            manager.moveToLast();
            expect(selectionCallback).not.toHaveBeenCalled();
        });

        it('handles empty results by keeping selectedIndex at 0', () => {
            manager.updateResults([]);
            selectionCallback.mockClear();
            manager.moveToLast();
            expect(manager.selectedIndex).toBe(0);
        });
    });

    describe('getSelectedResult', () => {
        it('returns the result at selectedIndex', () => {
            expect(manager.getSelectedResult()).toEqual({ id: 1 });
            manager.selectedIndex = 1;
            expect(manager.getSelectedResult()).toEqual({ id: 2 });
            manager.selectedIndex = 2;
            expect(manager.getSelectedResult()).toEqual({ id: 3 });
        });

        it('returns null if index is out of bounds', () => {
            manager.updateResults([]);
            expect(manager.getSelectedResult()).toBeNull();
        });

        it('returns null for invalid selectedIndex', () => {
            manager.selectedIndex = 99;
            expect(manager.getSelectedResult()).toBeNull();
        });
    });

    describe('updateResults', () => {
        it('resets selectedIndex to 0', () => {
            manager.selectedIndex = 2;
            manager.updateResults([{ id: 'a' }, { id: 'b' }]);
            expect(manager.selectedIndex).toBe(0);
        });

        it('does NOT trigger onSelectionChange callback', () => {
            manager.selectedIndex = 2;
            selectionCallback.mockClear();
            manager.updateResults([{ id: 'new' }]);
            expect(selectionCallback).not.toHaveBeenCalled();
        });

        it('stores new results array', () => {
            const newResults = [{ id: 'x' }, { id: 'y' }];
            manager.updateResults(newResults);
            expect(manager.results).toBe(newResults);
            expect(manager.results.length).toBe(2);
        });
    });

    describe('updateVisualSelection', () => {
        it('calls toggle("selected", true) on item at selectedIndex', () => {
            manager.selectedIndex = 1;
            manager.updateVisualSelection();
            expect(mockItems[1].classList.toggle).toHaveBeenCalledWith('selected', true);
        });

        it('calls toggle("selected", false) on other items', () => {
            manager.selectedIndex = 1;
            // Clear previous calls from beforeEach setup
            mockItems.forEach(item => item.classList.toggle.mockClear());
            manager.updateVisualSelection();
            expect(mockItems[0].classList.toggle).toHaveBeenCalledWith('selected', false);
            expect(mockItems[2].classList.toggle).toHaveBeenCalledWith('selected', false);
        });

        it('calls scrollIntoView on selected item', () => {
            manager.selectedIndex = 1;
            mockItems.forEach(item => item.scrollIntoView.mockClear());
            manager.updateVisualSelection();
            expect(mockItems[1].scrollIntoView).toHaveBeenCalledWith({
                behavior: 'smooth',
                block: 'nearest'
            });
        });

        it('does not crash when selected item does not exist in DOM', () => {
            mockContainer.querySelectorAll.mockReturnValue([]);
            expect(() => manager.updateVisualSelection()).not.toThrow();
        });
    });

    describe('handleKeyDown', () => {
        const createMockEvent = (key) => ({
            key,
            preventDefault: vi.fn(),
            stopPropagation: vi.fn()
        });

        it('handles ArrowDown by calling moveSelection("down") and returns true', () => {
            const event = createMockEvent('ArrowDown');
            const result = manager.handleKeyDown(event, true);
            expect(result).toBe(true);
            expect(manager.selectedIndex).toBe(1);
        });

        it('handles ArrowUp by calling moveSelection("up") and returns true', () => {
            manager.selectedIndex = 2;
            const event = createMockEvent('ArrowUp');
            const result = manager.handleKeyDown(event, true);
            expect(result).toBe(true);
            expect(manager.selectedIndex).toBe(1);
        });

        it('handles Home by calling moveToFirst() and returns true', () => {
            manager.selectedIndex = 2;
            const event = createMockEvent('Home');
            const result = manager.handleKeyDown(event, true);
            expect(result).toBe(true);
            expect(manager.selectedIndex).toBe(0);
        });

        it('handles End by calling moveToLast() and returns true', () => {
            const event = createMockEvent('End');
            const result = manager.handleKeyDown(event, true);
            expect(result).toBe(true);
            expect(manager.selectedIndex).toBe(2);
        });

        it('returns false for unhandled keys (e.g., "a")', () => {
            const event = createMockEvent('a');
            const result = manager.handleKeyDown(event, true);
            expect(result).toBe(false);
            expect(event.preventDefault).not.toHaveBeenCalled();
            expect(event.stopPropagation).not.toHaveBeenCalled();
        });

        it('calls preventDefault and stopPropagation for handled keys', () => {
            const event = createMockEvent('ArrowDown');
            manager.handleKeyDown(event, true);
            expect(event.preventDefault).toHaveBeenCalled();
            expect(event.stopPropagation).toHaveBeenCalled();
        });

        it('respects container check when skipContainerCheck is false', () => {
            // Mock document.activeElement for this test
            const mockActiveElement = {};
            vi.stubGlobal('document', { activeElement: mockActiveElement });

            mockContainer.contains.mockReturnValue(false);
            const event = createMockEvent('ArrowDown');
            const result = manager.handleKeyDown(event, false);
            expect(result).toBe(false);
            expect(manager.selectedIndex).toBe(0); // unchanged
            expect(mockContainer.contains).toHaveBeenCalledWith(mockActiveElement);

            vi.unstubAllGlobals();
        });
    });

    describe('edge cases', () => {
        it('handles empty results array without crashing on navigation', () => {
            manager.updateResults([]);
            expect(() => manager.moveSelection('down')).not.toThrow();
            expect(() => manager.moveSelection('up')).not.toThrow();
            expect(() => manager.moveToFirst()).not.toThrow();
            expect(() => manager.moveToLast()).not.toThrow();
        });

        it('handles single result - up stays at 0', () => {
            manager.updateResults([{ id: 'only' }]);
            manager.moveSelection('up');
            expect(manager.selectedIndex).toBe(0);
        });

        it('handles single result - down stays at 0', () => {
            manager.updateResults([{ id: 'only' }]);
            manager.moveSelection('down');
            expect(manager.selectedIndex).toBe(0);
        });

        it('callback not called for single result navigation', () => {
            manager.updateResults([{ id: 'only' }]);
            selectionCallback.mockClear();
            manager.moveSelection('down');
            manager.moveSelection('up');
            expect(selectionCallback).not.toHaveBeenCalled();
        });

        it('handles manager without callback', () => {
            const noCallbackManager = new SelectionManager(mockContainer, null);
            noCallbackManager.updateResults([{ id: 1 }, { id: 2 }]);
            expect(() => noCallbackManager.moveSelection('down')).not.toThrow();
            expect(noCallbackManager.selectedIndex).toBe(1);
        });
    });
});

describe('async selection preservation', () => {
    const container = () => ({ querySelectorAll: () => [], contains: () => true });
    const space = (id, score) => ({ type: 'arcify-space', title: 'Work', score,
        metadata: { matchScore: score, arcifyBridge: { kind: 'space', peerId: 'peer', windowId: 2, spaceId: id } } });
    it('preserves identity across object replacement, enrichment, ranking and score changes', () => {
        const manager = new SelectionManager(container());
        manager.updateResults([space('work', 0.8)]);
        const replacement = space('work', 0.95);
        manager.updateResults([space('other', 1), replacement], { preserveSelection: true });
        expect(manager.getSelectedResult()).toBe(replacement);
    });
    it('does not confuse identical URL tab instances or different window/peer workspace identities', () => {
        const manager = new SelectionManager(container());
        const tab = id => ({ type: 'open-tab', url: 'chrome://newtab/', metadata: { tabId: id } });
        manager.updateResults([tab(1)]);
        manager.updateResults([tab(2)], { preserveSelection: true });
        expect(manager.getSelectedResult()).toBeNull();
        manager.updateResults([space('work', 1)]);
        const elsewhere = space('work', 1); elsewhere.metadata.arcifyBridge.windowId = 3;
        manager.updateResults([elsewhere], { preserveSelection: true });
        expect(manager.getSelectedResult()).toBeNull();
    });
    it('keeps the same tab identity across pin changes and same-window workspace moves', () => {
        const manager = new SelectionManager(container());
        manager.updateResults([{ type: 'open-tab', metadata: { tabId: 7 } }]);
        const pinned = { type: 'pinned-tab', metadata: { tabId: 7 } };
        manager.updateResults([pinned], { preserveSelection: true });
        expect(manager.getSelectedResult()).toBe(pinned);
        const bridgeTab = space('work', 1);
        bridgeTab.type = 'open-tab'; bridgeTab.metadata.arcifyBridge.kind = 'tab'; bridgeTab.metadata.arcifyBridge.tabId = 7;
        manager.updateResults([bridgeTab]);
        const moved = { ...bridgeTab, metadata: { arcifyBridge: { ...bridgeTab.metadata.arcifyBridge, spaceId: 'home' } } };
        manager.updateResults([moved], { preserveSelection: true });
        expect(manager.getSelectedResult()).toBe(moved);
    });
    it('holds no selection after a chosen result disappears until fresh navigation or input', () => {
        const manager = new SelectionManager(container());
        manager.updateResults([space('work', 1)]);
        manager.updateResults([space('other', 1)], { preserveSelection: true });
        expect(manager.selectedIndex).toBe(-1);
        manager.updateResults([space('work', 1)], { preserveSelection: true });
        expect(manager.selectedIndex).toBe(-1);
        manager.moveSelection('down');
        expect(manager.selectedIndex).toBe(0);
    });
    it.each(['ArrowUp', 'Home', 'ArrowDown', 'End'])('records explicit %s intent even without an index change', key => {
        const onChange = vi.fn(), onNavigation = vi.fn();
        const manager = new SelectionManager(container(), onChange, onNavigation);
        manager.updateResults([space('work', 1)]);
        manager.handleKeyDown({ key, preventDefault() {}, stopPropagation() {} }, true);
        expect(onNavigation).toHaveBeenCalledOnce();
        expect(onChange).not.toHaveBeenCalled();
    });
});
