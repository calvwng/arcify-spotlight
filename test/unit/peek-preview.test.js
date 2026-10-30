// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createPeekPreviewRegistry, PEEK_WRAPPER_PORT, PEEK_OBSERVER_PORT } from '../../shared/peek-preview-broker.js';
import { installPeekPreviewObserver } from '../../shared/peek-preview-observer.js';
import { installPeekWrapper } from '../../shared/peek-wrapper.js';
const SELF = 'a'.repeat(32), ORIGIN = `chrome-extension://${SELF}`, ORIGINAL = 'https://original.test/link', NEXT = 'https://current.test/page';
const event = () => { const listeners = new Set(); return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), emit: (...args) => Promise.all([...listeners].map(fn => fn(...args))) }; };
const cleanup = []; afterEach(() => { cleanup.splice(0).forEach(fn => fn()); vi.useRealTimers(); document.body.replaceChildren(); });
function port(name, sender = {}) {
    const p = { name, sender: { id: SELF, tab: { id: 1, windowId: 10 }, frameId: 2, documentId: 'wrapper-document', documentLifecycle: 'active', origin: ORIGIN, url: `${ORIGIN}/peek-wrapper.html`, ...sender }, onMessage: event(), onDisconnect: event(), postMessage: vi.fn() };
    let closed = false; p.disconnect = vi.fn(() => { if (!closed) { closed = true; return p.onDisconnect.emit(); } }); return p;
}
function fixture() {
    const s = { alive: true, source: { tabId: 1, windowId: 10 } }, sessions = new Map([[1, s]]), notify = vi.fn();
    const api = { runtime: { id: SELF, getURL: p => `${ORIGIN}/${p}`, onConnect: event() } };
    const registry = createPeekPreviewRegistry(api, { sessions, notify, timeoutMs: 50 });
    const nonce = registry.prepare(s, ORIGINAL); cleanup.push(() => { s.alive = false; registry.close(s); registry.dispose(); });
    const wrapper = async (overrides = {}) => {
        const w = port(PEEK_WRAPPER_PORT, overrides); w.postMessage.mockImplementation(m => { if (m.kind === 'probe') void w.onMessage.emit({ kind: 'probe', id: m.id, live: true }); });
        await api.runtime.onConnect.emit(w); await w.onMessage.emit({ kind: 'bind', nonce: s.preview.nonce }); await w.onMessage.emit({ kind: 'loaded' }); return w;
    };
    const observer = async (w, overrides = {}) => {
        const o = port(PEEK_OBSERVER_PORT, { frameId: 3, documentId: 'child-document', origin: 'null', url: NEXT, ...overrides }); o.url = NEXT;
        o.postMessage.mockImplementation(m => { if (m.kind === 'sample') void o.onMessage.emit({ kind: 'sample', id: m.id, live: true, url: o.url }); });
        await api.runtime.onConnect.emit(o);
        const challenge = o.postMessage.mock.calls.find(([m]) => m.kind === 'challenge')?.[0];
        if (w && challenge) await w.onMessage.emit({ kind: 'child-proof', nonce: challenge.nonce }); return o;
    };
    return { s, api, registry, nonce, notify, wrapper, observer };
}
it('exact wrapper and direct child binding selects fresh History/hash URL, without trusting sender.url', async () => {
    const f = fixture(), w = await f.wrapper(), o = await f.observer(w); o.url = `${NEXT}/history#latest`;
    const selection = await f.registry.select(f.s); expect(selection).toMatchObject({ mode: 'current', url: o.url, frameId: 3, documentId: 'child-document', revision: expect.any(String) });
    await f.registry.verify(f.s, selection); expect(f.notify).toHaveBeenCalledWith(f.s, { kind: 'selected-url', url: o.url, known: true });
    o.url += '-changed'; await expect(f.registry.verify(f.s, selection)).rejects.toThrow();
});
it('unknown or blocked embedding explicitly selects the original link without a last-known guess', async () => {
    const f = fixture(); const selection = await f.registry.select(f.s);
    expect(selection).toEqual({ mode: 'original', url: ORIGINAL, frameId: null, documentId: null, revision: null });
    expect(f.notify).toHaveBeenCalledWith(f.s, { kind: 'selected-url', url: ORIGINAL, known: false });
});
it('optional documentId absence uses exact live Ports and a new binding revision', async () => {
    const f = fixture(), w = await f.wrapper({ documentId: undefined, documentLifecycle: undefined }), o = await f.observer(w, { documentId: undefined, documentLifecycle: undefined });
    const selection = await f.registry.select(f.s); expect(selection.documentId).toBeNull(); await f.registry.verify(f.s, selection);
    o.disconnect(); await expect(f.registry.verify(f.s, selection)).rejects.toThrow();
});
it('child load retires old proof, publishes unknown, and rejects an old queued nonce', async () => {
    const f = fixture(), w = await f.wrapper(), o = await f.observer(w);
    const old = o.postMessage.mock.calls.find(([m]) => m.kind === 'challenge')[0].nonce;
    await w.onMessage.emit({ kind: 'loaded' }); expect(f.s.preview.bound).toBeNull();
    expect(f.notify).toHaveBeenLastCalledWith(f.s, { kind: 'preview-url', url: ORIGINAL, known: false });
    await w.onMessage.emit({ kind: 'child-proof', nonce: old }); expect(f.s.preview.bound).toBeNull();
    const fresh = o.postMessage.mock.calls.filter(([m]) => m.kind === 'challenge').at(-1)[0].nonce;
    expect(fresh).not.toBe(old); await w.onMessage.emit({ kind: 'child-proof', nonce: fresh }); expect(f.s.preview.bound.observer.documentId).toBe('child-document');
});
it('replayed proof cannot replace binding revision and a disconnected old document cannot rebind', async () => {
    const f = fixture(), w = await f.wrapper(), o = await f.observer(w), binding = f.s.preview.bound;
    const old = o.postMessage.mock.calls.find(([m]) => m.kind === 'challenge')[0].nonce;
    await w.onMessage.emit({ kind: 'child-proof', nonce: old }); expect(f.s.preview.bound).toBe(binding);
    o.disconnect(); await w.onMessage.emit({ kind: 'loaded' }); const next = await f.observer(w, { documentId: 'next-document' });
    await w.onMessage.emit({ kind: 'child-proof', nonce: old }); expect(f.s.preview.bound.observer.documentId).toBe('next-document');
    expect(next.disconnect).not.toHaveBeenCalled();
});
it('rogue wrapper with wrong nonce and unrelated observer never gain bound authority', async () => {
    const f = fixture(), rogue = port(PEEK_WRAPPER_PORT); await f.api.runtime.onConnect.emit(rogue);
    await rogue.onMessage.emit({ kind: 'bind', nonce: crypto.randomUUID() }); expect(rogue.disconnect).toHaveBeenCalled(); expect(f.s.preview.wrapper).toBeNull();
    const w = await f.wrapper(), o = await f.observer(null); expect(f.s.preview.bound).toBeNull();
    await w.onMessage.emit({ kind: 'child-proof', nonce: crypto.randomUUID() }); expect(f.s.preview.bound).toBeNull();
    o.disconnect();
});
for (const mismatch of [{ origin: 'https://page.test' }, { frameId: 0 }, { documentLifecycle: 'cached' }, { id: 'b'.repeat(32) }, { tab: { id: 1, windowId: 99 } }]) it(`rejects observer sender mismatch ${JSON.stringify(mismatch)}`, async () => {
    const f = fixture(), w = await f.wrapper(), o = await f.observer(w, mismatch); expect(o.disconnect).toHaveBeenCalled(); expect(f.s.preview.bound).toBeNull();
});
it('a bad fresh sample fails closed rather than downgrading to the original URL', async () => {
    const f = fixture(), w = await f.wrapper(), o = await f.observer(w); o.url = 'javascript:alert(1)';
    await expect(f.registry.select(f.s)).rejects.toThrow(); expect(f.notify.mock.calls.some(([, m]) => m.kind === 'selected-url')).toBe(false);
});
it('wrapper lifecycle change during sample rejects the action before selection', async () => {
    const f = fixture(), w = await f.wrapper(), o = await f.observer(w);
    o.postMessage.mockImplementation(m => { if (m.kind === 'sample') { void w.onMessage.emit({ kind: 'loaded' }); void o.onMessage.emit({ kind: 'sample', id: m.id, live: true, url: NEXT }); } });
    await expect(f.registry.select(f.s)).rejects.toThrow();
});
function observerFixture(ancestor = ORIGIN) {
    const handlers = new Map(), p = port(PEEK_OBSERVER_PORT), api = { runtime: { id: SELF, connect: vi.fn(() => p) } };
    const window = { parent: { postMessage: vi.fn() }, location: { protocol: 'https:', href: NEXT, ancestorOrigins: [ancestor] }, addEventListener: (k, fn) => handlers.set(k, fn), removeEventListener: k => handlers.delete(k) };
    const document = { prerendering: false, readyState: 'complete' };
    const observer = installPeekPreviewObserver({ api, window, document }); cleanup.push(() => observer.dispose()); return { api, window, document, handlers, p };
}
it('ordinary and nested web frames are completely inert', () => {
    for (const ancestor of ['https://page.test', 'null', null]) { const f = observerFixture(ancestor); expect(f.api.runtime.connect).not.toHaveBeenCalled(); expect(f.handlers.size).toBe(0); }
});
it('observer sends private challenge only to the extension parent and samples fresh location', async () => {
    vi.useFakeTimers(); const f = observerFixture(), nonce = crypto.randomUUID();
    await f.p.onMessage.emit({ kind: 'challenge', nonce }); expect(f.window.parent.postMessage).toHaveBeenCalledWith({ kind: 'peekPreviewProof', nonce }, ORIGIN);
    await f.p.onMessage.emit({ kind: 'bound' }); f.window.location.href += '#hash'; await vi.advanceTimersByTimeAsync(250);
    expect(f.p.postMessage).toHaveBeenLastCalledWith({ kind: 'url', url: f.window.location.href });
    await f.p.onMessage.emit({ kind: 'freeze' }); f.window.location.href += '-fresh'; const id = crypto.randomUUID();
    await f.p.onMessage.emit({ kind: 'sample', id }); expect(f.p.postMessage).toHaveBeenLastCalledWith({ kind: 'sample', id, live: true, url: f.window.location.href });
    const count = f.p.postMessage.mock.calls.length; await vi.advanceTimersByTimeAsync(1000); expect(f.p.postMessage).toHaveBeenCalledTimes(count);
});
it('pagehide retires observer and queued samples; BFCache pageshow needs a fresh Port', async () => {
    const f = observerFixture(); await f.p.onMessage.emit({ kind: 'bound' }); f.handlers.get('pagehide')({ isTrusted: true });
    const count = f.p.postMessage.mock.calls.length; await f.p.onMessage.emit({ kind: 'sample', id: crypto.randomUUID() }); expect(f.p.postMessage).toHaveBeenCalledTimes(count);
    const next = port(PEEK_OBSERVER_PORT); f.api.runtime.connect.mockReturnValue(next); f.handlers.get('pageshow')({ isTrusted: true });
    expect(f.api.runtime.connect).toHaveBeenCalledTimes(2); expect(next.postMessage).not.toHaveBeenCalled();
});
it('wrapper forwards only its exact opaque direct child, never unrelated or nested senders', async () => {
    document.body.innerHTML = '<p id="peek-current-url"></p><p id="peek-url-kind"></p><iframe id="peek-site"></iframe>';
    const handlers = new Map(), parent = {}, p = port(PEEK_WRAPPER_PORT), api = { runtime: { connect: () => p } };
    const window = { parent, addEventListener: (k, fn) => handlers.set(k, fn), removeEventListener: k => handlers.delete(k) };
    const wrapper = installPeekWrapper({ api, window, document }); cleanup.push(() => wrapper.dispose()); const nonce = crypto.randomUUID();
    handlers.get('message')({ source: parent, data: { kind: 'peekWrapperBootstrap', nonce } }); expect(p.postMessage).toHaveBeenCalledWith({ kind: 'bind', nonce });
    await p.onMessage.emit({ kind: 'start', url: ORIGINAL }); const child = document.getElementById('peek-site');
    for (const source of [{}, parent]) handlers.get('message')({ source, origin: 'null', data: { kind: 'peekPreviewProof', nonce } });
    expect(p.postMessage.mock.calls.filter(([m]) => m.kind === 'child-proof')).toHaveLength(0);
    handlers.get('message')({ source: child.contentWindow, origin: 'null', data: { kind: 'peekPreviewProof', nonce } }); expect(p.postMessage).toHaveBeenLastCalledWith({ kind: 'child-proof', nonce });
    expect(child.src).toBe(ORIGINAL);
});
it('manifest adds no permission or host expansion and wrapper retains the opaque sandbox', () => {
    const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
    expect(manifest.permissions).not.toContain('webNavigation'); expect(manifest.host_permissions).toBeUndefined();
    const observer = manifest.content_scripts.find(s => s.js.includes('peek-preview-observer.js'));
    expect(observer).toMatchObject({ matches: ['http://*/*', 'https://*/*'], all_frames: true, run_at: 'document_start' });
    const html = readFileSync('peek-wrapper.html', 'utf8'); expect(html).toContain('sandbox="allow-scripts allow-forms"'); expect(html).not.toContain('allow-same-origin'); expect(html).toContain('referrerpolicy="no-referrer"');
});

