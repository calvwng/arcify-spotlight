// @vitest-environment jsdom
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import {installLittleArcHeaderBroker} from '../../shared/little-arc-header-broker.js';
import {installLittleArcHeaderContent} from '../../shared/little-arc-header-content.js';
import {installLittleArcHeaderFrame} from '../../shared/little-arc-header-frame.js';
import {HEADER_TOP_PORT,HEADER_FRAME_PORT,HEADER_PAGE,validateHeaderContext} from '../../shared/little-arc-header-protocol.js';
import {transientUrlFromQuery} from '../../shared/arcify-transient-actions-ui.js';
const SELF='a'.repeat(32),PEER='b'.repeat(32),NONCE='11111111-1111-4111-8111-111111111111';
const event=()=>{const listeners=new Set();return {addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn),emit:(...args)=>Promise.all([...listeners].map(fn=>fn(...args)))};};
const context=()=>({viewId:NONCE,windows:[{id:10,title:'Window 10'}],spaces:[{id:'a',bookmarkFolderId:'fa',name:'Home'}],proposed:{windowId:10,spaceId:'a',bookmarkFolderId:'fa'}});
function fixture(){
 const source={id:3,windowId:20,url:'https://page.test/',incognito:false,active:true};
 const storage={arcifyBridgePeerId:PEER,arcifyBridgePairingGeneration:'g'},sessionData={};
 const api={runtime:{id:SELF,getURL:p=>`chrome-extension://${SELF}/${p}`,onConnect:event(),onMessage:event(),onMessageExternal:event(),sendMessage:vi.fn(async(_peer,request)=>request.action==='inspect'?{success:true,context:context()}:{success:true,reviewReady:true})},storage:{local:{get:async()=>structuredClone(storage)},session:{get:async()=>structuredClone(sessionData),set:async v=>Object.assign(sessionData,structuredClone(v))},onChanged:event()},
 tabs:{get:async()=>structuredClone(source),sendMessage:vi.fn(async()=>{}),onUpdated:event(),onRemoved:event(),onAttached:event(),onDetached:event(),onReplaced:event()},windows:{get:async()=>({id:20,type:'normal',incognito:false,focused:true}),onRemoved:event()}};
 const broker=installLittleArcHeaderBroker(api);const ports=[];
 const port=(name,sender)=>{let closed=false;const p={name,sender,onMessage:event(),onDisconnect:event(),postMessage:vi.fn(),disconnect:vi.fn(()=>{if(closed)return;closed=true;void p.onDisconnect.emit();})};ports.push(p);return p;};
 const top=()=>port(HEADER_TOP_PORT,{id:SELF,frameId:0,url:source.url,origin:'https://page.test',tab:{...source}});
 const frame=()=>port(HEADER_FRAME_PORT,{id:SELF,frameId:4,url:api.runtime.getURL(HEADER_PAGE),origin:`chrome-extension://${SELF}`,tab:{...source}});
 const mount=async()=>{const t=top();await api.runtime.onConnect.emit(t);await t.onMessage.emit({kind:'hello'});return t;};
 const bind=async t=>{const nonce=t.postMessage.mock.calls.find(([m])=>m.kind==='mount')[0].challenge;const f=frame();await api.runtime.onConnect.emit(f);await f.onMessage.emit({kind:'bind',challenge:nonce});return f;};
 return {api,broker,source,storage,sessionData,port,top,frame,mount,bind,dispose:()=>broker.dispose()};
}
let cleanups=[];afterEach(()=>{cleanups.splice(0).forEach(fn=>fn());document.body.replaceChildren();vi.restoreAllMocks();vi.useRealTimers();});
it('attested top frame and private challenge bind extension frame without documentId',async()=>{const f=fixture();cleanups.push(f.dispose);const t=await f.mount(),frame=await f.bind(t);expect(frame.postMessage).toHaveBeenCalledWith({kind:'context',context:{...context(),siteHostname:'page.test'}});expect(t.postMessage.mock.calls.every(([m])=>!Object.hasOwn(m,'context'))).toBe(true);expect(f.api.runtime.sendMessage.mock.calls[0][1].source).toEqual({tabId:3,windowId:20,url:'https://page.test/'});});
for(const bad of ['web','otherExtension','childContent','tabMismatch','windowMismatch','wrongPage','wrongOrigin'])it(`rejects ${bad} source/frame spoof`,async()=>{const f=fixture();cleanups.push(f.dispose);if(['web','otherExtension','childContent'].includes(bad)){const p=f.top();if(bad==='web')p.sender.id=undefined;if(bad==='otherExtension')p.sender.id=PEER;if(bad==='childContent')p.sender.frameId=5;await f.api.runtime.onConnect.emit(p);expect(p.disconnect).toHaveBeenCalled();expect(f.api.runtime.sendMessage).not.toHaveBeenCalled();return;}const t=await f.mount(),p=f.frame(),nonce=t.postMessage.mock.calls[0][0].challenge;if(bad==='tabMismatch')p.sender.tab.id=8;if(bad==='windowMismatch')p.sender.tab.windowId=99;if(bad==='wrongPage')p.sender.url=f.api.runtime.getURL('options.html');if(bad==='wrongOrigin')p.sender.origin='https://evil.test';await f.api.runtime.onConnect.emit(p);if(!p.disconnect.mock.calls.length)await p.onMessage.emit({kind:'bind',challenge:nonce});expect(p.disconnect).toHaveBeenCalled();});
it('challenge cannot replay or bind a second iframe',async()=>{const f=fixture();cleanups.push(f.dispose);const t=await f.mount();await f.bind(t);const p=f.frame();await f.api.runtime.onConnect.emit(p);await p.onMessage.emit({kind:'bind',challenge:t.postMessage.mock.calls[0][0].challenge});expect(p.disconnect).toHaveBeenCalled();});
it('only reviews target once; never exposes promote or page mutation commands',async()=>{const f=fixture();cleanups.push(f.dispose);const frame=await f.bind(await f.mount());await frame.onMessage.emit({kind:'review',target:context().proposed});await frame.onMessage.emit({kind:'review',target:context().proposed});expect(f.api.runtime.sendMessage.mock.calls.filter(([,r])=>r.action==='review')).toHaveLength(1);expect(frame.postMessage).toHaveBeenCalledWith({kind:'reviewReady'});await frame.onMessage.emit({kind:'promote',target:context().proposed});expect(f.api.runtime.sendMessage.mock.calls.some(([,r])=>r.action==='promote')).toBe(false);});
it('refresh prepares fresh authority after review; target/window substitutions rejected',async()=>{const f=fixture();cleanups.push(f.dispose);const frame=await f.bind(await f.mount());await frame.onMessage.emit({kind:'review',target:{...context().proposed,bookmarkFolderId:'wrong'}});expect(f.api.runtime.sendMessage.mock.calls.some(([,r])=>r.action==='review')).toBe(false);await frame.onMessage.emit({kind:'refresh'});await frame.onMessage.emit({kind:'review',target:null});expect(f.api.runtime.sendMessage.mock.calls.filter(([,r])=>r.action==='review')).toHaveLength(1);});
for(const kind of ['navigate','pending','pin','split','removed','detached','replacement','pairing','disconnect'])it(`retires authority after ${kind}`,async()=>{const f=fixture();cleanups.push(f.dispose);const top=await f.mount(),frame=await f.bind(top);if(kind==='navigate'){f.source.url='https://new.test/';await f.api.tabs.onUpdated.emit(3,{url:f.source.url});expect(f.api.tabs.sendMessage).toHaveBeenCalledWith(3,{type:'littleArcHeaderRefresh'},{frameId:0});}if(kind==='pending')await f.api.tabs.onUpdated.emit(3,{pendingUrl:'https://other.test/'});if(kind==='pin')await f.api.tabs.onUpdated.emit(3,{pinned:true});if(kind==='split')await f.api.tabs.onUpdated.emit(3,{splitViewId:0});if(kind==='removed')await f.api.tabs.onRemoved.emit(3);if(kind==='detached')await f.api.tabs.onDetached.emit(3);if(kind==='replacement')await f.api.tabs.onReplaced.emit(9,3);if(kind==='pairing'){f.storage.arcifyBridgePairingGeneration='new';await f.api.storage.onChanged.emit({arcifyBridgePairingGeneration:{}},'local');}if(kind==='disconnect')top.disconnect();expect(frame.disconnect).toHaveBeenCalled();await frame.onMessage.emit({kind:'review',target:context().proposed});expect(f.api.runtime.sendMessage.mock.calls.some(([,r])=>r.action==='review')).toBe(false);});
it('ordinary/untracked or old peer leaves fallback, no header mount',async()=>{const f=fixture();cleanups.push(f.dispose);f.api.runtime.sendMessage.mockResolvedValue({success:true,context:null});const top=await f.mount();expect(top.postMessage).toHaveBeenCalledWith({kind:'untracked'});expect(f.broker.sessions.size).toBe(0);});
it('navigation during awaited inspect cannot mount late response',async()=>{const f=fixture();cleanups.push(f.dispose);let finish;f.api.runtime.sendMessage.mockImplementation(()=>new Promise(r=>finish=r));const top=f.top();await f.api.runtime.onConnect.emit(top);const work=top.onMessage.emit({kind:'hello'});for(let i=0;i<15;i++)await Promise.resolve();await f.api.tabs.onUpdated.emit(3,{url:'https://other.test/'});finish({success:true,context:context()});await work;expect(top.postMessage.mock.calls.some(([m])=>m.kind==='mount')).toBe(false);});
it('malformed or conflicting metadata is rejected before frame presentation',()=>{for(const change of [c=>c.windows.push(c.windows[0]),c=>c.spaces[0].bookmarkFolderId='',c=>c.proposed.windowId=99,c=>c.viewId='bad']){const c=context();change(c);expect(()=>validateHeaderContext(c)).toThrow();}});
it.each(['little arc google.com','Little Arc example.com/path?q=one#two','little arc sub.example.co.uk/a'])('normalizes explicit bare domain %s visibly as complete URL',q=>{expect(transientUrlFromQuery(q)).toBe(`https://${q.replace(/^little\s+arc\s+/i,'')}`);});
it.each(['google.com','little arc search for things','little arc localhost','little arc 127.0.0.1','little arc example.com:443','little arc https:example.com','little arc user@example.com','little arc example.com\\evil','little arc example.com/has space'])('rejects ambiguous input %s',q=>expect(transientUrlFromQuery(q)).toBeNull());
it('automatic content mounts once, keeps secret out of DOM, hides fullscreen and resumes BFCache',async()=>{
 const f=fixture();cleanups.push(f.dispose);const ports=[];f.api.runtime.connect=vi.fn(()=>{const p=f.port(HEADER_TOP_PORT,{});ports.push(p);return p;});
 const fakeWindow={top:null,location:{href:'https://page.test/'},MutationObserver:window.MutationObserver,addEventListener:window.addEventListener.bind(window),removeEventListener:window.removeEventListener.bind(window)};fakeWindow.top=fakeWindow;
 const content=installLittleArcHeaderContent({api:f.api,document,window:fakeWindow});cleanups.push(()=>content.dispose());expect(installLittleArcHeaderContent({api:f.api,document,window:fakeWindow})).toBe(content);
 await ports[0].onMessage.emit({kind:'mount',challenge:NONCE});expect(document.querySelectorAll('#arcify-little-arc-header-host')).toHaveLength(1);expect(document.getElementById('arcify-little-arc-header-host').style.getPropertyPriority('height')).toBe('important');expect(document.body.innerHTML).not.toContain(NONCE);
 Object.defineProperty(document,'fullscreenElement',{configurable:true,value:document.documentElement});document.dispatchEvent(new Event('fullscreenchange'));expect(document.getElementById('arcify-little-arc-header-host').style.display).toBe('none');Object.defineProperty(document,'fullscreenElement',{configurable:true,value:null});document.dispatchEvent(new Event('fullscreenchange'));
 window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));expect(document.getElementById('arcify-little-arc-header-host')).toBeNull();window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));expect(ports).toHaveLength(2);
});
it('content ignores page spoof refresh; disposal removes injected UI',async()=>{const f=fixture();cleanups.push(f.dispose);const p=f.port(HEADER_TOP_PORT,{});f.api.runtime.connect=vi.fn(()=>p);const w={top:null,location:{href:'https://page.test/'},addEventListener(){},removeEventListener(){}};w.top=w;const content=installLittleArcHeaderContent({api:f.api,document,window:w});await p.onMessage.emit({kind:'mount',challenge:NONCE});await f.api.runtime.onMessage.emit({type:'littleArcHeaderRefresh'},{id:PEER});expect(f.api.runtime.connect).toHaveBeenCalledTimes(1);content.dispose();expect(document.getElementById('arcify-little-arc-header-host')).toBeNull();});

