// @vitest-environment jsdom
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { TransientActionController, transientUrlFromQuery } from '../../shared/arcify-transient-actions-ui.js';
import { SharedSpotlightLogic } from '../../shared/shared-component-logic.js';
import { SpotlightUtils } from '../../shared/ui-utilities.js';
import { resultIdentity } from '../../shared/selection-manager.js';
import { transientScope, transientResult, clone } from '../fixtures/transient-actions.js';
let controller, api, scope, showError, showSuccess, listeners;
const gesture = { type: 'keydown', key: 'Enter', isTrusted: true };
const mutations = () => api.runtime.sendMessage.mock.calls.filter(([message]) => message.action === 'arcifyOpenTransient');
beforeEach(() => {
    scope = transientScope(); listeners = []; showError = vi.fn(); showSuccess = vi.fn();
    api = { tabs: { getCurrent: vi.fn(async () => ({ id: 9 })) }, storage: { onChanged: { addListener: listener => listeners.push(listener), removeListener: vi.fn() } },
        runtime: { sendMessage: vi.fn(async message => message.action === 'arcifyTransientContext' ? { success: true, scope: clone(scope) } : { success: true, result: transientResult() }) } };
});
afterEach(() => { controller?.dispose(); controller = null; vi.restoreAllMocks(); vi.useRealTimers(); });
async function mount(options = {}) { controller = new TransientActionController({ api, showError, showSuccess, ...options }); await controller.ready; }
const result = () => controller.results('https://target.test/')[0];
describe('Little Arc explicit URL controller', () => {
    it.each(['https://target.test/', 'little arc https://target.test/', ' Little Arc   https://target.test/ '])('extracts %s', query => expect(transientUrlFromQuery(query)).toBe('https://target.test/'));
    it.each(['', 'little arc', 'example.test', 'little arc example.test', 'open little arc https://target.test/', 'little arc javascript:alert(1)', 'chrome://settings'])('offers nothing for %s', async query => { await mount(); expect(controller.results(query)).toEqual([]); });
    it('hides when the background reports an old/unpaired peer', async () => { scope = null; await mount(); expect(result()).toBeUndefined(); expect(mutations()).toHaveLength(0); });
    it('keeps the ordinary complete URL row first; explicit command can be first', async () => {
        await mount();
        for (const query of ['https://target.test/', 'little arc https://target.test/']) {
            const instant = SpotlightUtils.generateInstantSuggestion(query), actions = controller.results(query);
            const ordinary = { type: 'history', title: 'Past page', url: 'https://past.test/' };
            const combined = SharedSpotlightLogic.combineResults(instant, [ordinary], { query, actions });
            expect(combined[0].type).toBe(query.startsWith('little') ? 'arcify-transient-action' : 'url-suggestion');
            expect(combined).toContain(instant); expect(combined).toContain(ordinary);
            if (!query.startsWith('little')) expect(combined[1]).toBe(actions[0]);
        }
    });
    it('uses exact URL/context identity and safe result formatting', async () => {
        await mount(); const first = result();
        const second = controller.results('https://target.test/other')[0]; expect(resultIdentity(first)).not.toBe(resultIdentity(second));
        expect(controller.matches(first)).toBe(false);
        expect(SpotlightUtils.formatResult(second)).toMatchObject({ title: 'Open link in Little Arc', action: 'Open Little Arc' });
        expect(SpotlightUtils.formatResult(second).subtitle).toContain('After restart: no control tab → ordinary tabs');
        expect(SharedSpotlightLogic.generateResultsHTML([second], 'current-tab')).toContain('data-result-type="arcify-transient-action"');
    });
    it('resolves newtab source only with getCurrent and includes its exact ID', async () => {
        await mount({ newTab: true }); expect(api.tabs.getCurrent).toHaveBeenCalledOnce(); expect(api.runtime.sendMessage.mock.calls[0][0]).toEqual({ action: 'arcifyTransientContext', tabId: 9 });
    });
    it.each([{ isTrusted: false }, { repeat: true }, { isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { type: 'click', button: 1 }])('ignores synthetic/repeated/modified gesture %j', async patch => {
        await mount(); expect(controller.invoke(result(), { ...gesture, ...patch })).toBe(true); expect(mutations()).toHaveLength(0);
    });
    it('consumes the selected URL once on double Enter/click and never handles ordinary rows', async () => {
        await mount(); let resolve; api.runtime.sendMessage.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
        const selected = result(); expect(controller.invoke({ type: 'url-suggestion', url: selected.metadata.transientAction.url }, gesture)).toBe(false);
        controller.invoke(selected, gesture); controller.invoke(selected, { type: 'click', button: 0, isTrusted: true });
        expect(mutations()).toHaveLength(1); expect(controller.results('https://target.test/')).toEqual([]);
        resolve({ success: true, result: transientResult() }); await controller.operation; expect(showSuccess).toHaveBeenCalledOnce();
    });
    it('rejects stale query/context rows and late reads', async () => {
        await mount(); const selected = result(); controller.results('https://other.test/'); controller.invoke(selected, gesture); expect(mutations()).toHaveLength(0);
        let resolve; api.runtime.sendMessage.mockImplementationOnce(() => new Promise(done => { resolve = done; })); const old = controller.prepare();
        scope.viewId = 'new-view'; await controller.prepare(); resolve({ success: true, scope: transientScope() }); await old;
        expect(controller.scope.viewId).toBe('new-view'); controller.invoke(selected, gesture); expect(mutations()).toHaveLength(0);
    });
    it.each(['pairing', 'dispose'])('suppresses late success after %s', async kind => {
        await mount(); let resolve; api.runtime.sendMessage.mockImplementationOnce(() => new Promise(done => { resolve = done; })); controller.invoke(result(), gesture);
        if (kind === 'pairing') listeners[0]({ arcifyBridgePairingGeneration: { newValue: 'new' } }, 'local'); else controller.dispose();
        resolve({ success: true, result: transientResult() }); await controller.operation; expect(showSuccess).not.toHaveBeenCalled(); expect(mutations()).toHaveLength(1);
    });
    it('times out with actionable uncertainty and never replays or falls back', async () => {
        vi.useFakeTimers(); await mount({ timeoutMs: 30 }); api.runtime.sendMessage.mockImplementationOnce(() => new Promise(() => {}));
        const selected = result(); controller.invoke(selected, gesture); await vi.advanceTimersByTimeAsync(31); await controller.operation;
        expect(showError).toHaveBeenCalledWith(expect.stringContaining('Check for an existing temporary window')); expect(showSuccess).not.toHaveBeenCalled();
        controller.invoke(selected, gesture); expect(mutations()).toHaveLength(1); expect(controller.scope).toBeNull();
    });
    it('treats a malformed success as unknown, without any navigation request', async () => {
        await mount(); api.runtime.sendMessage.mockResolvedValueOnce({ success: true, result: { ...transientResult(), transientWindowId: 2 } }); controller.invoke(result(), gesture); await controller.operation;
        expect(showSuccess).not.toHaveBeenCalled(); expect(showError).toHaveBeenCalledOnce(); expect(mutations()).toHaveLength(1);
        expect(api.runtime.sendMessage.mock.calls.some(([message]) => message.action === 'spotlightHandleResult')).toBe(false);
    });
});
