import { describe, it, expect, vi } from 'vitest';
import { createHelperSourceCapture } from '../../shared/helper-source.js';

const OWN = 'b'.repeat(32), OTHER = 'c'.repeat(32), documentUrl = `chrome-extension://${OWN}/newtab.html`;
const event = () => { const listeners = new Set(); return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn),
    fire: (...args) => [...listeners].forEach(fn => fn(...args)) }; };
function fixture(nativeUrl) {
    const tab = { id: 42, windowId: 2, url: nativeUrl, status: 'complete' };
    const api = { runtime: { id: OWN, getURL: path => `chrome-extension://${OWN}/${path}` },
        tabs: { get: vi.fn(async () => ({ ...tab })), remove: vi.fn(async () => {}),
            onUpdated: event(), onDetached: event(), onRemoved: event(), onReplaced: event() }, storage: { onChanged: event() } };
    const sender = { id: OWN, url: documentUrl, frameId: 0, documentLifecycle: 'active', tab: { ...tab } };
    return { tab, api, sender, capture: createHelperSourceCapture(api) };
}
describe('browser New Tab override provenance', () => {
    it.each([documentUrl, 'chrome://newtab', 'chrome://newtab/'])('preserves own document and exact native URL %s through verification and dismissal', async nativeUrl => {
        const f = fixture(nativeUrl), guard = f.capture(f.sender);
        expect(guard.source).toMatchObject({ tabId: 42, url: documentUrl, nativeUrl });
        await expect(f.capture.verify({ type: 'arcify-helper-source', ...guard.source, windowId: 2 })).resolves.toEqual({ live: true });
        await guard.dismiss(); expect(f.api.tabs.remove).toHaveBeenCalledExactlyOnceWith(42); guard.dispose();
    });
    it.each(['chrome://newtab/?x', 'chrome://newtab/#x', 'chrome://new-tab-page/', 'helium://newtab/', 'https://newtab/', `chrome-extension://${OTHER}/newtab.html`])('rejects unsupported native helper lookalike %s', nativeUrl => {
        const f = fixture(nativeUrl); expect(() => f.capture(f.sender)).toThrow(expect.objectContaining({ code: 'STALE_HELPER_SOURCE' }));
    });
    it.each([`chrome-extension://${OTHER}/newtab.html`, `chrome-extension://${OWN}/options.html`, 'chrome://newtab/', 'https://page.test/'])('does not grant an alias based on an unrelated sender document %s', url => {
        const f = fixture('chrome://newtab/'); expect(f.capture({ ...f.sender, url })).toBeNull();
    });
    it.each(['chrome://newtab', documentUrl, 'https://other.test/'])('rejects native URL changing from captured alias to %s even without its event', async url => {
        const f = fixture('chrome://newtab/'), guard = f.capture(f.sender); f.tab.url = url;
        await expect(guard.dismiss()).rejects.toHaveProperty('code', 'STALE_HELPER_SOURCE'); expect(f.api.tabs.remove).not.toHaveBeenCalled(); guard.dispose();
    });
    it.each(['reload', 'move-back'])('keeps alias document event fence for %s', async kind => {
        const f = fixture('chrome://newtab/'), guard = f.capture(f.sender);
        if (kind === 'reload') f.api.tabs.onUpdated.fire(42, { status: 'loading' });
        else f.api.tabs.onDetached.fire(42, { oldWindowId: 2 });
        await expect(guard.dismiss()).rejects.toHaveProperty('code', 'STALE_HELPER_SOURCE'); expect(f.api.tabs.remove).not.toHaveBeenCalled(); guard.dispose();
    });
    it('rejects a peer challenge that changes the captured alias while retaining its token', async () => {
        const f = fixture('chrome://newtab/'), guard = f.capture(f.sender);
        await expect(f.capture.verify({ type: 'arcify-helper-source', ...guard.source, nativeUrl: 'chrome://newtab', windowId: 2 })).rejects.toHaveProperty('code', 'STALE_HELPER_SOURCE'); guard.dispose();
    });
});