it('complete extension-frame form only stages review, refreshes after return, dismisses/reopens accessibly',async()=>{
 document.body.innerHTML='<main id="header"><div id="expanded"><form id="choices"><select id="window"></select><select id="space"></select><button id="review"></button></form><button id="controls"></button><button id="refresh"></button><button id="dismiss"></button><p id="status" role="status"></p></div><button id="reopen" hidden></button></main>';
 const f=fixture();cleanups.push(f.dispose);const frame=f.port(HEADER_FRAME_PORT,{});f.api.runtime.connect=vi.fn(()=>frame);const handlers=new Map(),messages=new Map();
 for(const id of ['choices','space','window','controls','refresh','dismiss','reopen']){const element=document.getElementById(id),original=element.addEventListener.bind(element);element.addEventListener=(type,callback)=>{handlers.set(`${id}:${type}`,callback);original(type,callback);};}
 const fakeWindow={parent:{},addEventListener:(type,callback)=>messages.set(type,callback),removeEventListener:type=>messages.delete(type)};
 const ui=installLittleArcHeaderFrame({api:f.api,document,window:fakeWindow});cleanups.push(()=>ui.dispose());
 messages.get('message')({source:{},data:{kind:'littleArcHeaderBootstrap',challenge:NONCE}});expect(f.api.runtime.connect).not.toHaveBeenCalled();
 messages.get('message')({source:fakeWindow.parent,data:{kind:'littleArcHeaderBootstrap',challenge:NONCE,collapsed:true}});expect(document.getElementById('expanded').hidden).toBe(true);expect(document.getElementById('reopen').hidden).toBe(false);expect(frame.postMessage).toHaveBeenCalledWith({kind:'bind',challenge:NONCE});await frame.onMessage.emit({kind:'context',context:context()});
 handlers.get('reopen:click')({isTrusted:true});expect(document.getElementById('expanded').hidden).toBe(false);expect(document.getElementById('space').value).toBe('a');expect(document.getElementById('window').value).toBe('10');expect(document.getElementById('review').textContent).toBe('Review for Home');
 handlers.get('choices:submit')({isTrusted:false,preventDefault(){}});expect(frame.postMessage.mock.calls.some(([m])=>m.kind==='review')).toBe(false);
 handlers.get('choices:submit')({isTrusted:true,preventDefault(){}});expect(frame.postMessage).toHaveBeenCalledWith({kind:'review',target:context().proposed});expect(document.getElementById('refresh').disabled).toBe(true);
 await frame.onMessage.emit({kind:'reviewReady'});expect(document.getElementById('refresh').disabled).toBe(false);expect(document.getElementById('review').disabled).toBe(true);
 handlers.get('refresh:click')({isTrusted:true});expect(frame.postMessage).toHaveBeenCalledWith({kind:'refresh'});await frame.onMessage.emit({kind:'context',context:context()});expect(document.getElementById('review').disabled).toBe(false);
 handlers.get('dismiss:click')({isTrusted:true});expect(document.getElementById('expanded').hidden).toBe(true);expect(document.getElementById('reopen').hidden).toBe(false);expect(frame.postMessage).toHaveBeenCalledWith({kind:'resize',collapsed:true,advanced:false,height:28});
 handlers.get('reopen:click')({isTrusted:true});expect(document.getElementById('expanded').hidden).toBe(false);expect(document.activeElement).toBe(document.getElementById('space'));expect(frame.postMessage.mock.calls.some(([m])=>m.kind==='promote')).toBe(false);
});
it('unexpected worker disconnect reconnects read-only at most twice, explicit untracked stops',async()=>{
 vi.useFakeTimers();const f=fixture();cleanups.push(f.dispose);const ports=[];f.api.runtime.connect=vi.fn(()=>{const p=f.port(HEADER_TOP_PORT,{});ports.push(p);return p;});const w={top:null,location:{href:'https://page.test/'},addEventListener(){},removeEventListener(){}};w.top=w;
 const content=installLittleArcHeaderContent({api:f.api,document,window:w});cleanups.push(()=>content.dispose());ports[0].disconnect();await vi.advanceTimersByTimeAsync(500);expect(ports).toHaveLength(2);ports[1].disconnect();await vi.advanceTimersByTimeAsync(1000);expect(ports).toHaveLength(3);ports[2].disconnect();await vi.advanceTimersByTimeAsync(5000);expect(ports).toHaveLength(3);content.dispose();vi.useRealTimers();
 const fresh=installLittleArcHeaderContent({api:f.api,document,window:w});cleanups.push(()=>fresh.dispose());const p=ports.at(-1);await p.onMessage.emit({kind:'untracked'});expect(f.api.runtime.sendMessage).not.toHaveBeenCalled();
});

