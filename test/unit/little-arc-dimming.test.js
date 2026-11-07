// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSourceDimming, DIM_KEY, DIM_PORT, DIM_OFFER } from '../../shared/little-arc-dimming-broker.js';
import { installSourceDimming } from '../../shared/little-arc-dimming-content.js';
const event = () => { const listeners = new Set(); return { addListener: f => listeners.add(f), removeListener: f => listeners.delete(f), emit: (...args) => Promise.all([...listeners].map(f => f(...args))) }; };
const SELF = 'a'.repeat(32), PEER = 'b'.repeat(32), source = { tabId: 1, windowId: 10, url: 'https://source.test/' }, target = { tabId: 2, windowId: 20 }, pair = { peerId: PEER, generation: 'g' };
const cleanups = [];
beforeEach(() => { vi.useFakeTimers(); document.body.replaceChildren(); });
afterEach(() => { cleanups.splice(0).forEach(f => f()); vi.restoreAllMocks(); vi.useRealTimers(); });
function fixture() {
    const settings = { [DIM_KEY]: true, peekEnabled: true, arcifyBridgePeerId: PEER, arcifyBridgePairingGeneration: 'g' };
    const tabs = { 1: { id: 1, windowId: 10, url: source.url, active: true }, 2: { id: 2, windowId: 20, active: true } };
    const windows = { 10: { id: 10, type: 'normal', focused: false }, 20: { id: 20, type: 'normal', focused: true } };
    const api = { runtime: { id: SELF, onConnect: event() }, storage: { local: { get: vi.fn(async () => ({ ...settings })) }, onChanged: event() },
        tabs: { get: vi.fn(async id => ({ ...tabs[id] })), sendMessage: vi.fn(async () => ({ accepted: true })), ...Object.fromEntries(['onRemoved','onDetached','onAttached','onReplaced','onUpdated','onActivated'].map(k => [k,event()])) },
        windows: { get: vi.fn(async id => ({ ...windows[id] })), onRemoved: event(), onFocusChanged: event() } };
    const manager = createSourceDimming(api); cleanups.push(() => manager.dispose());
    const start = () => manager.start(source, 'doc', target, pair);
    const port = () => { const p = { name: DIM_PORT, sender: { id: SELF, tab: { id: 1, windowId: 10 }, frameId: 0, documentId: 'doc', origin: 'https://source.test', url: 'https://source.test/old-spa-url' }, onMessage: event(), onDisconnect: event(), postMessage: vi.fn(), disconnect: vi.fn() }; return p; };
    const bind = async () => { await start(); const p = port(), id = api.tabs.sendMessage.mock.calls.at(-1)[1].id; await api.runtime.onConnect.emit(p); await p.onMessage.emit({kind:'bind',id}); return {p,id}; };
    return { api, settings, tabs, windows, manager, start, port, bind };
}
it('routes only to exact document/frame and binds a separate cosmetic port despite stale sender URL', async () => {
    const f=fixture(), {p,id}=await f.bind();
    expect(f.api.tabs.sendMessage).toHaveBeenCalledWith(1,{type:DIM_OFFER,id,url:source.url},{documentId:'doc',frameId:0});
    expect(p.postMessage).toHaveBeenCalledWith({kind:'lease',id,ms:4000,strength:55});
    expect(JSON.stringify(p.postMessage.mock.calls)).not.toMatch(/operation|connection|authorization/);
});
for (const cause of ['off','unpaired','generation','sourceFocus','sourceMoved','sourceUrl','sourceInactive','destinationMoved','destinationFocus','private','sameWindow']) it(`does not offer dimming when ${cause}`,async()=>{
    const f=fixture();
    if(cause==='off')f.settings[DIM_KEY]=false;
    if(cause==='unpaired')f.settings.arcifyBridgePeerId='c'.repeat(32);
    if(cause==='generation')f.settings.arcifyBridgePairingGeneration='new';
    if(cause==='sourceFocus')f.windows[10].focused=true;
    if(cause==='sourceMoved')f.tabs[1].windowId=11;
    if(cause==='sourceUrl')f.tabs[1].url='https://source.test/new';
    if(cause==='sourceInactive')f.tabs[1].active=false;
    if(cause==='destinationMoved')f.tabs[2].windowId=21;
    if(cause==='destinationFocus')f.windows[20].focused=false;
    if(cause==='private')f.windows[20].incognito=true;
    if(cause==='sameWindow')await f.manager.start(source,'doc',{tabId:2,windowId:10},pair);else await f.start();
    expect(f.api.tabs.sendMessage).not.toHaveBeenCalled();
});
for(const cause of ['frame','document','window','extension','origin','cached'])it(`rejects wrong ${cause} cosmetic port`,async()=>{
    const f=fixture();await f.start();const p=f.port();
    if(cause==='frame')p.sender.frameId=2;if(cause==='document')p.sender.documentId='new';if(cause==='window')p.sender.tab.windowId=11;
    if(cause==='extension')p.sender.id=PEER;if(cause==='origin')p.sender.origin='https://evil.test';if(cause==='cached')p.sender.documentLifecycle='cached';
    await f.api.runtime.onConnect.emit(p);expect(p.disconnect).toHaveBeenCalled();expect(p.postMessage).not.toHaveBeenCalled();
});
for(const cause of ['sourceNavigation','sameUrlReload','destinationClose','sourceReplacement','focus','activation','pairing','disconnect','expiry'])it(`clears terminally on ${cause}`,async()=>{
    const f=fixture(),{p,id}=await f.bind();
    if(cause==='sourceNavigation')await f.api.tabs.onUpdated.emit(1,{url:'https://source.test/new'});
    if(cause==='sameUrlReload')await f.api.tabs.onUpdated.emit(1,{status:'loading'});
    if(cause==='destinationClose')await f.api.windows.onRemoved.emit(20);
    if(cause==='sourceReplacement')await f.api.tabs.onReplaced.emit(4,1);
    if(cause==='focus'){f.windows[10].focused=true;await f.api.windows.onFocusChanged.emit(10);}
    if(cause==='activation'){f.windows[10].focused=true;await f.api.tabs.onActivated.emit({windowId:10,tabId:1});}
    if(cause==='targetActivation')await f.api.tabs.onActivated.emit({windowId:20,tabId:4});
    if(cause==='pairing')await f.api.storage.onChanged.emit({arcifyBridgePairingGeneration:{}},'local');
    if(cause==='disconnect')await p.onDisconnect.emit();if(cause==='expiry')await vi.advanceTimersByTimeAsync(4001);
    expect(p.disconnect).toHaveBeenCalled();p.postMessage.mockClear();await p.onMessage.emit({kind:'pulse',id});expect(p.postMessage).not.toHaveBeenCalled();
});
it('does not renew an async validation cleared during its read',async()=>{
    const f=fixture(),{p,id}=await f.bind();let resolve;f.api.tabs.get.mockImplementationOnce(()=>new Promise(r=>resolve=r));
    const pending=p.onMessage.emit({kind:'pulse',id});f.windows[10].focused=true;await f.api.windows.onFocusChanged.emit(10);resolve({...f.tabs[1]});await pending;
    expect(p.postMessage).toHaveBeenCalledTimes(1);
});
it('an old lease disconnect cannot clear its replacement',async()=>{
    const f=fixture(),old=await f.bind(),next=await f.bind();await old.p.onDisconnect.emit();await next.p.onMessage.emit({kind:'pulse',id:next.id});expect(next.p.postMessage).toHaveBeenCalledTimes(2);
});
it('continued pulses cannot extend the ten-minute absolute cap',async()=>{
    const f=fixture(),{p,id}=await f.bind();
    for(let i=0;i<399;i++){await vi.advanceTimersByTimeAsync(1500);await p.onMessage.emit({kind:'pulse',id});}
    expect(p.disconnect).not.toHaveBeenCalled();await vi.advanceTimersByTimeAsync(1501);
    await p.onMessage.emit({kind:'pulse',id});expect(p.disconnect).toHaveBeenCalled();
});
function contentFixture() {
    let focused=false,visibility='visible';const listeners=new Map();
    const win={location:{href:source.url},top:null,addEventListener:(type,f)=>listeners.set(type,f),removeEventListener:()=>{}};win.top=win;
    vi.spyOn(document,'hasFocus').mockImplementation(()=>focused);vi.spyOn(document,'visibilityState','get').mockImplementation(()=>visibility);
    const ports=[];const api={runtime:{id:SELF,onMessage:event(),connect:vi.fn(()=>{const p={onMessage:event(),onDisconnect:event(),postMessage:vi.fn(),disconnect:vi.fn()};ports.push(p);return p;})}};
    const control=installSourceDimming({api,document,window:win});cleanups.push(()=>control.dispose());
    const offer=async()=>{const id=crypto.randomUUID();control.receive({type:DIM_OFFER,id,url:source.url},{id:SELF});return {p:ports.at(-1),id};};
    const mount=async()=>{const v=await offer();await v.p.onMessage.emit({kind:'lease',id:v.id,ms:4000,strength:55});return v;};
    return {api,win,listeners,ports,offer,mount,focus:()=>focused=true,blur:()=>focused=false,hide:()=>visibility='hidden',show:()=>visibility='visible'};
}
it('decorative dimming never traps focus or pointer events, and has no motion',async()=>{
    const f=contentFixture();await f.mount();const host=document.body.firstElementChild;
    expect(host.getAttribute('aria-hidden')).toBe('true');expect(host.style.pointerEvents).toBe('none');expect(host.hasAttribute('tabindex')).toBe(false);expect(host.hasAttribute('inert')).toBe(false);expect(host.style.animation).toBe('');expect(host.style.transition).toBe('');
    expect(host.style.background).toBe('rgba(0, 0, 0, 0.55)');
});
it('renders only validated lease strength and clears malformed renewals',async()=>{
    const f=contentFixture(),{p,id}=await f.mount();await p.onMessage.emit({kind:'lease',id,ms:4000,strength:70});
    expect(document.body.firstElementChild.style.background).toBe('rgba(0, 0, 0, 0.7)');
    await p.onMessage.emit({kind:'lease',id,ms:4000,strength:'70'});expect(document.body.children.length).toBe(0);
});
it('a legacy lease without strength fails clear rather than guessing opacity',async()=>{
    const f=contentFixture(),{p,id}=await f.mount();await p.onMessage.emit({kind:'lease',id,ms:4000});expect(document.body.children.length).toBe(0);
});
it('broker passes saved strength and settings changes retire rather than revive the lease',async()=>{
    const f=fixture();f.settings.littleArcDimStrength=75;const {p,id}=await f.bind();expect(p.postMessage).toHaveBeenCalledWith({kind:'lease',id,ms:4000,strength:75});
    await f.api.storage.onChanged.emit({littleArcDimStrength:{newValue:55}},'local');p.postMessage.mockClear();await p.onMessage.emit({kind:'pulse',id});expect(p.postMessage).not.toHaveBeenCalled();
});
it('broker skips dimming for malformed saved strength without touching launch behavior',async()=>{
    const f=fixture();f.settings.littleArcDimStrength=0.7;await f.start();expect(f.api.tabs.sendMessage).not.toHaveBeenCalled();
});
for(const cause of ['focus','pointerdown','keydown','pagehide','disconnect','timeout','navigation'])it(`content clears on ${cause} without blocking source input`,async()=>{
    const f=contentFixture(),{p}=await f.mount();const input={isTrusted:true,preventDefault:vi.fn(),stopPropagation:vi.fn()};
    if(cause==='focus')f.focus();input.type=cause;if(['focus','pointerdown','keydown','pagehide'].includes(cause))f.listeners.get(cause)(input);
    if(cause==='disconnect')await p.onDisconnect.emit();if(cause==='timeout')await vi.advanceTimersByTimeAsync(4001);
    if(cause==='navigation'){f.win.location.href+='new';await vi.advanceTimersByTimeAsync(1501);}
    expect(document.body.children.length).toBe(0);expect(input.preventDefault).not.toHaveBeenCalled();expect(input.stopPropagation).not.toHaveBeenCalled();
});
it('rejects a late offer after source focus and ignores old renewals',async()=>{
    const f=contentFixture(),old=await f.mount();f.listeners.get('pointerdown')({isTrusted:true});await old.p.onMessage.emit({kind:'lease',id:old.id,ms:4000,strength:55});expect(document.body.children.length).toBe(0);
    f.focus();await f.offer();expect(f.api.runtime.connect).toHaveBeenCalledTimes(1);
});
it('90 percent lease renders decorative black at 0.9 opacity',async()=>{const f=contentFixture(),{p,id}=await f.mount();await p.onMessage.emit({kind:'lease',id,ms:4000,strength:90});const host=document.body.firstElementChild;expect(host.style.background).toBe('rgba(0, 0, 0, 0.9)');expect(host.style.opacity).toBe('');expect(host.style.pointerEvents).toBe('none');});
it.each([101,99.5])('invalid strength %s clears existing overlay',async strength=>{const f=contentFixture(),{p,id}=await f.mount();await p.onMessage.emit({kind:'lease',id,ms:4000,strength});expect(document.body.children.length).toBe(0);});
it('broker admits saved 90 percent strength',async()=>{const f=fixture();f.settings.littleArcDimStrength=90;const {p,id}=await f.bind();expect(p.postMessage).toHaveBeenCalledWith({kind:'lease',id,ms:4000,strength:90});});

