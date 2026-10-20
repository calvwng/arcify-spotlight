// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SidebarCommandController, SIDEBAR_RESULT_TYPE } from '../../shared/arcify-sidebar-command.js';
import { SharedSpotlightLogic } from '../../shared/shared-component-logic.js';
const OWN = 'a'.repeat(32), PEER = 'b'.repeat(32), NEXT = 'c'.repeat(32);
const gesture = extra => ({ type: 'keydown', key: 'Enter', isTrusted: true, preventDefault() {}, stopPropagation() {}, ...extra });
const controllers = [];
afterEach(() => { controllers.splice(0).forEach(c => c.dispose()); vi.useRealTimers(); });
function fixture(status = { status: 'connected', peerId: PEER, capabilities: ['openSidebar'] }) {
    let storageChanged;
    const api = { storage: { local: { get: vi.fn().mockResolvedValue({ arcifyBridgePeerId: PEER }) },
        onChanged: { addListener: fn => storageChanged = fn, removeListener: vi.fn() } },
        runtime: { id: OWN, sendMessage: vi.fn().mockResolvedValue({ success: true, status }) },
        tabs: { getCurrent: vi.fn().mockResolvedValue({ id: 9 }) } };
    const showError = vi.fn(), showSuccess = vi.fn(), onChange = vi.fn();
    const controller = new SidebarCommandController({ api, showError, showSuccess, onChange, timeoutMs: 50 });
    controllers.push(controller);
    return { api, controller, showError, showSuccess, onChange, change: (...args) => storageChanged(...args) };
}
const externalCalls = api => api.runtime.sendMessage.mock.calls.filter(args => typeof args[0] === 'string');

