// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { installPeekBroker, PEEK_PORT, PEEK_AUTHORITY } from '../../shared/peek-broker.js';
import { eligiblePeekLink, installPeekContent } from '../../shared/peek-content.js';
import { installPeekOptions } from '../../shared/peek-options.js';
import { PEEK_WRAPPER_PORT, PEEK_OBSERVER_PORT } from '../../shared/peek-preview-broker.js';
const SELF = 'a'.repeat(32), PEER = 'b'.repeat(32), OP = '11111111-1111-4111-8111-111111111111';
const event = () => { const listeners = new Set(); return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), emit: (...args) => Promise.all([...listeners].map(fn => fn(...args))) }; };
const cleanups = []; afterEach(() => { cleanups.splice(0).forEach(fn => fn()); document.body.replaceChildren(); vi.restoreAllMocks(); vi.useRealTimers(); });
function fixture(overrides = {}) {
    const source = { id: 1, windowId: 10, url: 'https://source.test/private?secret=parent', active: true, incognito: false };
    const settings = { peekEnabled: true, peekIframeEnabled: true, arcifyBridgePeerId: PEER, arcifyBridgePairingGeneration: 'g', ...overrides };
    const api = { runtime: { id: SELF, getURL: p => `chrome-extension://${SELF}/${p}`, onConnect: event(), onMessage: event(), onMessageExternal: event(), sendMessage: vi.fn(async (_peer, request) => {
        if (request.action === 'capability') return { success: true, version: 3 };
        if (request.action === 'prepare') return { success: true, operation: OP };
        if (request.action === 'acknowledge') return { success: true, acknowledged: true };
        if (request.action === 'pulse') return { success: true, alive: true };
        return { success: true, completed: true, action: request.action, tabId: 3, windowId: 10 };
    }) }, storage: { local: { get: async () => structuredClone(settings), set: async v => Object.assign(settings, v) }, onChanged: event() },
    tabs: { get: async () => structuredClone(source), sendMessage: vi.fn(async () => ({ url: source.url, live: true, safe: true, action: broker.sessions.get(1)?.executing, selected: broker.sessions.get(1)?.selection })), onUpdated: event(), onRemoved: event(), onAttached: event(), onDetached: event(), onReplaced: event() },
    windows: { get: async () => ({ id: 10, type: 'normal', incognito: false, focused: true }), onRemoved: event() } };
    const broker = installPeekBroker(api); cleanups.push(() => broker.dispose());
    const port = (sender = { id: SELF, tab: { ...source }, frameId: 0, documentId: 'document-one', url: source.url, origin: 'https://source.test' }) => {
        let closed = false; const p = { name: PEEK_PORT, sender, onMessage: event(), onDisconnect: event(), postMessage: vi.fn(), disconnect: vi.fn(() => { if (!closed) { closed = true; void p.onDisconnect.emit(); } }) }; return p;
    };
    const mount = async () => { const p = port(); await api.runtime.onConnect.emit(p); await p.onMessage.emit({ kind: 'hello' }); return p; };
    const open = async () => { const p = await mount(); await p.onMessage.emit({ kind: 'open', url: 'https://target.test/original' }); return p; };
    return { api, source, settings, broker, port, mount, open };
}
it('opt-in defaults off and readiness requires supported paired backend', async () => {
    const f = fixture(); delete f.settings.peekEnabled; const p = await f.mount(); expect(p.disconnect).toHaveBeenCalled(); expect(f.api.runtime.sendMessage).not.toHaveBeenCalled();
    f.settings.peekEnabled = true; f.api.runtime.sendMessage.mockResolvedValue({ success: true }); const old = await f.mount(); expect(old.postMessage.mock.calls.some(([m]) => m.kind === 'ready')).toBe(false);
});
it('a v1 paired backend fails readiness before any link can be intercepted', async () => {
    const f = fixture(); f.api.runtime.sendMessage.mockResolvedValue({ success: true, version: 1 }); const p = await f.mount();
    expect(p.postMessage.mock.calls.some(([m]) => m.kind === 'ready')).toBe(false); expect(p.disconnect).toHaveBeenCalled();
});