it('dismissed presentation is carried privately into remounted frame after worker reconnect',async()=>{
 vi.useFakeTimers();const f=fixture();cleanups.push(f.dispose);const ports=[],frames=[];const create=document.createElement.bind(document);vi.spyOn(document,'createElement').mockImplementation((name,...args)=>{const node=create(name,...args);if(name==='iframe'){Object.defineProperty(node,'contentWindow',{value:{postMessage:vi.fn()}});frames.push(node);}return node;});
 f.api.runtime.connect=vi.fn(()=>{const p=f.port(HEADER_TOP_PORT,{});ports.push(p);return p;});const w={top:null,location:{href:'https://page.test/'},addEventListener(){},removeEventListener(){}};w.top=w;
 const content=installLittleArcHeaderContent({api:f.api,document,window:w});cleanups.push(()=>content.dispose());await ports[0].onMessage.emit({kind:'mount',challenge:NONCE});await ports[0].onMessage.emit({kind:'resize',collapsed:true,advanced:false,height:28});ports[0].disconnect();await vi.advanceTimersByTimeAsync(500);await ports[1].onMessage.emit({kind:'mount',challenge:NONCE});
 const frame=frames.at(-1),send=frame.contentWindow.postMessage;frame.dispatchEvent(new Event('load'));expect(send).toHaveBeenCalledWith({kind:'littleArcHeaderBootstrap',challenge:NONCE,collapsed:true,advanced:false},`chrome-extension://${SELF}`);expect(document.getElementById('arcify-little-arc-header-host').style.height).toBe('28px');
 content.dispose();vi.useRealTimers();
});

it('blocked/unbound iframe removes empty host without mutation or automatic retry',async()=>{
 vi.useFakeTimers();const f=fixture();cleanups.push(f.dispose);const ports=[];f.api.runtime.connect=vi.fn(()=>{const p=f.port(HEADER_TOP_PORT,{});ports.push(p);return p;});const w={top:null,location:{href:'https://page.test/'},addEventListener(){},removeEventListener(){}};w.top=w;
 const content=installLittleArcHeaderContent({api:f.api,document,window:w});cleanups.push(()=>content.dispose());await ports[0].onMessage.emit({kind:'mount',challenge:NONCE});await vi.advanceTimersByTimeAsync(4000);expect(document.getElementById('arcify-little-arc-header-host')).toBeNull();await vi.advanceTimersByTimeAsync(10000);expect(ports).toHaveLength(1);expect(f.api.runtime.sendMessage).not.toHaveBeenCalled();content.dispose();vi.useRealTimers();
});
it('bound acknowledgement cancels fallback timeout and leaves controller overlay available',async()=>{
 vi.useFakeTimers();const f=fixture();cleanups.push(f.dispose);const p=f.port(HEADER_TOP_PORT,{});f.api.runtime.connect=vi.fn(()=>p);const w={top:null,location:{href:'https://page.test/'},addEventListener(){},removeEventListener(){}};w.top=w;
 const content=installLittleArcHeaderContent({api:f.api,document,window:w});cleanups.push(()=>content.dispose());await p.onMessage.emit({kind:'mount',challenge:NONCE});await p.onMessage.emit({kind:'bound'});await vi.advanceTimersByTimeAsync(10000);expect(document.getElementById('arcify-little-arc-header-host')).not.toBeNull();content.dispose();vi.useRealTimers();
});

