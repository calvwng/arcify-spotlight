import { afterEach, expect, it, vi } from 'vitest';
import { DIM_KEY, DIM_STRENGTH_KEY, DIM_PREFERENCES_TYPE as TYPE, DIM_AUTHORIZATION_TYPE as AUTH, readDimmingPreference, installDimmingPreferences } from '../../shared/little-arc-dimming-preferences.js';
const SELF='a'.repeat(32), PEER='b'.repeat(32);
const event=()=>{const listeners=new Set();return {addListener:f=>listeners.add(f),removeListener:f=>listeners.delete(f),emit:(...args)=>[...listeners].map(f=>f(...args))};};
const cleanups=[];afterEach(()=>{cleanups.splice(0).forEach(f=>f());vi.useRealTimers();});
function fixture(values={}) {
    const saved={arcifyBridgePeerId:PEER,arcifyBridgePairingGeneration:'g',...values};
    const used=new Set();
    const api={runtime:{id:SELF,onMessageExternal:event(),sendMessage:vi.fn(async(peer,request)=>{
        const authorized=peer===PEER&&!used.has(request.requestId);used.add(request.requestId);
        return {type:AUTH,version:1,requestId:request.requestId,authorized};
    })},storage:{local:{get:vi.fn(async()=>structuredClone(saved)),set:vi.fn(async values=>Object.assign(saved,values))},onChanged:event()}};
    const service=installDimmingPreferences(api,{authorizationTimeoutMs:50});cleanups.push(()=>service.dispose());
    const sender={id:PEER,url:`chrome-extension://${PEER}/background.js`,origin:`chrome-extension://${PEER}`};
    const request=(action='get',fields={})=>({type:TYPE,version:1,requestId:crypto.randomUUID(),action,...fields});
    const send=(message,from=sender)=>new Promise(resolve=>api.runtime.onMessageExternal.emit(message,from,resolve));
    const set=(expected,preference)=>send(request('set',{expected,preference}));
    return {api,saved,request,send,set,sender,service};
}
it('defaults only absent values without writing or changing existing enabled state',async()=>{
    expect(readDimmingPreference({})).toEqual({enabled:false,strength:55});
    expect(readDimmingPreference({[DIM_KEY]:true})).toEqual({enabled:true,strength:55});
    const f=fixture({[DIM_KEY]:true});expect(await f.send(f.request())).toMatchObject({success:true,preference:{enabled:true,strength:55}});expect(f.api.storage.local.set).not.toHaveBeenCalled();
});
for(const strength of [null,'55',14,91,55.5,NaN,Infinity])it(`fails closed for saved strength ${strength}`,async()=>{
    const f=fixture({[DIM_KEY]:true,[DIM_STRENGTH_KEY]:strength});expect(await f.send(f.request())).toMatchObject({success:false,error:{code:'INVALID_PREFERENCE'}});expect(f.api.storage.local.set).not.toHaveBeenCalled();
});
it('fails closed for a malformed saved enabled flag',async()=>{
    const f=fixture({[DIM_KEY]:'true'});expect(await f.send(f.request())).toMatchObject({success:false,error:{code:'INVALID_PREFERENCE'}});
});
it('serializes full compare/write/readback and rejects stale concurrent settings',async()=>{
    const f=fixture();const [a,b]=await Promise.all([f.set({enabled:false,strength:55},{enabled:true,strength:65}),f.set({enabled:false,strength:55},{enabled:false,strength:20})]);
    expect(a).toMatchObject({success:true,preference:{enabled:true,strength:65}});expect(b).toMatchObject({success:false,error:{code:'STALE_PREFERENCE'}});
    expect(f.api.storage.local.set).toHaveBeenCalledTimes(1);expect(f.saved[DIM_KEY]).toBe(true);expect(f.saved[DIM_STRENGTH_KEY]).toBe(65);
});
for(const cause of ['tab','otherPeer','popup','origin','version','extra','fraction','range','string','missingExpected'])it(`rejects ${cause} before writing`,async()=>{
    const f=fixture(),sender={...f.sender},request=f.request('set',{expected:{enabled:false,strength:55},preference:{enabled:true,strength:70}});
    if(cause==='tab')sender.tab={id:1};if(cause==='otherPeer')sender.id=SELF;if(cause==='popup')sender.url=`chrome-extension://${PEER}/options.html`;if(cause==='origin')sender.origin='https://wrong.test';
    if(cause==='version')request.version=2;if(cause==='extra')request.extra=true;if(cause==='fraction')request.preference.strength=55.5;if(cause==='range')request.preference.strength=91;if(cause==='string')request.preference.enabled='true';if(cause==='missingExpected')delete request.expected;
    expect(await f.send(request,sender)).toMatchObject({success:false});expect(f.api.storage.local.set).not.toHaveBeenCalled();
});
for(const cause of ['denied','missing','wrongId','extra','pairing','disposed'])it(`final authorization ${cause} prevents storage write`,async()=>{
    const f=fixture();f.api.runtime.sendMessage.mockImplementation(async(_peer,request)=>{
        if(cause==='pairing'){f.saved.arcifyBridgePairingGeneration='new';f.api.storage.onChanged.emit({arcifyBridgePairingGeneration:{}},'local');}
        if(cause==='disposed')f.service.dispose();
        if(cause==='missing')return undefined;
        return {type:AUTH,version:1,requestId:cause==='wrongId'?crypto.randomUUID():request.requestId,authorized:cause!=='denied',...(cause==='extra'?{extra:true}:{})};
    });
    expect(await f.set({enabled:false,strength:55},{enabled:true,strength:70})).toMatchObject({success:false,error:{code:'UNAUTHORIZED'}});expect(f.api.storage.local.set).not.toHaveBeenCalled();
});
it('authorization receives the exact immutable expected/preference request and is one-use',async()=>{
    const f=fixture(),request=f.request('set',{expected:{enabled:false,strength:55},preference:{enabled:true,strength:70}});
    expect(await f.send(request)).toMatchObject({success:true});
    expect(f.api.runtime.sendMessage).toHaveBeenCalledWith(PEER,{type:AUTH,version:1,requestId:request.requestId,action:'verify',request});
    const repeated={...request,expected:{enabled:true,strength:70},preference:{enabled:true,strength:60}};
    expect(await f.send(repeated)).toMatchObject({success:false,error:{code:'UNAUTHORIZED'}});expect(f.api.storage.local.set).toHaveBeenCalledTimes(1);
});
it('expired or absent pending controller authorization never retries',async()=>{
    vi.useFakeTimers();const f=fixture();f.api.runtime.sendMessage.mockImplementation(()=>new Promise(()=>{}));const result=f.set({enabled:false,strength:55},{enabled:true,strength:70});
    await vi.advanceTimersByTimeAsync(51);expect(await result).toMatchObject({success:false,error:{code:'UNAUTHORIZED'}});expect(f.api.storage.local.set).not.toHaveBeenCalled();expect(f.api.runtime.sendMessage).toHaveBeenCalledTimes(1);
});
it('does not write a request queued after its controller becomes unavailable',async()=>{
    const f=fixture();let release;const original=f.api.runtime.sendMessage.getMockImplementation();let count=0;
    f.api.runtime.sendMessage.mockImplementation(async(...args)=>{if(++count===1)return new Promise(resolve=>{release=()=>original(...args).then(resolve);});return {type:AUTH,version:1,requestId:args[1].requestId,authorized:false};});
    const first=f.send(f.request());while(!release)await Promise.resolve();const second=f.set({enabled:false,strength:55},{enabled:true,strength:70});release();await first;
    expect(await second).toMatchObject({success:false,error:{code:'UNAUTHORIZED'}});expect(f.api.storage.local.set).not.toHaveBeenCalled();
});
it('failed readback reports uncertainty without replay or rollback',async()=>{
    const f=fixture();f.api.storage.local.set.mockImplementation(async()=>{});expect(await f.set({enabled:false,strength:55},{enabled:true,strength:70})).toMatchObject({success:false,error:{code:'UNCONFIRMED'}});expect(f.api.storage.local.set).toHaveBeenCalledTimes(1);
});
it('legacy or external preference change during authorization cannot be overwritten',async()=>{
    const f=fixture();const original=f.api.runtime.sendMessage.getMockImplementation();
    f.api.runtime.sendMessage.mockImplementation(async(...args)=>{f.saved[DIM_STRENGTH_KEY]=20;f.api.storage.onChanged.emit({[DIM_STRENGTH_KEY]:{newValue:20}},'local');return original(...args);});
    expect(await f.set({enabled:false,strength:55},{enabled:true,strength:70})).toMatchObject({success:false,error:{code:'STALE_PREFERENCE'}});expect(f.api.storage.local.set).not.toHaveBeenCalled();expect(f.saved[DIM_STRENGTH_KEY]).toBe(20);
});
it('its own storage change event does not misclassify a verified save as stale',async()=>{
    const f=fixture();f.api.storage.local.set.mockImplementation(async values=>{Object.assign(f.saved,values);f.api.storage.onChanged.emit(Object.fromEntries(Object.entries(values).map(([key,newValue])=>[key,{newValue}])),'local');});
    expect(await f.set({enabled:false,strength:55},{enabled:true,strength:70})).toMatchObject({success:true,preference:{enabled:true,strength:70}});
});
it.each([15,55,75,90])('preserves valid saved strength %s without migration',async strength=>{const f=fixture({[DIM_KEY]:true,[DIM_STRENGTH_KEY]:strength});expect(await f.send(f.request())).toMatchObject({success:true,preference:{enabled:true,strength}});expect(f.api.storage.local.set).not.toHaveBeenCalled();});
it('explicit CAS accepts the new 90 percent endpoint',async()=>{const f=fixture();expect(await f.set({enabled:false,strength:55},{enabled:true,strength:90})).toMatchObject({success:true,preference:{enabled:true,strength:90}});});