for (const action of ['expand', 'fallback']) it(`real broker ${action} samples exact child and attests frozen current URL to backend`, async () => {
    const f = fixture(), top = await f.open(), s = f.broker.sessions.get(1), wrapperUrl = f.api.runtime.getURL('peek-wrapper.html');
    const w = f.port({ id: SELF, tab: { ...f.source }, frameId: 2, documentId: 'wrapper-doc', documentLifecycle: 'active', url: wrapperUrl, origin: `chrome-extension://${SELF}` }); w.name = PEEK_WRAPPER_PORT;
    w.postMessage.mockImplementation(m => { if (m.kind === 'probe') void w.onMessage.emit({ kind: 'probe', id: m.id, live: true }); });
    await f.api.runtime.onConnect.emit(w); await w.onMessage.emit({ kind: 'bind', nonce: s.preview.nonce }); await w.onMessage.emit({ kind: 'loaded' });
    const o = f.port({ id: SELF, tab: { ...f.source }, frameId: 3, documentId: 'child-doc', documentLifecycle: 'active', url: 'https://initial-preview.test/', origin: 'null' }); o.name = PEEK_OBSERVER_PORT;
    const current = 'https://cross-origin.test/history?next=1#fresh';
    o.postMessage.mockImplementation(m => { if (m.kind === 'sample') void o.onMessage.emit({ kind: 'sample', id: m.id, live: true, url: current }); });
    await f.api.runtime.onConnect.emit(o); const nonce = o.postMessage.mock.calls.find(([m]) => m.kind === 'challenge')[0].nonce;
    await w.onMessage.emit({ kind: 'child-proof', nonce }); let proof;
    f.api.runtime.sendMessage.mockImplementation(async (_peer, request) => {
        if (request.action === action) {
            await new Promise(resolve => f.api.runtime.onMessageExternal.emit({ type: PEEK_AUTHORITY, connection: s.connection, operation: s.operation, source: s.source, action }, { id: PEER }, value => { proof = value; resolve(); }));
            return { success: true, completed: true, action, tabId: 9, windowId: 10 };
        }
    });
    await top.onMessage.emit({ kind: action });
    expect(proof).toMatchObject({ authorized: true, selection: { mode: 'current', url: current, frameId: 3, documentId: 'child-doc', revision: expect.any(String) } });
    expect(top.postMessage).toHaveBeenCalledWith({ kind: 'selected-url', url: current, known: true }); expect(top.postMessage).toHaveBeenCalledWith({ kind: 'completed', action });
    expect(JSON.stringify(o.postMessage.mock.calls)).not.toContain(f.source.url); expect(JSON.stringify(w.postMessage.mock.calls)).not.toContain(f.source.url);
});
it('ready is read-only, original URL held by backend, authority never sent to content or iframe', async () => {
    const f = fixture(), p = await f.open(); expect(p.postMessage).toHaveBeenCalledWith({ kind: 'ready' }); expect(p.postMessage).toHaveBeenCalledWith({ kind: 'show', url: 'https://target.test/original', nonce: expect.any(String) });
    expect(JSON.stringify(p.postMessage.mock.calls)).not.toContain(OP); expect(f.api.runtime.sendMessage.mock.calls.map(([, r]) => r.action)).toEqual(['capability', 'prepare']);
    await p.onMessage.emit({ kind: 'expand' }); expect(p.postMessage).toHaveBeenCalledWith({ kind: 'completed', action: 'expand' });
    expect(f.api.tabs.sendMessage).toHaveBeenCalledWith(1, { type: 'arcifyPeekLiveProbe' }, { documentId: 'document-one', frameId: 0 });
});
for (const cause of ['page', 'otherExtension', 'child', 'extensionFrame', 'inactiveDocument', 'wrongOrigin', 'private']) it(`rejects ${cause} runtime connection`, async () => {
    const f = fixture(), p = f.port();
    if (cause === 'page') delete p.sender.id;
    if (cause === 'otherExtension') p.sender.id = PEER;
    if (cause === 'child') p.sender.frameId = 3;
    if (cause === 'extensionFrame') p.sender.url = `chrome-extension://${SELF}/little-arc-header.html`;
    if (cause === 'inactiveDocument') p.sender.documentLifecycle = 'cached';
    if (cause === 'wrongOrigin') p.sender.origin = 'https://evil.test';
    if (cause === 'private') p.sender.tab.incognito = true;
    await f.api.runtime.onConnect.emit(p); expect(p.disconnect).toHaveBeenCalled(); expect(f.api.runtime.sendMessage).not.toHaveBeenCalled();
});
it('repeated action/open cannot create a second operation, including switching to fallback', async () => {
    const f = fixture(), p = await f.open(); await Promise.all([p.onMessage.emit({ kind: 'expand' }), p.onMessage.emit({ kind: 'expand' }), p.onMessage.emit({ kind: 'fallback' })]);
    await p.onMessage.emit({ kind: 'open', url: 'https://another.test/' });
    expect(f.api.runtime.sendMessage.mock.calls.filter(([, r]) => ['expand', 'fallback'].includes(r.action))).toHaveLength(1);
    expect(f.api.runtime.sendMessage.mock.calls.filter(([, r]) => r.action === 'prepare')).toHaveLength(1);
});
for (const cause of ['navigate', 'sameUrlReload', 'detach', 'replace', 'windowClose', 'disable', 'pair', 'portClose']) it(`invalidates ${cause} and never replays`, async () => {
    const f = fixture(), p = await f.open();
    if (cause === 'navigate') await f.api.tabs.onUpdated.emit(1, { url: 'https://other.test/' });
    if (cause === 'sameUrlReload') { await f.api.tabs.onUpdated.emit(1, { status: 'loading' }); p.disconnect(); }
    if (cause === 'detach') await f.api.tabs.onDetached.emit(1);
    if (cause === 'replace') await f.api.tabs.onReplaced.emit(4, 1);
    if (cause === 'windowClose') await f.api.windows.onRemoved.emit(10);
    if (cause === 'disable') await f.api.storage.onChanged.emit({ peekEnabled: { newValue: false } }, 'local');
    if (cause === 'pair') await f.api.storage.onChanged.emit({ arcifyBridgePairingGeneration: {} }, 'local');
    if (cause === 'portClose') await p.onMessage.emit({ kind: 'close' });
    await p.onMessage.emit({ kind: 'expand' }); expect(p.disconnect).toHaveBeenCalled(); expect(f.api.runtime.sendMessage.mock.calls.some(([, r]) => r.action === 'expand')).toBe(false);
});
it('status-only subframe loading preserves top-document operation and explicit expansion',async()=>{
    const f=fixture(),p=await f.open();await f.api.tabs.onUpdated.emit(1,{status:'loading'});await f.api.tabs.onUpdated.emit(1,{status:'complete'});
    expect(p.disconnect).not.toHaveBeenCalled();await p.onMessage.emit({kind:'expand'});expect(p.postMessage).toHaveBeenCalledWith({kind:'completed',action:'expand'});
});
it('missing browser document identity refuses the handshake without a frame-only fallback',async()=>{
    const f=fixture(),p=f.port();delete p.sender.documentId;await f.api.runtime.onConnect.emit(p);await p.onMessage.emit({kind:'hello'});await p.onMessage.emit({kind:'open',url:'https://target.test/original'});
    f.api.tabs.sendMessage.mockResolvedValue({url:f.source.url,live:false,safe:false,action:null});await p.onMessage.emit({kind:'expand'});
    expect(p.disconnect).toHaveBeenCalled();expect(f.api.tabs.sendMessage).not.toHaveBeenCalled();expect(f.api.runtime.sendMessage).not.toHaveBeenCalled();
});
it('failed presentation or wrong live document cannot expand', async () => {
    const f = fixture(), p = await f.open(); f.api.tabs.sendMessage.mockResolvedValue({ url: f.source.url, live: true, safe: false, action: 'expand' });
    await p.onMessage.emit({ kind: 'expand' }); expect(f.api.runtime.sendMessage.mock.calls.some(([, r]) => r.action === 'expand')).toBe(false);
});
it('fresh backend authority matches executing operation and exact source; rogue proofs denied', async () => {
    const f = fixture(), p = await f.open(); let finish;
    f.api.runtime.sendMessage.mockImplementation((_peer, req) => req.action === 'expand' ? new Promise(r => finish = r) : Promise.resolve({ success: true }));
    const work = p.onMessage.emit({ kind: 'expand' }); for (let i = 0; i < 30 && !finish; i++) await Promise.resolve();
    const s = f.broker.sessions.get(1), request = { type: PEEK_AUTHORITY, connection: s.connection, operation: OP, action: 'expand', source: s.source };
    const call = async (message, sender = { id: PEER }) => { let result; await f.api.runtime.onMessageExternal.emit(message, sender, v => { result = v; }); for (let i = 0; i < 30 && !result; i++) await Promise.resolve(); return result; };
    expect(await call(request)).toEqual({ authorized: true, selection: s.selection }); expect(await call({ ...request, operation: 'wrong' })).toEqual({ authorized: false }); expect(await call(request, { id: PEER, tab: { id: 1 } })).toEqual({ authorized: false });
    await p.onMessage.emit({ kind: 'close' }); expect(await call(request)).toEqual({ authorized: false }); finish({ success: true, completed: true, action: 'expand', tabId: 3, windowId: 10 }); await work;
    expect(p.postMessage.mock.calls.some(([m]) => m.kind === 'completed')).toBe(false);
});
function contentFixture(overrides = {}) {
    const f = fixture(overrides), p = f.port(), handlers = new Map(), windowHandlers = new Map(), elements = [];
    f.api.runtime.connect = vi.fn(() => p);
    const addDocument = document.addEventListener.bind(document); vi.spyOn(document, 'addEventListener').mockImplementation((name, fn, options) => { handlers.set(name, fn); addDocument(name, fn, options); });
    const addElement = window.HTMLElement.prototype.addEventListener;
    vi.spyOn(window.HTMLElement.prototype, 'addEventListener').mockImplementation(function (name, fn, options) { elements.push({ node: this, name, fn }); return addElement.call(this, name, fn, options); });
    vi.spyOn(document, 'hasFocus').mockReturnValue(true); Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    const rect = { left: 10, top: 10, right: 600, bottom: 500, width: 590, height: 490 };
    vi.spyOn(window.HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect);
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => document.getElementById('arcify-peek-host') });
    window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    window.HTMLDialogElement.prototype.close = function () { this.open = false; };
    const w = { top: null, location: { href: f.source.url }, HTMLDialogElement: window.HTMLDialogElement, innerWidth: 1000, innerHeight: 900,
        getComputedStyle: () => ({ visibility: 'visible', opacity: '1' }), addEventListener: (name, fn) => windowHandlers.set(name, fn), removeEventListener: name => windowHandlers.delete(name) }; w.top = w;
    const content = installPeekContent({ api: f.api, document, window: w }); cleanups.push(() => content.dispose());
    const node = id => elements.find(e => e.node.id === id)?.node;
    const click = id => elements.find(e => e.node.id === id && e.name === 'click').fn({ isTrusted: true, button: 0, composedPath: () => [node(id)], preventDefault() {}, stopPropagation() {} });
    const link = document.createElement('a'); link.href = 'https://target.test/original'; link.textContent = 'Target'; document.body.append(link);
    const gesture = changes => ({ isTrusted: true, button: 0, detail: 1, shiftKey: true, ctrlKey: false, metaKey: false, altKey: false, defaultPrevented: false, composedPath: () => [link, document.body], preventDefault: vi.fn(), stopImmediatePropagation: vi.fn(), ...changes });
    const open = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await p.onMessage.emit({ kind: 'ready' }); const e = gesture(); handlers.get('click')(e); await p.onMessage.emit({ kind: 'show', url: link.href }); return e; };
    return { ...f, p, w, content, link, gesture, handlers, windowHandlers, elements, node, click, open };
}
it('eligible trusted Shift-primary gesture only; plain/modified/editable/download/special targets remain ordinary', () => {
    const f = contentFixture(); expect(eligiblePeekLink(f.gesture(), document, f.w)?.url).toBe(f.link.href);
    for (const value of [{ isTrusted: false }, { button: 1 }, { shiftKey: false }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { detail: 0 }, { defaultPrevented: true }]) expect(eligiblePeekLink(f.gesture(value), document, f.w)).toBeNull();
    for (const url of ['javascript:alert(1)', 'mailto:test@test.test', 'chrome://settings/', 'https://user:pass@target.test/']) { f.link.href = url; expect(eligiblePeekLink(f.gesture(), document, f.w)).toBeNull(); }
    f.link.href = 'https://target.test/'; f.link.download = 'file'; expect(eligiblePeekLink(f.gesture(), document, f.w)).toBeNull(); f.link.removeAttribute('download');
    f.link.target = 'named-frame'; expect(eligiblePeekLink(f.gesture(), document, f.w)).toBeNull(); f.link.target = '';
    const input = document.createElement('input'); expect(eligiblePeekLink(f.gesture({ composedPath: () => [input, f.link] }), document, f.w)).toBeNull();
});
it('readiness gates interception, mounts one opaque iframe, shows fallback after blocked load without actions', async () => {
    const f = contentFixture(), early = f.gesture(); f.handlers.get('click')(early); expect(early.preventDefault).not.toHaveBeenCalled();
    const e = await f.open(); expect(e.preventDefault).toHaveBeenCalled(); const host = document.getElementById('arcify-peek-host'); expect(host.shadowRoot).toBeNull();
    const preview = f.node('peek-preview'); expect(preview.src).toBe(f.api.runtime.getURL('peek-wrapper.html')); expect(preview.getAttribute('referrerpolicy')).toBe('no-referrer'); expect(preview.hasAttribute('sandbox')).toBe(false);
    preview.dispatchEvent(new Event('error')); expect(f.node('peek-fallback').disabled).toBe(false); expect(f.node('peek-expand').disabled).toBe(false);
    const actions = () => f.p.postMessage.mock.calls.filter(([m]) => ['expand', 'fallback'].includes(m.kind)); expect(actions()).toHaveLength(0);
    preview.dispatchEvent(new Event('load')); expect(actions()).toHaveLength(0); f.click('peek-fallback'); f.click('peek-fallback'); f.click('peek-expand'); expect(actions()).toEqual([[{ kind: 'fallback' }]]);
    expect(JSON.stringify(preview.outerHTML)).not.toContain('parent'); expect(document.body.innerHTML).not.toContain(OP);
});
it('close restores clicked-link focus and destroys frame', async () => {
    const f = contentFixture(); await f.open(); f.click('peek-close'); expect(document.getElementById('arcify-peek-host')).toBeNull(); expect(document.activeElement).toBe(f.link);
});
it('source navigation removes without mutation', async () => {
    const g = contentFixture(); await g.open(); g.w.location.href = 'https://source.test/new'; g.windowHandlers.get('popstate')(); expect(document.getElementById('arcify-peek-host')).toBeNull(); expect(g.p.postMessage.mock.calls.some(([m]) => m.kind === 'expand')).toBe(false);
});
it('expected source hiding after dispatch retains immutable action proof but cannot admit a fresh action', async () => {
    const f = contentFixture(); await f.open(); f.click('peek-expand'); Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    let response; await f.api.runtime.onMessage.emit({ type: 'arcifyPeekLiveProbe' }, { id: SELF }, v => response = v);
    expect(response).toMatchObject({ live: true, safe: false, action: 'expand' }); f.click('peek-fallback'); expect(f.p.postMessage.mock.calls.filter(([m]) => m.kind === 'fallback')).toHaveLength(0);
    await f.p.onMessage.emit({ kind: 'completed', action: 'expand' }); expect(f.p.postMessage).toHaveBeenCalledWith({ kind: 'acknowledge' });
    await f.p.onMessage.emit({ kind: 'acknowledged' }); expect(document.getElementById('arcify-peek-host')).toBeNull();
});
it('BFCache hide destroys pending operation; pageshow reconnects only read-only capability', async () => {
    const f = contentFixture(); await f.open(); f.click('peek-expand'); f.windowHandlers.get('pagehide')({ persisted: true });
    expect(document.getElementById('arcify-peek-host')).toBeNull(); f.windowHandlers.get('pageshow')({ persisted: true }); for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(f.p.postMessage.mock.calls.filter(([m]) => m.kind === 'expand')).toHaveLength(1);
});
it('trusted top beforeunload retires same-URL reload, while synthetic unload cannot revoke it',async()=>{
    const f=contentFixture();await f.open();f.windowHandlers.get('beforeunload')({isTrusted:false});expect(document.getElementById('arcify-peek-host')).not.toBeNull();
    f.click('peek-expand');f.windowHandlers.get('beforeunload')({isTrusted:true});expect(document.getElementById('arcify-peek-host')).toBeNull();
    let response;await f.api.runtime.onMessage.emit({type:'arcifyPeekLiveProbe'},{id:SELF},v=>response=v);expect(response).toMatchObject({live:false,action:null});
    expect(f.p.postMessage.mock.calls.filter(([m])=>m.kind==='expand')).toHaveLength(1);
});
it('worker disconnect keeps visible uncertain state and cannot retry, and ignores forged page probes', async () => {
    const f = contentFixture(); await f.open(); f.click('peek-expand'); f.p.disconnect(); expect(f.node('peek-fallback').disabled).toBe(true); expect(f.node('peek-expand').disabled).toBe(true);
    const respond = vi.fn(); await f.api.runtime.onMessage.emit({ type: 'arcifyPeekLiveProbe' }, { id: PEER }, respond); expect(respond).not.toHaveBeenCalled();
    expect(f.api.runtime.connect).toHaveBeenCalledTimes(1); expect(f.p.postMessage.mock.calls.filter(([m]) => m.kind === 'expand')).toHaveLength(1);
});
it('idle worker disconnect warms read-only capability on real pointer gesture without automatic retry', async () => {
    const f=contentFixture();for(let i=0;i<10;i++)await Promise.resolve();await f.p.onMessage.emit({kind:'ready'});f.p.disconnect();
    expect(f.api.runtime.connect).toHaveBeenCalledTimes(1);f.handlers.get('pointerover')({isTrusted:false});for(let i=0;i<10;i++)await Promise.resolve();expect(f.api.runtime.connect).toHaveBeenCalledTimes(1);
    f.handlers.get('pointerover')({isTrusted:true});for(let i=0;i<10;i++)await Promise.resolve();expect(f.api.runtime.connect).toHaveBeenCalledTimes(2);
    expect(f.p.postMessage.mock.calls.every(([m])=>m.kind==='hello')).toBe(true);
});
it('only open idle preview pulses; action and dismissal stop heartbeat and pulse cannot rearm',async()=>{
    vi.useFakeTimers();const f=contentFixture();await f.open();await vi.advanceTimersByTimeAsync(30000);
    expect(f.p.postMessage.mock.calls.filter(([m])=>m.kind==='pulse')).toHaveLength(2);f.click('peek-expand');await vi.advanceTimersByTimeAsync(30000);
    expect(f.p.postMessage.mock.calls.filter(([m])=>m.kind==='pulse')).toHaveLength(2);f.click('peek-close');await vi.advanceTimersByTimeAsync(30000);
    expect(f.p.postMessage.mock.calls.filter(([m])=>m.kind==='pulse')).toHaveLength(2);
});
it('heartbeat backend is read-only and cannot recreate a consumed operation',async()=>{
    const f=fixture(),p=await f.open();await p.onMessage.emit({kind:'pulse'});expect(f.api.runtime.sendMessage.mock.calls.map(([,r])=>r.action)).toEqual(['capability','prepare','pulse']);
    await p.onMessage.emit({kind:'expand'});await p.onMessage.emit({kind:'pulse'});expect(f.api.runtime.sendMessage.mock.calls.filter(([,r])=>r.action==='pulse')).toHaveLength(1);
});
it('lost acknowledgement preserves known successful opening instead of inviting a retry',async()=>{
    const f=contentFixture();await f.open();f.click('peek-expand');await f.p.onMessage.emit({kind:'completed',action:'expand'});f.p.disconnect();
    const button=f.node('peek-expand'),root=button.getRootNode();expect(root.getElementById('peek-status').textContent).toContain('already opened successfully');expect(button.disabled).toBe(true);
});
it('options default off and only trusted UI event writes opt-in with readback', async () => {
    document.body.innerHTML = '<input type="checkbox" id="peek-enabled"><p id="peek-options-status"></p>';
    const checkbox = document.getElementById('peek-enabled'); let change; checkbox.addEventListener = (_name, fn) => { change = fn; };
    const values = {}, api = { storage: { local: { get: async () => ({ ...values }), set: vi.fn(async data => Object.assign(values, data)) } } };
    await installPeekOptions({ api, document }).ready; expect(checkbox.checked).toBe(false); checkbox.checked = true;
    await change({ isTrusted: false }); expect(api.storage.local.set).not.toHaveBeenCalled(); await change({ isTrusted: true }); expect(values.peekEnabled).toBe(true);
});

