import {it,expect,vi,afterEach} from 'vitest';
import {createRoutedSourceCapture,isRoutedUrlSubmission,installRoutedSourceValidation} from '../../shared/routed-open-source.js';
import {handleBridgeResult} from '../../shared/arcify-bridge-actions.js';
import {ArcifyBridgeClient} from '../../shared/arcify-bridge.js';
import {responseFor,ROUTED_OPEN_FEATURE} from '../../shared/arcify-bridge-protocol.js';
const SELF='a'.repeat(32),PEER='b'.repeat(32),url='https://source.test/';
const result={type:'url-suggestion',url:'https://destination.test/'};
const event=()=>{const listeners=new Set();return {addListener:f=>listeners.add(f),removeListener:f=>listeners.delete(f),fire(...args){for(const f of listeners)f(...args);}};};
function fixture(){
 const tab={id:7,windowId:2,url,active:true,incognito:false,pinned:false,status:'complete'};
 const sender={id:SELF,tab:structuredClone(tab),url,origin:'https://source.test',frameId:0,documentLifecycle:'active'};
 const state={peer:PEER,old:false,missing:false,commands:[],generation:'g1',delay:null};
 const snapshot=()=>({windowId:2,capturedAt:1,activeSpaceId:'work',spaces:[{id:'work',name:'Work',color:'blue',tabIds:[7],pinnedTabIds:[],temporaryTabIds:[7]}],tabs:[{...tab,spaceId:'work',title:'Source'}],bookmarks:[]});
 const api={runtime:{id:SELF,getURL:p=>'chrome-extension://'+SELF+'/'+p,onMessageExternal:event(),sendMessage:vi.fn((_peer,request,callback)=>{
  state.commands.push(request);if(state.old&&request.command==='hello'&&request.supportedFeatures?.includes(ROUTED_OPEN_FEATURE)){callback(responseFor(request,'arcify',{ok:false,error:{code:'INVALID_REQUEST'}}));return;}
  if(state.delay&&request.command==='hello'){state.delay=()=>callback(responseFor(request,'arcify',{ok:true,extensionId:PEER,snapshot:snapshot(),capabilities:[ROUTED_OPEN_FEATURE]}));return;}
  if(request.command==='openRoutedTab'&&state.missing)return;
  callback(responseFor(request,'arcify',{ok:true,extensionId:PEER,snapshot:snapshot(),capabilities:state.old?[]:[ROUTED_OPEN_FEATURE],...(request.command==='openRoutedTab'?{tabId:8,transientWindowId:3}:{})}));
 })},storage:{local:{get:async()=>({arcifyBridgePeerId:state.peer,arcifyBridgePairingGeneration:state.generation})},onChanged:event()},
 tabs:{get:vi.fn(async()=>structuredClone(tab)),create:vi.fn(),update:vi.fn()},windows:{get:async()=>({id:2,type:'normal',incognito:false,focused:true}),onRemoved:event()},search:{query:vi.fn()}};
 for(const name of ['onUpdated','onRemoved','onDetached','onReplaced','onActivated'])api.tabs[name]=event();
 vi.stubGlobal('chrome',api);const capture=createRoutedSourceCapture(api),bridge=new ArcifyBridgeClient(api,20);
 return {api,sender,state,tab,capture,bridge};
}
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
it('actual router/client negotiates and sends one exact attested source, without optional documentId',async()=>{
 const f=fixture(),routing=f.capture(result,'new-tab',f.sender);const value=await handleBridgeResult(f.bridge,f.api,result,'new-tab',{tabId:7,windowId:2,routing});
 expect(value.command).toBe('openRoutedTab');expect(f.state.commands.map(r=>r.command)).toEqual(['hello','openRoutedTab']);
 expect(f.state.commands[1].source).toEqual(routing.source);expect(f.api.tabs.create).not.toHaveBeenCalled();routing.dispose();
});
it('old peer rejection of capability never dispatches a mutation or falls back',async()=>{
 const f=fixture();f.state.old=true;const routing=f.capture(result,'new-tab',f.sender);
 await expect(handleBridgeResult(f.bridge,f.api,result,'new-tab',{tabId:7,windowId:2,routing})).rejects.toMatchObject({code:'UNSUPPORTED'});
 expect(f.state.commands.every(r=>r.command==='hello')).toBe(true);expect(f.api.tabs.create).not.toHaveBeenCalled();routing.dispose();
});
it('same URL navigation during handshake invalidates source before mutation',async()=>{
 const f=fixture();f.bridge.timeoutMs=1000;f.state.delay=true;const routing=f.capture(result,'new-tab',f.sender);
 const pending=handleBridgeResult(f.bridge,f.api,result,'new-tab',{tabId:7,windowId:2,routing}).catch(e=>e);
 await vi.waitFor(()=>expect(typeof f.state.delay).toBe('function'));f.api.tabs.onUpdated.fire(7,{status:'loading'});f.state.delay();
 expect(await pending).toMatchObject({code:'STALE_ROUTING_SOURCE'});expect(f.state.commands.every(r=>r.command==='hello')).toBe(true);routing.dispose();
});
it.each([{frameId:1},{documentLifecycle:'cached'},{id:PEER},{url:'https://another.test/'},{tab:undefined},{origin:'https://evil.test'}])('refuses forged/missing browser source %j',patch=>{
 const f=fixture();expect(()=>f.capture(result,'new-tab',{...f.sender,...patch})).toThrow();expect(f.state.commands).toEqual([]);
});
it('duplicate intake is claimed synchronously, then disposed grants reject liveness checks',async()=>{
 const f=fixture(),guard=f.capture(result,'new-tab',f.sender);expect(()=>f.capture(result,'new-tab',f.sender)).toThrow(/pending/);
 const message={type:'arcify-routed-source',...guard.source,windowId:2};expect(await f.capture.verify(message)).toEqual({live:true});guard.dispose();await expect(f.capture.verify(message)).rejects.toThrow();
});
it('only paired background may validate the live original source and extra flags fail',async()=>{
 const f=fixture(),guard=f.capture(result,'new-tab',f.sender);installRoutedSourceValidation(f.api,f.bridge,f.capture);
 const message={type:'arcify-routed-source',...guard.source,windowId:2};const query=(m,sender)=>new Promise(resolve=>f.api.runtime.onMessageExternal.fire(m,sender,resolve));
 expect(await query(message,{id:PEER})).toEqual({live:true});expect(await query(message,{id:PEER,url:'https://untrusted.test/'})).toEqual({live:false});
 expect(await query({...message,owned:true},{id:PEER})).toEqual({live:false});f.api.tabs.onUpdated.fire(7,{status:'loading'});expect(await query(message,{id:PEER})).toEqual({live:false});guard.dispose();
});
it('pending mutation timeout never replays or opens via native fallback',async()=>{
 vi.useFakeTimers();const f=fixture();f.state.missing=true;const routing=f.capture(result,'new-tab',f.sender);
 const pending=handleBridgeResult(f.bridge,f.api,result,'new-tab',{tabId:7,windowId:2,routing}).catch(e=>e);await vi.advanceTimersByTimeAsync(21);
 expect(await pending).toMatchObject({code:'TIMEOUT'});expect(f.state.commands.filter(r=>r.command==='openRoutedTab')).toHaveLength(1);expect(f.api.tabs.create).not.toHaveBeenCalled();routing.dispose();
});
it('packaged helper, search, saved results and current-tab navigation remain outside routing',()=>{
 const f=fixture();expect(f.capture(result,'new-tab',{...f.sender,url:f.api.runtime.getURL('newtab.html')})).toBeNull();
 for(const [r,mode] of [[result,'current-tab'],[{type:'search-query',metadata:{query:'hello'}},'new-tab'],[{type:'bookmark',url:'https://saved.test/'},'new-tab'],[{...result,metadata:{arcifyBridge:{kind:'favorite'}}},'new-tab'],[{...result,url:'chrome://settings/'},'new-tab']])expect(isRoutedUrlSubmission(r,mode)).toBe(false);
});
it('source pin is only preliminary evidence; Arcify alone determines a proven global Favorite',async()=>{
 const f=fixture();f.tab.pinned=true;f.sender.tab.pinned=true;const guard=f.capture(result,'new-tab',f.sender);await expect(guard.check()).resolves.toMatchObject({tabId:7});guard.dispose();
});