async function compactFixture(value=context()){
 const {readFileSync}=await import('node:fs');document.body.innerHTML=readFileSync('little-arc-header.html','utf8');
 const f=fixture();cleanups.push(f.dispose);const frame=f.port(HEADER_FRAME_PORT,{});f.api.runtime.connect=vi.fn(()=>frame);const handlers=new Map(),messages=new Map();
 for(const id of ['choices','space','window','controls','refresh','dismiss','reopen','more','space-menu-toggle','space-search']){const node=document.getElementById(id),original=node.addEventListener.bind(node);node.addEventListener=(type,handler)=>{handlers.set(`${id}:${type}`,handler);original(type,handler);};}
 const w={parent:{},addEventListener:(type,handler)=>messages.set(type,handler),removeEventListener:type=>messages.delete(type)};
 const ui=installLittleArcHeaderFrame({api:f.api,document,window:w});cleanups.push(()=>ui.dispose());messages.get('message')({source:w.parent,data:{kind:'littleArcHeaderBootstrap',challenge:NONCE}});await frame.onMessage.emit({kind:'context',context:value});
 return {...f,frame,handlers,click:id=>handlers.get(`${id}:click`)({isTrusted:true})};
}
it('production compact markup hides advanced controls, toggles repeatedly without review and preserves exact destination',async()=>{
 const c=context();c.windows.push({id:987654321,title:'Window 987654321'});const f=await compactFixture(c),more=document.getElementById('more'),advanced=document.getElementById('advanced');expect(advanced.hidden).toBe(true);expect(more.getAttribute('aria-expanded')).toBe('false');expect(advanced.contains(document.getElementById('window'))).toBe(true);expect(advanced.contains(document.getElementById('refresh'))).toBe(true);expect(advanced.contains(document.getElementById('controls'))).toBe(true);
 expect([...document.getElementById('window').options].map(o=>o.textContent)).toEqual(['Choose...','Originating window','Window 2']);expect(document.getElementById('window').value).toBe('10');
 for(let i=0;i<4;i++){f.click('more');expect(advanced.hidden).toBe(false);expect(more.getAttribute('aria-expanded')).toBe('true');document.getElementById('window').focus();f.click('more');expect(advanced.hidden).toBe(true);expect(document.activeElement).toBe(more);}
 expect(f.frame.postMessage.mock.calls.some(([m])=>m.kind==='review')).toBe(false);f.handlers.get('choices:submit')({isTrusted:true,preventDefault(){}});expect(f.frame.postMessage).toHaveBeenCalledWith({kind:'review',target:c.proposed});
});
it('missing proposed window exposes advanced choice context without automatically choosing a destination',async()=>{
 const c=context();c.proposed=null;const f=await compactFixture(c);expect(document.getElementById('advanced').hidden).toBe(false);expect(document.getElementById('review').disabled).toBe(true);expect(document.getElementById('window').value).toBe('');expect(document.getElementById('status').textContent).toContain('Choose a destination window');expect(f.frame.postMessage.mock.calls.some(([m])=>m.kind==='review')).toBe(false);
});
it('critical error is outside advanced, reveals dismissed header and retains explicit refresh recovery',async()=>{
 const f=await compactFixture();f.click('dismiss');expect(document.getElementById('expanded').hidden).toBe(true);await f.frame.onMessage.emit({kind:'error',message:'Destination changed. Nothing moved.'});expect(document.getElementById('expanded').hidden).toBe(false);expect(document.getElementById('advanced').hidden).toBe(true);expect(document.getElementById('advanced').contains(document.getElementById('status'))).toBe(false);expect(document.getElementById('status').textContent).toContain('Nothing moved');expect(document.getElementById('review').disabled).toBe(true);f.click('more');expect(document.getElementById('refresh').disabled).toBe(false);f.click('refresh');expect(f.frame.postMessage).toHaveBeenCalledWith({kind:'refresh'});await f.frame.onMessage.emit({kind:'context',context:context()});expect(document.getElementById('review').disabled).toBe(false);
});
it('More presentation survives collapse/reopen without granting any action authority',async()=>{
 const f=await compactFixture();f.click('more');f.click('dismiss');f.click('reopen');expect(document.getElementById('advanced').hidden).toBe(false);expect(document.activeElement.id).toBe('space-menu-toggle');expect(f.frame.postMessage.mock.calls.some(([m])=>m.kind==='review'||m.kind==='promote')).toBe(false);
});
it('authenticated resize accepts only boolean advanced presentation and cannot dispatch review',async()=>{
 const f=fixture();cleanups.push(f.dispose);const top=await f.mount(),frame=await f.bind(top);await frame.onMessage.emit({kind:'resize',collapsed:false,advanced:true,height:145});expect(top.postMessage).toHaveBeenCalledWith({kind:'resize',collapsed:false,advanced:true,height:145});const calls=f.api.runtime.sendMessage.mock.calls.length;await frame.onMessage.emit({kind:'resize',collapsed:false,advanced:'yes'});expect(f.api.runtime.sendMessage).toHaveBeenCalledTimes(calls);expect(frame.postMessage).toHaveBeenCalledWith(expect.objectContaining({kind:'error'}));
});


async function directFixture(){
 const f=fixture();cleanups.push(f.dispose);
 f.api.runtime.sendMessage.mockImplementation(async(_peer,request)=>{
  if(request.action==='inspect')return {success:true,context:{...context(),directEnabled:true}};
  if(request.action==='directPrepare')return {success:true,authorization:NONCE,expiresInMs:15000};
  if(request.action==='directRevoke')return {success:true,revoked:true};
  if(request.action==='directPlace')return {success:true,phase:'committed',tabId:3,windowId:10,spaceId:'a',focused:true,controllerClosed:true};
  return {success:true,reviewReady:true};
 });
 const top=await f.mount(),frame=await f.bind(top);
 const challenge=top.postMessage.mock.calls.find(([m])=>m.kind==='mount')[0].challenge;
 f.api.tabs.sendMessage.mockResolvedValue({challenge,safe:true,url:f.source.url});
 await top.onMessage.emit({kind:'presentation',safe:true});
 return {...f,top,frame,challenge};
}
it('size settings uses authenticated one-use controller route without preferences or placement',async()=>{const f=fixture();cleanups.push(f.dispose);const frame=await f.bind(await f.mount());await frame.onMessage.emit({kind:'sizeSettings'});await frame.onMessage.emit({kind:'sizeSettings'});const calls=f.api.runtime.sendMessage.mock.calls.filter(([,r])=>r.action==='settings');expect(calls).toHaveLength(1);expect(Object.keys(calls[0][1]).sort()).toEqual(['action','source','type','viewId']);expect(f.api.runtime.sendMessage.mock.calls.some(([,r])=>r.action==='directPlace')).toBe(false);});
it('rogue settings properties do not enter privileged route',async()=>{const f=fixture();cleanups.push(f.dispose);const frame=await f.bind(await f.mount());await frame.onMessage.emit({kind:'sizeSettings',enabled:true});expect(f.api.runtime.sendMessage.mock.calls.some(([,r])=>r.action==='settings')).toBe(false);});