it('legacy enabled settings default to direct Little Arc without enabling previously-off users', async () => {
    const f = fixture({ peekIframeEnabled: undefined }), p = await f.mount();
    await p.onMessage.emit({ kind: 'launch', url: 'https://target.test/original' });
    expect(f.api.runtime.sendMessage.mock.calls.map(([,r]) => r.action)).toEqual(['capability', 'prepare', 'fallback']);
    expect(p.postMessage).toHaveBeenCalledWith({ kind: 'completed', action: 'fallback' });
    expect(f.broker.sessions.get(1).preview).toBeUndefined();
    await p.onMessage.emit({ kind: 'launch', url: 'https://target.test/original' });
    await p.onMessage.emit({ kind: 'expand' });
    expect(f.api.runtime.sendMessage.mock.calls.filter(([,r]) => r.action === 'fallback')).toHaveLength(1);
    expect(f.api.runtime.sendMessage.mock.calls.some(([,r]) => r.action === 'expand')).toBe(false);
});
for (const iframe of [false, true]) it(`rejects commands from the other mode when iframe=${iframe}`, async () => {
    const f = fixture({ peekIframeEnabled: iframe }), p = await f.mount();
    await p.onMessage.emit({ kind: iframe ? 'launch' : 'open', url: 'https://target.test/original' });
    expect(f.api.runtime.sendMessage.mock.calls.map(([,r]) => r.action)).toEqual(['capability']);
});
it('direct action rechecks exact source and selected link before prepare and native dispatch', async () => {
    const f = fixture({ peekIframeEnabled: false }), p = await f.mount();
    f.api.tabs.sendMessage.mockResolvedValue({ url: f.source.url, live: true, safe: true, action: 'fallback', selected: { mode: 'original', url: 'https://other.test/' } });
    await p.onMessage.emit({ kind: 'launch', url: 'https://target.test/original' });
    expect(f.api.runtime.sendMessage.mock.calls.map(([,r]) => r.action)).toEqual(['capability']);
});
it('a direct action interrupted during prepare never dispatches a native open', async () => {
    const f = fixture({ peekIframeEnabled: false }), p = await f.mount();
    f.api.runtime.sendMessage.mockImplementation(async (_peer, r) => { if (r.action === 'prepare') { f.source.url = 'https://source.test/changed'; return { success: true, operation: OP }; } throw Error('Unexpected native action'); });
    await p.onMessage.emit({ kind: 'launch', url: 'https://target.test/original' });
    expect(f.api.runtime.sendMessage.mock.calls.some(([,r]) => r.action === 'fallback')).toBe(false);
});
it('mode change invalidates an admitted direct source instead of changing the action', async () => {
    const f = fixture({ peekIframeEnabled: false }), p = await f.mount(); f.settings.peekIframeEnabled = true;
    await p.onMessage.emit({ kind: 'launch', url: 'https://target.test/original' });
    expect(f.api.runtime.sendMessage.mock.calls.some(([,r]) => r.action === 'prepare')).toBe(false);
});
it('direct trusted click suppresses browser default and sends one launch without any iframe', async () => {
    const f = contentFixture({ peekIframeEnabled: false }); for (let i=0;i<10;i++) await Promise.resolve(); await f.p.onMessage.emit({kind:'ready'});
    const e=f.gesture(); f.handlers.get('click')(e); f.handlers.get('click')(f.gesture());
    expect(e.preventDefault).toHaveBeenCalledOnce(); expect(e.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(f.p.postMessage.mock.calls.filter(([m])=>m.kind==='launch')).toEqual([[{kind:'launch',url:f.link.href}]]);
    expect(f.node('peek-close').getRootNode().getElementById('peek-status').textContent).toContain('Opening Little Arc'); expect(f.node('peek-preview')).toBeUndefined(); expect(f.node('peek-close').textContent).toBe('Close Little Arc status');
    let proof; await f.api.runtime.onMessage.emit({type:'arcifyPeekLiveProbe'},{id:SELF},v=>proof=v);
    expect(proof).toMatchObject({live:true,safe:true,action:'fallback',selected:{mode:'original',url:f.link.href}});
    await f.p.onMessage.emit({kind:'completed',action:'fallback'}); await f.p.onMessage.emit({kind:'acknowledged'});
    expect(document.getElementById('arcify-peek-host')).toBeNull();
});
it('one cold gesture connects visibly then launches once without replaying duplicate clicks', async () => {
    const f=contentFixture({peekIframeEnabled:false}); for(let i=0;i<10;i++)await Promise.resolve();
    const e=f.gesture(); f.handlers.get('click')(e); f.handlers.get('click')(f.gesture());
    expect(e.preventDefault).toHaveBeenCalledOnce(); expect(document.getElementById('arcify-shift-link-status')).not.toBeNull();
    expect(f.p.postMessage.mock.calls.some(([m])=>m.kind==='launch')).toBe(false);
    await f.p.onMessage.emit({kind:'ready'}); await f.p.onMessage.emit({kind:'ready'});
    expect(f.p.postMessage.mock.calls.filter(([m])=>m.kind==='launch')).toHaveLength(1);
    expect(document.getElementById('arcify-shift-link-status')).toBeNull();
});
for(const cause of ['timeout','focus','hidden','link','download','namedTarget','disabledLink','removed','source','pagehide','settings','disconnect']) it(`cold intent canceled by ${cause} never opens on delayed readiness`,async()=>{
    vi.useFakeTimers(); const f=contentFixture({peekIframeEnabled:false});for(let i=0;i<10;i++)await Promise.resolve();
    const e=f.gesture();f.handlers.get('click')(e);expect(e.preventDefault).toHaveBeenCalled();
    if(cause==='timeout')await vi.advanceTimersByTimeAsync(2501);
    if(cause==='focus')f.windowHandlers.get('blur')();
    if(cause==='hidden'){Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});f.handlers.get('visibilitychange')();}
    if(cause==='link')f.link.href='https://target.test/changed';
    if(cause==='download')f.link.download='file';
    if(cause==='namedTarget')f.link.target='other-frame';
    if(cause==='disabledLink')f.link.setAttribute('aria-disabled','true');
    if(cause==='removed')f.link.remove();
    if(cause==='source')f.w.location.href='https://source.test/changed';
    if(cause==='pagehide')f.windowHandlers.get('pagehide')();
    if(cause==='settings')await f.api.storage.onChanged.emit({peekIframeEnabled:{}},'local');
    if(cause==='disconnect')f.p.disconnect();
    await f.p.onMessage.emit({kind:'ready'});
    expect(f.p.postMessage.mock.calls.some(([m])=>['launch','open'].includes(m.kind))).toBe(false);
});
it('initial capability failure can recover on the next genuine pointer gesture without prior success',async()=>{
    const f=contentFixture({peekIframeEnabled:false});for(let i=0;i<10;i++)await Promise.resolve();await f.p.onMessage.emit({kind:'error'});f.p.disconnect();
    f.handlers.get('pointerover')({isTrusted:true});for(let i=0;i<10;i++)await Promise.resolve();expect(f.api.runtime.connect).toHaveBeenCalledTimes(2);
    const e=f.gesture();f.handlers.get('click')(e);await f.p.onMessage.emit({kind:'ready'});
    expect(e.preventDefault).toHaveBeenCalled();expect(f.p.postMessage.mock.calls.filter(([m])=>m.kind==='launch')).toHaveLength(1);
});
it('cold handshake failure cancels the first intent; later recovery needs a fresh real gesture',async()=>{
    const f=contentFixture({peekIframeEnabled:false});for(let i=0;i<10;i++)await Promise.resolve();f.handlers.get('click')(f.gesture());
    await f.p.onMessage.emit({kind:'error'});await f.p.onMessage.emit({kind:'ready'});
    expect(f.p.postMessage.mock.calls.some(([m])=>m.kind==='launch')).toBe(false);
    f.handlers.get('click')(f.gesture());expect(f.p.postMessage.mock.calls.filter(([m])=>m.kind==='launch')).toHaveLength(1);
});
it('disabled and unread opt-in preserve native gestures',async()=>{
    const f=contentFixture({peekEnabled:false});const unread=f.gesture();f.handlers.get('click')(unread);for(let i=0;i<10;i++)await Promise.resolve();const off=f.gesture();f.handlers.get('click')(off);
    expect(unread.preventDefault).not.toHaveBeenCalled();expect(off.preventDefault).not.toHaveBeenCalled();expect(f.api.runtime.connect).not.toHaveBeenCalled();
});
it('options preserve legacy enabled migration and require explicit experimental iframe opt-in',async()=>{
    document.body.innerHTML='<input type="checkbox" id="peek-enabled"><input type="checkbox" id="peek-iframe-enabled"><p id="peek-options-status"></p>';
    const main=document.getElementById('peek-enabled'),optional=document.getElementById('peek-iframe-enabled');let change;optional.addEventListener=(_n,fn)=>change=fn;
    const values={peekEnabled:true},api={storage:{local:{get:async()=>({...values}),set:vi.fn(async v=>Object.assign(values,v))}}};
    await installPeekOptions({api,document}).ready;expect(main.checked).toBe(true);expect(optional.checked).toBe(false);expect(api.storage.local.set).not.toHaveBeenCalled();
    optional.checked=true;await change({isTrusted:false});expect(api.storage.local.set).not.toHaveBeenCalled();await change({isTrusted:true});expect(values.peekIframeEnabled).toBe(true);
});

