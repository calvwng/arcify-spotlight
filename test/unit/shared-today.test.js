import { describe, it, expect, vi, afterEach } from 'vitest';
import { ArcifyBridgeProvider } from '../../shared/data-providers/arcify-bridge-provider.js';
import { validateSnapshot } from '../../shared/arcify-bridge.js';
import { handleBridgeResult } from '../../shared/arcify-bridge-actions.js';
import { resultIdentity } from '../../shared/selection-manager.js';
import { SpotlightUtils } from '../../shared/ui-utilities.js';
const peerId='a'.repeat(32);
const row={id:9,windowId:2,spaceId:'a',bookmarkFolderId:'fa',title:'Remote',url:'https://same.test/'};
function fixture(){
 const snapshot={windowId:1,capturedAt:1,activeSpaceId:'a',spaces:[{id:'a',bookmarkFolderId:'fa',name:'A',color:'blue',tabIds:[1],pinnedTabIds:[],temporaryTabIds:[1]}],tabs:[{id:1,windowId:1,spaceId:'a',title:'Local',url:row.url,pinned:false,active:true}],bookmarks:[],sharedToday:[{...row},{...row,id:10}]};
 const api={storage:{local:{get:vi.fn().mockResolvedValue({})}},tabs:{get:vi.fn(),create:vi.fn(),update:vi.fn()},search:{query:vi.fn()}};vi.stubGlobal('chrome',api);
 const provider=new ArcifyBridgeProvider(snapshot,{autocompleteProvider:{}},peerId);
 const bridge={getPeerId:vi.fn().mockResolvedValue(peerId),snapshot:vi.fn().mockResolvedValue(snapshot),request:vi.fn().mockResolvedValue({tabId:9}),serializeAction:fn=>fn()};
 return {snapshot,api,provider,bridge};
}
afterEach(()=>vi.unstubAllGlobals());
describe('shared Today authoritative results',()=>{
 it('keeps equal URLs as separate exact local/remote choices with window label',async()=>{const f=fixture();validateSnapshot(f.snapshot,1);const results=await f.provider.getOpenTabs();expect(results).toHaveLength(3);expect(new Set(results.map(resultIdentity)).size).toBe(3);expect(f.provider.deduplicateResults(results)).toHaveLength(3);expect(SpotlightUtils.formatResult(results[1])).toMatchObject({action:'Open in owning window',subtitle:'A · Window 2'});expect(results[1].metadata.tabId).toBeUndefined();});
 it.each(['current-tab','new-tab'])('routes remote choice in %s without native fallback or navigation',async mode=>{const f=fixture();const result=(await f.provider.getOpenTabs())[1];await handleBridgeResult(f.bridge,f.api,result,mode,{windowId:1,tabId:1});expect(f.bridge.request).toHaveBeenCalledExactlyOnceWith('openSharedToday',1,{tabId:9,ownerWindowId:2,spaceId:'a',bookmarkFolderId:'fa'},peerId);expect(f.api.tabs.create).not.toHaveBeenCalled();expect(f.api.tabs.update).not.toHaveBeenCalled();});
 for(const field of ['id','windowId','spaceId','bookmarkFolderId'])it(`rejects stale remote ${field} before dispatch`,async()=>{const f=fixture();const result=(await f.provider.getOpenTabs())[1];f.snapshot.sharedToday[0][field]=field==='id'||field==='windowId'?99:'changed';await expect(handleBridgeResult(f.bridge,f.api,result,'new-tab',{windowId:1,tabId:1})).rejects.toMatchObject({code:'STALE_RESULT'});expect(f.bridge.request).not.toHaveBeenCalled();});
 it('accepts legacy snapshot without shared field and preserves local results',async()=>{const f=fixture();delete f.snapshot.sharedToday;expect(validateSnapshot(f.snapshot,1)).toBe(f.snapshot);expect(await f.provider.getOpenTabs()).toHaveLength(1);});
 it.each([r=>r.push({...row}),r=>{r[0].windowId=1;},r=>{r[0].bookmarkFolderId='other';},r=>{r[0].id=-1;},r=>{r[0].extra=true;}])('rejects malformed or contradictory shared identities',change=>{const f=fixture();change(f.snapshot.sharedToday);expect(()=>validateSnapshot(f.snapshot,1)).toThrow();});
 it('source context mismatch cannot use remote metadata',async()=>{const f=fixture();const result=(await f.provider.getOpenTabs())[1];result.metadata.arcifyBridge.windowId=3;await expect(handleBridgeResult(f.bridge,f.api,result,'current-tab',{windowId:1,tabId:1})).rejects.toMatchObject({code:'WRONG_WINDOW'});expect(f.bridge.request).not.toHaveBeenCalled();});
});
