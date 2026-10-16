// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mountStartupSidebarSuggestion, offerStartupSidebarSuggestion, STARTUP_SUGGESTION_ACTION } from '../../shared/startup-sidebar-suggestion.js';
const OWN = 'a'.repeat(32), PEER = 'b'.repeat(32);
const url = `chrome-extension://${OWN}/newtab.html`;
const mounted = [];
afterEach(() => mounted.splice(0).forEach(m => m.dispose()));
async function fixture({ tabId = 9, windowId = 2, ready = true, prepared = true } = {}) {
    const page = document.implementation.createHTMLDocument();
    Object.defineProperty(page, 'URL', { configurable: true, value: url });
    Object.defineProperty(page, 'visibilityState', { configurable: true, value: 'visible' });
    const input = page.createElement('input'); page.body.append(input);
    const listeners = new Set();
    const api = { runtime: { id: OWN, getURL: path => `chrome-extension://${OWN}/${path}`,
        onMessage: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) } },
        tabs: { getCurrent: vi.fn().mockResolvedValue({ id: tabId, windowId, url: 'chrome://newtab/' }) } };
    const controller = { prepared, peerId: PEER };
    const select = vi.fn(), clearSelection = vi.fn(), isReady = vi.fn(() => ready);
    const mount = mountStartupSidebarSuggestion({ api, document: page, input, controller, select, clearSelection, isReady });
    mounted.push(mount); await mount.ready;
    const offer = (overrides = {}, sender = { id: OWN }) => {
        const respond = vi.fn();
        for (const listener of listeners) listener({ action: STARTUP_SUGGESTION_ACTION, requestId: 'startup-1', peerId: PEER, tabId, windowId, ...overrides }, sender, respond);
        return respond.mock.calls[0]?.[0];
    };
    return { mount, input, page, controller, select, clearSelection, isReady, offer, listeners };
}

describe('newtab startup offer lifecycle', () => {
    it('accepts once only after selecting an empty visible ready page, without editing/focusing input', async () => {
        const f = await fixture(); const focus = vi.spyOn(f.input, 'focus');
        expect(f.offer()).toMatchObject({ accepted: true });
        expect(f.select).toHaveBeenCalledTimes(1); expect(f.mount.selected).toBe(true);
        expect(f.input.value).toBe(''); expect(focus).not.toHaveBeenCalled();
        expect(f.offer()).toMatchObject({ accepted: false, reason: 'not-eligible' });
        expect(f.select).toHaveBeenCalledTimes(1);
    });
    it.each(['typing', 'cleared typing', 'arrow', 'pointer', 'blur', 'hidden'])('terminally declines after %s', async action => {
        const f = await fixture();
        if (action.includes('typing')) {
            f.input.value = 'hello'; f.input.dispatchEvent(new Event('input'));
            if (action === 'cleared typing') f.input.value = '';
        }
        if (action === 'arrow') f.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
        if (action === 'pointer') f.page.dispatchEvent(new Event('pointerdown'));
        if (action === 'blur') f.input.dispatchEvent(new Event('blur'));
        if (action === 'hidden') {
            Object.defineProperty(f.page, 'visibilityState', { value: 'hidden', configurable: true });
            f.page.dispatchEvent(new Event('visibilitychange'));
            Object.defineProperty(f.page, 'visibilityState', { value: 'visible', configurable: true });
        }
        expect(f.offer()).toMatchObject({ accepted: false, reason: 'user-interaction' });
        expect(f.select).not.toHaveBeenCalled();
    });
    it('clears an applied preselection on hide/blur and cannot restore it later', async () => {
        const f = await fixture(); f.offer();
        Object.defineProperty(f.page, 'visibilityState', { value: 'hidden', configurable: true });
        f.page.dispatchEvent(new Event('visibilitychange'));
        expect(f.clearSelection).toHaveBeenCalledOnce(); expect(f.mount.selected).toBe(false);
        Object.defineProperty(f.page, 'visibilityState', { value: 'visible', configurable: true });
        expect(f.offer({ requestId: 'later' })).toMatchObject({ accepted: false, reason: 'user-interaction' });
    });
    it('does not late-apply after a not-ready decline', async () => {
        const f = await fixture({ prepared: false });
        expect(f.offer()).toMatchObject({ accepted: false, reason: 'not-ready' });
        f.controller.prepared = true;
        expect(f.offer()).toMatchObject({ accepted: false, reason: 'not-eligible' });
        expect(f.select).not.toHaveBeenCalled();
    });
    it('isolates two windows/pages and rejects a mismatched target without responding', async () => {
        const first = await fixture(), second = await fixture({ tabId: 19, windowId: 3 });
        expect(second.offer({ tabId: 9, windowId: 2 })).toBeUndefined();
        expect(first.offer()).toMatchObject({ accepted: true });
        expect(second.select).not.toHaveBeenCalled();
    });
    it.each([{ id: PEER }, { id: OWN, tab: { id: 9 } }, { id: OWN, url: `chrome-extension://${OWN}/options.html` }])('rejects untrusted relay sender %j', async sender => {
        const f = await fixture(); expect(f.offer({}, sender)).toBeUndefined(); expect(f.select).not.toHaveBeenCalled();
    });
    it('rejects mismatched paired ID and late messages after disposal', async () => {
        const f = await fixture(); expect(f.offer({ peerId: 'c'.repeat(32) })).toMatchObject({ accepted: false });
        f.mount.dispose(); expect(f.offer()).toBeUndefined(); expect(f.select).not.toHaveBeenCalled();
    });
});

