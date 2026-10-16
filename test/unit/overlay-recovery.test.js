import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { boundedOverlayDelivery, captureOverlayCommand, installOverlayRecoveryValidation, VALIDATE_OVERLAY_RECOVERY, isMissingOverlayReceiver, isRecoverableOverlayUrl,
    OVERLAY_DELIVERY_TIMEOUT_MS, recoverOverlayReceiver } from '../../shared/overlay-recovery.js';

const source = { id: 7, windowId: 2, active: true, url: 'https://example.test/', status: 'complete', incognito: false };
const message = { action: 'activateSpotlight', mode: 'current-tab', ensureOpen: false, tabUrl: source.url, tabId: source.id };
function harness() {
    let current = { ...source };
    const listeners = {};
    const event = name => {
        listeners[name] = new Set();
        return { addListener: fn => listeners[name].add(fn), removeListener: fn => listeners[name].delete(fn) };
    };
    const api = {
        runtime: { id: 'own', onMessage: { addListener: vi.fn() } },
        tabs: { query: vi.fn(async () => [{ ...current }]), get: vi.fn(async () => ({ ...current })),
            sendMessage: vi.fn(async () => ({ success: true, open: true })) },
        scripting: { executeScript: vi.fn(async () => [{ frameId: 0, documentId: 'document-1' }]) },
        windows: { onRemoved: event('windowRemoved'), onFocusChanged: event('windowFocusChanged') }
    };
    for (const name of ['onUpdated', 'onActivated', 'onDetached', 'onRemoved', 'onReplaced']) api.tabs[name] = event(name);
    return { api, listeners, mutate: changes => { current = { ...current, ...changes }; },
        emit: (name, ...args) => listeners[name].forEach(fn => fn(...args)) };
}
afterEach(() => vi.useRealTimers());

