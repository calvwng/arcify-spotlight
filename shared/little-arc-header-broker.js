import {createLittleArcDispatchLedger} from './little-arc-dispatch-ledger.js';
import { PEER_KEY,PAIRING_GENERATION_KEY,isTransientUrl,isExtensionId } from './arcify-bridge-protocol.js';
import { HEADER_TYPE,HEADER_TOP_PORT,HEADER_FRAME_PORT,HEADER_PAGE,exact,positive,uuid,validateHeaderContext,validHitRegions } from './little-arc-header-protocol.js';
const error=()=>new Error('Little Arc header changed or is unavailable. Use the trusted control tab; nothing was retried.');
export function installLittleArcHeaderBroker(api=chrome,{timeoutMs=5000}={}){
 const DIRECT_AUTHORITY='littleArcDirectAuthorityV1',RECOVERY_AUTHORITY='littleArcControlsRecoveryAuthority';
 const ledger=createLittleArcDispatchLedger(api);
 const sessions=new Map(),challenges=new Map(),removers=[];
 const listen=(event,fn)=>{event?.addListener(fn);removers.push(()=>event?.removeListener(fn));};
 const close=s=>{if(!s.alive)return;s.alive=false;s.grant=null;s.recovery=null;sessions.delete(s.source.tabId);challenges.delete(s.challenge);try{s.top.disconnect();}catch{}try{s.frame?.disconnect();}catch{}};
 const post=(port,message)=>{try{port.postMessage(message);}catch{}};
 const pairing=async()=>{const data=await api.storage.local.get([PEER_KEY,PAIRING_GENERATION_KEY]);return {peerId:data[PEER_KEY],generation:data[PAIRING_GENERATION_KEY]??null};};
 async function sourceLive(s,active=false){
  if(!s.alive)throw error();const [tab,window]=await Promise.all([api.tabs.get(s.source.tabId),api.windows.get(s.source.windowId)]);
  if(!s.alive||tab.id!==s.source.tabId||window.id!==s.source.windowId||tab.windowId!==s.source.windowId||tab.incognito||tab.pinned||tab.splitViewId!==undefined&&tab.splitViewId!==-1||window.incognito||window.type!=='normal'||tab.url!==s.source.url||tab.pendingUrl&&tab.pendingUrl!==tab.url||!isTransientUrl(tab.url)||active&&(!tab.active||!window.focused))throw error();
 }
 async function directLive(s){
  await sourceLive(s,true);
  const proof=await api.tabs.sendMessage(s.source.tabId,{type:'littleArcHeaderLiveProbe'},{frameId:0,...(s.documentId?{documentId:s.documentId}:{})});
  if(!s.alive||!proof||proof.challenge!==s.challenge||proof.url!==s.source.url||proof.safe!==true)throw error();
  await sourceLive(s,true);
 }
 async function call(s,action,fields={},beforeDispatch=null,deadlineMs=timeoutMs){
  const current=await pairing();if(!s.alive||current.peerId!==s.pair.peerId||current.generation!==s.pair.generation||!isExtensionId(current.peerId))throw error();
  let timer;
  if(beforeDispatch)beforeDispatch();
  try{
   const response=await Promise.race([api.runtime.sendMessage(current.peerId,{type:HEADER_TYPE,action,source:s.source,...fields}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(error()),deadlineMs);})]);
   if(action==='directPlace'&&response?.success===true&&response.phase==='committed'&&response.tabId===s.source.tabId&&response.windowId===s.target?.windowId&&response.spaceId===s.target?.spaceId)await ledger.retire(s.source.tabId,s.operation);
   const after=await pairing();if(!s.alive||after.peerId!==current.peerId||after.generation!==current.generation||response?.success!==true)throw error();
   if(action==='directPrepare'){if(!exact(response,['success','authorization','expiresInMs'])||!uuid(response.authorization)||response.expiresInMs!==15000)throw error();return response;}
   if(action==='directPlace'){if(response.phase!=='committed'||response.tabId!==s.source.tabId)throw error();return response;}
   if(action==='directRevoke')return response;
   if(action==='inspect'){if(!exact(response,['success','context']))throw error();return response.context===null?null:validateHeaderContext(response.context);}
   if(!exact(response,['success','reviewReady'])||response.reviewReady!==true)throw error();return response;
  }finally{clearTimeout(timer);}
 }
 async function prepare(s){await sourceLive(s);const value=await call(s,'inspect');const context=value?{...value,siteHostname:new URL(s.source.url).hostname}:null;if(!context){post(s.top,{kind:'untracked'});close(s);return;}s.context=context;s.presentation=null;s.preparing=null;s.locked=await ledger.blocked(s.source.tabId);if(!s.locked)s.consumed=false;s.grant=null;return context;}
 const refreshReturned=async s=>{
  if(!s.alive||!s.frame||!s.settingsUsed)return;
  if(s.inFlight){s.returnRequested=true;return;}
  if(s.settingsDispatched)return;
  s.inFlight=true;s.returnRequested=false;const revision=s.revision=(s.revision??0)+1;
  try{await sourceLive(s,true);const context=await prepare(s);if(!s.alive||s.revision!==revision||!context)return;s.settingsUsed=false;post(s.frame,{kind:'context',context});if(s.locked)post(s.frame,{kind:'placementLocked'});}
  catch{if(s.alive)post(s.frame,{kind:'error',message:error().message});}
  finally{s.inFlight=false;if(s.returnRequested){s.returnRequested=false;void refreshReturned(s);}}
 };
 const connected=port=>{
  const sender=port.sender;
  if(![HEADER_TOP_PORT,HEADER_FRAME_PORT].includes(port.name))return;
  const own=sender?.id===api.runtime.id&&!sender.tab?.incognito&&positive(sender.tab?.id)&&positive(sender.tab?.windowId)&&(!sender.documentLifecycle||sender.documentLifecycle==='active');
  if(!own){port.disconnect();return;}
  if(port.name===HEADER_TOP_PORT){
   let url;try{url=new URL(sender.url);}catch{port.disconnect();return;}
   if(sender.frameId!==0||!isTransientUrl(sender.url)||sender.origin&&sender.origin!==url.origin){port.disconnect();return;}
   const prior=sessions.get(sender.tab.id);if(prior)close(prior);
   const s={alive:true,top:port,source:{tabId:sender.tab.id,windowId:sender.tab.windowId,url:sender.url},challenge:crypto.randomUUID(),connection:crypto.randomUUID(),documentId:typeof sender.documentId==='string'&&sender.documentId?sender.documentId:null,context:null,consumed:false,grant:null,presentation:null};sessions.set(s.source.tabId,s);
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
    if(exact(message,['kind'])&&message.kind==='refresh'){const context=await prepare(s);if(context){if(!s.settingsDispatched)s.settingsUsed=false;post(port,{kind:'context',context});if(s.locked)post(port,{kind:'placementLocked'});}return;}
    if(exact(message,['kind','mode'])&&message.kind==='colorScheme'&&['light','dark'].includes(message.mode)){post(s.top,{kind:'colorScheme',mode:message.mode});return;}
    if(exact(message,['kind','rects'])&&message.kind==='hitRegions'&&validHitRegions(message.rects)){post(s.top,{kind:'hitRegions',rects:message.rects});return;}
    if(exact(message,['kind','collapsed','advanced','height'])&&message.kind==='resize'&&typeof message.collapsed==='boolean'&&typeof message.advanced==='boolean'&&Number.isInteger(message.height)&&message.height>=28&&message.height<=480){post(s.top,{kind:'resize',collapsed:message.collapsed,advanced:message.advanced,height:message.height});return;}
    if(exact(message,['kind'])&&message.kind==='cancelDirect'){s.grant=null;await call(s,'directRevoke',{connection:s.connection});return;}
    if(exact(message,['kind','target'])&&message.kind==='placeDirect'){
     const target=message.target;
     const valid=c=>!c?.controlsMissing&&exact(target,['windowId','spaceId','bookmarkFolderId'])&&c?.directEnabled===true&&c.windows.some(w=>w.id===target.windowId)&&c.spaces.some(v=>v.id===target.spaceId&&v.bookmarkFolderId===target.bookmarkFolderId);
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
     if(s.settingsDispatched||s.settingsUsed||s.consumed&&!s.locked)throw error();
     const source={...s.source};
     const current=()=>{if(!s.alive||sessions.get(source.tabId)!==s||s.revision!==revision||!['tabId','windowId','url'].every(key=>s.source[key]===source[key]))throw error();};
     s.grant=null;s.consumed=true;s.settingsUsed=true;current();await sourceLive(s,true);current();
     // Views expire independently of the mounted header. Refresh this read-only
     // context once before settings, without resetting placement/dispatch fences.
     const fresh=await call(s,'inspect');current();if(!fresh)throw error();
     await sourceLive(s,true);current();
     s.context={...fresh,siteHostname:new URL(source.url).hostname};if(fresh.controlsMissing){s.grant=null;s.preparing=null;s.presentation=null;}
     post(port,{kind:'settingsContext',context:s.context});
     await sourceLive(s,true);current();
     if(s.context.controlsMissing){
      await directLive(s);current();
      const request={viewId:s.context.viewId,connection:s.connection,requestId:crypto.randomUUID()};
      const pending={...request,source:{...s.source},revision,expires:Date.now()+15000,stages:new Set(),authorizedStages:new Set()};s.recovery=pending;
      try{await call(s,'recoverControls',request,()=>{current();if(s.settingsDispatched)throw error();s.settingsDispatched=true;},15000);if(!pending.authorizedStages.has('prepare')||!pending.authorizedStages.has('commit'))throw error();}finally{if(s.recovery===pending)s.recovery=null;}
     }else await call(s,'settings',{viewId:s.context.viewId},()=>{current();if(s.settingsDispatched)throw error();s.settingsDispatched=true;});
     current();s.settingsDispatched=false;post(port,{kind:'reviewReady'});return;
    }
    if(exact(message,['kind','target'])&&message.kind==='review'){
     const target=message.target;if(s.context?.controlsMissing)throw error();if(s.consumed&&(!s.locked||target!==null))throw error();
     if(target!==null&&(!exact(target,['windowId','spaceId','bookmarkFolderId'])||!s.context.windows.some(w=>w.id===target.windowId)||!s.context.spaces.some(v=>v.id===target.spaceId&&v.bookmarkFolderId===target.bookmarkFolderId)))throw error();
     s.grant=null;s.consumed=true;await sourceLive(s,true);await call(s,'review',{viewId:s.context.viewId,target});post(port,{kind:'reviewReady'});return;
    }
    throw error();
   }catch{post(port,{kind:'error',message:error().message});if(!bound)port.disconnect();}
  };
  port.onMessage.addListener(message=>{
   // Claim synchronously, before queuing/awaiting; discard concurrent duplicates,
   // including when the first request later fails before dispatch.
   const s=bound,isPlace=message?.kind==='placeDirect',isSettings=message?.kind==='sizeSettings';
   if((isPlace||isSettings)&&s){if(s.inFlight||isPlace&&s.locked||isSettings&&(s.settingsDispatched||s.settingsUsed))return Promise.resolve();s.inFlight=true;}
   let revision=s?.revision??0;
   if(s&&['placeDirect','cancelDirect','refresh','review','sizeSettings'].includes(message?.kind)){revision=s.revision=(s.revision??0)+1;s.grant=null;}
   const work=()=>handle(message,revision).finally(()=>{if((isPlace||isSettings)&&s){s.inFlight=false;if(s.returnRequested){s.returnRequested=false;void refreshReturned(s);}}});
   queue=queue.then(work).catch(()=>post(port,{kind:'error',message:error().message}));return queue;
  });

 };
 listen(api.runtime.onMessageExternal,(message,sender,respond)=>{
  if(message?.type==='littleArcControlsClosed'){
   const refreshClosed=async()=>{
    if(!exact(message,['type','version','generation','source'])||message.version!==1||!exact(message.source,['tabId','windowId','url']))return {accepted:false};
    const s=sessions.get(message.source.tabId),pair=await pairing();
    if(!s?.alive||sessions.get(s.source.tabId)!==s||message.generation!==pair.generation||sender.id!==pair.peerId||sender.tab||sender.url&&sender.url!==`chrome-extension://${pair.peerId}/background.js`||sender.origin&&sender.origin!==`chrome-extension://${pair.peerId}`||pair.peerId!==s.pair.peerId||pair.generation!==s.pair.generation||!['tabId','windowId','url'].every(k=>s.source[k]===message.source[k]))return {accepted:false};
    await directLive(s);const after=await pairing();
    if(!s.alive||sessions.get(s.source.tabId)!==s||after.peerId!==pair.peerId||after.generation!==pair.generation)return {accepted:false};
    await refreshReturned(s);return {accepted:true};
   };
   refreshClosed().then(respond,()=>respond({accepted:false}));return true;
  }
  if(message?.type===RECOVERY_AUTHORITY){
   const verifyRecovery=async()=>{
    if(!exact(message,['type','stage','source','viewId','connection','requestId'])||!['prepare','commit'].includes(message.stage)||!exact(message.source,['tabId','windowId','url']))return {authorized:false};
    const s=sessions.get(message.source?.tabId),pending=s?.recovery;
    const valid=()=>s?.alive&&sessions.get(s.source.tabId)===s&&s.recovery===pending&&pending&&pending.expires>Date.now()&&s.revision===pending.revision&&['tabId','windowId','url'].every(k=>pending.source[k]===message.source[k])&&['viewId','connection','requestId'].every(k=>pending[k]===message[k]);
    const pair=await pairing();
    if(!valid()||sender.id!==pair.peerId||sender.tab||sender.url&&sender.url!==`chrome-extension://${pair.peerId}/background.js`||sender.origin&&sender.origin!==`chrome-extension://${pair.peerId}`||pair.peerId!==s.pair.peerId||pair.generation!==s.pair.generation||pending.stages.has(message.stage)||message.stage==='commit'&&!pending.authorizedStages.has('prepare'))return {authorized:false};
    pending.stages.add(message.stage);
    await directLive(s);const after=await pairing();
    const authorized=!!valid()&&after.peerId===pair.peerId&&after.generation===pair.generation;if(authorized)pending.authorizedStages.add(message.stage);return {authorized};
   };
   verifyRecovery().then(respond,()=>respond({authorized:false}));return true;
  }
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
 listen(api.tabs.onActivated,info=>{const s=sessions.get(info.tabId);if(s&&s.source.windowId===info.windowId)void refreshReturned(s);});
 listen(api.windows.onFocusChanged,id=>{for(const s of sessions.values())if(s.source.windowId===id)void refreshReturned(s);});
 listen(api.tabs.onRemoved,id=>{invalidate(id);void ledger.retire(id,null).catch(()=>{});});listen(api.tabs.onDetached,invalidate);listen(api.tabs.onAttached,invalidate);listen(api.tabs.onReplaced,(added,removed)=>{invalidate(added);invalidate(removed);});
 listen(api.windows.onRemoved,id=>{for(const s of [...sessions.values()])if(s.source.windowId===id)close(s);});
 listen(api.storage.onChanged,(changes,area)=>{if(area==='local'&&[PEER_KEY,PAIRING_GENERATION_KEY].some(k=>Object.hasOwn(changes,k)))for(const s of [...sessions.values()])close(s);});
 return {dispose(){for(const s of [...sessions.values()])close(s);removers.forEach(fn=>fn());},sessions};
}