const flush=async()=>{for(let i=0;i<80;i++)await Promise.resolve();};
it('idle selection has no grant; explicit Open prepares and dispatches once without frame token',async()=>{
 const f=await directFixture();vi.useFakeTimers();await vi.advanceTimersByTimeAsync(60000);
 await f.top.onMessage.emit({kind:'presentation',safe:true});
 expect(f.api.runtime.sendMessage.mock.calls.some(([,r])=>r.action==='directPrepare')).toBe(false);
 await f.frame.onMessage.emit({kind:'placeDirect',target:context().proposed});
 await f.frame.onMessage.emit({kind:'placeDirect',target:context().proposed});
 expect(f.api.runtime.sendMessage.mock.calls.filter(([,r])=>r.action==='directPrepare')).toHaveLength(1);
 expect(f.api.runtime.sendMessage.mock.calls.filter(([,r])=>r.action==='directPlace')).toHaveLength(1);
 expect(f.frame.postMessage.mock.calls.some(([m])=>JSON.stringify(m).includes('authorization'))).toBe(false);
});
it.each(['wrongWindow','wrongFolder','noOptIn','fullscreen','oldDocument','inactive','popupSource','disconnected','changedPair'])('click-time path rejects %s',async kind=>{
 const f=await directFixture();let target=context().proposed;
 if(kind==='wrongWindow')target={...target,windowId:999};if(kind==='wrongFolder')target={...target,bookmarkFolderId:'other'};
 if(kind==='noOptIn')f.broker.sessions.get(3).context.directEnabled=false;
 if(kind==='fullscreen')await f.top.onMessage.emit({kind:'presentation',safe:false});
 if(kind==='oldDocument')f.api.tabs.sendMessage.mockResolvedValue({challenge:'other',safe:true,url:f.source.url});
 if(kind==='inactive')f.source.active=false;if(kind==='popupSource')f.api.windows.get=async()=>({id:20,type:'popup',focused:true});
 if(kind==='disconnected')f.top.disconnect();if(kind==='changedPair')f.storage.arcifyBridgePairingGeneration='new';
 await f.frame.onMessage.emit({kind:'placeDirect',target});
 expect(f.api.runtime.sendMessage.mock.calls.some(([,r])=>r.action==='directPlace')).toBe(false);
});
it.each(['closedWindow','deletedSpace','reboundFolder','renamedSpace','disabledMode'])('fresh inspect rejects %s without silent substitute',async kind=>{
 const f=await directFixture(),send=f.api.runtime.sendMessage.getMockImplementation();
 f.api.runtime.sendMessage.mockImplementation(async(peer,r)=>{if(r.action!=='inspect')return send(peer,r);const c={...context(),directEnabled:true};if(kind==='closedWindow'){c.windows=[];c.proposed=null;}if(kind==='deletedSpace'){c.spaces=[];c.proposed=null;}if(kind==='reboundFolder'){c.spaces[0].bookmarkFolderId='new';c.proposed=null;}if(kind==='renamedSpace')c.spaces[0].name='New';if(kind==='disabledMode')c.directEnabled=false;return {success:true,context:c};});
 await f.frame.onMessage.emit({kind:'placeDirect',target:context().proposed});
 expect(f.api.runtime.sendMessage.mock.calls.some(([,r])=>r.action==='directPrepare'||r.action==='directPlace')).toBe(false);
});
it('synchronous intake claim discards a concurrent duplicate even when first validation fails',async()=>{
 const f=await directFixture(),send=f.api.runtime.sendMessage.getMockImplementation();let release;
 f.api.runtime.sendMessage.mockImplementation((peer,r)=>r.action==='inspect'?new Promise(resolve=>release=resolve):send(peer,r));
 const first=f.frame.onMessage.emit({kind:'placeDirect',target:context().proposed});const duplicate=f.frame.onMessage.emit({kind:'placeDirect',target:context().proposed});await flush();
 release({success:false});await first;await duplicate;
 expect(f.api.runtime.sendMessage.mock.calls.filter(([,r])=>r.action==='inspect')).toHaveLength(2);
 expect(f.api.runtime.sendMessage.mock.calls.some(([,r])=>r.action==='directPlace')).toBe(false);
});
it.each(['cancelDirect','refresh','navigation'])('queued %s invalidates awaited authorization before dispatch',async kind=>{
 const f=await directFixture(),send=f.api.runtime.sendMessage.getMockImplementation();let release;
 f.api.runtime.sendMessage.mockImplementation((peer,r)=>r.action==='directPrepare'?new Promise(resolve=>release=resolve):send(peer,r));
 const first=f.frame.onMessage.emit({kind:'placeDirect',target:context().proposed});await flush();expect(release).toBeTypeOf('function');
 const changed=kind==='navigation'?f.api.tabs.onUpdated.emit(3,{status:'loading'}):f.frame.onMessage.emit({kind});
 release({success:true,authorization:NONCE,expiresInMs:15000});await first;await changed;
 expect(f.api.runtime.sendMessage.mock.calls.some(([,r])=>r.action==='directPlace')).toBe(false);
});
it.each(['rejected','lostReply','invalidReceipt'])('post-dispatch %s remains locked through refresh and new connection',async kind=>{
 const f=await directFixture(),send=f.api.runtime.sendMessage.getMockImplementation();vi.useFakeTimers();
 f.api.runtime.sendMessage.mockImplementation((peer,r)=>{if(r.action!=='directPlace')return send(peer,r);if(kind==='lostReply')return new Promise(()=>{});if(kind==='rejected')throw Error('lost');return {success:true,phase:'uncertain',tabId:3};});
 const run=f.frame.onMessage.emit({kind:'placeDirect',target:context().proposed});await vi.advanceTimersByTimeAsync(5100);await run;
 expect(f.sessionData.littleArcHeaderDispatchV1['3']).toBeTruthy();
 await f.frame.onMessage.emit({kind:'refresh'});await f.frame.onMessage.emit({kind:'placeDirect',target:context().proposed});
 const nextTop=await f.mount(),next=await f.bind(nextTop);expect(next.postMessage).toHaveBeenCalledWith({kind:'placementLocked'});
 await next.onMessage.emit({kind:'placeDirect',target:context().proposed});
 expect(f.api.runtime.sendMessage.mock.calls.filter(([,r])=>r.action==='directPlace')).toHaveLength(1);
});
it('storage fence failure prevents send and remains fail-closed',async()=>{
 const f=await directFixture();f.api.storage.session.set=async()=>{throw Error('quota');};
 await f.frame.onMessage.emit({kind:'placeDirect',target:context().proposed});
 await f.frame.onMessage.emit({kind:'refresh'});
 expect(f.frame.postMessage).toHaveBeenCalledWith({kind:'placementLocked'});
 expect(f.api.runtime.sendMessage.mock.calls.some(([,r])=>r.action==='directPlace')).toBe(false);
});
it('confirmed commit after expected detach retires only its matching fence without retry',async()=>{
 const f=await directFixture(),send=f.api.runtime.sendMessage.getMockImplementation();
 f.api.runtime.sendMessage.mockImplementation(async(peer,r)=>{if(r.action==='directPlace')await f.api.tabs.onDetached.emit(3);return send(peer,r);});
 await f.frame.onMessage.emit({kind:'placeDirect',target:context().proposed});
 expect(f.frame.disconnect).toHaveBeenCalled();expect(f.sessionData.littleArcHeaderDispatchV1['3']).toBeUndefined();
});
it.each(['page','content','otherExtension','wrongConnection','wrongTarget'])('issuance rejects %s authority spoof',async kind=>{
 const f=await directFixture(),s=f.broker.sessions.get(3);s.preparing=context().proposed;
 const message={type:'littleArcDirectAuthorityV1',connection:s.connection,authorization:null,source:s.source,target:context().proposed};
 let sender={id:PEER};if(kind==='page')sender.url='https://evil.test';if(kind==='content')sender.tab={id:3};if(kind==='otherExtension')sender.id=SELF;if(kind==='wrongConnection')message.connection='forged';if(kind==='wrongTarget')message.target={...message.target,windowId:999};
 const result=await new Promise(resolve=>f.api.runtime.onMessageExternal.emit(message,sender,resolve));expect(result.authorized).toBe(false);
});
it('redemption requires current private proof, exact token and fresh presentation',async()=>{
 const f=await directFixture(),s=f.broker.sessions.get(3);s.executing=NONCE;s.grant={authorization:NONCE,expires:Date.now()+15000};
 const ask=()=>new Promise(resolve=>f.api.runtime.onMessageExternal.emit({type:'littleArcDirectAuthorityV1',connection:s.connection,authorization:NONCE,source:s.source},{id:PEER},resolve));
 expect((await ask()).authorized).toBe(true);
 f.api.tabs.sendMessage.mockImplementation(async()=>{await f.top.onMessage.emit({kind:'presentation',safe:false});return {challenge:f.challenge,safe:true,url:f.source.url};});
 expect((await ask()).authorized).toBe(false);
});
it('explicit alternate window and Space survive safe refresh without action or grant',async()=>{
 const c={...context(),directEnabled:true};c.windows.push({id:11,title:'other'});c.spaces.push({id:'b',bookmarkFolderId:'fb',name:'Work'});
 const f=await compactFixture(c);document.getElementById('window').value='11';f.handlers.get('window:change')();document.getElementById('space').value='b';f.handlers.get('space:change')();
 f.click('refresh');await f.frame.onMessage.emit({kind:'context',context:c});
 expect(document.getElementById('window').value).toBe('11');expect(document.getElementById('space').value).toBe('b');
 expect(f.frame.postMessage.mock.calls.some(([m])=>m.kind==='prepareDirect'||m.kind==='placeDirect')).toBe(false);
 vi.spyOn(document,'hasFocus').mockReturnValue(true);f.handlers.get('choices:submit')({isTrusted:true,preventDefault(){}});f.handlers.get('choices:submit')({isTrusted:true,preventDefault(){}});
 expect(f.frame.postMessage.mock.calls.filter(([m])=>m.kind==='placeDirect').map(([m])=>m.target)).toEqual([{windowId:11,spaceId:'b',bookmarkFolderId:'fb'}]);
});
it.each(['closed','rebound'])('invalid retained destination %s is blank, not launch suggestion',async kind=>{
 const c=context();c.windows.push({id:11,title:'other'});const f=await compactFixture(c);document.getElementById('window').value='11';f.handlers.get('window:change')();
 const next=structuredClone(c);if(kind==='closed')next.windows.pop();else{next.spaces[0].bookmarkFolderId='new';next.proposed={...next.proposed,bookmarkFolderId:'new'};}
 await f.frame.onMessage.emit({kind:'context',context:next});expect(document.getElementById('window').value).toBe('');expect(document.getElementById('review').disabled).toBe(true);expect(document.getElementById('status').textContent).toContain('changed or is unavailable');
});
it('UI idle, safe selection and collapse never authorize; synthetic/repeat activation rejected',async()=>{
 const f=await compactFixture({...context(),directEnabled:true});vi.useFakeTimers();await vi.advanceTimersByTimeAsync(60000);vi.spyOn(document,'hasFocus').mockReturnValue(true);
 expect(document.getElementById('review').disabled).toBe(false);
 f.click('dismiss');f.click('reopen');f.handlers.get('space:change')();
 for(const e of [{isTrusted:false},{isTrusted:true,repeat:true}])f.handlers.get('choices:submit')({...e,preventDefault(){}});
 expect(f.frame.postMessage.mock.calls.some(([m])=>['placeDirect','prepareDirect'].includes(m.kind))).toBe(false);
});
it('uncertainty remains visible with More closed and refresh never re-enables Open',async()=>{
 const f=await compactFixture({...context(),directEnabled:true});await f.frame.onMessage.emit({kind:'placementLocked'});f.click('refresh');await f.frame.onMessage.emit({kind:'context',context:{...context(),directEnabled:true}});
 expect(document.getElementById('review').disabled).toBe(true);expect(document.getElementById('controls').disabled).toBe(false);expect(document.getElementById('status').textContent).toContain('uncertain');expect(document.getElementById('advanced').hidden).toBe(true);
});
it.each([NaN,Infinity,-1,0,27,481,100000,'90',90.5])('authenticated sizing rejects invalid height %s',async height=>{
 const f=fixture();cleanups.push(f.dispose);const top=await f.mount(),frame=await f.bind(top);await frame.onMessage.emit({kind:'resize',collapsed:false,advanced:false,height});
 expect(top.postMessage.mock.calls.some(([m])=>m.kind==='resize')).toBe(false);
});
it('content clamps authenticated measurement to viewport, never trusts page sizing messages',async()=>{
 const f=fixture();cleanups.push(f.dispose);const p=f.port(HEADER_TOP_PORT,{});f.api.runtime.connect=vi.fn(()=>p);const w={top:null,innerHeight:200,location:{href:'https://page.test/'},addEventListener(){},removeEventListener(){}};w.top=w;
 const content=installLittleArcHeaderContent({api:f.api,document,window:w});cleanups.push(()=>content.dispose());await p.onMessage.emit({kind:'mount',challenge:NONCE});
 await p.onMessage.emit({kind:'resize',collapsed:false,advanced:true,height:400});expect(document.getElementById('arcify-little-arc-header-host').style.height).toBe('184px');
 await f.api.runtime.onMessage.emit({kind:'resize',height:99},{id:PEER});expect(document.getElementById('arcify-little-arc-header-host').style.height).toBe('184px');
});


