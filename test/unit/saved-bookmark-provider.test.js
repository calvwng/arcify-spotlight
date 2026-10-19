import { describe, it, expect, vi } from 'vitest';
import { SavedBookmarkProvider, readSavedTree, validateSavedResult } from '../../shared/data-providers/saved-bookmark-provider.js';
import { SpotlightUtils } from '../../shared/ui-utilities.js';
import { resultIdentity } from '../../shared/selection-manager.js';
const link = (id, title = 'Example') => ({ id, title, url: 'https://example.test/' });
const fixture = () => [{ id: '0', children: [{ id: '1', title: 'Bookmarks', children: [
    { id: 'a', title: 'Arcify', children: [{ id: 's', title: 'Work', children: [
        link('b'), { id: 'f', title: 'Research', children: [link('c'), link('c')] },
        { id: 'empty', title: 'Empty', children: [] }
    ] }] }, link('ordinary', 'Ordinary')
] }] }];
function provider(tree = fixture(), options) {
    chrome.bookmarks.getTree.mockResolvedValue(tree);
    return new SavedBookmarkProvider(options);
}
describe('saved bookmark discovery', () => {
    it('reads nested links, folders and order without local spaces or live URL binding', async () => {
        const p = provider();
        const data = await p.savedTree();
        expect(data.entries.map(x => x.node.id)).toEqual(['s','b','f','c','empty']);
        const rows = (await p.getBookmarkSuggestions('Example')).filter(x => x.metadata.savedBookmark);
        expect(rows.map(x => x.metadata.bookmarkId)).toEqual(['b','c']);
        expect(rows[1].metadata.savedBookmark.path).toBe('Arcify / Work / Research / Example');
        expect(rows.every(x => !x.metadata.tabId && !x.metadata.spaceId)).toBe(true);
        expect(resultIdentity(rows[0])).not.toBe(resultIdentity(rows[1]));
        expect(chrome.bookmarks.getTree).toHaveBeenCalledTimes(1);
    });
    it('uses one folder manager URL, including empty folders', async () => {
        const [row] = await provider().getBookmarkSuggestions('Empty');
        expect(row.url).toBe('chrome://bookmarks/?id=empty');
        expect(SpotlightUtils.formatResult(row, 'new-tab').action).toBe('View Folder');
        await expect(validateSavedResult(row, null)).resolves.toBeUndefined();
    });
    it('keeps equal-URL nodes, removes repeat identities and history duplicates, preserves live tabs', async () => {
        const p = provider();
        const rows = (await p.getBookmarkSuggestions('Example')).filter(x => x.metadata.savedBookmark);
        const live = { type: 'open-tab', url: rows[0].url, metadata: { tabId: 42 } };
        const history = { type: 'history', url: rows[0].url };
        expect(p.deduplicateResults([...rows, rows[0], live, history])).toEqual([live, ...rows]);
    });
    it('leaves ordinary bookmarks searchable with missing or ambiguous roots', async () => {
        expect(readSavedTree([link('x')]).status).toBe('missing');
        const tree = fixture(); tree[0].children.push({ id:'other', title:'Arcify', children:[link('z')] });
        const p = provider(tree);
        expect((await p.savedTree()).status).toBe('ambiguous');
        expect((await p.getBookmarkSuggestions('Example')).every(x => !x.metadata.savedBookmark)).toBe(true);
    });
    it('reports inaccessible bookmarks without breaking ordinary search', async () => {
        const p = provider(); chrome.bookmarks.getTree.mockRejectedValue(new Error('No access'));
        expect(await p.getBookmarkSuggestions('Example')).toEqual([]);
        expect(await p.discoveryStatus()).toContain('unavailable');
    });
    it.each(['rename','move','delete','url'])('refreshes and rejects stale %s selections', async change => {
        const p = provider(); const [row] = await p.getBookmarkSuggestions('Example');
        const tree = fixture(), space = tree[0].children[0].children[0].children[0];
        if (change === 'rename') space.children[0].title = 'Changed';
        if (change === 'move') { const item = space.children.shift(); space.children[0].children.push(item); }
        if (change === 'delete') space.children.shift();
        if (change === 'url') space.children[0].url = 'https://changed.test/';
        chrome.bookmarks.getTree.mockResolvedValue(tree);
        await expect(validateSavedResult(row, null)).rejects.toThrow('changed');
        expect((await new SavedBookmarkProvider().savedTree()).entries).not.toEqual((await p.savedTree()).entries);
    });
    it('rejects old fallback choices on reconnect and unavailable choices after disconnect', async () => {
        const [row] = await provider().getBookmarkSuggestions('Example');
        await expect(validateSavedResult(row, 'a'.repeat(32))).rejects.toThrow('connection');
        const offlineProvider = provider(fixture(), { unavailable:true }); offlineProvider.discoveryPeerId='a'.repeat(32);
        const [offline] = await offlineProvider.getBookmarkSuggestions('Example');
        await expect(validateSavedResult(offline, null)).rejects.toThrow('connection');
        const [fresh] = await provider().getBookmarkSuggestions('Example');
        await expect(validateSavedResult(fresh, null)).resolves.toBeUndefined();
    });
});

