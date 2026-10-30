import { HEADER_TOP_PORT,HEADER_PAGE,validHitRegions } from './little-arc-header-protocol.js';
import { PEER_KEY,PAIRING_GENERATION_KEY,isTransientUrl } from './arcify-bridge-protocol.js';
// No page-message receiver. The private challenge travels only from the runtime
// Port to the extension-origin frame, never in a DOM attribute or frame URL.
export function installLittleArcHeaderContent({api=chrome,document=globalThis.document,window=globalThis.window}={}){
 if(window.top!==window||!isTransientUrl(window.location.href))return {dispose(){}};
 if(window.__arcifyLittleArcHeader)return window.__arcifyLittleArcHeader;
 let port=null,host=null,frame=null,observer=null,disposed=false,challenge=null,collapsed=false,advanced=false,measuredHeight=96,reconnects=0,reconnectTimer=null,bindTimer=null,presentationTimer=null;
 const remove=()=>{if(presentationTimer!==null){clearInterval(presentationTimer);presentationTimer=null;}if(bindTimer!==null){clearTimeout(bindTimer);bindTimer=null;}observer?.disconnect();observer=null;host?.remove();host=frame=null;challenge=null;};
 const disconnect=()=>{if(reconnectTimer!==null){clearTimeout(reconnectTimer);reconnectTimer=null;}const old=port;port=null;try{old?.disconnect();}catch{}remove();};
 // Set the reset and its overrides atomically: mutating one CSSOM longhand
 // after an important all shorthand can re-expand/reset sibling longhands.
 const resize=()=>{const height=Math.max(28,Math.min(measuredHeight,Math.max(28,(window.innerHeight||600)-16)))+'px';if(host)host.setAttribute('style',`all:initial!important;position:fixed!important;top:8px!important;left:8px!important;right:8px!important;height:${height}!important;z-index:2147483647!important;display:${document.fullscreenElement?'none':'block'}!important;pointer-events:none!important;`);};
 const systemMedia=window.matchMedia?.('(prefers-color-scheme: dark)');
 const reportSystemScheme=()=>{if(port)try{port.postMessage({kind:'systemScheme',mode:systemMedia?.matches?'dark':'light'});}catch{}};
 systemMedia?.addEventListener?.('change',reportSystemScheme);
 const visibility=()=>resize();
 // A genuine top-document pointer event can dismiss this header's chooser only.
 // No preventDefault/stopPropagation, no page messages, no destination payload.
 const outsidePointer=event=>{if(!event.isTrusted||!host||!frame||!port||!challenge||event.composedPath?.().includes(host)||host.contains(event.target))return;try{port.postMessage({kind:'dismissPicker'});}catch{}};
 const safePresentation=()=>{try{const rect=host?.getBoundingClientRect(),style=host&&window.getComputedStyle(host);const top=document.elementFromPoint(Math.max(10,Math.min(window.innerWidth-10,(rect?.left||0)+20)),Math.max(10,(rect?.top||0)+20));return !!(host?.isConnected&&!collapsed&&!document.prerendering&&!document.fullscreenElement&&document.visibilityState==='visible'&&document.hasFocus()&&rect.width>=240&&Math.abs(rect.height-Math.max(28,Math.min(measuredHeight,Math.max(28,(window.innerHeight||600)-16))))<=2&&Math.abs(rect.width-(window.innerWidth-16))<=2&&Math.abs(rect.left-8)<=2&&Math.abs(rect.top-8)<=2&&rect.top>=0&&rect.bottom<=window.innerHeight&&style.visibility==='visible'&&Number(style.opacity)===1&&top===host);}catch{return false;}};

 function mount(){
  if(disposed||!port||!challenge||host||!document.body)return;
  host=document.createElement('div');host.id='arcify-little-arc-header-host';
  host.setAttribute('style','all:initial!important;position:fixed!important;top:8px!important;left:8px!important;right:8px!important;height:150px;z-index:2147483647!important;display:block!important;pointer-events:none!important;');
  const shadow=host.attachShadow({mode:'closed'});
  frame=document.createElement('iframe');frame.src=api.runtime.getURL(HEADER_PAGE);frame.title='Little Arc temporary page controls';
  frame.setAttribute('style','border:0;width:100%;height:100%;display:block;pointer-events:auto;color-scheme:light dark;');
  const mountedFrame=frame,mountedPort=port,nonce=challenge;
  frame.addEventListener('load',()=>{if(frame===mountedFrame&&port===mountedPort&&challenge===nonce&&frame.contentWindow)frame.contentWindow.postMessage({kind:'littleArcHeaderBootstrap',challenge,collapsed,advanced},api.runtime.getURL('').replace(/\/$/,''));},{once:true});
  frame.addEventListener('error',()=>{if(frame===mountedFrame&&port===mountedPort)disconnect();},{once:true});
  shadow.append(frame);document.body.append(host);resize();visibility();
  bindTimer=setTimeout(()=>{bindTimer=null;if(frame===mountedFrame&&port===mountedPort)disconnect();},4000);
  if(window.MutationObserver){observer=new window.MutationObserver(()=>{if(host&&!host.isConnected)disconnect();});observer.observe(document.documentElement,{childList:true,subtree:true});}
 }
 function attempt(){
  if(disposed||port||document.fullscreenElement)return;
  try{
   const current=api.runtime.connect({name:HEADER_TOP_PORT});port=current;
   current.onDisconnect.addListener(()=>{void api.runtime.lastError;if(port===current){port=null;remove();if(!disposed&&reconnects<2){const delay=++reconnects*500;reconnectTimer=setTimeout(()=>{reconnectTimer=null;attempt();},delay);}}});
   current.onMessage.addListener(message=>{
    if(port!==current)return;
    if(message?.kind==='mount'&&typeof message.challenge==='string'){challenge=message.challenge;mount();}
    else if(message?.kind==='bound'){
     reportSystemScheme();reconnects=0;if(presentationTimer!==null)clearInterval(presentationTimer);
     const report=()=>{try{current.postMessage({kind:'presentation',safe:safePresentation()});}catch{}};
     report();presentationTimer=setInterval(report,500);
     if(bindTimer!==null){clearTimeout(bindTimer);bindTimer=null;}}
    else if(message?.kind==='colorScheme'&&Object.keys(message).length===2&&['light','dark'].includes(message.mode)&&frame)frame.style.setProperty('color-scheme',message.mode);
    else if(message?.kind==='hitRegions'&&Object.keys(message).length===2&&validHitRegions(message.rects)&&frame){
     const width=Math.max(0,(window.innerWidth||0)-16),height=Math.max(28,Math.min(measuredHeight,Math.max(28,(window.innerHeight||600)-16)));
     const paths=message.rects.map(([x,y,w,h])=>{const a=Math.min(x,width),b=Math.min(y,height),c=Math.min(x+w,width),d=Math.min(y+h,height);return `M ${a} ${b} H ${c} V ${d} H ${a} Z`;});
     frame.style.setProperty('clip-path',`path('${paths.join(' ')||'M 0 0 Z'}')`);
    }
    else if(message?.kind==='resize'&&typeof message.collapsed==='boolean'&&Number.isInteger(message.height)&&message.height>=28&&message.height<=480){collapsed=message.collapsed;advanced=message.advanced===true;measuredHeight=message.height;resize();}
    else if(['untracked','unavailable'].includes(message?.kind))disconnect();
   });current.postMessage({kind:'hello'});
  }catch{disconnect();}
 }
 const refresh=(message,sender,respond)=>{
  if(message?.type==='littleArcHeaderLiveProbe'&&sender.id===api.runtime.id&&!sender.tab){respond?.({challenge:port?challenge:null,safe:safePresentation(),url:window.location.href});return;}
if(message?.type==='littleArcHeaderRefresh'&&sender.id===api.runtime.id&&!sender.tab){
 // Completion is a readiness hint, not new authority. Loading/navigation already
 // invalidates the broker port. Do not reset a healthy/pending connection or view.
 if(!port)attempt();else if(challenge&&!host)mount();
}};
 const changed=(changes,area)=>{if(area==='local'&&[PEER_KEY,PAIRING_GENERATION_KEY].some(k=>Object.hasOwn(changes,k))){disconnect();attempt();}};
 const ready=()=>{mount();attempt();};
 const fullscreen=()=>{visibility();if(!document.fullscreenElement)attempt();};
 const dispose=()=>{if(disposed)return;disposed=true;systemMedia?.removeEventListener?.('change',reportSystemScheme);disconnect();api.runtime.onMessage.removeListener(refresh);api.storage.onChanged.removeListener(changed);document.removeEventListener('pointerdown',outsidePointer,true);document.removeEventListener('DOMContentLoaded',ready);document.removeEventListener('fullscreenchange',fullscreen);window.removeEventListener('resize',resize);window.removeEventListener('pagehide',hide);window.removeEventListener('pageshow',show);delete window.__arcifyLittleArcHeader;};
 api.runtime.onMessage.addListener(refresh);api.storage.onChanged.addListener(changed);
 document.addEventListener('pointerdown',outsidePointer,true);document.addEventListener('DOMContentLoaded',ready);document.addEventListener('fullscreenchange',fullscreen);window.addEventListener('resize',resize);const hide=event=>{if(event.persisted)disconnect();else dispose();};const show=event=>{if(event.persisted)attempt();};window.addEventListener('pagehide',hide);window.addEventListener('pageshow',show);
 window.__arcifyLittleArcHeader={dispose};attempt();return window.__arcifyLittleArcHeader;
}