it('retired pending document clears loaded and cannot authorize a new loading document', async () => {
    const f = fixture(), w = await f.wrapper(), old = await f.observer(null);
    expect(f.s.preview.loaded).toBe(true); expect(f.s.preview.bound).toBeNull(); old.disconnect(); expect(f.s.preview.loaded).toBe(false);
    const next = await f.observer(null, { documentId: 'next-doc' }); expect(next.postMessage).not.toHaveBeenCalled();
    await w.onMessage.emit({ kind: 'loaded' }); const nonce = next.postMessage.mock.calls.find(([m]) => m.kind === 'challenge')[0].nonce;
    await w.onMessage.emit({ kind: 'child-proof', nonce }); expect(f.s.preview.bound.observer.documentId).toBe('next-doc');
});
it('observer challenge cannot prove a loading document even if another frame load was observed', async () => {
    const f = observerFixture(); f.document.readyState = 'loading'; const nonce = crypto.randomUUID();
    await f.p.onMessage.emit({ kind: 'challenge', nonce }); expect(f.window.parent.postMessage).not.toHaveBeenCalled();
    f.document.readyState = 'complete'; f.handlers.get('load')({ isTrusted: false }); expect(f.window.parent.postMessage).not.toHaveBeenCalled();
    f.handlers.get('load')({ isTrusted: true }); expect(f.window.parent.postMessage).toHaveBeenCalledWith({ kind: 'peekPreviewProof', nonce }, ORIGIN);
});
it('fresh Ports without documentId cannot satisfy an earlier selected binding at the same frame and URL', async () => {
    const f = fixture(), w = await f.wrapper({ documentId: undefined }); await f.observer(w, { documentId: undefined });
    const old = await f.registry.select(f.s); f.registry.close(f.s); f.registry.prepare(f.s, ORIGINAL);
    const nextWrapper = await f.wrapper({ documentId: undefined }); await f.observer(nextWrapper, { documentId: undefined });
    const next = await f.registry.select(f.s); expect(next.url).toBe(old.url); expect(next.frameId).toBe(old.frameId); expect(next.revision).not.toBe(old.revision);
    await expect(f.registry.verify(f.s, old)).rejects.toThrow(); await f.registry.verify(f.s, next);
});
it('session close disposes a wrapper connected before it has bound', async () => {
    const f = fixture(), pending = port(PEEK_WRAPPER_PORT); await f.api.runtime.onConnect.emit(pending);
    f.s.alive = false; f.registry.close(f.s); expect(pending.disconnect).toHaveBeenCalled();
});