// Saved node identity must survive progressive scoring updates and keyboard navigation.
describe('saved bookmark keyboard identity', () => {
    it('keeps equal-URL choices distinct across arrow selection and a refresh', async () => {
        const { SelectionManager } = await import('../../shared/selection-manager.js');
        const rows = (await provider().getBookmarkSuggestions('Example')).filter(row => row.metadata.savedBookmark);
        const container = { querySelectorAll: () => [] };
        const selection = new SelectionManager(container);
        selection.updateResults(rows);
        selection.moveSelection('down');
        expect(selection.getSelectedResult().metadata.bookmarkId).toBe('c');
        selection.updateResults([...rows].reverse(), { preserveSelection:true });
        expect(selection.getSelectedResult().metadata.bookmarkId).toBe('c');
        selection.updateResults(rows.slice(0,1), { preserveSelection:true });
        expect(selection.getSelectedResult()).toBeNull();
    });
});

describe('saved results through shared rendering', () => {
    it('retains distinct saved identities when the instant URL matches', async () => {
        const { SharedSpotlightLogic } = await import('../../shared/shared-component-logic.js');
        const p = provider();
        const rows = p.deduplicateResults(await p.getBookmarkSuggestions('example'));
        const instant = { type:'url-suggestion', url:'https://example.test/', title:'Example' };
        const combined = SharedSpotlightLogic.combineResults(instant, rows);
        expect(combined).not.toContain(instant);
        expect(combined.filter(row => row.metadata?.savedBookmark).map(row => row.metadata.bookmarkId)).toEqual(['b','c']);
        const html = SharedSpotlightLogic.generateResultsHTML(combined, 'new-tab');
        expect(html).toContain('Saved bookmarks: Arcify / Work / Research / Example');
    });
});

describe('bookmark refresh ordering', () => {
    it('uses browser sibling order as the tie break after reorders and imports', async () => {
        const tree=fixture();
        const space=tree[0].children[0].children[0].children[0];
        space.children=[link('first'),link('second')];
        const first=await provider(tree).getBookmarkSuggestions('Example');
        expect(first.filter(row=>row.metadata.savedBookmark).map(row=>row.metadata.bookmarkId)).toEqual(['first','second']);
        space.children.reverse(); space.children.push(link('imported'));
        const refreshed=await new SavedBookmarkProvider().getBookmarkSuggestions('Example');
        expect(refreshed.filter(row=>row.metadata.savedBookmark).map(row=>row.metadata.bookmarkId)).toEqual(['second','first','imported']);
    });
});

describe('exact ancestry validation', () => {
    it('rejects a move between same-named folders even with unchanged display path', async () => {
        const tree=fixture(); const space=tree[0].children[0].children[0].children[0];
        space.children=[{id:'left',title:'Same',children:[link('moved')]},{id:'right',title:'Same',children:[]}];
        const p=provider(tree); const row=(await p.getBookmarkSuggestions('Example')).find(x=>x.metadata.bookmarkId==='moved');
        space.children[1].children.push(space.children[0].children.pop());
        await expect(validateSavedResult(row,null)).rejects.toThrow('changed');
    });
});