describe('renderer sidebar gesture path', () => {
    it('prepares before input and invokes external sendMessage on the original Enter stack with no read/await/relay', async () => {
        const f = fixture(); await f.controller.ready;
        const result = f.controller.result('arcify sidebar');
        expect(result.type).toBe(SIDEBAR_RESULT_TYPE);
        const readCount = f.api.storage.local.get.mock.calls.length;
        const handler = SharedSpotlightLogic.createKeyDownHandler({ handleKeyDown: () => false, getSelectedResult: () => result }, (selected, event) => f.controller.invoke(selected, event));
        handler(gesture());
        expect(externalCalls(f.api)).toHaveLength(1); // No microtask flush before assertion.
        const [target, request, callback] = externalCalls(f.api)[0];
        expect(target).toBe(PEER);
        expect(request).toEqual({ type: 'arcify-sidebar', version: 1, requestId: expect.any(String) });
        expect(f.api.storage.local.get).toHaveBeenCalledTimes(readCount);
        callback({ ...request, role: 'arcify', ok: true });
        expect(f.showSuccess).toHaveBeenCalledWith('Arcify sidebar opened.');
    });
    it('uses the same immediate dedicated route for a trusted primary click', async () => {
        const f = fixture(); await f.controller.ready;
        f.controller.invoke(f.controller.result(), gesture({ type: 'click', button: 0 }));
        expect(externalCalls(f.api)).toHaveLength(1);
    });
    it.each([
        { isTrusted: false }, { repeat: true }, { isComposing: true }, { key: 'Space' },
        { type: 'click', button: 2 }
    ])('rejects synthetic, repeated, composing, and unrelated events %j', async extra => {
        const f = fixture(); await f.controller.ready;
        expect(f.controller.invoke(f.controller.result(), gesture(extra))).toBe(true);
        expect(externalCalls(f.api)).toEqual([]);
    });
    it('rejects a real DOM synthetic click at the actual shared delegated listener', async () => {
        const f = fixture(); await f.controller.ready;
        const container = document.createElement('div');
        container.innerHTML = '<button class="arcify-spotlight-result-item" data-index="0">Open</button>';
        SharedSpotlightLogic.setupResultClickHandling(container, (result, index, event) => f.controller.invoke(result, event), () => [f.controller.result()]);
        container.firstChild.click();
        expect(externalCalls(f.api)).toEqual([]);
    });
    it.each([undefined, [], ['futureCapability']])('hides command when old/unsupported companion omits capability %j', async capabilities => {
        const f = fixture({ status: 'connected', peerId: PEER, capabilities }); await f.controller.ready;
        expect(f.controller.result()).toBeNull();
        expect(f.controller.result('sidebar')).toBeNull();
    });
    it('invalidates immediately and refuses a stale row before a replacement read resolves', async () => {
        const f = fixture(); await f.controller.ready;
        const stale = f.controller.result();
        f.api.storage.local.get.mockReturnValue(new Promise(() => {}));
        f.change({ arcifyBridgePeerId: { oldValue: PEER, newValue: NEXT } }, 'local');
        expect(f.controller.result()).toBeNull();
        f.controller.invoke(stale, gesture());
        expect(externalCalls(f.api)).toEqual([]);
        expect(f.showError).toHaveBeenCalledWith(expect.stringContaining('toolbar button'));
    });
    it('does not resurrect readiness from a late status after revocation', async () => {
        const f = fixture(); let resolveStatus;
        f.api.runtime.sendMessage.mockReturnValue(new Promise(resolve => resolveStatus = resolve));
        const oldReady = f.controller.ready; await Promise.resolve();
        f.api.storage.local.get.mockResolvedValue({});
        f.change({ arcifyBridgePeerId: { newValue: '' } }, 'local');
        await f.controller.ready;
        resolveStatus({ success: true, status: { status: 'connected', peerId: PEER, capabilities: ['openSidebar'] } });
        await oldReady;
        expect(f.controller.result()).toBeNull();
    });
    it('does not resurrect readiness from a late storage read after revocation', async () => {
        const f = fixture(); await f.controller.ready;
        let resolveOld;
        f.api.storage.local.get.mockReturnValueOnce(new Promise(resolve => resolveOld = resolve)).mockResolvedValue({});
        const oldReady = f.controller.prepare();
        f.change({ arcifyBridgePeerId: { newValue: '' } }, 'local'); await f.controller.ready;
        resolveOld({ arcifyBridgePeerId: PEER }); await oldReady;
        expect(f.controller.result()).toBeNull();
    });
    it('reports refusal/invalid response, drops readiness and never retries or navigates', async () => {
        const f = fixture(); await f.controller.ready;
        f.controller.invoke(f.controller.result(), gesture());
        const [, request, callback] = externalCalls(f.api)[0];
        callback({ ...request, role: 'arcify', ok: false, error: { code: 'UNAUTHORIZED', message: 'Pairing was revoked.' } });
        expect(f.showError).toHaveBeenCalledWith('Pairing was revoked. Open Arcify from its toolbar button instead.');
        expect(f.controller.result()).toBeNull();
        expect(externalCalls(f.api)).toHaveLength(1);
    });
    it('suppresses repeated actions while pending and consumes timeout without retry', async () => {
        vi.useFakeTimers(); const f = fixture(); await f.controller.ready;
        const result = f.controller.result();
        f.controller.invoke(result, gesture()); f.controller.invoke(result, gesture());
        await vi.advanceTimersByTimeAsync(51);
        expect(externalCalls(f.api)).toHaveLength(1);
        expect(f.showError).toHaveBeenCalledWith(expect.stringContaining('did not confirm'));
    });
    it('suppresses old acknowledgement after pairing revision changes', async () => {
        const f = fixture(); await f.controller.ready;
        f.controller.invoke(f.controller.result(), gesture());
        const [, request, callback] = externalCalls(f.api)[0];
        f.api.storage.local.get.mockResolvedValue({});
        f.change({ arcifyBridgePeerId: { newValue: '' } }, 'local'); await f.controller.ready;
        callback({ ...request, role: 'arcify', ok: true });
        expect(f.showSuccess).not.toHaveBeenCalled(); expect(f.showError).not.toHaveBeenCalled();
    });
    it('ignores completion after disposal and leaves ordinary results to normal action routing', async () => {
        const f = fixture(); await f.controller.ready;
        expect(f.controller.invoke({ type: 'open-tab' }, gesture())).toBe(false);
        f.controller.invoke(f.controller.result(), gesture());
        const [, request, callback] = externalCalls(f.api)[0];
        f.controller.dispose(); callback({ ...request, role: 'arcify', ok: true });
        expect(f.showSuccess).not.toHaveBeenCalled();
    });
});