it.each(['pairing','cancel'])('proven %s change before send releases only its own fence',async kind=>{
 const f=await directFixture(),original=f.api.storage.session.set;let cancel;
 f.api.storage.session.set=async data=>{await original(data);if(data.littleArcHeaderDispatchV1?.['3']){if(kind==='pairing')f.storage.arcifyBridgePairingGeneration='new';else cancel=f.frame.onMessage.emit({kind:'cancelDirect'});}};
 await f.frame.onMessage.emit({kind:'placeDirect',target:context().proposed});if(cancel)await cancel;
 expect(f.api.runtime.sendMessage.mock.calls.some(([,r])=>r.action==='directPlace')).toBe(false);expect(f.sessionData.littleArcHeaderDispatchV1?.['3']).toBeUndefined();
});
it('changed source during fresh inspect never authorizes',async()=>{
 const f=await directFixture(),send=f.api.runtime.sendMessage.getMockImplementation();
 f.api.runtime.sendMessage.mockImplementation(async(peer,r)=>{const result=await send(peer,r);if(r.action==='inspect')f.source.url='https://new.test';return result;});
 await f.frame.onMessage.emit({kind:'placeDirect',target:context().proposed});expect(f.api.runtime.sendMessage.mock.calls.some(([,r])=>r.action==='directPrepare')).toBe(false);
});
it('ResizeObserver measures natural header height after status and More changes',async()=>{
 const original=window.ResizeObserver;let notify;window.ResizeObserver=class{constructor(fn){notify=fn;}observe(){}disconnect(){}};
 // compactFixture uses its own window; inject through a separate full frame setup.
 const f=fixture();cleanups.push(f.dispose);const {readFileSync}=await import('node:fs');document.body.innerHTML=readFileSync('little-arc-header.html','utf8');
 const p=f.port(HEADER_FRAME_PORT,{});f.api.runtime.connect=()=>p;const messages={};const w={parent:{},ResizeObserver:window.ResizeObserver,addEventListener:(k,fn)=>messages[k]=fn,removeEventListener(){}};
 let height=67.2;document.getElementById('header').getBoundingClientRect=()=>({height});const ui=installLittleArcHeaderFrame({api:f.api,document,window:w});cleanups.push(()=>ui.dispose());
 messages.message({source:w.parent,data:{kind:'littleArcHeaderBootstrap',challenge:NONCE}});await p.onMessage.emit({kind:'context',context:context()});expect(p.postMessage).toHaveBeenCalledWith({kind:'resize',collapsed:false,advanced:false,height:68});
 height=145.3;notify();expect(p.postMessage).toHaveBeenCalledWith({kind:'resize',collapsed:false,advanced:false,height:146});height=900;notify();expect(p.postMessage).toHaveBeenCalledWith({kind:'resize',collapsed:false,advanced:false,height:480});window.ResizeObserver=original;
});
it('live proof refuses host clipped below authenticated measured geometry',async()=>{
 const f=fixture();cleanups.push(f.dispose);const p=f.port(HEADER_TOP_PORT,{});f.api.runtime.connect=()=>p;
 let rect={left:8,top:8,bottom:76,width:984,height:68};const w={top:null,innerWidth:1000,innerHeight:800,location:{href:'https://page.test/'},getComputedStyle:()=>({visibility:'visible',opacity:'1'}),addEventListener(){},removeEventListener(){}};w.top=w;
 vi.spyOn(document,'hasFocus').mockReturnValue(true);const content=installLittleArcHeaderContent({api:f.api,document,window:w});cleanups.push(()=>content.dispose());await p.onMessage.emit({kind:'mount',challenge:NONCE});await p.onMessage.emit({kind:'resize',collapsed:false,advanced:false,height:68});
 const host=document.getElementById('arcify-little-arc-header-host');host.getBoundingClientRect=()=>rect;document.elementFromPoint=()=>host;
 const proof=async()=>{let value;await f.api.runtime.onMessage.emit({type:'littleArcHeaderLiveProbe'},{id:SELF},v=>value=v);return value;};
 expect((await proof()).safe).toBe(true);rect={...rect,height:28,bottom:36};expect((await proof()).safe).toBe(false);
});

