import {it,expect,beforeEach,vi} from 'vitest';
import {chromeMock} from '../mocks/chrome.js';
import './setup.js';
const PEER='a'.repeat(32),SELF='b'.repeat(32),sourceUrl='https://source.test/';
const result={type:'url-suggestion',url:'https://target.test/'};
const event=()=>{const listeners=new Set();return {addListener:vi.fn(f=>listeners.add(f)),removeListener:vi.fn(f=>listeners.delete(f)),fire(...args){for(const f of listeners)f(...args);}};};
let tab,sender,commands,oldPeer,sourceReply,helloHook;
const snapshot=()=>({windowId:2,activeSpaceId:'work',capturedAt:1,spaces:[{id:'work',name:'Work',color:'blue',tabIds:[42],pinnedTabIds:[],temporaryTabIds:[42]}],tabs:[{...tab,spaceId:'work',title:'Source'}],bookmarks:[]});
const invoke=(message,from=sender)=>new Promise(resolve=>chromeMock.runtime.onMessage.callListeners(message,from,resolve));
const select=(extra={},from=sender)=>invoke({action:'spotlightHandleResult',result,mode:'new-tab',...extra},from);
beforeEach(async()=>{
 commands=[];oldPeer=false;sourceReply=null;helloHook=null;
 tab={id:42,windowId:2,url:sourceUrl,active:true,pinned:false,incognito:false,status:'complete'};
 sender={id:SELF,tab:structuredClone(tab),url:sourceUrl,origin:'https://source.test',frameId:0,documentLifecycle:'active'};
 for(const name of ['onUpdated','onRemoved','onDetached','onReplaced','onActivated'])chromeMock.tabs[name]=event();chromeMock.windows.onRemoved=event();chromeMock.storage.onChanged=event();
 chromeMock.storage.session={get:vi.fn(async()=>({})),set:vi.fn(async()=>{})};
 chromeMock.storage.local.get.mockImplementation(async()=>({arcifyBridgePeerId:PEER}));
 chromeMock.tabs.get.mockImplementation(async()=>structuredClone(tab));chromeMock.windows.get.mockResolvedValue({id:2,type:'normal',focused:true,incognito:false});
 chromeMock.runtime.sendMessage.mockImplementation((_id,request,callback)=>{
  commands.push(request);
  if(request.command==='hello'&&helloHook)helloHook();
  const respond=()=>callback({type:'arcify-bridge',version:1,role:'arcify',requestId:request.requestId,ok:true,extensionId:PEER,snapshot:snapshot(),capabilities:oldPeer?[]:['sourceRoutedOpenV1'],tabId:50});
  if(request.command==='openRoutedTab') {
   // Simulate Arcify's independent liveness challenge to the original document.
   chromeMock.runtime.onMessageExternal.callListeners({type:'arcify-routed-source',...request.source,windowId:2},{id:PEER},reply=>{sourceReply=reply;respond();});
  } else respond();
 });
 await import('../../background.js');
});
it('production background ignores malicious source flags and caller tabId; derives exact source from browser sender',async()=>{
 const response=await select({tabId:999,source:{tabId:999,url:'https://evil.test/',owned:true},routing:true});
 expect(response).toMatchObject({success:true,command:'openRoutedTab',sourceTabId:42});
 expect(commands.find(r=>r.command==='openRoutedTab').source).toMatchObject({tabId:42,url:sourceUrl});expect(sourceReply).toEqual({live:true});expect(chromeMock.tabs.create).not.toHaveBeenCalled();
});
it('production duplicate internal submissions dispatch only once',async()=>{
 const [a,b]=await Promise.all([select(),select()]);expect([a.success,b.success]).toEqual([true,false]);expect(b.errorCode).toBe('ACTION_PENDING');expect(commands.filter(r=>r.command==='openRoutedTab')).toHaveLength(1);
});
it.each(['navigation','move','pin','pairing'])('production source change during hello rejects %s without mutation',async kind=>{
 helloHook=()=>{if(kind==='navigation')chromeMock.tabs.onUpdated.fire(42,{status:'loading'});if(kind==='move'){tab.windowId=3;chromeMock.tabs.onDetached.fire(42);}if(kind==='pin')tab.pinned=true;if(kind==='pairing')chromeMock.storage.onChanged.fire({arcifyBridgePairingGeneration:{}},'local');};
 const response=await select();expect(response.success).toBe(false);expect(['STALE_ROUTING_SOURCE','INVALID_RESPONSE']).toContain(response.errorCode);expect(commands.every(r=>r.command==='hello')).toBe(true);expect(chromeMock.tabs.create).not.toHaveBeenCalled();
});
it('production old peer is rejected before dispatch and does not fall back',async()=>{oldPeer=true;expect(await select()).toMatchObject({success:false,errorCode:'UNSUPPORTED'});expect(commands.every(r=>r.command==='hello')).toBe(true);expect(chromeMock.tabs.create).not.toHaveBeenCalled();});
it('production helper, current-tab, saved and search paths retain their existing commands',async()=>{
 const cases=[{extra:{mode:'current-tab'},from:sender,command:'navigateTab'},
 {extra:{},from:{...sender,url:chromeMock.runtime.getURL('newtab.html')},command:'openTab'},
 {extra:{result:{type:'bookmark',url:'https://saved.test/'}},from:sender,command:'openTab'},
 {extra:{result:{type:'search-query',metadata:{query:'hello'}}},from:sender,command:'openTab'}];
 for(const c of cases){commands.length=0;expect((await select(c.extra,c.from)).success).toBe(true);expect(commands.some(r=>r.command===c.command)).toBe(true);expect(commands.some(r=>r.command==='openRoutedTab')).toBe(false);}
});
it('production sender must be an active top document with a native tab',async()=>{
 for(const patch of [{frameId:1},{documentLifecycle:'cached'},{tab:null},{url:'https://forged.test/'}])expect(await select({}, {...sender,...patch})).toMatchObject({success:false,errorCode:'STALE_ROUTING_SOURCE'});
 expect(commands).toEqual([]);
});
