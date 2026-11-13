import { describe, it, expect, vi } from 'vitest';
import { flattenFolders, folderResults, installFolderMessages } from '../../shared/folder-search.js';
const tree = [{ id: '0', title: '', children: [{ id: '1', title: 'Work', children: [{ id: '2', title: 'Areas', parentId: '1', children: [{ id: '3', title: 'Reference', parentId: '2' }, { id: '4', title: 'Link', url: 'https://example.com' }] }] }, { id: '5', title: 'Personal', children: [{ id: '6', title: 'Areas' }] }] }];
describe('folder discovery', () => {
 it('includes nested and empty folders, excludes URLs and browser root', () => { expect(flattenFolders(tree).map(x => x.id)).toEqual(['1','2','3','5','6']); });
 it('matches command, partial and fuzzy names with distinguishable paths', () => {
  for (const query of ['open Areas', 'op Area', 'Areas', 'open Aeras']) expect(folderResults(flattenFolders(tree), query).map(x => x.metadata.folder.id)).toContain('2');
  expect(folderResults(flattenFolders(tree), 'Areas').map(x => x.metadata.folder.path)).toEqual(expect.arrayContaining(['Work / Areas', 'Personal / Areas']));
 });
 it('does not surface folders for blank or single-character queries', () => { expect(folderResults(flattenFolders(tree), '')).toEqual([]); expect(folderResults(flattenFolders(tree), 'open a')).toEqual([]); });
});
function harness(options) {
 let handler;
 const api = { runtime: { id: 'self', onMessage: { addListener: fn => handler = fn } }, bookmarks: { getTree: vi.fn(async () => tree), get: vi.fn(async id => id === '2' ? [{ id, title: 'Areas' }] : [{ id, url: 'https://example.com', parentId: '2' }]), getChildren: vi.fn(async () => []) }, tabs: { create: vi.fn(async () => ({})) } };
 installFolderMessages(api, options);
 const send = (command, fields = {}, sender = { id: 'self', tab: { windowId: 8 } }) => new Promise(resolve => handler({ action: 'spotlightFolders', command, ...fields }, sender, resolve));
 return { api, send };
}
describe('folder actions', () => {
 it('rejects private and foreign sender reads', async () => { const {api,send}=harness(); expect((await send('list', {}, { id:'other' })).success).toBe(false); expect((await send('list',{}, {id:'self',tab:{incognito:true}})).success).toBe(false); expect(api.bookmarks.getTree).not.toHaveBeenCalled(); });
 it('opens manager to exact folder in source window', async () => { const {api,send}=harness(); expect((await send('manage',{id:'2'})).success).toBe(true); expect(api.tabs.create).toHaveBeenCalledWith({url:'chrome://bookmarks/?id=2',windowId:8}); });
 it('revalidates child membership before opening a bookmark', async () => { const {api,send}=harness(); api.bookmarks.get.mockResolvedValueOnce([{id:'2'}]).mockResolvedValueOnce([{id:'4',parentId:'9',url:'https://example.com'}]); expect((await send('openBookmark',{id:'2',bookmarkId:'4'})).success).toBe(false); expect(api.tabs.create).not.toHaveBeenCalled(); });
 it('refuses unsafe URL schemes and missing folders', async () => { const {api,send}=harness(); api.bookmarks.get.mockResolvedValueOnce([{id:'2'}]).mockResolvedValueOnce([{id:'4',parentId:'2',url:'javascript:alert(1)'}]); expect((await send('openBookmark',{id:'2',bookmarkId:'4'})).success).toBe(false); api.bookmarks.get.mockResolvedValueOnce([]); expect((await send('children',{id:'2'})).success).toBe(false); });
});

it('uses paired navigation instead of native opening and never falls back on its error', async () => {
 const openBookmark=vi.fn(async()=>true); const {api,send}=harness({openBookmark});
 expect((await send('openBookmark',{id:'2',bookmarkId:'4'})).success).toBe(true);expect(openBookmark).toHaveBeenCalledOnce();expect(api.tabs.create).not.toHaveBeenCalled();
 openBookmark.mockRejectedValueOnce(new Error('Disconnected'));expect((await send('openBookmark',{id:'2',bookmarkId:'4'})).success).toBe(false);expect(api.tabs.create).not.toHaveBeenCalled();
});
it('uses resolved source window and rejects private helper reads', async () => {
 const resolveSource=vi.fn(async()=>({windowId:42}));const {api,send}=harness({resolveSource});
 await send('manage',{id:'2',tabId:9},{id:'self'});expect(api.tabs.create).toHaveBeenCalledWith({url:'chrome://bookmarks/?id=2',windowId:42});
 resolveSource.mockRejectedValueOnce(new Error('Private window'));expect((await send('list',{tabId:9},{id:'self'})).success).toBe(false);expect(api.bookmarks.getTree).not.toHaveBeenCalled();
});