it('ordinary complete refresh preserves the exact host and pending connection',async()=>{const f=fixture();cleanups.push(f.dispose);const p=f.port(HEADER_TOP_PORT,{});f.api.runtime.connect=vi.fn(()=>p);const w={top:null,location:{href:'https://page.test/'},addEventListener(){},removeEventListener(){}};w.top=w;const c=installLittleArcHeaderContent({api:f.api,document,window:w});cleanups.push(()=>c.dispose());await p.onMessage.emit({kind:'mount',challenge:NONCE});const host=document.getElementById('arcify-little-arc-header-host');for(let i=0;i<3;i++)await f.api.runtime.onMessage.emit({type:'littleArcHeaderRefresh'},{id:SELF});expect(document.getElementById('arcify-little-arc-header-host')).toBe(host);expect(p.disconnect).not.toHaveBeenCalled();expect(f.api.runtime.connect).toHaveBeenCalledTimes(1);});
it('completion on healthy broker does not inspect again or retire current view',async()=>{const f=fixture();cleanups.push(f.dispose);const top=await f.mount(),frame=await f.bind(top);const before=f.api.runtime.sendMessage.mock.calls.length;await f.api.tabs.onUpdated.emit(3,{status:'complete'});expect(f.api.runtime.sendMessage.mock.calls.length).toBe(before);expect(top.disconnect).not.toHaveBeenCalled();expect(frame.disconnect).not.toHaveBeenCalled();});
it('domain is broker derived and malformed or extra domain metadata rejected',()=>{expect(validateHeaderContext({...context(),siteHostname:'example.test'}).siteHostname).toBe('example.test');for(const siteHostname of ['<img>','a/b','a b','',null])expect(()=>validateHeaderContext({...context(),siteHostname})).toThrow();});
it('Space colors accept only bounded hex data, never arbitrary style',()=>{const c=context();c.spaces[0].color='#aabbcc';expect(validateHeaderContext(c)).toBe(c);c.spaces[0].color='url(https://evil.test)';expect(()=>validateHeaderContext(c)).toThrow();});

it('search Enter selects exact Space without submitting review or placement',async()=>{const c=context();c.spaces.push({id:'b',bookmarkFolderId:'fb',name:'Research'});const f=await compactFixture(c);f.click('space-menu-toggle');expect(document.getElementById('space-picker').hidden).toBe(false);const search=document.getElementById('space-search');search.value='rese';f.handlers.get('space-search:input')();f.handlers.get('space-search:keydown')({isTrusted:true,key:'Enter',preventDefault(){},stopPropagation(){}});expect(document.getElementById('space').value).toBe('b');expect(document.getElementById('space-picker').hidden).toBe(true);expect(document.activeElement.id).toBe('space-menu-toggle');expect(f.frame.postMessage.mock.calls.some(([m])=>['review','placeDirect'].includes(m.kind))).toBe(false);});
it('picker Escape and zero results preserve exact selected identity',async()=>{const f=await compactFixture(context());f.click('space-menu-toggle');const search=document.getElementById('space-search');search.value='nothing';f.handlers.get('space-search:input')();f.handlers.get('space-search:keydown')({isTrusted:true,key:'Enter',preventDefault(){},stopPropagation(){}});expect(document.getElementById('space').value).toBe('a');f.handlers.get('space-search:keydown')({isTrusted:true,key:'Escape',preventDefault(){},stopPropagation(){}});expect(document.getElementById('space-picker').hidden).toBe(true);expect(f.frame.postMessage.mock.calls.some(([m])=>['review','placeDirect'].includes(m.kind))).toBe(false);});
it('routine hint is hidden but critical error stays visible with More closed',async()=>{const f=await compactFixture({...context(),siteHostname:'page.test'});expect(document.getElementById('domain').textContent).toBe('page.test');expect(document.getElementById('status').hidden).toBe(true);await f.frame.onMessage.emit({kind:'error',message:'Destination changed. Nothing moved.'});expect(document.getElementById('status').hidden).toBe(false);expect(document.getElementById('advanced').hidden).toBe(true);});

it('authenticated bound replenishes reconnect budget after readiness hint races disconnect',async()=>{vi.useFakeTimers();const f=fixture();cleanups.push(f.dispose);const ports=[];f.api.runtime.connect=vi.fn(()=>{const port=f.port(HEADER_TOP_PORT,{});ports.push(port);return port;});const w={top:null,location:{href:'https://page.test/'},addEventListener(){},removeEventListener(){}};w.top=w;const c=installLittleArcHeaderContent({api:f.api,document,window:w});cleanups.push(()=>c.dispose());for(let i=0;i<4;i++){const port=ports[i];await port.onMessage.emit({kind:'mount',challenge:NONCE});await port.onMessage.emit({kind:'bound'});const host=document.getElementById('arcify-little-arc-header-host');await f.api.runtime.onMessage.emit({type:'littleArcHeaderRefresh'},{id:SELF});expect(document.getElementById('arcify-little-arc-header-host')).toBe(host);port.disconnect();await vi.advanceTimersByTimeAsync(500);expect(ports.length).toBe(i+2);}});

