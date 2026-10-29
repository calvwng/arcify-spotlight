import {HEADER_FRAME_PORT,validateHeaderContext,uuid} from './little-arc-header-protocol.js';
import {deriveSpaceTheme} from './space-theme-palette.js';
export function installLittleArcHeaderFrame({api=chrome,document=globalThis.document,window=globalThis.window}={}){
 const byId=id=>document.getElementById(id),space=byId('space'),destinationWindow=byId('window'),status=byId('status');
 let port=null,context=null,pending=false,closed=false,reviewUsed=false,advancedOpen=false,locked=false,intent=null,explicit=false,lastHeight=0;
 const picker=byId('space-picker'),search=byId('space-search'),toggle=byId('space-menu-toggle');let highlighted=0;const windowLabels=new Map();
 let systemMode=null;
 const media=window.matchMedia?.('(prefers-color-scheme: dark)');
 const paintTheme=()=>{
  const mode=context?.themeMode==='dark'||context?.themeMode!=='light'&&(systemMode?systemMode==='dark':media?.matches)?'dark':'light';
  const theme=deriveSpaceTheme(context?.spaces.find(s=>s.id===space.value)?.color,mode);
  const root=document.documentElement;root.dataset.theme=mode;root.style.setProperty('color-scheme',mode);
  for(const [key,value] of Object.entries(theme))root.style.setProperty('--la-'+key,value);
  if(port)send({kind:'colorScheme',mode});
 };
 media?.addEventListener?.('change',paintTheme);paintTheme();
 const selected=()=>{const s=context?.spaces.find(v=>v.id===space.value),w=context?.windows.find(v=>String(v.id)===destinationWindow.value);return s&&w?{windowId:w.id,spaceId:s.id,bookmarkFolderId:s.bookmarkFolderId}:null;};
 const controls=()=>{for(const id of ['space','window','review','controls','refresh','size-settings'].filter(id=>byId(id)))byId(id).disabled=closed||pending||!context;byId('review').disabled ||= reviewUsed||locked||!selected();byId('controls').disabled ||= reviewUsed;if(byId('size-settings'))byId('size-settings').disabled ||= reviewUsed;byId('refresh').disabled=closed||pending||!port;if(toggle)toggle.disabled=closed||pending||!context;};
 const send=message=>{if(!closed&&port)try{port.postMessage(message);}catch{closed=true;showError('Connection lost. Use the trusted control tab.');controls();}};
 // Measure natural content, never iframe/viewport height: avoid resize feedback.
 const measure=()=>{const height=Math.max(28,Math.min(480,Math.ceil(byId('header').getBoundingClientRect().height)));if(!Number.isFinite(height))return;lastHeight=height;send({kind:'resize',collapsed:byId('expanded').hidden,advanced:advancedOpen,height});
  // Clip transparent backing so clicks reach the real page, without replay.
  const rects=['choices','space-picker','advanced','status','reopen'].map(byId).filter(e=>e&&e.getClientRects().length).map(e=>{const r=e.getBoundingClientRect(),x=Math.max(0,r.left),y=Math.max(0,r.top),right=Math.min(32768,document.documentElement.clientWidth,r.right),bottom=Math.min(height,r.bottom);return [x,y,Math.max(0,right-x),Math.max(0,bottom-y)];}).filter(r=>r[2]>0&&r[3]>0);
  send({kind:'hitRegions',rects});};
 const presentation=()=>{const more=byId('more'),advanced=byId('advanced');if(more&&advanced){advanced.hidden=!advancedOpen;more.setAttribute('aria-expanded',String(advancedOpen));}measure();};
 const showError=message=>{status.hidden=false;status.textContent=message;if(byId('expanded').hidden){byId('expanded').hidden=false;byId('reopen').hidden=true;}presentation();};
 const closePicker=(focus=false)=>{if(!picker)return;picker.hidden=true;toggle.setAttribute('aria-expanded','false');search.removeAttribute('aria-activedescendant');if(focus)toggle.focus();presentation();};
 // Only dismissal is accepted here. Parent page messages cannot choose or place.
 const outsidePointer=event=>{if(!event.isTrusted||!picker||picker.hidden||picker.contains(event.target)||toggle.contains(event.target))return;closePicker(picker.contains(document.activeElement));};
 document.addEventListener('pointerdown',outsidePointer,true);
 const dismissFromPage=()=>{if(!picker||picker.hidden)return;if(picker.contains(document.activeElement))document.activeElement.blur();closePicker();};
 const chooseSpace=(id,event)=>{if(!event.isTrusted||pending||closed||!context?.spaces.some(s=>s.id===id))return;space.value=id;explicit=true;intent=selected();send({kind:'cancelDirect'});label();closePicker(true);};
 const drawSpaces=()=>{if(!picker||!context)return;const results=byId('space-results');results.replaceChildren();const entries=context.spaces.filter(s=>s.name.toLocaleLowerCase().includes(search.value.toLocaleLowerCase().trim()));highlighted=Math.max(0,Math.min(highlighted,entries.length-1));byId('space-empty').hidden=entries.length>0;for(const [i,s] of entries.entries()){const button=document.createElement('button');button.type='button';button.id='space-option-'+i;button.setAttribute('role','option');button.setAttribute('aria-selected',String(s.id===space.value));button.dataset.highlight=String(i===highlighted);const dot=document.createElement('span');dot.className='space-dot';dot.setAttribute('aria-hidden','true');const hue=[...s.id].reduce((a,c)=>(a*31+c.charCodeAt(0))%360,0);dot.style.background=s.color||`hsl(${hue} 45% 55%)`;const name=document.createElement('span');name.textContent=s.name;button.append(dot,name);button.addEventListener('click',event=>chooseSpace(s.id,event));results.append(button);}if(entries.length)search.setAttribute('aria-activedescendant','space-option-'+highlighted);else search.removeAttribute('aria-activedescendant');presentation();return entries;};
 toggle?.addEventListener('click',event=>{if(!event.isTrusted||pending||closed||!context)return;if(!picker.hidden){closePicker(true);return;}picker.hidden=false;toggle.setAttribute('aria-expanded','true');search.value='';highlighted=0;drawSpaces();search.focus({preventScroll:true});});
 search?.addEventListener('input',()=>{highlighted=0;drawSpaces();});
 search?.addEventListener('keydown',event=>{if(!event.isTrusted)return;if(['Enter','ArrowDown','ArrowUp','Escape'].includes(event.key)){event.preventDefault();event.stopPropagation();}if(event.key==='Escape'){closePicker(true);return;}if(event.key==='ArrowDown')highlighted++;if(event.key==='ArrowUp')highlighted--;const entries=drawSpaces()||[];if(event.key==='Enter'&&entries[highlighted])chooseSpace(entries[highlighted].id,event);byId('space-option-'+highlighted)?.scrollIntoView?.({block:'nearest'});});
 picker?.addEventListener('keydown',event=>{if(event.isTrusted&&event.key==='Escape'){event.preventDefault();closePicker(true);}});
 const label=()=>{paintTheme();const s=context?.spaces.find(v=>v.id===space.value);byId('review').textContent=s?(context?.directEnabled?'Open in ':'Review for ')+s.name:'Review destination';controls();};
 const windowLabel=id=>{if(!windowLabels.has(id))windowLabels.set(id,windowLabels.size+1);return context.proposed?.windowId===id?'Originating window':'Window '+windowLabels.get(id);};
 const render=value=>{
  const previous=intent;context=validateHeaderContext(value);if(byId('domain')){byId('domain').textContent=context.siteHostname||'Temporary page';byId('domain').title=context.siteHostname||'Temporary page';}if(picker)closePicker();pending=false;reviewUsed=false;space.replaceChildren();destinationWindow.replaceChildren();
  for(const [select,list] of [[space,context.spaces],[destinationWindow,context.windows]]){
   const choose=document.createElement('option');choose.value='';choose.textContent='Choose...';select.append(choose);
   for(const [index,item] of list.entries()){const option=document.createElement('option');option.value=String(item.id);option.textContent=select===destinationWindow?windowLabel(item.id):item.name;select.append(option);}
  }
  // Intent is not authority. Missing explicit choices never become suggestions.
  const target=previous??(!explicit?context.proposed:null);
  const valid=target&&context.windows.some(w=>w.id===target.windowId)&&context.spaces.some(s=>s.id===target.spaceId&&s.bookmarkFolderId===target.bookmarkFolderId);
  if(valid){space.value=target.spaceId;destinationWindow.value=String(target.windowId);intent=structuredClone(target);}else if(target){intent=target;}
  if(!destinationWindow.value)advancedOpen=true;
  label();status.textContent=locked?'A placement was dispatched or its outcome is uncertain. Check trusted controls; do not repeat the transfer.':target&&!valid?'The selected destination changed or is unavailable. Choose a destination explicitly. Nothing was moved.':destinationWindow.value?(context.directEnabled?'Open validates this destination and moves this page once. Trusted controls are under More.':'Review here; confirm in the control tab.'):'Choose a destination window under More, then a Space. Nothing has moved.';status.hidden=!!picker&&!locked&&!!target&&valid;presentation();controls();
 };
 const safeGesture=event=>event.isTrusted&&!event.repeat&&document.visibilityState==='visible'&&document.hasFocus()&&!document.fullscreenElement&&!byId('expanded').hidden;
 const review=target=>{if(pending||closed||!context||reviewUsed)return;pending=true;controls();status.hidden=false;status.textContent='Opening trusted controls. Nothing has moved.';presentation();send({kind:'review',target});};
 const bootstrap=event=>{
  if(port||window.parent===window||event.source!==window.parent||event.data?.kind!=='littleArcHeaderBootstrap'||!uuid(event.data.challenge))return;
  const collapsed=event.data.collapsed===true;advancedOpen=event.data.advanced===true;byId('expanded').hidden=collapsed;byId('reopen').hidden=!collapsed;
  port=api.runtime.connect({name:HEADER_FRAME_PORT});
  port.onDisconnect.addListener(()=>{void api.runtime.lastError;closed=true;controls();showError('Header connection ended. Use the trusted control tab; nothing was retried.');});
  port.onMessage.addListener(message=>{
   try{
    if(message?.kind==='context')render(message.context);
    else if(message?.kind==='systemScheme'&&Object.keys(message).length===2&&['light','dark'].includes(message.mode)){systemMode=message.mode;paintTheme();}
    else if(message?.kind==='dismissPicker'&&Object.keys(message).length===1)dismissFromPage();
    else if(message?.kind==='placementLocked'){locked=true;pending=false;showError('A placement was dispatched or its outcome is uncertain. Check trusted controls; do not repeat the transfer.');controls();}
    else if(message?.kind==='directCommitted'){locked=true;pending=false;status.textContent='Page placed. Check the destination window; do not repeat the transfer.';controls();presentation();}
    else if(message?.kind==='reviewReady'){status.textContent='Review and confirm in the trusted control tab. Nothing has moved. Refresh choices here to prepare another review.';pending=false;reviewUsed=true;controls();presentation();}
    else if(message?.kind==='error'){pending=false;reviewUsed=false;context=null;showError(message.message);controls();}
   }catch{context=null;showError('Invalid choices. Use the trusted controller.');controls();}
  });port.postMessage({kind:'bind',challenge:event.data.challenge});
 };
 window.addEventListener('message',bootstrap);
 byId('choices').addEventListener('submit',event=>{event.preventDefault();if(!safeGesture(event)||pending||closed||reviewUsed||locked)return;const target=selected();if(!target)return;if(context?.directEnabled){pending=true;controls();status.hidden=false;status.textContent='Checking this destination and placing this page. Do not repeat an uncertain transfer.';presentation();send({kind:'placeDirect',target});return;}review(target);});
 byId('size-settings')?.addEventListener('click',event=>{if(!event.isTrusted||pending||closed||!context||reviewUsed)return;pending=true;controls();status.hidden=false;status.textContent='Opening trusted window size settings. Nothing has moved.';presentation();send({kind:'sizeSettings'});});
 byId('controls').addEventListener('click',event=>{if(event.isTrusted)review(null);});
 byId('refresh').addEventListener('click',event=>{if(event.isTrusted&&!pending){pending=true;controls();send({kind:'refresh'});}});
 byId('dismiss').addEventListener('click',event=>{if(event.isTrusted){send({kind:'cancelDirect'});closePicker();byId('expanded').hidden=true;byId('reopen').hidden=false;presentation();byId('reopen').focus();}});
 byId('reopen').addEventListener('click',event=>{if(event.isTrusted){byId('expanded').hidden=false;byId('reopen').hidden=true;presentation();(toggle||space).focus();}});
 byId('more')?.addEventListener('click',event=>{if(!event.isTrusted)return;advancedOpen=!advancedOpen;if(!advancedOpen&&byId('advanced')?.contains(document.activeElement))byId('more').focus();presentation();});
 for(const select of [space,destinationWindow])select.addEventListener('change',()=>{explicit=true;intent=selected();send({kind:'cancelDirect'});label();presentation();});
 const observer=window.ResizeObserver?new window.ResizeObserver(()=>{const height=Math.max(28,Math.min(480,Math.ceil(byId('header').getBoundingClientRect().height)));if(height!==lastHeight)measure();}):null;
 let scrollFrame=null;const scrolled=()=>{if(scrollFrame!==null)return;if(window.requestAnimationFrame)scrollFrame=window.requestAnimationFrame(()=>{scrollFrame=null;measure();});else measure();};
 observer?.observe(byId('header'));window.addEventListener('resize',measure);document.addEventListener('scroll',scrolled,{capture:true,passive:true});controls();
 return {dispose(){document.removeEventListener('scroll',scrolled,true);if(scrollFrame!==null)window.cancelAnimationFrame?.(scrollFrame);media?.removeEventListener?.('change',paintTheme);document.removeEventListener('pointerdown',outsidePointer,true);observer?.disconnect();closed=true;try{port?.disconnect();}catch{}window.removeEventListener('message',bootstrap);window.removeEventListener('resize',measure);}};
}
if(typeof document!=='undefined'&&document.getElementById('header'))installLittleArcHeaderFrame();