it('direct native result uncertainty never retries or downgrades to another open command',async()=>{
 const f=fixture({peekIframeEnabled:false}),p=await f.mount();const original=f.api.runtime.sendMessage.getMockImplementation();
 f.api.runtime.sendMessage.mockImplementation(async(peer,r)=>{if(r.action==='fallback')throw Error('lost native reply');return original(peer,r);});
 await p.onMessage.emit({kind:'launch',url:'https://target.test/original'});await p.onMessage.emit({kind:'launch',url:'https://target.test/original'});await p.onMessage.emit({kind:'open',url:'https://target.test/original'});
 expect(f.api.runtime.sendMessage.mock.calls.filter(([,r])=>r.action==='fallback')).toHaveLength(1);expect(p.postMessage.mock.calls.some(([m])=>m.kind==='completed')).toBe(false);
});
it('v2 capability cannot arm the direct Shift-click protocol',async()=>{
 const f=fixture({peekIframeEnabled:false});f.api.runtime.sendMessage.mockResolvedValue({success:true,version:2});const p=await f.mount();await p.onMessage.emit({kind:'launch',url:'https://target.test/original'});
 expect(p.disconnect).toHaveBeenCalled();expect(f.api.runtime.sendMessage.mock.calls.some(([,r])=>r.action==='prepare')).toBe(false);
});

