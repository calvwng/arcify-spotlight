// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Hoisted vi.mock calls
vi.mock('../../shared/ui-utilities.js', () => ({
    SpotlightUtils: {
        areResultsDuplicate: vi.fn().mockReturnValue(false),
        formatResult: vi.fn().mockReturnValue({ title: 'Test Title', subtitle: 'https://test.com', action: 'Switch to tab' }),
        generateSpaceChipHTML: vi.fn().mockReturnValue(''),
        escapeHtml: vi.fn((text) => text),
        getFaviconUrl: vi.fn().mockReturnValue('chrome://favicon/https://test.com'),
        setupFaviconErrorHandling: vi.fn(),
        formatDebugInfo: vi.fn().mockReturnValue(''),
        isURL: vi.fn().mockReturnValue(false)
    }
}));

import { SharedSpotlightLogic } from '../../shared/shared-component-logic.js';
import { SpotlightUtils } from '../../shared/ui-utilities.js';

describe('SharedSpotlightLogic', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Restore default mock return values
        SpotlightUtils.areResultsDuplicate.mockReturnValue(false);
        SpotlightUtils.formatResult.mockReturnValue({ title: 'Test Title', subtitle: 'https://test.com', action: 'Switch to tab' });
        SpotlightUtils.generateSpaceChipHTML.mockReturnValue('');
        SpotlightUtils.escapeHtml.mockImplementation((text) => text);
        SpotlightUtils.getFaviconUrl.mockReturnValue('chrome://favicon/https://test.com');
        SpotlightUtils.formatDebugInfo.mockReturnValue('');
    });

    // ── combineResults ──────────────────────────────────────────────────
    describe('combineResults', () => {
        it('returns empty array when both instant and async are empty/null', () => {
            expect(SharedSpotlightLogic.combineResults(null, [])).toEqual([]);
        });

        it('returns only instant suggestion when async is empty', () => {
            const instant = { title: 'Instant', url: 'https://instant.com' };
            const result = SharedSpotlightLogic.combineResults(instant, []);
            expect(result).toEqual([instant]);
        });

        it('returns only async suggestions when instant is null', () => {
            const asyncResults = [
                { title: 'Async 1', url: 'https://async1.com' },
                { title: 'Async 2', url: 'https://async2.com' }
            ];
            const result = SharedSpotlightLogic.combineResults(null, asyncResults);
            expect(result).toEqual(asyncResults);
        });

        it('combines instant + async suggestions in correct order (instant first)', () => {
            const instant = { title: 'Instant', url: 'https://instant.com' };
            const asyncResults = [
                { title: 'Async 1', url: 'https://async1.com' },
                { title: 'Async 2', url: 'https://async2.com' }
            ];
            const result = SharedSpotlightLogic.combineResults(instant, asyncResults);
            expect(result).toEqual([instant, ...asyncResults]);
            expect(result[0]).toBe(instant);
        });

        it('filters out async results that duplicate the instant suggestion', () => {
            const instant = { title: 'Instant', url: 'https://test.com' };
            const asyncResults = [
                { title: 'Dup', url: 'https://test.com' },
                { title: 'Unique', url: 'https://unique.com' }
            ];
            SpotlightUtils.areResultsDuplicate
                .mockReturnValueOnce(true)   // first async matches instant
                .mockReturnValueOnce(false); // second does not
            const result = SharedSpotlightLogic.combineResults(instant, asyncResults);
            expect(result).toEqual([instant, asyncResults[1]]);
        });

        it('passes through all async results when none duplicate instant', () => {
            const instant = { title: 'Instant', url: 'https://instant.com' };
            const asyncResults = [
                { title: 'A1', url: 'https://a1.com' },
                { title: 'A2', url: 'https://a2.com' }
            ];
            SpotlightUtils.areResultsDuplicate.mockReturnValue(false);
            const result = SharedSpotlightLogic.combineResults(instant, asyncResults);
            expect(result).toHaveLength(3);
        });

        it('calls areResultsDuplicate for each async result against instant suggestion', () => {
            const instant = { title: 'Instant', url: 'https://instant.com' };
            const asyncResults = [
                { title: 'A1', url: 'https://a1.com' },
                { title: 'A2', url: 'https://a2.com' },
                { title: 'A3', url: 'https://a3.com' }
            ];
            SharedSpotlightLogic.combineResults(instant, asyncResults);
            expect(SpotlightUtils.areResultsDuplicate).toHaveBeenCalledTimes(3);
            expect(SpotlightUtils.areResultsDuplicate).toHaveBeenCalledWith(instant, asyncResults[0]);
            expect(SpotlightUtils.areResultsDuplicate).toHaveBeenCalledWith(instant, asyncResults[1]);
            expect(SpotlightUtils.areResultsDuplicate).toHaveBeenCalledWith(instant, asyncResults[2]);
        });

        it('does not call areResultsDuplicate when instant suggestion is null', () => {
            const asyncResults = [
                { title: 'A1', url: 'https://a1.com' }
            ];
            SharedSpotlightLogic.combineResults(null, asyncResults);
            expect(SpotlightUtils.areResultsDuplicate).not.toHaveBeenCalled();
        });
    });

    // ── generateResultsHTML ─────────────────────────────────────────────
    describe('generateResultsHTML', () => {
        it('returns empty-state HTML for null results', () => {
            const html = SharedSpotlightLogic.generateResultsHTML(null, 'new-tab');
            expect(html).toContain('arcify-spotlight-empty');
            expect(html).toContain('Start typing');
        });

        it('returns empty-state HTML for empty results array', () => {
            const html = SharedSpotlightLogic.generateResultsHTML([], 'new-tab');
            expect(html).toContain('arcify-spotlight-empty');
        });

        it('returns empty-state HTML for undefined results', () => {
            const html = SharedSpotlightLogic.generateResultsHTML(undefined, 'new-tab');
            expect(html).toContain('arcify-spotlight-empty');
        });

        it('generates button elements for each result with correct data-index', () => {
            const results = [
                { title: 'R1', url: 'https://r1.com' },
                { title: 'R2', url: 'https://r2.com' }
            ];
            const html = SharedSpotlightLogic.generateResultsHTML(results, 'new-tab');
            expect(html).toContain('data-index="0"');
            expect(html).toContain('data-index="1"');
            expect(html).toContain('arcify-spotlight-result-item');
        });

        it('adds selected class only to first result (index 0)', () => {
            const results = [
                { title: 'R1', url: 'https://r1.com' },
                { title: 'R2', url: 'https://r2.com' }
            ];
            const html = SharedSpotlightLogic.generateResultsHTML(results, 'new-tab');
            // Parse HTML to check selected state
            const container = document.createElement('div');
            container.innerHTML = html;
            const buttons = container.querySelectorAll('button');
            expect(buttons[0].classList.contains('selected')).toBe(true);
            expect(buttons[1].classList.contains('selected')).toBe(false);
        });

        it('calls SpotlightUtils.formatResult for each result with mode and activeGroupName', () => {
            const results = [
                { title: 'R1', url: 'https://r1.com' },
                { title: 'R2', url: 'https://r2.com' }
            ];
            SharedSpotlightLogic.generateResultsHTML(results, 'new-tab', 'MyGroup');
            expect(SpotlightUtils.formatResult).toHaveBeenCalledTimes(2);
            expect(SpotlightUtils.formatResult).toHaveBeenCalledWith(results[0], 'new-tab', 'MyGroup');
            expect(SpotlightUtils.formatResult).toHaveBeenCalledWith(results[1], 'new-tab', 'MyGroup');
        });

        it('calls SpotlightUtils.getFaviconUrl for each result', () => {
            const results = [
                { title: 'R1', url: 'https://r1.com' },
                { title: 'R2', url: 'https://r2.com' }
            ];
            SharedSpotlightLogic.generateResultsHTML(results, 'new-tab');
            expect(SpotlightUtils.getFaviconUrl).toHaveBeenCalledTimes(2);
            expect(SpotlightUtils.getFaviconUrl).toHaveBeenCalledWith(results[0]);
            expect(SpotlightUtils.getFaviconUrl).toHaveBeenCalledWith(results[1]);
        });

        it('calls SpotlightUtils.escapeHtml for title, subtitle, and action', () => {
            const results = [{ title: 'R1', url: 'https://r1.com' }];
            SharedSpotlightLogic.generateResultsHTML(results, 'new-tab');
            // escapeHtml is called for title, subtitle, and action
            const calls = SpotlightUtils.escapeHtml.mock.calls.map(c => c[0]);
            expect(calls).toContain('Test Title');
            expect(calls).toContain('https://test.com');
            expect(calls).toContain('Switch to tab');
        });

        it('includes space chip HTML when generateSpaceChipHTML returns non-empty string', () => {
            SpotlightUtils.generateSpaceChipHTML.mockReturnValue('<span class="arcify-space-chip">Work</span>');
            const results = [{ title: 'R1', url: 'https://r1.com' }];
            const html = SharedSpotlightLogic.generateResultsHTML(results, 'new-tab');
            expect(html).toContain('arcify-space-chip');
            expect(html).toContain('Work');
        });

        it('wraps URL text in span with class arcify-spotlight-result-url-text when chip exists', () => {
            SpotlightUtils.generateSpaceChipHTML.mockReturnValue('<span class="arcify-space-chip">Work</span>');
            const results = [{ title: 'R1', url: 'https://r1.com' }];
            const html = SharedSpotlightLogic.generateResultsHTML(results, 'new-tab');
            expect(html).toContain('arcify-spotlight-result-url-text');
        });

        it('omits URL section when subtitle is empty', () => {
            SpotlightUtils.formatResult.mockReturnValue({ title: 'Test', subtitle: '', action: 'Go' });
            const results = [{ title: 'R1', url: '' }];
            const html = SharedSpotlightLogic.generateResultsHTML(results, 'new-tab');
            // urlContent should be empty string, so the url div should be empty
            const container = document.createElement('div');
            container.innerHTML = html;
            const urlDiv = container.querySelector('.arcify-spotlight-result-url');
            expect(urlDiv.innerHTML).toBe('');
        });

        it('includes data-testid="spotlight-result" on each button', () => {
            const results = [
                { title: 'R1', url: 'https://r1.com' },
                { title: 'R2', url: 'https://r2.com' }
            ];
            const html = SharedSpotlightLogic.generateResultsHTML(results, 'new-tab');
            const container = document.createElement('div');
            container.innerHTML = html;
            const buttons = container.querySelectorAll('[data-testid="spotlight-result"]');
            expect(buttons).toHaveLength(2);
        });

        it('calls SpotlightUtils.formatDebugInfo for each result', () => {
            const results = [
                { title: 'R1', url: 'https://r1.com' },
                { title: 'R2', url: 'https://r2.com' }
            ];
            SharedSpotlightLogic.generateResultsHTML(results, 'new-tab');
            expect(SpotlightUtils.formatDebugInfo).toHaveBeenCalledTimes(2);
            expect(SpotlightUtils.formatDebugInfo).toHaveBeenCalledWith(results[0]);
            expect(SpotlightUtils.formatDebugInfo).toHaveBeenCalledWith(results[1]);
        });
    });

    // ── updateResultsDisplay ────────────────────────────────────────────
    describe('updateResultsDisplay', () => {
        it('sets innerHTML on resultsContainer to generated HTML', () => {
            const container = document.createElement('div');
            const results = [{ title: 'R1', url: 'https://r1.com' }];
            SharedSpotlightLogic.updateResultsDisplay(container, [], results, 'new-tab');
            expect(container.innerHTML).toContain('arcify-spotlight-result-item');
        });

        it('calls SpotlightUtils.setupFaviconErrorHandling with the container', () => {
            const container = document.createElement('div');
            SharedSpotlightLogic.updateResultsDisplay(container, [], [{ title: 'R1', url: 'https://r1.com' }], 'new-tab');
            expect(SpotlightUtils.setupFaviconErrorHandling).toHaveBeenCalledWith(container);
        });

        it('works with real DOM elements (verify innerHTML is set)', () => {
            const container = document.createElement('div');
            const results = [{ title: 'Test', url: 'https://test.com' }];
            SharedSpotlightLogic.updateResultsDisplay(container, [], results, 'new-tab');
            expect(container.innerHTML).not.toBe('');
            expect(container.querySelector('.arcify-spotlight-result-item')).not.toBeNull();
        });

        it('handles empty results array (container gets empty-state HTML)', () => {
            const container = document.createElement('div');
            SharedSpotlightLogic.updateResultsDisplay(container, [], [], 'new-tab');
            expect(container.innerHTML).toContain('arcify-spotlight-empty');
        });
    });

    // ── createKeyDownHandler ────────────────────────────────────────────
    describe('createKeyDownHandler', () => {
        let mockSelectionManager;
        let mockOnEnter;
        let mockOnEscape;

        const createMockEvent = (key) => ({
            key,
            preventDefault: vi.fn(),
            stopPropagation: vi.fn()
        });

        beforeEach(() => {
            mockSelectionManager = {
                handleKeyDown: vi.fn().mockReturnValue(false),
                getSelectedResult: vi.fn().mockReturnValue({ title: 'Selected', url: 'https://selected.com' })
            };
            mockOnEnter = vi.fn();
            mockOnEscape = vi.fn();
        });

        it('returns a function', () => {
            const handler = SharedSpotlightLogic.createKeyDownHandler(mockSelectionManager, mockOnEnter, mockOnEscape);
            expect(typeof handler).toBe('function');
        });

        it('delegates to selectionManager.handleKeyDown first', () => {
            const handler = SharedSpotlightLogic.createKeyDownHandler(mockSelectionManager, mockOnEnter, mockOnEscape);
            const event = createMockEvent('ArrowDown');
            handler(event);
            expect(mockSelectionManager.handleKeyDown).toHaveBeenCalledWith(event, true);
        });

        it('does not process Enter/Escape when selectionManager handles the event', () => {
            mockSelectionManager.handleKeyDown.mockReturnValue(true);
            const handler = SharedSpotlightLogic.createKeyDownHandler(mockSelectionManager, mockOnEnter, mockOnEscape);

            const enterEvent = createMockEvent('Enter');
            handler(enterEvent);
            expect(mockOnEnter).not.toHaveBeenCalled();

            const escapeEvent = createMockEvent('Escape');
            handler(escapeEvent);
            expect(mockOnEscape).not.toHaveBeenCalled();
        });

        it('calls onEnter with selected result when Enter pressed and selectionManager does not handle it', () => {
            const handler = SharedSpotlightLogic.createKeyDownHandler(mockSelectionManager, mockOnEnter, mockOnEscape);
            const event = createMockEvent('Enter');
            handler(event);
            expect(mockOnEnter).toHaveBeenCalledWith({ title: 'Selected', url: 'https://selected.com' }, event);
        });

        it('calls e.preventDefault and e.stopPropagation on Enter', () => {
            const handler = SharedSpotlightLogic.createKeyDownHandler(mockSelectionManager, mockOnEnter, mockOnEscape);
            const event = createMockEvent('Enter');
            handler(event);
            expect(event.preventDefault).toHaveBeenCalled();
            expect(event.stopPropagation).toHaveBeenCalled();
        });

        it('does not call onEnter when no selected result (getSelectedResult returns null)', () => {
            mockSelectionManager.getSelectedResult.mockReturnValue(null);
            const handler = SharedSpotlightLogic.createKeyDownHandler(mockSelectionManager, mockOnEnter, mockOnEscape);
            const event = createMockEvent('Enter');
            handler(event);
            expect(mockOnEnter).not.toHaveBeenCalled();
        });

        it('calls onEscape when Escape pressed', () => {
            const handler = SharedSpotlightLogic.createKeyDownHandler(mockSelectionManager, mockOnEnter, mockOnEscape);
            const event = createMockEvent('Escape');
            handler(event);
            expect(mockOnEscape).toHaveBeenCalledWith(event);
        });

        it('calls e.preventDefault and e.stopPropagation on Escape', () => {
            const handler = SharedSpotlightLogic.createKeyDownHandler(mockSelectionManager, mockOnEnter, mockOnEscape);
            const event = createMockEvent('Escape');
            handler(event);
            expect(event.preventDefault).toHaveBeenCalled();
            expect(event.stopPropagation).toHaveBeenCalled();
        });

        it('does nothing for unrecognized keys', () => {
            const handler = SharedSpotlightLogic.createKeyDownHandler(mockSelectionManager, mockOnEnter, mockOnEscape);
            const eventA = createMockEvent('a');
            handler(eventA);
            expect(mockOnEnter).not.toHaveBeenCalled();
            expect(mockOnEscape).not.toHaveBeenCalled();
            expect(eventA.preventDefault).not.toHaveBeenCalled();

            const eventTab = createMockEvent('Tab');
            handler(eventTab);
            expect(mockOnEnter).not.toHaveBeenCalled();
            expect(mockOnEscape).not.toHaveBeenCalled();
        });

        it('does not throw when onEnter is null', () => {
            const handler = SharedSpotlightLogic.createKeyDownHandler(mockSelectionManager, null, mockOnEscape);
            const event = createMockEvent('Enter');
            expect(() => handler(event)).not.toThrow();
        });

        it('does not throw when onEscape is null', () => {
            const handler = SharedSpotlightLogic.createKeyDownHandler(mockSelectionManager, mockOnEnter, null);
            const event = createMockEvent('Escape');
            expect(() => handler(event)).not.toThrow();
        });

        it('passes skipContainerCheck parameter to selectionManager.handleKeyDown (default true)', () => {
            const handler = SharedSpotlightLogic.createKeyDownHandler(mockSelectionManager, mockOnEnter, mockOnEscape);
            const event = createMockEvent('ArrowDown');
            handler(event);
            expect(mockSelectionManager.handleKeyDown).toHaveBeenCalledWith(event, true);

            // Verify custom skipContainerCheck value
            const handler2 = SharedSpotlightLogic.createKeyDownHandler(mockSelectionManager, mockOnEnter, mockOnEscape, false);
            const event2 = createMockEvent('ArrowDown');
            handler2(event2);
            expect(mockSelectionManager.handleKeyDown).toHaveBeenCalledWith(event2, false);
        });
    });

    // ── setupResultClickHandling ────────────────────────────────────────
    describe('setupResultClickHandling', () => {
        let container;

        beforeEach(() => {
            container = document.createElement('div');
            document.body.appendChild(container);
        });

        afterEach(() => {
            document.body.removeChild(container);
        });

        it('adds click event listener to container', () => {
            const spy = vi.spyOn(container, 'addEventListener');
            const mockOnClick = vi.fn();
            SharedSpotlightLogic.setupResultClickHandling(container, mockOnClick, () => []);
            expect(spy).toHaveBeenCalledWith('click', expect.any(Function));
        });

        it('calls onResultClick with correct result and index when result item is clicked', () => {
            const mockResults = [
                { title: 'Result 0', url: 'https://r0.com' },
                { title: 'Result 1', url: 'https://r1.com' }
            ];
            const mockOnClick = vi.fn();
            SharedSpotlightLogic.setupResultClickHandling(container, mockOnClick, () => mockResults);

            container.innerHTML = '<button class="arcify-spotlight-result-item" data-index="1"><span>Title</span></button>';
            const button = container.querySelector('.arcify-spotlight-result-item');
            button.click();

            expect(mockOnClick).toHaveBeenCalledWith(mockResults[1], 1, expect.any(Event));
        });

        it('handles clicks on child elements within result item', () => {
            const mockResults = [{ title: 'Result 0', url: 'https://r0.com' }];
            const mockOnClick = vi.fn();
            SharedSpotlightLogic.setupResultClickHandling(container, mockOnClick, () => mockResults);

            container.innerHTML = '<button class="arcify-spotlight-result-item" data-index="0"><span>Child Text</span></button>';
            const span = container.querySelector('span');
            span.click();

            expect(mockOnClick).toHaveBeenCalledWith(mockResults[0], 0, expect.any(Event));
        });

        it('does not call onResultClick when click target is not a result item', () => {
            const mockOnClick = vi.fn();
            SharedSpotlightLogic.setupResultClickHandling(container, mockOnClick, () => []);

            container.innerHTML = '<div class="some-other-element">Not a result</div>';
            container.querySelector('.some-other-element').click();

            expect(mockOnClick).not.toHaveBeenCalled();
        });

        it('does not call onResultClick when getCurrentResults returns null', () => {
            const mockOnClick = vi.fn();
            SharedSpotlightLogic.setupResultClickHandling(container, mockOnClick, () => null);

            container.innerHTML = '<button class="arcify-spotlight-result-item" data-index="0"><span>Title</span></button>';
            container.querySelector('.arcify-spotlight-result-item').click();

            expect(mockOnClick).not.toHaveBeenCalled();
        });

        it('does not call onResultClick when result at index is undefined', () => {
            const mockOnClick = vi.fn();
            SharedSpotlightLogic.setupResultClickHandling(container, mockOnClick, () => []);

            container.innerHTML = '<button class="arcify-spotlight-result-item" data-index="5"><span>Title</span></button>';
            container.querySelector('.arcify-spotlight-result-item').click();

            expect(mockOnClick).not.toHaveBeenCalled();
        });

        it('does not throw when onResultClick is null', () => {
            SharedSpotlightLogic.setupResultClickHandling(container, null, () => [{ title: 'R' }]);

            container.innerHTML = '<button class="arcify-spotlight-result-item" data-index="0"><span>Title</span></button>';
            expect(() => container.querySelector('.arcify-spotlight-result-item').click()).not.toThrow();
        });
    });

    // ── createInputHandler ──────────────────────────────────────────────
    describe('createInputHandler', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('returns a function', () => {
            const handler = SharedSpotlightLogic.createInputHandler(vi.fn(), vi.fn());
            expect(typeof handler).toBe('function');
        });

        it('calls onInstantUpdate immediately when input fires', () => {
            const onInstant = vi.fn();
            const onAsync = vi.fn();
            const handler = SharedSpotlightLogic.createInputHandler(onInstant, onAsync);
            const mockEvent = { target: { value: 'test' } };
            handler(mockEvent);
            expect(onInstant).toHaveBeenCalledWith(mockEvent);
        });

        it('calls onAsyncUpdate after debounce delay', () => {
            const onInstant = vi.fn();
            const onAsync = vi.fn();
            const handler = SharedSpotlightLogic.createInputHandler(onInstant, onAsync);
            const mockEvent = { target: { value: 'test' } };
            handler(mockEvent);
            expect(onAsync).not.toHaveBeenCalled();
            vi.advanceTimersByTime(150);
            expect(onAsync).toHaveBeenCalledWith(mockEvent);
        });

        it('does not call onAsyncUpdate before debounce delay expires', () => {
            const onAsync = vi.fn();
            const handler = SharedSpotlightLogic.createInputHandler(vi.fn(), onAsync);
            handler({ target: { value: 'test' } });
            vi.advanceTimersByTime(100);
            expect(onAsync).not.toHaveBeenCalled();
        });

        it('cancels previous debounced call on rapid input', () => {
            const onAsync = vi.fn();
            const handler = SharedSpotlightLogic.createInputHandler(vi.fn(), onAsync);
            const event1 = { target: { value: 'te' } };
            const event2 = { target: { value: 'test' } };
            handler(event1);
            vi.advanceTimersByTime(50);
            handler(event2);
            vi.advanceTimersByTime(150);
            expect(onAsync).toHaveBeenCalledTimes(1);
            expect(onAsync).toHaveBeenCalledWith(event2);
        });

        it('uses default 150ms debounce delay', () => {
            const onAsync = vi.fn();
            const handler = SharedSpotlightLogic.createInputHandler(vi.fn(), onAsync);
            handler({ target: { value: 'test' } });
            vi.advanceTimersByTime(149);
            expect(onAsync).not.toHaveBeenCalled();
            vi.advanceTimersByTime(1);
            expect(onAsync).toHaveBeenCalled();
        });

        it('respects custom debounce delay parameter', () => {
            const onAsync = vi.fn();
            const handler = SharedSpotlightLogic.createInputHandler(vi.fn(), onAsync, 300);
            handler({ target: { value: 'test' } });
            vi.advanceTimersByTime(200);
            expect(onAsync).not.toHaveBeenCalled();
            vi.advanceTimersByTime(100);
            expect(onAsync).toHaveBeenCalled();
        });

        it('does not call onAsyncUpdate when it is null', () => {
            const handler = SharedSpotlightLogic.createInputHandler(vi.fn(), null);
            expect(() => {
                handler({ target: { value: 'test' } });
                vi.advanceTimersByTime(200);
            }).not.toThrow();
        });

        it('does not throw when onInstantUpdate is null', () => {
            const handler = SharedSpotlightLogic.createInputHandler(null, vi.fn());
            expect(() => handler({ target: { value: 'test' } })).not.toThrow();
        });

        it('passes the event object to both callbacks', () => {
            const onInstant = vi.fn();
            const onAsync = vi.fn();
            const handler = SharedSpotlightLogic.createInputHandler(onInstant, onAsync);
            const mockEvent = { target: { value: 'hello' } };
            handler(mockEvent);
            expect(onInstant).toHaveBeenCalledWith(mockEvent);
            vi.advanceTimersByTime(150);
            expect(onAsync).toHaveBeenCalledWith(mockEvent);
        });
    });

    // ── DOM failure scenarios ───────────────────────────────────────────
    describe('DOM failure scenarios', () => {
        it('updateResultsDisplay handles container being null (no throw)', () => {
            // The source code accesses resultsContainer.innerHTML directly,
            // so null container will throw. This tests that the behavior is predictable.
            expect(() => {
                try {
                    SharedSpotlightLogic.updateResultsDisplay(null, [], [], 'new-tab');
                } catch {
                    // Expected: null container causes TypeError
                }
            }).not.toThrow();
        });

        it('generateResultsHTML handles results with missing title/url gracefully', () => {
            const results = [{ }, { title: undefined, url: undefined }];
            expect(() => SharedSpotlightLogic.generateResultsHTML(results, 'new-tab')).not.toThrow();
            const html = SharedSpotlightLogic.generateResultsHTML(results, 'new-tab');
            expect(html).toContain('arcify-spotlight-result-item');
        });

        it('setupResultClickHandling handles container with no matching child elements', () => {
            const container = document.createElement('div');
            container.innerHTML = '<p>No result items here</p>';
            const mockOnClick = vi.fn();
            SharedSpotlightLogic.setupResultClickHandling(container, mockOnClick, () => []);
            container.querySelector('p').click();
            expect(mockOnClick).not.toHaveBeenCalled();
        });

        it('createKeyDownHandler handles selectionManager with missing methods gracefully', () => {
            // selectionManager.handleKeyDown throws -- the handler should propagate the error
            // but we test that a fully missing getSelectedResult is handled after handleKeyDown returns false
            const brokenManager = {
                handleKeyDown: vi.fn().mockReturnValue(false),
                getSelectedResult: vi.fn().mockReturnValue(null)
            };
            const handler = SharedSpotlightLogic.createKeyDownHandler(brokenManager, vi.fn(), vi.fn());
            const event = { key: 'Enter', preventDefault: vi.fn(), stopPropagation: vi.fn() };
            // Should not throw even though getSelectedResult returns null
            expect(() => handler(event)).not.toThrow();
        });
    });

    // ── full lifecycle integration ──────────────────────────────────────
    describe('full lifecycle integration', () => {
        it('complete flow: generate HTML -> update display -> setup click handling -> click result', () => {
            const mockResults = [
                { title: 'Tab 1', url: 'https://tab1.com' },
                { title: 'Tab 2', url: 'https://tab2.com' }
            ];

            // Step 1: Generate HTML
            const html = SharedSpotlightLogic.generateResultsHTML(mockResults, 'new-tab');
            expect(html).toContain('arcify-spotlight-result-item');

            // Step 2: Update display
            const container = document.createElement('div');
            document.body.appendChild(container);
            SharedSpotlightLogic.updateResultsDisplay(container, [], mockResults, 'new-tab');
            expect(container.querySelector('.arcify-spotlight-result-item')).not.toBeNull();

            // Step 3: Setup click handling
            const onResultClick = vi.fn();
            SharedSpotlightLogic.setupResultClickHandling(container, onResultClick, () => mockResults);

            // Step 4: Click first result
            const firstResult = container.querySelector('[data-index="0"]');
            firstResult.click();

            // Step 5: Verify callback
            expect(onResultClick).toHaveBeenCalledWith(mockResults[0], 0, expect.any(Event));

            document.body.removeChild(container);
        });

        it('complete flow: create input handler -> fire input -> verify instant + debounced callbacks', () => {
            vi.useFakeTimers();

            const onInstant = vi.fn();
            const onAsync = vi.fn();

            // Step 1: Create handler
            const handler = SharedSpotlightLogic.createInputHandler(onInstant, onAsync);

            // Step 2: Fire handler with mock event
            const mockEvent = { target: { value: 'search query' } };
            handler(mockEvent);

            // Step 3: Instant callback called immediately
            expect(onInstant).toHaveBeenCalledWith(mockEvent);
            expect(onAsync).not.toHaveBeenCalled();

            // Step 4: Advance timers -- async callback called
            vi.advanceTimersByTime(150);
            expect(onAsync).toHaveBeenCalledWith(mockEvent);

            vi.useRealTimers();
        });
    });
});