describe('precise recovery eligibility and permission contract', () => {
    it('recognizes only Chrome\'s definitive missing receiver error', () => {
        expect(isMissingOverlayReceiver(new Error('Could not establish connection. Receiving end does not exist.'))).toBe(true);
        for (const value of ['The message port closed before a response was received.', 'Extension context invalidated.',
            'timeout', 'Receiving end does not exist.', 'Cannot access contents of url']) {
            expect(isMissingOverlayReceiver(new Error(value))).toBe(false);
        }
        expect(isMissingOverlayReceiver(null)).toBe(false);
    });
    it('allows ordinary HTTP(S), excludes privileged/opaque/store URLs, and adds no broad host grant', () => {
        for (const value of ['https://github.com/calvwng/arcify', 'http://localhost:8000/test', 'https://chrome.google.com/other'])
            expect(isRecoverableOverlayUrl(value)).toBe(true);
        for (const value of ['file:///page', 'ftp://example.test', 'data:text/html,test', 'blob:https://example.test/id',
            'chrome://newtab/', 'about:blank', 'chrome-extension://id/file', 'https://chromewebstore.google.com/',
            'https://chrome.google.com/webstore', 'https://chrome.google.com/webstore/detail/id',
            'https://microsoftedge.microsoft.com/addons/detail/id', 'not a URL']) expect(isRecoverableOverlayUrl(value)).toBe(false);
        const manifest = JSON.parse(readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8'));
        expect(manifest.permissions.filter(value => ['activeTab', 'scripting'].includes(value))).toEqual(['activeTab', 'scripting']);
        expect(manifest.host_permissions).toBeUndefined();
        expect(manifest.content_scripts[0].all_frames).toBe(false);
    });
});

describe('request-scoped command source guard', () => {
    it('starts watching before first lookup and remembers a same-URL reload even after it completes', async () => {
        const { api, emit, listeners } = harness();
        let resolve;
        api.tabs.query.mockReturnValueOnce(new Promise(done => { resolve = done; }));
        const guard = captureOverlayCommand(api);
        const lookup = guard.resolve();
        emit('onUpdated', source.id, { status: 'loading' });
        emit('onUpdated', source.id, { status: 'complete' });
        resolve([{ ...source }]);
        expect(await lookup).toEqual(source);
        expect(await guard.isCurrent()).toBe(false);
        guard.dispose();
        expect(Object.values(listeners).every(set => set.size === 0)).toBe(true);
    });
    it.each(['onActivated', 'windowFocusChanged'])('rejects retargeting during initial lookup after %s', async event => {
        const { api, emit, mutate } = harness(); let resolve;
        api.tabs.query.mockReturnValueOnce(new Promise(done => { resolve = done; }));
        const guard = captureOverlayCommand(api); const lookup = guard.resolve();
        if (event === 'onActivated') emit(event, { tabId: 77, windowId: 2 });
        else emit(event, 3);
        const replacement = { ...source, id: 77, windowId: event === 'onActivated' ? 2 : 3 };
        mutate(replacement); resolve([replacement]); await lookup;
        expect(await guard.isCurrent({ settled: true })).toBe(false); guard.dispose();
    });
    it('retains a navigation-away-and-back rather than comparing only the final URL', async () => {
        const { api, emit } = harness();
        const guard = captureOverlayCommand(api, source); await guard.resolve();
        emit('onUpdated', source.id, { url: 'https://elsewhere.test/' });
        emit('onUpdated', source.id, { url: source.url });
        expect(await guard.isCurrent()).toBe(false); guard.dispose();
    });
    it.each([3, -1])('consumes a resolved command when focus leaves its window for %s', async windowId => {
        const { api, emit } = harness();
        const guard = captureOverlayCommand(api, source); await guard.resolve();
        emit('windowFocusChanged', source.windowId);
        expect(await guard.isCurrent({ settled: true })).toBe(true);
        emit('windowFocusChanged', windowId);
        emit('windowFocusChanged', source.windowId);
        expect(await guard.isCurrent()).toBe(false);
        expect(await recoverOverlayReceiver(api, source, guard, message)).toEqual({ status: 'changed' });
        expect(api.scripting.executeScript).not.toHaveBeenCalled();
        expect(api.tabs.sendMessage).not.toHaveBeenCalled(); guard.dispose();
    });
    it('rejects pending renderer validation after focus changes during style initialization', async () => {
        const { api, emit } = harness();
        const guard = captureOverlayCommand(api, source); await guard.resolve();
        installOverlayRecoveryValidation(api);
        const listener = api.runtime.onMessage.addListener.mock.calls[0][0];
        api.tabs.sendMessage.mockImplementation(async (_id, request) => {
            emit('windowFocusChanged', 3);
            const response = await new Promise(resolve => listener({ action: VALIDATE_OVERLAY_RECOVERY,
                requestId: request.recoveryRequestId }, { id: 'own', frameId: 0,
                documentId: 'document-1', documentLifecycle: 'active', url: source.url, tab: source }, resolve));
            expect(response).toEqual({ valid: false });
            return { success: false, changed: true };
        });
        expect(await recoverOverlayReceiver(api, source, guard, message)).toEqual({ status: 'changed' });
        expect(api.scripting.executeScript).toHaveBeenCalledOnce();
        expect(api.tabs.sendMessage).toHaveBeenCalledOnce(); guard.dispose();
    });
    it('ignores unrelated tabs and non-navigation changes, but rejects source window loss', async () => {
        const { api, emit } = harness();
        const guard = captureOverlayCommand(api, source); await guard.resolve();
        emit('onUpdated', source.id, { title: 'Renamed', groupId: 6 });
        emit('onUpdated', 99, { status: 'loading' });
        emit('onActivated', { tabId: 99, windowId: 10 });
        expect(await guard.isCurrent({ settled: true })).toBe(true);
        emit('windowRemoved', 2); expect(await guard.isCurrent()).toBe(false); guard.dispose();
    });
    it('rejects navigation while awaiting the last identity read', async () => {
        const { api, emit } = harness();
        const guard = captureOverlayCommand(api, source); await guard.resolve();
        api.tabs.query.mockImplementation(async () => { emit('onUpdated', 7, { status: 'loading' }); return [{ ...source }]; });
        expect(await guard.isCurrent({ settled: true })).toBe(false); guard.dispose();
    });
    it('allows messaging a still-loading receiver but cannot repair until a settled invocation', async () => {
        const { api, mutate } = harness(); mutate({ status: 'loading' });
        const guard = captureOverlayCommand(api, { ...source, status: 'loading' }); await guard.resolve();
        expect(await guard.isCurrent()).toBe(true); expect(await guard.isCurrent({ settled: true })).toBe(false);
        guard.dispose();
    });
});

describe('bounded dormant injection and exact-document open', () => {
    it('opens once with source context and returned main-frame document identity', async () => {
        const { api } = harness(); const guard = captureOverlayCommand(api, source); await guard.resolve();
        expect(await recoverOverlayReceiver(api, source, guard, message)).toMatchObject({ status: 'opened' });
        expect(api.scripting.executeScript).toHaveBeenCalledOnce();
        expect(api.tabs.sendMessage).toHaveBeenCalledExactlyOnceWith(7,
            { ...message, ensureOpen: true, recovery: true, recoveryRequestId: expect.any(String), expectedUrl: source.url }, { documentId: 'document-1' });
        guard.dispose();
    });
    it('validates only the attested pending main document and expires the capability after open', async () => {
        const { api } = harness();
        const guard = captureOverlayCommand(api, source); await guard.resolve();
        installOverlayRecoveryValidation(api);
        const listener = api.runtime.onMessage.addListener.mock.calls[0][0];
        const sender = { id: 'own', frameId: 0, documentId: 'document-1', documentLifecycle: 'active', url: source.url, tab: source };
        let token;
        const validate = (overrides = {}, requestId = token) => new Promise(resolve =>
            listener({ action: VALIDATE_OVERLAY_RECOVERY, requestId }, { ...sender, ...overrides }, resolve));
        api.tabs.sendMessage.mockImplementation(async (_id, request) => {
            token = request.recoveryRequestId;
            expect(await validate()).toEqual({ valid: true });
            for (const overrides of [{ id: 'other' }, { frameId: 1 }, { documentId: 'other-document' },
                { documentLifecycle: 'prerender' }, { url: 'https://elsewhere.test/' },
                { tab: { ...source, id: 99 } }, { tab: { ...source, windowId: 99 } },
                { tab: { ...source, incognito: true } }]) expect(await validate(overrides)).toEqual({ valid: false });
            expect(await validate({}, 'unknown-token')).toEqual({ valid: false });
            return { success: true, open: true };
        });
        expect(await recoverOverlayReceiver(api, source, guard, message)).toMatchObject({ status: 'opened' });
        expect(await validate()).toEqual({ valid: false });
        guard.dispose();
    });

    it('expires the validation capability when the single ensure-open times out', async () => {
        vi.useFakeTimers(); const { api } = harness(); let token;
        const guard = captureOverlayCommand(api, source); await guard.resolve();
        installOverlayRecoveryValidation(api);
        const listener = api.runtime.onMessage.addListener.mock.calls[0][0];
        api.tabs.sendMessage.mockImplementation((_id, request) => { token = request.recoveryRequestId; return new Promise(() => {}); });
        const recovery = recoverOverlayReceiver(api, source, guard, message);
        await vi.advanceTimersByTimeAsync(OVERLAY_DELIVERY_TIMEOUT_MS);
        expect(await recovery).toEqual({ status: 'uncertain' });
        const response = vi.fn();
        listener({ action: VALIDATE_OVERLAY_RECOVERY, requestId: token }, { id: 'own', frameId: 0,
            documentId: 'document-1', documentLifecycle: 'active', url: source.url, tab: source }, response);
        expect(response).toHaveBeenCalledWith({ valid: false }); guard.dispose();
    });

    it.each([[], [{ frameId: 1, documentId: 'wrong-frame' }], [{ frameId: 0 }],
        [{ frameId: 0, documentId: 'one' }, { frameId: 1, documentId: 'two' }]])
    ('does not broadcast activation when injection lacks an unambiguous main document: %j', async results => {
        const { api } = harness(); api.scripting.executeScript.mockResolvedValue(results);
        const guard = captureOverlayCommand(api, source); await guard.resolve();
        expect(await recoverOverlayReceiver(api, source, guard, message)).toEqual({ status: 'fallback' });
        expect(api.tabs.sendMessage).not.toHaveBeenCalled(); guard.dispose();
    });
    it('bounds an uncertain activation and leaves any eventual completion alone', async () => {
        vi.useFakeTimers(); let complete;
        const delivery = boundedOverlayDelivery(new Promise(resolve => { complete = resolve; }));
        const observed = delivery.catch(error => error.code);
        await vi.advanceTimersByTimeAsync(OVERLAY_DELIVERY_TIMEOUT_MS);
        expect(await observed).toBe('OVERLAY_TIMEOUT'); complete({ success: true, open: true });
        await vi.runAllTimersAsync(); expect(vi.getTimerCount()).toBe(0);
    });
    it('does not send a late open or retry when dormant injection times out', async () => {
        vi.useFakeTimers(); const { api } = harness(); let complete;
        api.scripting.executeScript.mockReturnValue(new Promise(resolve => { complete = resolve; }));
        const guard = captureOverlayCommand(api, source); await guard.resolve();
        const recovery = recoverOverlayReceiver(api, source, guard, message);
        await vi.advanceTimersByTimeAsync(OVERLAY_DELIVERY_TIMEOUT_MS);
        expect(await recovery).toEqual({ status: 'uncertain' });
        complete([{ frameId: 0, documentId: 'late-document' }]); await vi.runAllTimersAsync();
        expect(api.tabs.sendMessage).not.toHaveBeenCalled(); expect(api.scripting.executeScript).toHaveBeenCalledOnce(); guard.dispose();
    });
    it('does not retry an uncertain ensure-open even when it eventually acknowledges', async () => {
        vi.useFakeTimers(); const { api } = harness(); let complete;
        api.tabs.sendMessage.mockReturnValue(new Promise(resolve => { complete = resolve; }));
        const guard = captureOverlayCommand(api, source); await guard.resolve();
        const recovery = recoverOverlayReceiver(api, source, guard, message);
        await vi.advanceTimersByTimeAsync(OVERLAY_DELIVERY_TIMEOUT_MS);
        expect(await recovery).toEqual({ status: 'uncertain' });
        complete({ success: true, open: true }); await vi.runAllTimersAsync();
        expect(api.tabs.sendMessage).toHaveBeenCalledOnce(); expect(api.scripting.executeScript).toHaveBeenCalledOnce(); guard.dispose();
    });
});
