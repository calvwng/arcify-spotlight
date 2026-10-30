import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SearchResult, ResultType, SpotlightTabMode } from '../../shared/search-types.js';

// Mock document.createElement for SpotlightUtils.escapeHtml (which uses DOM for HTML escaping)
// In Node environment, we provide a minimal shim that replicates textContent -> innerHTML behavior
const originalDocument = globalThis.document;
beforeAll(() => {
    globalThis.document = {
        createElement: () => {
            let text = '';
            return {
                set textContent(val) { text = val; },
                get innerHTML() {
                    return text
                        .replace(/&/g, '&amp;')
                        .replace(/</g, '&lt;')
                        .replace(/>/g, '&gt;')
                        .replace(/"/g, '&quot;');
                }
            };
        }
    };
});

afterAll(() => {
    globalThis.document = originalDocument;
});

// Import after document mock is set up (but vitest hoists beforeAll before imports via setup)
// The dynamic import pattern ensures the mock is in place
let SpotlightUtils;
beforeAll(async () => {
    const mod = await import('../../shared/ui-utilities.js');
    SpotlightUtils = mod.SpotlightUtils;
});

describe('SpotlightUtils.getChipColors', () => {
    const ALL_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

    it.each(ALL_COLORS)('returns correct bg/text for %s', (color) => {
        const result = SpotlightUtils.getChipColors(color);
        expect(result).toHaveProperty('bg');
        expect(result).toHaveProperty('text');
        expect(result.bg).toContain('rgba');
        expect(result.text).toContain('rgb');
    });

    it('falls back to grey for unknown color name', () => {
        const result = SpotlightUtils.getChipColors('magenta');
        const grey = SpotlightUtils.getChipColors('grey');
        expect(result).toEqual(grey);
    });

    it('falls back to grey for undefined input', () => {
        const result = SpotlightUtils.getChipColors(undefined);
        const grey = SpotlightUtils.getChipColors('grey');
        expect(result).toEqual(grey);
    });

    it('falls back to grey for null input', () => {
        const result = SpotlightUtils.getChipColors(null);
        const grey = SpotlightUtils.getChipColors('grey');
        expect(result).toEqual(grey);
    });

    it('all bg values use rgba with 0.15 opacity', () => {
        for (const color of ALL_COLORS) {
            const { bg } = SpotlightUtils.getChipColors(color);
            expect(bg).toMatch(/rgba\(\d+, \d+, \d+, 0\.15\)/);
        }
    });

    it('all text values use full rgb', () => {
        for (const color of ALL_COLORS) {
            const { text } = SpotlightUtils.getChipColors(color);
            expect(text).toMatch(/rgb\(\d+, \d+, \d+\)/);
        }
    });
});

describe('SpotlightUtils.generateSpaceChipHTML', () => {
    it('returns chip HTML with space name and color styling when group matches space', () => {
        const result = new SearchResult({
            type: ResultType.OPEN_TAB,
            title: 'GitHub',
            url: 'https://github.com',
            metadata: { spaceName: 'Work', spaceColor: 'blue', groupName: 'Work', groupColor: 'blue' }
        });

        const html = SpotlightUtils.generateSpaceChipHTML(result);

        expect(html).toContain('arcify-space-chip');
        expect(html).toContain('Work');
        expect(html).toContain('rgba(139, 179, 243, 0.15)'); // blue bg
        expect(html).toContain('rgb(139, 179, 243)'); // blue text
    });

    it('returns empty string for result without spaceName in metadata', () => {
        const result = new SearchResult({
            type: ResultType.OPEN_TAB,
            title: 'Example',
            url: 'https://example.com',
            metadata: { tabId: 1 }
        });

        expect(SpotlightUtils.generateSpaceChipHTML(result)).toBe('');
    });

    it('returns empty string for result with null metadata', () => {
        const result = new SearchResult({
            type: ResultType.OPEN_TAB,
            title: 'Example',
            url: 'https://example.com'
        });
        result.metadata = null;

        expect(SpotlightUtils.generateSpaceChipHTML(result)).toBe('');
    });

    it('returns empty string for result with empty metadata', () => {
        const result = new SearchResult({
            type: ResultType.OPEN_TAB,
            title: 'Example',
            url: 'https://example.com',
            metadata: {}
        });

        expect(SpotlightUtils.generateSpaceChipHTML(result)).toBe('');
    });

    it('truncates space names longer than 18 characters with ellipsis', () => {
        const result = new SearchResult({
            type: ResultType.OPEN_TAB,
            title: 'Test',
            url: 'https://test.com',
            metadata: { spaceName: 'This Is A Very Long Space Name', spaceColor: 'blue', groupName: 'This Is A Very Long Space Name', groupColor: 'blue' }
        });

        const html = SpotlightUtils.generateSpaceChipHTML(result);

        // The truncated name should be 18 chars + ellipsis character
        expect(html).toContain('This Is A Very Lon\u2026');
        // Full name should NOT appear as text content (only in title attribute)
        expect(html).not.toContain('>This Is A Very Long Space Name<');
    });

    it('does not truncate space names 18 characters or shorter', () => {
        const result = new SearchResult({
            type: ResultType.OPEN_TAB,
            title: 'Test',
            url: 'https://test.com',
            metadata: { spaceName: 'Short Name', spaceColor: 'green', groupName: 'Short Name', groupColor: 'green' }
        });

        const html = SpotlightUtils.generateSpaceChipHTML(result);

        expect(html).toContain('Short Name');
        expect(html).not.toContain('\u2026');
    });

    it('escapes HTML special characters in space name', () => {
        const result = new SearchResult({
            type: ResultType.OPEN_TAB,
            title: 'Test',
            url: 'https://test.com',
            metadata: { spaceName: '<script>alert("xss")</script>', spaceColor: 'red', groupName: '<script>alert("xss")</script>', groupColor: 'red' }
        });

        const html = SpotlightUtils.generateSpaceChipHTML(result);

        expect(html).not.toContain('<script>');
        expect(html).toContain('&lt;script&gt;');
    });

    it('uses groupColor from metadata for chip styling', () => {
        const result = new SearchResult({
            type: ResultType.OPEN_TAB,
            title: 'Test',
            url: 'https://test.com',
            metadata: { spaceName: 'Work', spaceColor: 'blue', groupName: 'Work', groupColor: 'purple' }
        });

        const html = SpotlightUtils.generateSpaceChipHTML(result);
        const purpleColors = SpotlightUtils.getChipColors('purple');

        expect(html).toContain(purpleColors.bg);
        expect(html).toContain(purpleColors.text);
    });

    it('falls back to grey when no groupColor in metadata', () => {
        const result = new SearchResult({
            type: ResultType.OPEN_TAB,
            title: 'Test',
            url: 'https://test.com',
            metadata: { groupName: 'Work' } // no groupColor
        });

        const html = SpotlightUtils.generateSpaceChipHTML(result);
        const greyColors = SpotlightUtils.getChipColors('grey');

        expect(html).toContain(greyColors.bg);
        expect(html).toContain(greyColors.text);
    });

    it('generates chip from groupName when spaceName is absent but groupName is present', () => {
        const result = new SearchResult({
            type: ResultType.OPEN_TAB,
            title: 'Test',
            url: 'https://test.com',
            metadata: { groupName: 'Dev', groupColor: 'cyan' }
        });

        const html = SpotlightUtils.generateSpaceChipHTML(result);

        expect(html).toContain('Dev');
        expect(html).toContain('arcify-space-chip');
    });

    it('uses groupColor as only color source (ignores spaceColor)', () => {
        const result = new SearchResult({
            type: ResultType.OPEN_TAB,
            title: 'Test',
            url: 'https://test.com',
            metadata: { spaceName: 'Work', spaceColor: 'blue', groupName: 'Work', groupColor: 'red' }
        });

        const html = SpotlightUtils.generateSpaceChipHTML(result);
        const redColors = SpotlightUtils.getChipColors('red');
        const blueColors = SpotlightUtils.getChipColors('blue');

        expect(html).toContain(redColors.bg);
        expect(html).toContain(redColors.text);
        expect(html).not.toContain(blueColors.bg);
    });

    it('sets title attribute to full (untruncated) space name', () => {
        const longName = 'This Is A Very Long Space Name Indeed';
        const result = new SearchResult({
            type: ResultType.OPEN_TAB,
            title: 'Test',
            url: 'https://test.com',
            metadata: { spaceName: longName, spaceColor: 'blue', groupName: longName, groupColor: 'blue' }
        });

        const html = SpotlightUtils.generateSpaceChipHTML(result);

        // Title attribute should contain the full escaped name
        expect(html).toContain(`title="${longName}"`);
    });

    it('shows actual group name when tab group differs from Arcify space', () => {
        const result = new SearchResult({
            type: ResultType.OPEN_TAB,
            title: 'Test',
            url: 'https://test.com',
            metadata: { spaceName: 'Work', spaceColor: 'blue', groupName: 'Personal', groupColor: 'green' }
        });

        const html = SpotlightUtils.generateSpaceChipHTML(result);
        const greenColors = SpotlightUtils.getChipColors('green');

        expect(html).toContain('Personal');
        expect(html).not.toContain('Work');
        expect(html).toContain(greenColors.bg);
        expect(html).toContain(greenColors.text);
    });

    it('returns empty string when tab has Arcify space but no tab group', () => {
        const result = new SearchResult({
            type: ResultType.OPEN_TAB,
            title: 'Test',
            url: 'https://test.com',
            metadata: { spaceName: 'Work', spaceColor: 'blue', isArcify: true }
        });

        expect(SpotlightUtils.generateSpaceChipHTML(result)).toBe('');
    });

    it('shows Arcify space name when group name matches space name', () => {
        const result = new SearchResult({
            type: ResultType.OPEN_TAB,
            title: 'Test',
            url: 'https://test.com',
            metadata: { spaceName: 'Work', spaceColor: 'blue', groupName: 'Work', groupColor: 'blue' }
        });

        const html = SpotlightUtils.generateSpaceChipHTML(result);

        expect(html).toContain('Work');
        expect(html).toContain('arcify-space-chip');
    });
});

describe('SpotlightUtils.formatResult - Arcify action text', () => {
    it('OPEN_TAB in NEW_TAB mode shows "Switch to Tab"', () => {
        const result = new SearchResult({
            type: ResultType.OPEN_TAB,
            title: 'GitHub',
            url: 'https://github.com',
            metadata: { tabId: 1, windowId: 1, isArcify: true, spaceName: 'Work' }
        });

        const formatted = SpotlightUtils.formatResult(result, SpotlightTabMode.NEW_TAB);
        expect(formatted.action).toBe('Switch to Tab');
    });

    it('OPEN_TAB in CURRENT_TAB mode shows "Open Pinned Tab" when groupName is present', () => {
        const result = new SearchResult({
            type: ResultType.OPEN_TAB,
            title: 'GitHub',
            url: 'https://github.com',
            metadata: { tabId: 1, windowId: 1, isArcify: true, spaceName: 'Work', groupName: 'Work' }
        });

        const formatted = SpotlightUtils.formatResult(result, SpotlightTabMode.CURRENT_TAB);
        expect(formatted.action).toBe('Open Pinned Tab');
    });

    it('OPEN_TAB in CURRENT_TAB mode shows enter arrow when isArcify is false', () => {
        const result = new SearchResult({
            type: ResultType.OPEN_TAB,
            title: 'Example',
            url: 'https://example.com',
            metadata: { tabId: 1, windowId: 1 }
        });

        const formatted = SpotlightUtils.formatResult(result, SpotlightTabMode.CURRENT_TAB);
        expect(formatted.action).toBe('\u21b5');
    });

    it('PINNED_TAB always shows "Open Pinned Tab" regardless of isActive', () => {
        const result = new SearchResult({
            type: ResultType.PINNED_TAB,
            title: 'GitHub',
            url: 'https://github.com',
            metadata: { bookmarkId: 'b1', spaceName: 'Work', isActive: true }
        });

        const formatted = SpotlightUtils.formatResult(result, SpotlightTabMode.CURRENT_TAB);
        expect(formatted.action).toBe('Open Pinned Tab');
    });

    it('PINNED_TAB with isActive false and isArcify true shows "Open Pinned Tab"', () => {
        const result = new SearchResult({
            type: ResultType.PINNED_TAB,
            title: 'GitHub',
            url: 'https://github.com',
            metadata: { bookmarkId: 'b1', spaceName: 'Work', isActive: false, isArcify: true }
        });

        const formatted = SpotlightUtils.formatResult(result, SpotlightTabMode.CURRENT_TAB);
        expect(formatted.action).toBe('Open Pinned Tab');
    });

    it('PINNED_TAB without isArcify still shows "Open Pinned Tab"', () => {
        const result = new SearchResult({
            type: ResultType.PINNED_TAB,
            title: 'Test',
            url: 'https://test.com',
            metadata: { bookmarkId: 'b2', isActive: false }
        });

        const formatted = SpotlightUtils.formatResult(result, SpotlightTabMode.CURRENT_TAB);
        expect(formatted.action).toBe('Open Pinned Tab');
    });

    it('BOOKMARK with isArcify in current space shows "Open Pinned Tab"', () => {
        const result = new SearchResult({
            type: ResultType.BOOKMARK,
            title: 'GitHub',
            url: 'https://github.com',
            metadata: { bookmarkId: 'b1', isArcify: true, spaceName: 'Work', spaceColor: 'blue' }
        });

        const formatted = SpotlightUtils.formatResult(result, SpotlightTabMode.CURRENT_TAB, 'Work');
        expect(formatted.action).toBe('Open Pinned Tab');
    });

    it('BOOKMARK with isArcify in different space shows enter arrow', () => {
        const result = new SearchResult({
            type: ResultType.BOOKMARK,
            title: 'GitHub',
            url: 'https://github.com',
            metadata: { bookmarkId: 'b1', isArcify: true, spaceName: 'Work', spaceColor: 'blue' }
        });

        const formatted = SpotlightUtils.formatResult(result, SpotlightTabMode.CURRENT_TAB, 'Personal');
        expect(formatted.action).toBe('\u21b5');
    });

    it('BOOKMARK with isArcify and no active group shows enter arrow', () => {
        const result = new SearchResult({
            type: ResultType.BOOKMARK,
            title: 'GitHub',
            url: 'https://github.com',
            metadata: { bookmarkId: 'b1', isArcify: true, spaceName: 'Work', spaceColor: 'blue' }
        });

        const formatted = SpotlightUtils.formatResult(result, SpotlightTabMode.CURRENT_TAB, null);
        expect(formatted.action).toBe('\u21b5');
    });

    it('BOOKMARK without isArcify shows enter arrow', () => {
        const result = new SearchResult({
            type: ResultType.BOOKMARK,
            title: 'Example',
            url: 'https://example.com',
            metadata: { bookmarkId: 'b2' }
        });

        const formatted = SpotlightUtils.formatResult(result, SpotlightTabMode.CURRENT_TAB);
        expect(formatted.action).toBe('\u21b5');
    });

    it('BOOKMARK with isArcify in current space shows "Open Pinned Tab" in NEW_TAB mode', () => {
        const result = new SearchResult({
            type: ResultType.BOOKMARK,
            title: 'GitHub',
            url: 'https://github.com',
            metadata: { bookmarkId: 'b1', isArcify: true, spaceName: 'Work', spaceColor: 'blue' }
        });

        const formatted = SpotlightUtils.formatResult(result, SpotlightTabMode.NEW_TAB, 'Work');
        expect(formatted.action).toBe('Open Pinned Tab');
    });
});