it('100 percent remains decorative and clears synchronously on trusted source input',async()=>{const f=contentFixture(),{p,id}=await f.mount();await p.onMessage.emit({kind:'lease',id,ms:4000,strength:100});const host=document.body.firstElementChild;expect(host.style.background).toBe('rgb(0, 0, 0)');expect(host.style.pointerEvents).toBe('none');expect(host.getAttribute('aria-hidden')).toBe('true');const input={isTrusted:true,preventDefault:vi.fn(),stopPropagation:vi.fn()};f.listeners.get('pointerdown')(input);expect(host.isConnected).toBe(false);expect(input.preventDefault).not.toHaveBeenCalled();expect(input.stopPropagation).not.toHaveBeenCalled();});
it('broker admits saved100percent strength',async()=>{const f=fixture();f.settings.littleArcDimStrength=100;const {p,id}=await f.bind();expect(p.postMessage).toHaveBeenCalledWith({kind:'lease',id,ms:4000,strength:100});});
it.each(['noBrowserFocus','unrelatedWindow','unrelatedSourceTab','unrelatedTargetTab','backgroundSourceActivation'])('retains admitted dimming on %s',async cause=>{
 const f=fixture(),{p,id}=await f.bind();
 if(cause==='noBrowserFocus'){f.windows[20].focused=false;await f.api.windows.onFocusChanged.emit(-1);}
 if(cause==='unrelatedWindow'){f.windows[20].focused=false;await f.api.windows.onFocusChanged.emit(99);}
 if(cause==='unrelatedSourceTab'){f.tabs[1].active=false;f.windows[10].focused=true;f.windows[20].focused=false;await f.api.tabs.onActivated.emit({tabId:9,windowId:10});await f.api.windows.onFocusChanged.emit(10);}
 if(cause==='unrelatedTargetTab'){f.tabs[2].active=false;await f.api.tabs.onActivated.emit({tabId:9,windowId:20});}
 if(cause==='backgroundSourceActivation')await f.api.tabs.onActivated.emit({tabId:1,windowId:10});
 await p.onMessage.emit({kind:'pulse',id});expect(p.disconnect).not.toHaveBeenCalled();expect(p.postMessage).toHaveBeenCalledTimes(2);
});
it('returning to exact source terminally clears and later target focus cannot revive',async()=>{const f=fixture(),{p,id}=await f.bind();f.windows[10].focused=true;f.windows[20].focused=false;await f.api.windows.onFocusChanged.emit(10);f.windows[10].focused=false;f.windows[20].focused=true;await f.api.windows.onFocusChanged.emit(20);await p.onMessage.emit({kind:'pulse',id});expect(p.disconnect).toHaveBeenCalled();expect(p.postMessage).toHaveBeenCalledTimes(1);expect(f.api.tabs.sendMessage).toHaveBeenCalledTimes(1);});
it('stale focus query cannot clear after a newer unrelated focus event',async()=>{const f=fixture(),{p,id}=await f.bind();let finish;f.api.windows.get.mockImplementationOnce(()=>new Promise(resolve=>finish=resolve));const pending=f.api.windows.onFocusChanged.emit(10);await f.api.windows.onFocusChanged.emit(99);finish({...f.windows[10],focused:true});await pending;await p.onMessage.emit({kind:'pulse',id});expect(p.disconnect).not.toHaveBeenCalled();});
it('source focus clears only its own association among two leases',async()=>{const f=fixture(),first=await f.bind();f.tabs[3]={id:3,windowId:30,url:'https://second.test/',active:true};f.tabs[4]={id:4,windowId:40,active:true};f.windows[30]={id:30,type:'normal',focused:false};f.windows[40]={id:40,type:'normal',focused:true};f.windows[20].focused=false;await f.manager.start({tabId:3,windowId:30,url:'https://second.test/'},'doc2',{tabId:4,windowId:40},pair);const id=f.api.tabs.sendMessage.mock.calls.at(-1)[1].id,p=f.port();p.sender={...p.sender,documentId:'doc2',tab:{id:3,windowId:30},origin:'https://second.test'};await f.api.runtime.onConnect.emit(p);await p.onMessage.emit({kind:'bind',id});f.windows[10].focused=true;f.windows[40].focused=false;await f.api.windows.onFocusChanged.emit(10);await p.onMessage.emit({kind:'pulse',id});expect(first.p.disconnect).toHaveBeenCalled();expect(p.disconnect).not.toHaveBeenCalled();expect(p.postMessage).toHaveBeenCalledTimes(2);});
it('hidden source renews without clearing on visibility or background element focus',async()=>{const f=contentFixture(),{p,id}=await f.mount();const host=document.body.firstElementChild;f.hide();document.dispatchEvent(new Event('visibilitychange'));f.listeners.get('focus')({type:'focus',isTrusted:true});await p.onMessage.emit({kind:'lease',id,ms:4000,strength:55});expect(host.isConnected).toBe(true);f.show();document.dispatchEvent(new Event('visibilitychange'));expect(host.isConnected).toBe(true);f.focus();f.listeners.get('focus')({type:'focus',isTrusted:true});expect(host.isConnected).toBe(false);});
it('hidden receiver expires without revival when timers were suspended',async()=>{const f=contentFixture(),{p,id}=await f.mount();f.hide();vi.setSystemTime(Date.now()+4001);await p.onMessage.emit({kind:'lease',id,ms:4000,strength:55});expect(document.body.children.length).toBe(0);f.show();await p.onMessage.emit({kind:'lease',id,ms:4000,strength:55});expect(document.body.children.length).toBe(0);});
it('broker rejects delayed pulse after lease deadline even before its timeout runs',async()=>{const f=fixture(),{p,id}=await f.bind();vi.setSystemTime(Date.now()+4001);await p.onMessage.emit({kind:'pulse',id});expect(p.disconnect).toHaveBeenCalled();expect(p.postMessage).toHaveBeenCalledTimes(1);});
it('stale focus read rejection cannot clear after a newer unrelated focus',async()=>{const f=fixture(),{p,id}=await f.bind();let reject;f.api.windows.get.mockImplementationOnce(()=>new Promise((_resolve,r)=>reject=r));const pending=f.api.windows.onFocusChanged.emit(10);await f.api.windows.onFocusChanged.emit(-1);reject(Error('stale focus read'));await pending;await p.onMessage.emit({kind:'pulse',id});expect(p.disconnect).not.toHaveBeenCalled();});
it('renewal rechecks once when an intervening focus event invalidates its snapshot',async()=>{const f=fixture(),{p,id}=await f.bind();let finish;f.api.windows.get.mockImplementationOnce(()=>new Promise(resolve=>finish=resolve));const pending=p.onMessage.emit({kind:'pulse',id});await f.api.windows.onFocusChanged.emit(99);finish({...f.windows[10],focused:true});await pending;expect(p.disconnect).not.toHaveBeenCalled();expect(p.postMessage).toHaveBeenCalledTimes(2);});
it.each(['sourceClose','targetClose','dispose','disconnect'])('unrelated focus does not suppress %s cleanup',async cause=>{const f=fixture(),{p,id}=await f.bind();f.windows[20].focused=false;await f.api.windows.onFocusChanged.emit(99);if(cause==='sourceClose')await f.api.tabs.onRemoved.emit(1);if(cause==='targetClose')await f.api.tabs.onRemoved.emit(2);if(cause==='dispose')f.manager.dispose();if(cause==='disconnect')await p.onDisconnect.emit();await p.onMessage.emit({kind:'pulse',id});expect(p.disconnect).toHaveBeenCalled();expect(p.postMessage).toHaveBeenCalledTimes(1);});
it('initial admission still rejects inactive destination and hidden source offers',async()=>{const broker=fixture();broker.tabs[2].active=false;await broker.start();expect(broker.api.tabs.sendMessage).not.toHaveBeenCalled();const content=contentFixture();content.hide();await content.offer();expect(content.api.runtime.connect).not.toHaveBeenCalled();});
it('visible background programmatic element focus does not dismiss the dim',async()=>{const f=contentFixture();await f.mount();f.listeners.get('focus')({type:'focus',isTrusted:true});expect(document.body.children.length).toBe(1);});
it.each(['stable','expired'])('twice-unstable focus observations never renew; next pulse %s',async outcome=>{const f=fixture(),{p,id}=await f.bind();const releases=[];let count=0;f.api.windows.get.mockImplementation(async windowId=>{if(windowId===10&&++count<=2)return new Promise(resolve=>releases.push(()=>resolve({...f.windows[10]})));return {...f.windows[windowId]};});const pending=p.onMessage.emit({kind:'pulse',id});await f.api.windows.onFocusChanged.emit(99);releases[0]();for(let i=0;i<20;i++)await Promise.resolve();expect(releases).toHaveLength(2);await f.api.windows.onFocusChanged.emit(-1);releases[1]();await pending;expect(p.postMessage).toHaveBeenCalledTimes(1);expect(p.disconnect).not.toHaveBeenCalled();if(outcome==='expired')vi.setSystemTime(Date.now()+4001);await p.onMessage.emit({kind:'pulse',id});if(outcome==='stable'){expect(p.postMessage).toHaveBeenCalledTimes(2);expect(p.disconnect).not.toHaveBeenCalled();}else{expect(p.postMessage).toHaveBeenCalledTimes(1);expect(p.disconnect).toHaveBeenCalled();}});
it('hidden document focus flag is not source return until visible focus is confirmed',async()=>{const f=contentFixture(),{p,id}=await f.mount();f.hide();f.focus();document.dispatchEvent(new Event('visibilitychange'));await p.onMessage.emit({kind:'lease',id,ms:4000,strength:55});await vi.advanceTimersByTimeAsync(1500);expect(document.body.children.length).toBe(1);expect(p.postMessage).toHaveBeenCalledWith({kind:'pulse',id});f.show();document.dispatchEvent(new Event('visibilitychange'));expect(document.body.children.length).toBe(0);});