describe('authenticated background startup routing', () => {
    function backgroundFixture() {
        const source = { id: 9, windowId: 2, active: true, url };
        const api = { tabs: { get: vi.fn().mockResolvedValue(source), sendMessage: vi.fn() }, windows: { get: vi.fn().mockResolvedValue({ id: 2, focused: true }) },
            runtime: { getURL: path => `chrome-extension://${OWN}/${path}`, sendMessage: vi.fn().mockResolvedValue({ accepted: true, requestId: 'startup-1', tabId: 9, windowId: 2 }) } };
        const bridge = { getPeerId: vi.fn().mockResolvedValue(PEER) };
        const message = { tabId: 9, windowId: 2, requestId: 'startup-1' };
        return { api, bridge, message, source };
    }
    it('uses runtime broadcast, never tabs.sendMessage, and correlates acknowledgement', async () => {
        const f = backgroundFixture(); expect(await offerStartupSidebarSuggestion(f.api, f.bridge, f.message, PEER)).toEqual({ accepted: true });
        expect(f.api.runtime.sendMessage).toHaveBeenCalledWith({ action: STARTUP_SUGGESTION_ACTION, requestId: 'startup-1', peerId: PEER, tabId: 9, windowId: 2 });
        expect(f.api.tabs.sendMessage).not.toHaveBeenCalled();
    });
    it('allows chrome://newtab only as candidate requiring extension-page acknowledgement', async () => {
        const f = backgroundFixture(); f.source.url = 'chrome://newtab/'; f.api.runtime.sendMessage.mockResolvedValue(undefined);
        await expect(offerStartupSidebarSuggestion(f.api, f.bridge, f.message, PEER)).rejects.toMatchObject({ code: 'DELIVERY_UNCERTAIN' });
    });
    it.each([{ active: false }, { pendingUrl: 'https://example.com' }, { url: 'https://example.com' }, { windowId: 3 }, { incognito: true }])('declines changed/ineligible source %j', async changes => {
        const f = backgroundFixture(); Object.assign(f.source, changes);
        expect(await offerStartupSidebarSuggestion(f.api, f.bridge, f.message, PEER)).toEqual({ accepted: false, reason: 'not-eligible' });
        expect(f.api.runtime.sendMessage).not.toHaveBeenCalled();
    });
    it('rechecks peer and source after async work', async () => {
        const f = backgroundFixture(); f.api.tabs.get.mockResolvedValueOnce(f.source).mockResolvedValue({ ...f.source, url: 'https://example.com' });
        expect(await offerStartupSidebarSuggestion(f.api, f.bridge, f.message, PEER)).toMatchObject({ accepted: false });
        expect(f.api.runtime.sendMessage).not.toHaveBeenCalled();
        f.bridge.getPeerId.mockResolvedValue(''); f.api.tabs.get.mockResolvedValue(f.source);
        await expect(offerStartupSidebarSuggestion(f.api, f.bridge, f.message, PEER)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });
    it('preserves terminal user-interaction decline and classifies malformed reply as uncertainty', async () => {
        const f = backgroundFixture(); f.api.runtime.sendMessage.mockResolvedValueOnce({ accepted: false, reason: 'user-interaction', requestId: 'startup-1', tabId: 9, windowId: 2 }).mockResolvedValueOnce({ accepted: false });
        expect(await offerStartupSidebarSuggestion(f.api, f.bridge, f.message, PEER)).toEqual({ accepted: false, reason: 'user-interaction' });
        await expect(offerStartupSidebarSuggestion(f.api, f.bridge, f.message, PEER)).rejects.toMatchObject({ code: 'DELIVERY_UNCERTAIN' });
    });
});
