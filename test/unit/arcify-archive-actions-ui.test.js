import { afterEach, describe, it, expect, vi } from 'vitest';
import { ArchiveActionController, archiveActionDefinition, matchArchiveEntryQuery } from '../../shared/arcify-archive-actions-ui.js';
import { resultIdentity } from '../../shared/selection-manager.js';
import { archiveScope, archiveResult, clone, spaceNames, PEER, OWN } from '../fixtures/archive-actions.js';
const enter = { type: 'keydown', key: 'Enter', isTrusted: true };
const click = { type: 'click', button: 0, isTrusted: true };
const controllers = [];
afterEach(() => { controllers.splice(0).forEach(controller => controller.dispose()); vi.useRealTimers(); });
function fixture(options = {}) {
    const state = { scope: archiveScope(), spaceNames: clone(spaceNames), callback: null, request: null };
    const listeners = [];
    const api = { runtime: { id: OWN, sendMessage: vi.fn((...args) => {
        if (typeof args[0] === 'string') { state.request = args[1]; state.callback = args[2]; return; }
        if (args[0].action === 'arcifyArchiveContext') return Promise.resolve({ success: true, scope: clone(state.scope), spaceNames: state.spaceNames });
        return Promise.resolve({ success: true, result: archiveResult(args[0].entryId) });
    }) }, tabs: { getCurrent: vi.fn(async () => ({ id: 9 })) }, storage: { onChanged: { addListener: fn => listeners.push(fn), removeListener: vi.fn() } } };
    const showError = vi.fn(), showSuccess = vi.fn(), onChange = vi.fn();
    const controller = new ArchiveActionController({ api, showError, showSuccess, onChange, ...options }); controllers.push(controller);
    const ack = patch => state.callback({ type: 'arcify-archive-open', version: 1, requestId: state.request.requestId, role: 'arcify', ok: true, displayed: true, ...patch });
    return { api, state, listeners, showError, showSuccess, onChange, controller, ack };
}
const external = f => f.api.runtime.sendMessage.mock.calls.filter(([arg]) => typeof arg === 'string');
const reopenCalls = f => f.api.runtime.sendMessage.mock.calls.filter(([arg]) => arg.action === 'arcifyArchiveReopen');
describe('one-shot Archive renderer controller', () => {
    it.each([enter, click])('dispatches Open Archive synchronously on trusted %j stack and requires displayed ACK', async gesture => {
        const f = fixture(); await f.controller.ready; const result = f.controller.results('open archive')[0];
        f.controller.invoke(result, gesture);
        expect(external(f)).toHaveLength(1); expect(f.state.request).toEqual({ type: 'arcify-archive-open', version: 1, requestId: expect.any(String), token: 'intent-1' });
        expect(external(f)[0][0]).toBe(PEER); expect(f.showSuccess).not.toHaveBeenCalled(); expect(f.controller.scope).toBeNull();
        f.ack(); await f.controller.operation; expect(f.showSuccess).toHaveBeenCalledWith('Arcify Archive opened.'); expect(f.controller.results('archive')).toEqual([]);
    });
    it.each([{ isTrusted: false }, { repeat: true }, { isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { key: 'Space' }])('rejects untrusted/held/IME/modifier gesture %j', async patch => {
        const f = fixture(); await f.controller.ready; f.controller.invoke(f.controller.results('open archive')[0], { ...enter, ...patch }); expect(external(f)).toHaveLength(0);
    });
    it('rejects stale result without replacing its identity', async () => {
        const f = fixture(); await f.controller.ready; const old = f.controller.results('open archive')[0]; f.state.scope.viewId = 'view-2'; await f.controller.prepare();
        f.controller.invoke(old, enter); expect(external(f)).toHaveLength(0); expect(f.showError).toHaveBeenCalled();
    });
    it('sends exactly once under repeated invocation and uncertain timeout; ignores late ACK', async () => {
        vi.useFakeTimers(); const f = fixture(); await f.controller.ready; const row = f.controller.results('open archive')[0];
        f.controller.invoke(row, enter); f.controller.invoke(row, enter); await vi.advanceTimersByTimeAsync(10000); await f.controller.operation;
        expect(external(f)).toHaveLength(1); expect(f.showError).toHaveBeenCalledOnce(); f.ack(); expect(f.showSuccess).not.toHaveBeenCalled();
        f.controller.invoke(row, enter); expect(external(f)).toHaveLength(1); expect(f.controller.scope).toBeNull();
    });
    it.each([{ displayed: undefined }, { displayed: false }, { extra: true }, { role: 'spotlight' }, { version: 2 }, { requestId: 'other' }, { ok: 1 }])('rejects malformed or merely opened success %j', async patch => {
        const f = fixture(); await f.controller.ready; f.controller.invoke(f.controller.results('open archive')[0], click); f.ack(patch); await f.controller.operation;
        expect(f.showError).toHaveBeenCalled(); expect(f.showSuccess).not.toHaveBeenCalled(); expect(external(f)).toHaveLength(1); expect(f.controller.scope).toBeNull();
    });
    it.each(['arcifyBridgePeerId', 'arcifyBridgePairingGeneration'])('invalidates pending results immediately on %s, ignoring late success', async key => {
        const f = fixture(); await f.controller.ready; const row = f.controller.results('open archive')[0]; f.controller.invoke(row, enter);
        f.listeners[0]({ [key]: { newValue: 'new' } }, 'local'); expect(f.controller.scope).toBeNull(); expect(f.controller.matches(row)).toBe(false);
        f.ack(); await f.controller.operation; expect(f.showSuccess).not.toHaveBeenCalled(); expect(f.showError).not.toHaveBeenCalled();
    });
    it('rejects in-flight preparation after a pair change', async () => {
        const f = fixture(); await f.controller.ready; const reads = [];
        f.api.runtime.sendMessage.mockImplementation(() => new Promise(done => { reads.push(done); }));
        const pending = f.controller.prepare(); f.listeners[0]({ arcifyBridgePairingGeneration: {} }, 'local');
        reads[1]({ success: true, scope: null, spaceNames: [] }); await f.controller.ready;
        reads[0]({ success: true, scope: archiveScope(), spaceNames }); await pending;
        expect(f.controller.scope).toBeNull(); expect(f.controller.results('archive')).toEqual([]);
    });
    it('does not rotate a view during a pending mutation', async () => {
        const f = fixture(); await f.controller.ready; f.controller.invoke(f.controller.results('open archive')[0], enter); await f.controller.prepare();
        expect(f.api.runtime.sendMessage.mock.calls.filter(([arg]) => arg.action === 'arcifyArchiveContext')).toHaveLength(1); f.ack(); await f.controller.operation;
    });
    it('reopens the exact same-URL twin once and preserves partial warnings', async () => {
        const f = fixture(); await f.controller.ready;
        const rows = f.controller.results('same archived title'), row = rows.find(item => item.metadata.archiveAction.entryId === 'entry-b');
        expect(rows).toHaveLength(2); expect(resultIdentity(rows[0])).not.toBe(resultIdentity(rows[1])); expect(archiveActionDefinition(row).subtitle).toBe('Archive • Home');
        f.api.runtime.sendMessage.mockResolvedValue({ success: true, result: { ...archiveResult(), status: 'partial', warning: 'Tab created; Archive cleanup needs checking.' } });
        f.controller.invoke(row, click); f.controller.invoke(row, click); await f.controller.operation;
        expect(reopenCalls(f)).toHaveLength(1); expect(reopenCalls(f)[0][0]).toEqual({ action: 'arcifyArchiveReopen', scope: row.metadata.archiveAction.scope, entryId: 'entry-b' });
        expect(f.showError).toHaveBeenCalledWith('Tab created; Archive cleanup needs checking.'); expect(f.showSuccess).not.toHaveBeenCalled(); expect(f.controller.scope).toBeNull();
    });
    it('does not replay a failed reopen or route it through generic navigation', async () => {
        const f = fixture(); await f.controller.ready; const row = f.controller.results('archive').find(item => item.metadata.archiveAction.entryId === 'entry-b');
        f.api.runtime.sendMessage.mockRejectedValue(new Error('Uncertain')); f.controller.invoke(row, enter); await f.controller.operation; f.controller.invoke(row, enter);
        expect(reopenCalls(f)).toHaveLength(1); expect(f.api.runtime.sendMessage.mock.calls.some(([arg]) => arg.action === 'spotlightHandleResult')).toBe(false); expect(f.showError).toHaveBeenCalled();
    });
    it('prepares the exact owned helper tab ID', async () => {
        const f = fixture({ newTab: true }); await f.controller.ready; expect(f.api.tabs.getCurrent).toHaveBeenCalledOnce(); expect(f.api.runtime.sendMessage).toHaveBeenCalledWith({ action: 'arcifyArchiveContext', tabId: 9 });
    });
    it('offers reopen entries without Open Archive when native sidebar support is absent', async () => {
        const f = fixture(); f.state.scope.openIntent = null; await f.controller.ready; await f.controller.prepare();
        expect(f.controller.results('open archive')).toEqual([]); expect(f.controller.results('archive')).toHaveLength(2);
    });
    it.each(['', 'qzxv', 'https://same.example/', 'archive unrelated', 'tab', 'open settings'])('does not expose Archive for unrelated query %j', async query => {
        const f = fixture(); await f.controller.ready; expect(f.controller.results(query)).toEqual([]);
    });
    it.each(['archive', 'archived', 'reopen', 'restore', 'same', 'reopen same', 'same archived title'])('matches only Archive terms or actual entry names: %s', query => {
        expect(matchArchiveEntryQuery(query, archiveScope().entries[0])).not.toBeNull();
    });
});
