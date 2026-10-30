import { isTransientUrl, isWindowId, bridgeError } from './arcify-bridge-protocol.js';

// Only these ordinary URL submissions enter routing. Saved/bookmark identities,
// helper pages, searches and current-tab navigation retain their existing paths.
export function isRoutedUrlSubmission(result, mode) {
    return mode === 'new-tab' && isTransientUrl(result?.url)
        && ['url-suggestion','history','top-site','autocomplete-suggestion'].includes(result.type)
        && (result.type !== 'autocomplete-suggestion' || result.metadata?.isUrl === true)
        && !result.metadata?.arcifyBridge && !result.metadata?.bookmarkFallback && !result.metadata?.bookmarkId;
}
const stale = () => bridgeError('STALE_ROUTING_SOURCE', 'The original Spotlight page changed. Reopen Spotlight from the intended page.');

export function createRoutedSourceCapture(api = chrome) {
    const pending = new Set(), grants = new Map();
    const capture = (result, mode, sender) => {
        if (!isRoutedUrlSubmission(result, mode)) return null;
        // Packaged helpers intentionally use current selected-Space semantics.
        if (sender?.id === api.runtime.id && sender.url?.split(/[?#]/)[0] === api.runtime.getURL('newtab.html')) return null;
        if (sender?.id !== api.runtime.id || sender.frameId !== 0
            || sender.documentLifecycle !== undefined && sender.documentLifecycle !== 'active'
            || !isWindowId(sender.tab?.id) || !isWindowId(sender.tab.windowId)
            || sender.tab.incognito !== false || typeof sender.tab.pinned !== 'boolean' || !isTransientUrl(sender.url)
            || sender.url !== sender.tab.url || sender.origin !== undefined && sender.origin !== new URL(sender.url).origin)
            throw stale();
        const source = Object.freeze({tabId:sender.tab.id,url:sender.url,token:crypto.randomUUID()});
        const windowId = sender.tab.windowId;
        if (pending.has(source.tabId)) throw bridgeError('ACTION_PENDING', 'A Spotlight opening from this page is already pending.');
        pending.add(source.tabId);
        let changed = false, disposed = false, dispatched = false;
        const expiresAt = performance.now() + 20000;
        const removers = [];
        const dispose = () => { if(disposed)return;disposed=true;pending.delete(source.tabId);grants.delete(source.token);removers.splice(0).forEach(remove=>remove()); };
        const listen = (event, fn) => { if(!event?.addListener || !event?.removeListener)throw stale();event.addListener(fn);removers.push(()=>event.removeListener(fn)); };
        try {
            listen(api.tabs.onUpdated,(id,change)=>{if(id===source.tabId&&(change.status==='loading'||['url','pendingUrl','pinned','splitViewId'].some(k=>Object.hasOwn(change,k))))changed=true;});
            listen(api.tabs.onRemoved,id=>{if(id===source.tabId)changed=true;});
            listen(api.tabs.onDetached,id=>{if(id===source.tabId)changed=true;});
            listen(api.tabs.onReplaced,(added,removed)=>{if(added===source.tabId||removed===source.tabId)changed=true;});
            listen(api.tabs.onActivated,info=>{if(info.windowId===windowId&&info.tabId!==source.tabId)changed=true;});
            listen(api.windows.onRemoved,id=>{if(id===windowId)changed=true;});
            listen(api.storage.onChanged,(changes,area)=>{if(area==='local'&&(Object.hasOwn(changes,'arcifyBridgePeerId')||Object.hasOwn(changes,'arcifyBridgePairingGeneration')))changed=true;});
        } catch(error){dispose();throw error;}
        const assert = () => {if(changed||disposed||performance.now()>=expiresAt)throw stale();};
        const guard = {source,windowId,dispose,assert,dispatched(){dispatched=true;},async check(){
            assert();
            const [tab,window]=await Promise.all([api.tabs.get(source.tabId),api.windows.get(windowId)]);
            assert();
            if(tab.id!==source.tabId||tab.windowId!==windowId||tab.url!==source.url||tab.pendingUrl||tab.status==='loading'
                ||tab.incognito!==false||tab.pinned!==sender.tab.pinned||!tab.active||Number.isInteger(tab.splitViewId)&&tab.splitViewId>=0
                ||window.id!==windowId||window.type!=='normal'||window.incognito!==false||!dispatched&&window.focused!==true)throw stale();
            return source;
        }};
        grants.set(source.token,guard);
        return guard;
    };
    capture.verify = async message => {
        const guard = grants.get(message?.token);
        if (!guard || Object.keys(message).length !== 5 || message.type !== 'arcify-routed-source'
            || message.tabId !== guard.source.tabId || message.url !== guard.source.url || message.windowId !== guard.windowId) throw stale();
        await guard.check(); return {live:true};
    };
    return capture;
}

// A liveness reply never dispatches an operation. It verifies the original
// browser-attested content-document fence, including same-URL navigation.
export function installRoutedSourceValidation(api, bridge, capture) {
    const listener = (message,sender,respond) => {
        if(message?.type!=='arcify-routed-source')return false;
        (async()=>{
            const peer=await bridge.getPeerId();
            if(!peer||sender?.id!==peer||sender.url && !sender.url.startsWith('chrome-extension://'+peer+'/')
                ||sender.origin && sender.origin!=='chrome-extension://'+peer)throw stale();
            const result=await capture.verify(message);
            if(await bridge.getPeerId()!==peer)throw stale();
            respond(result);
        })().catch(()=>respond({live:false}));
        return true;
    };
    api.runtime.onMessageExternal.addListener(listener);
    return ()=>api.runtime.onMessageExternal.removeListener(listener);
}