for (const navigation of ['pushState', 'replaceState', 'reconnect']) it(`new ${navigation} handshake binds the browser URL to the original top document`, async () => {
    const f = fixture(), p = f.port(), oldUrl = p.sender.url;
    f.source.url = `https://source.test/${navigation}`;
    await f.api.runtime.onConnect.emit(p); await p.onMessage.emit({ kind: 'hello' });
    expect(p.sender.url).toBe(oldUrl);
    expect(p.postMessage).toHaveBeenCalledWith({ kind: 'ready' });
    expect(f.broker.sessions.get(1).source.url).toBe(f.source.url);
    expect(f.api.tabs.sendMessage).toHaveBeenCalledTimes(2);
    for (const call of f.api.tabs.sendMessage.mock.calls) expect(call).toEqual([1, { type: 'arcifyPeekLiveProbe' }, { documentId: 'document-one', frameId: 0 }]);
    expect(f.api.runtime.sendMessage.mock.calls.map(([, r]) => r.action)).toEqual(['capability']);
    expect(f.api.runtime.sendMessage.mock.calls[0][1].source.url).toBe(f.source.url);
});
it('refresh uses the new browser document while old-document messages cannot rearm', async () => {
    const f = fixture(), old = await f.mount(); old.disconnect();
    const fresh = f.port(); fresh.sender.documentId = 'document-two';
    f.api.tabs.sendMessage.mockImplementation(async (_id, _request, target) => {
        if (target.documentId !== 'document-two' || target.frameId !== 0) throw Error('No matching document');
        return { url: f.source.url };
    });
    await f.api.runtime.onConnect.emit(fresh); await fresh.onMessage.emit({ kind: 'hello' });
    await old.onMessage.emit({ kind: 'open', url: 'https://target.test/stale' });
    expect(fresh.postMessage).toHaveBeenCalledWith({ kind: 'ready' });
    expect(f.api.runtime.sendMessage.mock.calls.every(([, r]) => r.action === 'capability')).toBe(true);
});
for (const invalid of ['differentOrigin', 'wrongTab', 'wrongWindow', 'privateTab', 'privateWindow', 'popupWindow', 'pendingNavigation', 'wrongProbeUrl', 'missingReceiver']) it(`new handshake refuses ${invalid} before capability`, async () => {
    const f = fixture(), p = f.port();
    if (invalid === 'differentOrigin') f.source.url = 'https://other.test/new';
    if (invalid === 'wrongTab') f.source.id = 2;
    if (invalid === 'wrongWindow') f.api.windows.get = async () => ({ id: 99, type: 'normal', incognito: false });
    if (invalid === 'privateTab') f.source.incognito = true;
    if (invalid === 'privateWindow') f.api.windows.get = async () => ({ id: 10, type: 'normal', incognito: true });
    if (invalid === 'popupWindow') f.api.windows.get = async () => ({ id: 10, type: 'popup', incognito: false });
    if (invalid === 'pendingNavigation') f.source.pendingUrl = 'https://source.test/next';
    if (invalid === 'wrongProbeUrl') f.api.tabs.sendMessage.mockResolvedValue({ url: 'https://source.test/page-supplied' });
    if (invalid === 'missingReceiver') f.api.tabs.sendMessage.mockRejectedValue(Error('No receiving document'));
    await f.api.runtime.onConnect.emit(p); await p.onMessage.emit({ kind: 'hello' });
    expect(p.disconnect).toHaveBeenCalled(); expect(p.postMessage.mock.calls.some(([r]) => r.kind === 'ready')).toBe(false);
    expect(f.api.runtime.sendMessage).not.toHaveBeenCalled();
});
for (const phase of ['firstProbe', 'capability', 'lastProbe']) for (const change of ['navigation', 'windowTransfer', 'pairing', 'disable', 'disconnect']) it(`${change} during ${phase} cannot publish ready or replay intent`, async () => {
    const f = fixture(), p = f.port(); let probes = 0;
    const changeState = () => {
        if (change === 'navigation') f.source.url = 'https://source.test/new';
        if (change === 'windowTransfer') f.source.windowId = 22;
        if (change === 'pairing') f.settings.arcifyBridgePairingGeneration = 'changed';
        if (change === 'disable') f.settings.peekEnabled = false;
        if (change === 'disconnect') p.disconnect();
    };
    f.api.tabs.sendMessage.mockImplementation(async () => {
        const response = { url: f.source.url }; probes++;
        if (phase === 'firstProbe' && probes === 1 || phase === 'lastProbe' && probes === 2) changeState();
        return response;
    });
    f.api.runtime.sendMessage.mockImplementation(async () => { if (phase === 'capability') changeState(); return { success: true, version: 3 }; });
    await f.api.runtime.onConnect.emit(p); await p.onMessage.emit({ kind: 'hello' });
    await p.onMessage.emit({ kind: 'open', url: 'https://target.test/stale' });
    expect(p.postMessage.mock.calls.some(([r]) => r.kind === 'ready')).toBe(false);
    expect(f.api.runtime.sendMessage.mock.calls.every(([, r]) => r.action === 'capability')).toBe(true);
});
it('same-URL replacement during capability fails the final exact-document route', async () => {
    const f = fixture(), p = f.port(); let currentDocument = 'document-one';
    f.api.tabs.sendMessage.mockImplementation(async (_id, _request, target) => {
        if (target.documentId !== currentDocument || target.frameId !== 0) throw Error('Document no longer exists');
        return { url: f.source.url };
    });
    f.api.runtime.sendMessage.mockImplementation(async () => { currentDocument = 'replacement-document'; return { success: true, version: 3 }; });
    await f.api.runtime.onConnect.emit(p); await p.onMessage.emit({ kind: 'hello' });
    expect(p.disconnect).toHaveBeenCalled(); expect(p.postMessage.mock.calls.some(([r]) => r.kind === 'ready')).toBe(false);
});
it('admitted source remains immutable after same-document URL change', async () => {
    const f = fixture(), p = await f.mount(), session = f.broker.sessions.get(1), original = { ...session.source };
    f.source.url = 'https://source.test/changed-after-ready';
    await p.onMessage.emit({ kind: 'open', url: 'https://target.test/' });
    expect(session.source).toEqual(original);
    expect(f.api.runtime.sendMessage.mock.calls.map(([, r]) => r.action)).toEqual(['capability']);
});
for (const response of [{ success: false }, { success: true, version: 2 }, null]) it(`capability failure ${JSON.stringify(response)} fails closed`, async () => {
    const f = fixture(); f.api.runtime.sendMessage.mockResolvedValue(response); const p = await f.mount();
    expect(p.disconnect).toHaveBeenCalled(); expect(p.postMessage.mock.calls.some(([r]) => r.kind === 'ready')).toBe(false);
});
it('unresponsive document probe has a bounded failure and no capability call', async () => {
    vi.useFakeTimers(); const f = fixture(), p = f.port(); f.api.tabs.sendMessage.mockImplementation(() => new Promise(() => {}));
    await f.api.runtime.onConnect.emit(p); const work = p.onMessage.emit({ kind: 'hello' });
    await vi.advanceTimersByTimeAsync(30001); await work;
    expect(p.disconnect).toHaveBeenCalled(); expect(f.api.runtime.sendMessage).not.toHaveBeenCalled();
});
it('same-URL replacement after readiness cannot prepare or open through a retired document', async () => {
    const f = fixture({ peekIframeEnabled: false }), p = await f.mount();
    f.api.tabs.sendMessage.mockRejectedValue(Error('Original document no longer exists'));
    await p.onMessage.emit({ kind: 'launch', url: 'https://target.test/' });
    expect(f.api.runtime.sendMessage.mock.calls.map(([, r]) => r.action)).toEqual(['capability']);
    expect(p.postMessage.mock.calls.some(([r]) => r.kind === 'completed')).toBe(false);
});
