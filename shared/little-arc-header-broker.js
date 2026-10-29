import {createLittleArcDispatchLedger} from './little-arc-dispatch-ledger.js';
import { PEER_KEY,PAIRING_GENERATION_KEY,isTransientUrl,isExtensionId } from './arcify-bridge-protocol.js';
import { HEADER_TYPE,HEADER_TOP_PORT,HEADER_FRAME_PORT,HEADER_PAGE,exact,positive,uuid,validateHeaderContext,validHitRegions } from './little-arc-header-protocol.js';
const error=()=>new Error('Little Arc header changed or is unavailable. Use the trusted control tab; nothing was retried.');
export function installLittleArcHeaderBroker(api=chrome,{timeoutMs=5000}={}){
 const DIRECT_AUTHORITY='littleArcDirectAuthorityV1';
 const ledger=createLittleArcDispatchLedger(api);
 const sessions=new Map(),challenges=new Map(),removers=[];
 const listen=(event,fn)=>{event?.addListener(fn);removers.push(()=>event?.removeListener(fn));};
 const close=s=>{if(!s.alive)return;s.alive=false;s.grant=null;sessions.delete(s.source.tabId);challenges.delete(s.challenge);try{s.top.disconnect();}catch{}try{s.frame?.disconnect();}catch{}};
 const post=(port,message)=>{try{port.postMessage(message);}catch{}};
 const pairing=async()=>{const data=await api.storage.local.get([PEER_KEY,PAIRING_GENERATION_KEY]);return {peerId:data[PEER_KEY],generation:data[PAIRING_GENERATION_KEY]??null};};
 async function sourceLive(s,active=false){
  if(!s.alive)throw error();const [tab,window]=await Promise.all([api.tabs.get(s.source.tabId),api.windows.get(s.source.windowId)]);
  if(!s.alive||tab.windowId!==s.source.windowId||tab.incognito||tab.pinned||tab.splitViewId!==undefined&&tab.splitViewId!==-1||window.incognito||window.type!=='normal'||tab.url!==s.source.url||tab.pendingUrl&&tab.pendingUrl!==tab.url||!isTransientUrl(tab.url)||active&&(!tab.active||!window.focused))throw error();
 }
 async function directLive(s){
  await sourceLive(s,true);
  const proof=await api.tabs.sendMessage(s.source.tabId,{type:'littleArcHeaderLiveProbe'},{frameId:0});
  if(!s.alive||!proof||proof.challenge!==s.challenge||proof.url!==s.source.url||proof.safe!==true)throw error();
  await sourceLive(s,true);
 }
 async function call(s,action,fields={},beforeDispatch=null){
  const current=await pairing();if(!s.alive||current.peerId!==s.pair.peerId||current.generation!==s.pair.generation||!isExtensionId(current.peerId))throw error();
  let timer;
  if(beforeDispatch)beforeDispatch();
  try{
   const response=await Promise.race([api.runtime.sendMessage(current.peerId,{type:HEADER_TYPE,action,source:s.source,...fields}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(error()),timeoutMs);})]);
   if(action==='directPlace'&&response?.success===true&&response.phase==='committed'&&response.tabId===s.source.tabId&&response.windowId===s.target?.windowId&&response.spaceId===s.target?.spaceId)await ledger.retire(s.source.tabId,s.operation);
   const after=await pairing();if(!s.alive||after.peerId!==current.peerId||after.generation!==current.generation||response?.success!==true)throw error();
   if(action==='directPrepare'){if(!exact(response,['success','authorization','expiresInMs'])||!uuid(response.authorization)||response.expiresInMs!==15000)throw error();return response;}
   if(action==='directPlace'){if(response.phase!=='committed'||response.tabId!==s.source.tabId)throw error();return response;}
   if(action==='directRevoke')return response;
   if(action==='inspect'){if(!exact(response,['success','context']))throw error();return response.context===null?null:validateHeaderContext(response.context);}
   if(!exact(response,['success','reviewReady'])||response.reviewReady!==true)throw error();return response;
  }finally{clearTimeout(timer);}
 }
 async function prepare(s){await sourceLive(s);const value=await call(s,'inspect');const context=value?{...value,siteHostname:new URL(s.source.url).hostname}:null;if(!context){post(s.top,{kind:'untracked'});close(s);return;}s.context=context;s.locked=await ledger.blocked(s.source.tabId);if(!s.locked)s.consumed=false;s.grant=null;return context;}
 const connected=port=>{
  const sender=port.sender;
  if(![HEADER_TOP_PORT,HEADER_FRAME_PORT].includes(port.name))return;
  const own=sender?.id===api.runtime.id&&!sender.tab?.incognito&&positive(sender.tab?.id)&&positive(sender.tab?.windowId)&&(!sender.documentLifecycle||sender.documentLifecycle==='active');
  if(!own){port.disconnect();return;}
  if(port.name===HEADER_TOP_PORT){
   let url;try{url=new URL(sender.url);}catch{port.disconnect();return;}
   if(sender.frameId!==0||!isTransientUrl(sender.url)||sender.origin&&sender.origin!==url.origin){port.disconnect();return;}
   const prior=sessions.get(sender.tab.id);if(prior)close(prior);
   const s={alive:true,top:port,source:{tabId:sender.tab.id,windowId:sender.tab.windowId,url:sender.url},challenge:crypto.randomUUID(),connection:crypto.randomUUID(),context:null,consumed:false,grant:null,presentation:null};sessions.set(s.source.tabId,s);
   port.onDisconnect.addListener(()=>close(s));let begun=false;
   port.onMessage.addListener(async message=>{
    // A scoped, already-authenticated top port can only close its own chooser.
    // This never touches grants, revisions, destinations or placement state.
    if(begun&&s.alive&&sessions.get(s.source.tabId)===s&&exact(message,['kind','mode'])&&message.kind==='systemScheme'&&['light','dark'].includes(message.mode)){s.systemMode=message.mode;if(s.frame)post(s.frame,{kind:'systemScheme',mode:s.systemMode});return;}
    if(begun&&s.alive&&sessions.get(s.source.tabId)===s&&exact(message,['kind'])&&message.kind==='dismissPicker'){if(s.frame)post(s.frame,{kind:'dismissPicker'});return;}
    if(begun&&exact(message,['kind','safe'])&&message.kind==='presentation'&&typeof message.safe==='boolean'){s.presentation={safe:message.safe,at:Date.now()};if(!message.safe)s.grant=null;return;}
    if(begun||!exact(message,['kind'])||message.kind!=='hello'){close(s);return;}begun=true;
    try{s.pair=await pairing();if(!isExtensionId(s.pair.peerId))throw error();if(!await prepare(s))return;
     challenges.set(s.challenge,s);s.expires=Date.now()+30000;post(port,{kind:'mount',challenge:s.challenge});
    }catch{post(port,{kind:'unavailable'});close(s);}
   });return;
  }
  if(sender.url!==api.runtime.getURL(HEADER_PAGE)||sender.origin&&sender.origin!==api.runtime.getURL('').replace(/\/$/,'')||!positive(sender.frameId)){port.disconnect();return;}
  let bound=null,attempted=false,queue=Promise.resolve();
  port.onDisconnect.addListener(()=>{if(bound)close(bound);});
  const handle=async (message,revision)=>{
   try{
    if(!bound){
     if(attempted||!exact(message,['kind','challenge'])||message.kind!=='bind'||!uuid(message.challenge))throw error();attempted=true;
     const s=challenges.get(message.challenge);challenges.delete(message.challenge);
     if(!s?.alive||s.frame||s.expires<Date.now()||sender.tab.id!==s.source.tabId||sender.tab.windowId!==s.source.windowId)throw error();
     await sourceLive(s);const current=await pairing();if(!s.alive||current.peerId!==s.pair.peerId||current.generation!==s.pair.generation)throw error();
     bound=s;s.frame=port;if(s.systemMode)post(port,{kind:'systemScheme',mode:s.systemMode});post(s.top,{kind:'bound'});post(port,{kind:'context',context:s.context});if(s.locked)post(port,{kind:'placementLocked'});return;
    }
    const s=bound;await sourceLive(s);
    if(exact(message,['kind'])&&message.kind==='refresh'){const context=await prepare(s);if(context){post(port,{kind:'context',context});if(s.locked)post(port,{kind:'placementLocked'});}return;}
    if(exact(message,['kind','mode'])&&message.kind==='colorScheme'&&['light','dark'].includes(message.mode)){post(s.top,{kind:'colorScheme',mode:message.mode});return;}
    if(exact(message,['kind','rects'])&&message.kind==='hitRegions'&&validHitRegions(message.rects)){post(s.top,{kind:'hitRegions',rects:message.rects});return;}
    if(exact(message,['kind','collapsed','advanced','height'])&&message.kind==='resize'&&typeof message.collapsed==='boolean'&&typeof message.advanced==='boolean'&&Number.isInteger(message.height)&&message.height>=28&&message.height<=480){post(s.top,{kind:'resize',collapsed:message.collapsed,advanced:message.advanced,height:message.height});return;}
    if(exact(message,['kind'])&&message.kind==='cancelDirect'){s.grant=null;await call(s,'directRevoke',{connection:s.connection});return;}
    if(exact(message,['kind','target'])&&message.kind==='placeDirect'){
     const target=message.target;
     const valid=c=>exact(target,['windowId','spaceId','bookmarkFolderId'])&&c?.directEnabled===true&&c.windows.some(w=>w.id===target.windowId)&&c.spaces.some(v=>v.id===target.spaceId&&v.bookmarkFolderId===target.bookmarkFolderId);
     const check=()=>{if(!s.alive||s.revision!==revision||s.locked||!s.presentation?.safe||Date.now()-s.presentation.at>1500)throw error();};
     try{
      check();if(s.consumed||!valid(s.context)||await ledger.blocked(s.source.tabId))throw error();
      const oldSpace=s.context.spaces.find(v=>v.id===target.spaceId);
      const fresh=await call(s,'inspect');check();
      if(!valid(fresh)||fresh.spaces.find(v=>v.id===target.spaceId).name!==oldSpace.name)throw error();
      s.context=fresh;await directLive(s);check();
      let prepared;s.preparing=structuredClone(target);
      try{prepared=await call(s,'directPrepare',{target,connection:s.connection});}finally{s.preparing=null;}
      check();s.grant={authorization:prepared.authorization,expires:Date.now()+prepared.expiresInMs};s.executing=prepared.authorization;s.target=structuredClone(target);
      await directLive(s);check();
      s.operation=crypto.randomUUID();await ledger.claim(s.source.tabId,s.source.windowId,s.operation);
      // From here a lost worker/acknowledgement is fail-closed. Never reset this
      // fence through a refresh or reconnect, even if dispatch itself is uncertain.
      s.locked=true;s.consumed=true;
      const result=await call(s,'directPlace',{connection:s.connection,authorization:prepared.authorization},()=>{if(!s.alive||s.revision!==revision||s.grant?.authorization!==prepared.authorization)throw error();s.dispatched=true;});
      post(port,{kind:'directCommitted',focused:result.focused===true,controllerClosed:result.controllerClosed===true});
     }finally{
      // This worker can prove no send occurred. A crash/lost response cannot take
      // this path; the persistent fence then remains for read-only reconciliation.
      if(s.locked&&!s.dispatched){try{await ledger.retire(s.source.tabId,s.operation);s.locked=false;s.consumed=false;}catch{}}
      s.grant=null;s.executing=null;s.preparing=null;if(s.locked)post(port,{kind:'placementLocked'});
     }
     return;
    }
    if(exact(message,['kind'])&&message.kind==='sizeSettings'){
     if(s.consumed&&!s.locked)throw error();s.grant=null;s.consumed=true;await sourceLive(s,true);await call(s,'settings',{viewId:s.context.viewId});post(port,{kind:'reviewReady'});return;
    }
    if(exact(message,['kind','target'])&&message.kind==='review'){
     const target=message.target;if(s.consumed&&(!s.locked||target!==null))throw error();
     if(target!==null&&(!exact(target,['windowId','spaceId','bookmarkFolderId'])||!s.context.windows.some(w=>w.id===target.windowId)||!s.context.spaces.some(v=>v.id===target.spaceId&&v.bookmarkFolderId===target.bookmarkFolderId)))throw error();
     s.grant=null;s.consumed=true;await sourceLive(s,true);await call(s,'review',{viewId:s.context.viewId,target});post(port,{kind:'reviewReady'});return;
    }
    throw error();
   }catch{post(port,{kind:'error',message:error().message});if(!bound)port.disconnect();}
  };
  port.onMessage.addListener(message=>{
   // Claim synchronously, before queuing/awaiting; discard concurrent duplicates,
   // including when the first request later fails before dispatch.
   const s=bound,isPlace=message?.kind==='placeDirect';
   if(isPlace&&s){if(s.inFlight||s.locked)return Promise.resolve();s.inFlight=true;}
   let revision=s?.revision??0;
   if(s&&['placeDirect','cancelDirect','refresh','review','sizeSettings'].includes(message?.kind)){revision=s.revision=(s.revision??0)+1;s.grant=null;}
   const work=()=>handle(message,revision).finally(()=>{if(isPlace&&s)s.inFlight=false;});
   queue=queue.then(work).catch(()=>post(port,{kind:'error',message:error().message}));return queue;
  });

 };
 listen(api.runtime.onMessageExternal,(message,sender,respond)=>{
  if(message?.type!==DIRECT_AUTHORITY)return;
  const verify=async()=>{
   const pair=await pairing();
   if(sender.id!==pair.peerId||sender.tab||sender.url&&sender.url!==`chrome-extension://${pair.peerId}/background.js`||sender.origin&&sender.origin!==`chrome-extension://${pair.peerId}`||!(exact(message,['type','connection','authorization','source'])||exact(message,['type','connection','authorization','source','target'])))return {authorized:false};
   const s=sessions.get(message.source?.tabId);
   if(message.authorization===null){
    if(!s?.alive||s.connection!==message.connection||!s.preparing||s.context.directEnabled!==true||s.pair.peerId!==pair.peerId||s.pair.generation!==pair.generation||!['tabId','windowId','url'].every(k=>s.source[k]===message.source[k])||!['windowId','spaceId','bookmarkFolderId'].every(k=>s.preparing[k]===message.target?.[k]))return {authorized:false};
    const pending=s.preparing,revision=s.revision;await directLive(s);return {authorized:s.alive&&s.preparing===pending&&s.revision===revision};
   }
   if(!s?.alive||s.connection!==message.connection||s.executing!==message.authorization||!s.grant||s.grant.authorization!==message.authorization||s.grant.expires<=Date.now()||s.pair.peerId!==pair.peerId||s.pair.generation!==pair.generation||!['tabId','windowId','url'].every(k=>s.source[k]===message.source[k])||!s.presentation?.safe||Date.now()-s.presentation.at>1500)return {authorized:false};
   await directLive(s);return {authorized:s.alive&&s.executing===message.authorization&&s.grant?.authorization===message.authorization&&s.grant.expires>Date.now()&&s.presentation?.safe===true&&Date.now()-s.presentation.at<=1500};
  };
  verify().then(respond,()=>respond({authorized:false}));return true;
 });
 listen(api.runtime.onConnect,connected);
 const invalidate=id=>{const s=sessions.get(id);if(s)close(s);};
 listen(api.tabs.onUpdated,(id,change)=>{if(['url','pendingUrl','pinned','splitViewId'].some(k=>Object.hasOwn(change,k))||change.status==='loading')invalidate(id);
  if(change.status==='complete'||Object.hasOwn(change,'url'))Promise.resolve(api.tabs.sendMessage(id,{type:'littleArcHeaderRefresh'},{frameId:0})).catch(()=>{});});
 listen(api.tabs.onRemoved,id=>{invalidate(id);void ledger.retire(id,null).catch(()=>{});});listen(api.tabs.onDetached,invalidate);listen(api.tabs.onAttached,invalidate);listen(api.tabs.onReplaced,(added,removed)=>{invalidate(added);invalidate(removed);});
 listen(api.windows.onRemoved,id=>{for(const s of [...sessions.values()])if(s.source.windowId===id)close(s);});
 listen(api.storage.onChanged,(changes,area)=>{if(area==='local'&&[PEER_KEY,PAIRING_GENERATION_KEY].some(k=>Object.hasOwn(changes,k)))for(const s of [...sessions.values()])close(s);});
 return {dispose(){for(const s of [...sessions.values()])close(s);removers.forEach(fn=>fn());},sessions};
}
