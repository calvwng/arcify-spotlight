export const HEADER_TYPE='arcify-little-arc-header-v1';
export const HEADER_ICON_INSPECT='inspectSpaceIcons';
export const HEADER_TOP_PORT='little-arc-header-top-v1';
export const HEADER_FRAME_PORT='little-arc-header-frame-v1';
export const HEADER_PAGE='little-arc-header.html';
export const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
export const positive=n=>Number.isSafeInteger(n)&&n>0;
export const uuid=s=>typeof s==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s);
// Keep the glyph contract aligned with Arcify's space-icons.js. Bound the
// payload before Unicode segmentation and accept one complete grapheme only.
const emojiBase = String.raw`(?![\p{Regional_Indicator}\p{Emoji_Modifier}#*0-9])\p{Emoji}`;
const emojiElement = String.raw`(?:\p{Emoji_Modifier_Base}[\uFE0E\uFE0F]?\p{Emoji_Modifier}|${emojiBase}[\uFE0E\uFE0F]?)`;
const emojiSequence=new RegExp(String.raw`^(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\u{1F3F4}[\u{E0061}-\u{E007A}]+\u{E007F}|${emojiElement}(?:\u200D${emojiElement})*)$`,'u');
const segmenter=new Intl.Segmenter(undefined,{granularity:'grapheme'});
const validGlyph=value=>{
 if(typeof value!=='string'||value.length>64||!emojiSequence.test(value))return false;
 const it=segmenter.segment(value)[Symbol.iterator]();return !it.next().done&&it.next().done;
};
export function validateHeaderContext(c){
 const keys=['viewId','windows','spaces','proposed'];
 for(const [key,valid] of Object.entries({
  directEnabled:v=>typeof v==='boolean',
  themeMode:v=>['light','dark','system'].includes(v),
  siteHostname:v=>typeof v==='string'&&v.length<=253&&v.length>0&&!/[\s\/\\<>]/.test(v),
  controlsMissing:v=>v===true&&c.directEnabled===false,
 })){if(c&&Object.hasOwn(c,key)){if(!valid(c[key]))throw Error('Invalid Little Arc choices. Use the trusted controller.');keys.push(key);}}
 const text=s=>typeof s==='string'&&s.length>0&&s.length<=200;
 const target=t=>exact(t,['windowId','spaceId','bookmarkFolderId'])&&positive(t.windowId)&&text(t.spaceId)&&text(t.bookmarkFolderId);
 const space=s=>{
  if(!s||typeof s!=='object')return false;
  const keys=['id','bookmarkFolderId','name'];
  if(Object.hasOwn(s,'color')){if(typeof s.color!=='string'||!/^#[0-9a-f]{6}$/i.test(s.color))return false;keys.push('color');}
  if(Object.hasOwn(s,'icon'))keys.push('icon');
  return exact(s,keys)&&text(s.id)&&text(s.bookmarkFolderId)&&typeof s.name==='string'&&s.name.length<=4096;
 };
 if(!exact(c,keys)||!uuid(c.viewId)||!Array.isArray(c.windows)||c.windows.length>512||!Array.isArray(c.spaces)||c.spaces.length>512
  ||c.windows.some(w=>!exact(w,['id','title'])||!positive(w.id)||typeof w.title!=='string'||w.title.length>4096)
  ||c.spaces.some(s=>!space(s))
  ||new Set(c.windows.map(w=>w.id)).size!==c.windows.length||new Set(c.spaces.map(s=>s.id)).size!==c.spaces.length
  ||c.proposed!==null&&(!target(c.proposed)||!c.windows.some(w=>w.id===c.proposed.windowId)||!c.spaces.some(s=>s.id===c.proposed.spaceId&&s.bookmarkFolderId===c.proposed.bookmarkFolderId)))throw Error('Invalid Little Arc choices. Use the trusted controller.');
 // Decoration may be dropped, but never forgive malformed identities or targets.
 if(c.spaces.some(s=>Object.hasOwn(s,'icon')&&!validGlyph(s.icon)))return {...c,spaces:c.spaces.map(s=>{
  if(!Object.hasOwn(s,'icon')||validGlyph(s.icon))return s;
  const {icon,...identity}=s;return identity;
 })};
 return c;
}

// Bounded presentation geometry only; never interpreted as CSS or authority.
export const validHitRegions = rects => Array.isArray(rects)&&rects.length<=5&&rects.every(r=>Array.isArray(r)&&r.length===4&&r.every(n=>Number.isFinite(n)&&n>=0&&n<=32768)&&r[1]+r[3]<=480&&r[0]+r[2]<=32768);
