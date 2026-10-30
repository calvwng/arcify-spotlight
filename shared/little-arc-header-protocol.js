export const HEADER_TYPE='arcify-little-arc-header-v1';
export const HEADER_TOP_PORT='little-arc-header-top-v1';
export const HEADER_FRAME_PORT='little-arc-header-frame-v1';
export const HEADER_PAGE='little-arc-header.html';
export const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
export const positive=n=>Number.isSafeInteger(n)&&n>0;
export const uuid=s=>typeof s==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s);
export function validateHeaderContext(c){
 if(c&&Object.hasOwn(c,'themeMode')){if(!['light','dark','system'].includes(c.themeMode))throw Error('Invalid theme mode.');const {themeMode,...rest}=c;validateHeaderContext(rest);return c;}
 if(c&&Object.hasOwn(c,'siteHostname')){if(typeof c.siteHostname!=='string'||c.siteHostname.length>253||!c.siteHostname||/[\s\/\\<>]/.test(c.siteHostname))throw Error('Invalid site identity.');const {siteHostname,...rest}=c;validateHeaderContext(rest);return c;}
 const text=s=>typeof s==='string'&&s.length>0&&s.length<=200;
 const target=t=>exact(t,['windowId','spaceId','bookmarkFolderId'])&&positive(t.windowId)&&text(t.spaceId)&&text(t.bookmarkFolderId);
 if(!(exact(c,['viewId','windows','spaces','proposed'])||exact(c,['viewId','windows','spaces','proposed','directEnabled'])&&typeof c.directEnabled==='boolean')||!uuid(c.viewId)||!Array.isArray(c.windows)||c.windows.length>512||!Array.isArray(c.spaces)||c.spaces.length>512
  ||c.windows.some(w=>!exact(w,['id','title'])||!positive(w.id)||typeof w.title!=='string'||w.title.length>4096)
  ||c.spaces.some(s=>!(exact(s,['id','bookmarkFolderId','name'])||exact(s,['id','bookmarkFolderId','name','color'])&&/^#[0-9a-f]{6}$/i.test(s.color))||!text(s.id)||!text(s.bookmarkFolderId)||typeof s.name!=='string'||s.name.length>4096)
  ||new Set(c.windows.map(w=>w.id)).size!==c.windows.length||new Set(c.spaces.map(s=>s.id)).size!==c.spaces.length
  ||c.proposed!==null&&(!target(c.proposed)||!c.windows.some(w=>w.id===c.proposed.windowId)||!c.spaces.some(s=>s.id===c.proposed.spaceId&&s.bookmarkFolderId===c.proposed.bookmarkFolderId)))throw Error('Invalid Little Arc choices. Use the trusted controller.');
 return c;
}

// Bounded presentation geometry only; never interpreted as CSS or authority.
export const validHitRegions = rects => Array.isArray(rects)&&rects.length<=5&&rects.every(r=>Array.isArray(r)&&r.length===4&&r.every(n=>Number.isFinite(n)&&n>=0&&n<=32768)&&r[1]+r[3]<=480&&r[0]+r[2]<=32768);
