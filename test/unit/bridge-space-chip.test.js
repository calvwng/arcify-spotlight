// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { SpotlightUtils } from '../../shared/ui-utilities.js';
import { ResultType, SearchResult } from '../../shared/search-types.js';

function bridgeResult(name, color = 'blue', extraMetadata = {}) {
    return new SearchResult({
        type: ResultType.BOOKMARK,
        title: 'Shared pinned page', url: 'https://example.com/shared',
        metadata: {
            spaceName: name, spaceColor: color, spaceId: 'work', bookmarkId: '31',
            arcifyBridge: { kind: 'bookmark', spaceId: 'work', bookmarkId: '31', windowId: 11 },
            ...extraMetadata
        }
    });
}

function parseChip(result) {
    const template = document.createElement('template');
    template.innerHTML = SpotlightUtils.generateSpaceChipHTML(result);
    return { fragment: template.content, chip: template.content.firstElementChild };
}

describe('Safe authoritative bridge workspace chips', () => {
    it.each([
        'Work" onpointerenter="alert(1)',
        '<img src=x onerror="alert(1)">',
        'Ops <qa> & "x"',
        'O\'Brien "Tools"',
        '&quot; &amp; < >',
        '\' autofocus onfocus=\'alert(1)'
    ])('renders the workspace name only as a title and text: %s', (name) => {
        const { fragment, chip } = parseChip(bridgeResult(name));
        expect(fragment.children).toHaveLength(1);
        expect(chip.tagName).toBe('SPAN');
        expect(chip.getAttributeNames().sort()).toEqual(['class', 'style', 'title']);
        expect(chip.getAttribute('title')).toBe(name);
        expect(chip.textContent).toBe(name.length > 18 ? `${name.substring(0, 18)}…` : name);
        expect(chip.children).toHaveLength(0);
        expect(fragment.querySelector('script, img, [onpointerenter], [onerror], [onfocus], [autofocus]')).toBeNull();
    });

    it('uses workspace name and color for closed bookmarks with no native group', () => {
        const { chip } = parseChip(bridgeResult('Work', 'blue'));
        const colors = SpotlightUtils.getChipColors('blue');
        expect(chip.textContent).toBe('Work');
        expect(chip.getAttribute('style')).toBe(`background:${colors.bg};color:${colors.text}`);
    });

    it('uses workspace metadata for live bridge tabs instead of conflicting native group metadata', () => {
        const result = bridgeResult('Authoritative Work', 'purple', {
            groupName: 'Native group', groupColor: 'red',
            arcifyBridge: { kind: 'tab', spaceId: 'work', tabId: 21, windowId: 11 }
        });
        result.type = ResultType.PINNED_TAB;
        const { chip } = parseChip(result);
        const colors = SpotlightUtils.getChipColors('purple');
        expect(chip.title).toBe('Authoritative Work');
        expect(chip.getAttribute('style')).toBe(`background:${colors.bg};color:${colors.text}`);
    });

    it('visibly distinguishes identical closed pins by their workspace labels and colors', () => {
        const first = bridgeResult('Work', 'blue');
        const second = bridgeResult('Personal', 'green', {
            spaceId: 'personal', bookmarkId: '32',
            arcifyBridge: { kind: 'bookmark', spaceId: 'personal', bookmarkId: '32', windowId: 11 }
        });
        expect(first.title).toBe(second.title);
        expect(first.url).toBe(second.url);
        const firstChip = parseChip(first).chip;
        const secondChip = parseChip(second).chip;
        expect(firstChip.textContent).toBe('Work');
        expect(secondChip.textContent).toBe('Personal');
        expect(firstChip.getAttribute('style')).toContain(`color:${SpotlightUtils.getChipColors('blue').text}`);
        expect(secondChip.getAttribute('style')).toContain(`color:${SpotlightUtils.getChipColors('green').text}`);
        expect(firstChip.getAttribute('style')).not.toBe(secondChip.getAttribute('style'));
    });

    it('keeps standalone group name/color behavior and also escapes its title attribute', () => {
        const name = 'Native" onpointerenter="alert(1)';
        const result = new SearchResult({
            type: ResultType.OPEN_TAB,
            metadata: { groupName: name, groupColor: 'red', spaceName: 'Ignored legacy space', spaceColor: 'blue' }
        });
        const { chip } = parseChip(result);
        expect(chip.title).toBe(name);
        expect(chip.getAttributeNames().sort()).toEqual(['class', 'style', 'title']);
        expect(chip.getAttribute('style')).toContain(`color:${SpotlightUtils.getChipColors('red').text}`);
        expect(chip.textContent).not.toContain('Ignored');
    });

    it('does not infer a workspace chip for a bridge result with no workspace name', () => {
        const result = bridgeResult(undefined, 'blue', { groupName: 'Unrelated native group' });
        expect(SpotlightUtils.generateSpaceChipHTML(result)).toBe('');
    });

    it('keeps legacy space-only results without a native group chip', () => {
        const result = new SearchResult({ metadata: { spaceName: 'Legacy Work', spaceColor: 'blue', isArcify: true } });
        expect(SpotlightUtils.generateSpaceChipHTML(result)).toBe('');
    });

    it('escapes quotes, angle brackets, and ampersands without double-decoding entities', () => {
        expect(SpotlightUtils.escapeHtml('"\'<>& &quot;')).toBe('&quot;&#39;&lt;&gt;&amp; &amp;quot;');
    });
});