it('early outside dismissal before frame bind is harmless and never grants authority',async()=>{
 const f=fixture();cleanups.push(f.dispose);const top=await f.mount();const before=f.api.runtime.sendMessage.mock.calls.length;
 await top.onMessage.emit({kind:'dismissPicker'});expect(top.disconnect).not.toHaveBeenCalled();const frame=await f.bind(top);
 await top.onMessage.emit({kind:'dismissPicker'});expect(frame.postMessage).toHaveBeenCalledWith({kind:'dismissPicker'});
 expect(f.api.runtime.sendMessage.mock.calls.length).toBe(before);expect(f.broker.sessions.get(3).grant).toBeFalsy();
});
it('dismissal remains scoped to current session and cannot contain destination or commands',async()=>{
 const f=fixture();cleanups.push(f.dispose);const top=await f.mount(),frame=await f.bind(top);
 await top.onMessage.emit({kind:'dismissPicker',target:context().proposed});expect(top.disconnect).toHaveBeenCalled();
 expect(frame.postMessage.mock.calls.some(([m])=>m.kind==='dismissPicker')).toBe(false);
 expect(f.api.runtime.sendMessage.mock.calls.some(([,r])=>r.action!=='inspect')).toBe(false);
});
it('old top session cannot dismiss a replacement header',async()=>{
 const f=fixture();cleanups.push(f.dispose);const old=await f.mount();await f.bind(old);const next=await f.mount(),frame=await f.bind(next);
 await old.onMessage.emit({kind:'dismissPicker'});expect(frame.postMessage.mock.calls.some(([m])=>m.kind==='dismissPicker')).toBe(false);
});
it('trusted outside pointer dismisses internally, not search/toggle/option or synthetic events',async()=>{
 let outside;const add=document.addEventListener.bind(document);vi.spyOn(document,'addEventListener').mockImplementation((type,fn,...args)=>{if(type==='pointerdown')outside=fn;return add(type,fn,...args);});
 const f=await compactFixture(context());f.click('space-menu-toggle');const picker=document.getElementById('space-picker');
 for(const target of [document.getElementById('space-search'),document.getElementById('space-menu-toggle'),picker.querySelector('button')]){outside({isTrusted:true,target});expect(picker.hidden).toBe(false);}
 outside({isTrusted:false,target:document.getElementById('domain')});expect(picker.hidden).toBe(false);
 outside({isTrusted:true,target:document.getElementById('domain')});expect(picker.hidden).toBe(true);expect(document.activeElement.id).toBe('space-menu-toggle');
 expect(document.getElementById('space').value).toBe('a');expect(f.frame.postMessage.mock.calls.some(([m])=>['review','placeDirect'].includes(m.kind))).toBe(false);
});
it('authenticated page dismissal closes only picker, retains selection and does not steal focus',async()=>{
 const f=await compactFixture({...context(),directEnabled:true});f.click('space-menu-toggle');
 await f.frame.onMessage.emit({kind:'dismissPicker',target:'spoof'});expect(document.getElementById('space-picker').hidden).toBe(false);
 await f.frame.onMessage.emit({kind:'dismissPicker'});expect(document.getElementById('space-picker').hidden).toBe(true);expect(document.activeElement.id).not.toBe('space-menu-toggle');
 for(let i=0;i<3;i++){f.click('space-menu-toggle');await f.frame.onMessage.emit({kind:'dismissPicker'});}
 expect(document.getElementById('space').value).toBe('a');expect(f.frame.postMessage.mock.calls.some(([m])=>['review','placeDirect'].includes(m.kind))).toBe(false);
});
it('page pointer forwarding is trusted, does not consume event, and cleans up on disposal',async()=>{
 let outside;const add=document.addEventListener.bind(document);vi.spyOn(document,'addEventListener').mockImplementation((type,fn,...args)=>{if(type==='pointerdown')outside=fn;return add(type,fn,...args);});
 const remove=vi.spyOn(document,'removeEventListener');const f=fixture();cleanups.push(f.dispose);const port=f.port(HEADER_TOP_PORT,{});f.api.runtime.connect=()=>port;
 const w={top:null,location:{href:'https://page.test/'},addEventListener(){},removeEventListener(){}};w.top=w;
 const c=installLittleArcHeaderContent({api:f.api,document,window:w});cleanups.push(()=>c.dispose());await port.onMessage.emit({kind:'mount',challenge:NONCE});
 const host=document.getElementById('arcify-little-arc-header-host'),preventDefault=vi.fn(),stopPropagation=vi.fn();
 outside({isTrusted:false,target:document.body});outside({isTrusted:true,target:host,composedPath:()=>[host]});expect(port.postMessage.mock.calls.filter(([m])=>m.kind==='dismissPicker')).toHaveLength(0);
 outside({isTrusted:true,target:document.body,composedPath:()=>[document.body],preventDefault,stopPropagation});expect(port.postMessage).toHaveBeenCalledWith({kind:'dismissPicker'});expect(preventDefault).not.toHaveBeenCalled();expect(stopPropagation).not.toHaveBeenCalled();
 c.dispose();expect(remove).toHaveBeenCalledWith('pointerdown',outside,true);
});
it('selected destination repaints from validated metadata and safe refresh retains it',async()=>{
 const c={...context(),themeMode:'dark'};c.spaces[0].color='#ff0000';c.spaces.push({id:'b',bookmarkFolderId:'fb',name:'Blue',color:'#0000ff'});const f=await compactFixture(c);
 const before=document.documentElement.style.getPropertyValue('--la-surface');expect(document.documentElement.dataset.theme).toBe('dark');
 document.getElementById('space').value='b';f.handlers.get('space:change')();expect(document.documentElement.style.getPropertyValue('--la-surface')).not.toBe(before);
 await f.frame.onMessage.emit({kind:'context',context:c});expect(document.getElementById('space').value).toBe('b');expect(document.documentElement.style.getPropertyValue('--la-tint')).toBe('#0000ff');
 c.spaces[1].color='#00ff00';await f.frame.onMessage.emit({kind:'context',context:c});expect(document.documentElement.style.getPropertyValue('--la-tint')).toBe('#00ff00');
 expect(f.frame.postMessage.mock.calls.some(([m])=>['review','placeDirect'].includes(m.kind))).toBe(false);
});
it.each(['dark','light','system'])('accepts bounded authoritative appearance %s',themeMode=>expect(validateHeaderContext({...context(),themeMode}).themeMode).toBe(themeMode));
it.each(['url(evil)','LIGHT',null,{},1])('rejects invalid appearance %s',themeMode=>expect(()=>validateHeaderContext({...context(),themeMode})).toThrow());
it('hit regions require exact bounded numeric geometry and never affect authorization',async()=>{
 const f=fixture();cleanups.push(f.dispose);const top=await f.mount(),frame=await f.bind(top),rects=[[0,0,1000,44],[650,50,350,100]];
 await frame.onMessage.emit({kind:'hitRegions',rects});expect(top.postMessage).toHaveBeenCalledWith({kind:'hitRegions',rects});
 for(const rects of [[[0,0,1,481]],[[0,0,'url(evil)',1]],[[0,-1,1,1]],Array(6).fill([0,0,1,1])]){const before=top.postMessage.mock.calls.length;await frame.onMessage.emit({kind:'hitRegions',rects});expect(top.postMessage.mock.calls.length).toBe(before);}
 expect(f.api.runtime.sendMessage.mock.calls.some(([,r])=>r.action!=='inspect')).toBe(false);
});

it('capture scroll recomputes hit regions without height change and disposal removes listener',async()=>{
 let scrolled;const add=document.addEventListener.bind(document);vi.spyOn(document,'addEventListener').mockImplementation((type,fn,...args)=>{if(type==='scroll')scrolled=fn;return add(type,fn,...args);});
 const f=await compactFixture(context());const header=document.getElementById('header'),choices=document.getElementById('choices');header.getBoundingClientRect=()=>({height:150});
 Object.defineProperty(document.documentElement,'clientWidth',{configurable:true,value:500});let y=60;choices.getClientRects=()=>[1];choices.getBoundingClientRect=()=>({left:0,top:y,right:500,bottom:y+44});
 scrolled();expect(f.frame.postMessage).toHaveBeenCalledWith({kind:'hitRegions',rects:[[0,60,500,44]]});y=0;scrolled();expect(f.frame.postMessage).toHaveBeenCalledWith({kind:'hitRegions',rects:[[0,0,500,44]]});
});
it('scheme forwarding is bounded, current-frame only and cannot carry placement',async()=>{
 const f=fixture();cleanups.push(f.dispose);const top=await f.mount(),frame=await f.bind(top);
 await frame.onMessage.emit({kind:'colorScheme',mode:'dark'});expect(top.postMessage).toHaveBeenCalledWith({kind:'colorScheme',mode:'dark'});
 const n=top.postMessage.mock.calls.length;await frame.onMessage.emit({kind:'colorScheme',mode:'light;display:none'});await frame.onMessage.emit({kind:'colorScheme',mode:'light',target:context().proposed});expect(top.postMessage.mock.calls.length).toBe(n);
 expect(f.api.runtime.sendMessage.mock.calls.some(([,r])=>r.action!=='inspect')).toBe(false);
});

it('System mode uses authenticated top preference, not iframe scheme feedback',async()=>{
 const c={...context(),themeMode:'light'},f=await compactFixture(c);await f.frame.onMessage.emit({kind:'systemScheme',mode:'dark'});expect(document.documentElement.dataset.theme).toBe('light');
 await f.frame.onMessage.emit({kind:'context',context:{...c,themeMode:'system'}});expect(document.documentElement.dataset.theme).toBe('dark');
 await f.frame.onMessage.emit({kind:'systemScheme',mode:'light'});expect(document.documentElement.dataset.theme).toBe('light');
 await f.frame.onMessage.emit({kind:'systemScheme',mode:'url(evil)'});expect(document.documentElement.dataset.theme).toBe('light');
 expect(f.frame.postMessage.mock.calls.some(([m])=>['review','placeDirect'].includes(m.kind))).toBe(false);
});
it('system preference is scoped to current top port and has no transfer authority',async()=>{
 const f=fixture();cleanups.push(f.dispose);const top=await f.mount();await top.onMessage.emit({kind:'systemScheme',mode:'dark'});const frame=await f.bind(top);expect(frame.postMessage).toHaveBeenCalledWith({kind:'systemScheme',mode:'dark'});
 await top.onMessage.emit({kind:'systemScheme',mode:'light'});expect(frame.postMessage).toHaveBeenCalledWith({kind:'systemScheme',mode:'light'});expect(f.api.runtime.sendMessage.mock.calls.some(([,r])=>r.action!=='inspect')).toBe(false);
});

it('caret focuses search without scrolling the still-short iframe or granting placement',async()=>{
 const f=await compactFixture(context()),search=document.getElementById('space-search'),focus=vi.spyOn(search,'focus');
 for(let i=0;i<3;i++){f.click('space-menu-toggle');expect(focus).toHaveBeenLastCalledWith({preventScroll:true});expect(document.activeElement).toBe(search);expect(document.getElementById('space-picker').hidden).toBe(false);f.click('space-menu-toggle');}
 expect(f.frame.postMessage.mock.calls.some(([m])=>['review','placeDirect'].includes(m.kind))).toBe(false);
});
