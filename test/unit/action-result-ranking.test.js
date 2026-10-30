// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { matchSidebarQuery } from '../../shared/arcify-sidebar-command.js';
import { SharedSpotlightLogic } from '../../shared/shared-component-logic.js';
import { SpotlightUtils } from '../../shared/ui-utilities.js';

const sidebar = { type: 'arcify-sidebar-command', title: 'Open Arcify sidebar', url: '', metadata: { sidebarPeerId: 'a'.repeat(32), matchScore: 0.9 } };
const workspace = { type: 'arcify-space', title: 'Work', url: '', metadata: { matchScore: 0.8, arcifyBridge: { kind: 'space', peerId: 'a'.repeat(32), windowId: 2, spaceId: 'work' } } };
const tab = { type: 'open-tab', title: 'Work tab', url: 'https://work.example', metadata: { arcifyBridge: { kind: 'tab', tabId: 1 } } };

describe('bounded sidebar command matching', () => {
    it.each(['open arcify', '  OPEN   ARCIFY ', 'show sidebar', 'side panel', 'sidebar open', 'arci', 'opn arcfi', 'open aricfy', 'open sideabr', 'sidbar', 'shwo panel'])('matches aliases, prefixes and typos: %j', query => {
        expect(matchSidebarQuery(query)).toBeGreaterThan(0);
    });
    it.each(['a', 'o', 'pen', 'open source', 'side effects', 'sidebar documentation', 'arcify alternatives', 'open xx sidebar', 'https://arcify.com', 'arcify.com', 'open arcify.com', 'chrome://newtab/', 'sidebar123', '<sidebar>', 'x'.repeat(65), 'open '.repeat(7), 'qzxv'])('rejects unrelated, URL, short or oversized input: %j', query => {
        expect(matchSidebarQuery(query)).toBeNull();
    });
    it('scores exact matches above fuzzy ones and keeps blank-query availability separate', () => {
        expect(matchSidebarQuery('open arcify')).toBe(1);
        expect(matchSidebarQuery('opn arcfi')).toBeLessThan(matchSidebarQuery('open arcify'));
        expect(matchSidebarQuery('  ')).toBe(0);
    });
});

describe('shared renderer action placement', () => {
    it('ranks matched commands by quality above retained web search, without changing navigation order', () => {
        const search = SpotlightUtils.generateInstantSuggestion('open arcify');
        const bookmark = { type: 'bookmark', title: 'Open Arcify', url: 'https://example.com', metadata: { arcifyBridge: { kind: 'bookmark' } } };
        const results = SharedSpotlightLogic.combineResults(search, [tab, workspace, bookmark], { actions: [sidebar], query: 'open arcify' });
        expect(results).toEqual([sidebar, workspace, search, tab, bookmark]);
    });
    it('promotes a better workspace match before a weaker sidebar match', () => {
        const search = SpotlightUtils.generateInstantSuggestion('side');
        const exactSpace = { ...workspace, metadata: { ...workspace.metadata, matchScore: 1 } };
        expect(SharedSpotlightLogic.combineResults(search, [exactSpace], { actions: [sidebar], query: 'side' })).toEqual([exactSpace, sidebar, search]);
    });
    it('does not treat ordinary bridge tabs/bookmarks or an unauthored space-shaped row as commands', () => {
        const search = SpotlightUtils.generateInstantSuggestion('work');
        const fakeSpace = { type: 'arcify-space', title: 'Work', metadata: {} };
        expect(SharedSpotlightLogic.combineResults(search, [tab, fakeSpace], { query: 'work' })).toEqual([search, tab, fakeSpace]);
    });
    it('preserves URL priority, empty defaults and the explicit one-shot startup choice', () => {
        const url = SpotlightUtils.generateInstantSuggestion('arcify.com');
        expect(SharedSpotlightLogic.combineResults(url, [workspace], { actions: [sidebar], query: 'arcify.com' })).toEqual([url, workspace, sidebar]);
        expect(SharedSpotlightLogic.combineResults(null, [tab], { actions: [sidebar] })).toEqual([tab, sidebar]);
        expect(SharedSpotlightLogic.combineResults(null, [tab], { actions: [sidebar], preferredAction: sidebar })).toEqual([sidebar, tab]);
    });
    it('leaves standalone web search unchanged', () => {
        const search = SpotlightUtils.generateInstantSuggestion('opn arcfi');
        expect(SharedSpotlightLogic.combineResults(search, [tab], { query: 'opn arcfi' })).toEqual([search, tab]);
    });
});

describe('sidebar action icon', () => {
    it('renders a visible panel SVG through the existing favicon image architecture', () => {
        const container = document.createElement('div');
        container.innerHTML = SharedSpotlightLogic.generateResultsHTML([sidebar], 'new-tab');
        const source = decodeURIComponent(container.querySelector('img').getAttribute('src'));
        expect(source).toContain('<rect');
        expect(source).toContain('M9 4v16');
        expect(source).toContain('stroke="#858585"');
        expect(source).not.toContain('currentColor');
        expect(source).not.toContain('<circle');
        const luminance = value => {
            const channel = value / 255;
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        };
        const stroke = luminance(0x85);
        for (const background of [luminance(0x2d), luminance(0xff)]) {
            const contrast = (Math.max(stroke, background) + 0.05) / (Math.min(stroke, background) + 0.05);
            expect(contrast).toBeGreaterThan(3.5);
        }
    });
});
