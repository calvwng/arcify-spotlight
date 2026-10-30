// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SplitActionController } from '../../shared/arcify-split-actions-ui.js';
import { splitScope, splitResult, clone } from '../fixtures/split-actions.js';
let controller, api, scope, parent, input, spy, showSuccess, showError, listeners;
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const picker = () => parent.querySelector('.arcify-split-action-prompt');
const options = () => [...picker().querySelectorAll('[role="option"]')];
const mutations = () => api.runtime.sendMessage.mock.calls.filter(([message]) => message.action === 'arcifySplitAction');
function fire(target, type, extra = {}) {
    const event = { type, target, key: 'Enter', button: 0, isTrusted: true, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra };
    spy.mock.calls.forEach(([name, callback], i) => { if (name === type && spy.mock.contexts[i] === target) callback(event); }); return event;
}
const invoke = (event = {}) => controller.invoke(controller.results('split')[0], { type: 'keydown', key: 'Enter', isTrusted: true, ...event });
beforeEach(() => {
    document.body.innerHTML = '<main><input><div class="results">Results</div></main>'; parent = document.querySelector('main'); input = parent.querySelector('input');
    scope = splitScope(); listeners = []; spy = vi.spyOn(EventTarget.prototype, 'addEventListener'); showSuccess = vi.fn(); showError = vi.fn();
    api = { storage: { onChanged: { addListener: listener => listeners.push(listener), removeListener: vi.fn() } }, runtime: { sendMessage: vi.fn(async message => message.action === 'arcifySplitActionsContext' ? { success: true, scope: clone(scope) } : { success: true, result: splitResult(message.command, message.scope, message.fields.target) }) } };
});
afterEach(() => { controller?.dispose(); controller = null; vi.restoreAllMocks(); vi.useRealTimers(); });
async function mount(options = {}) { controller = new SplitActionController({ api, parent, input, showSuccess, showError, ...options }); await controller.ready; }
describe('Split controller and accessible explicit picker', () => {
    it('offers no action without a source or any compatible target', async () => {
        await mount(); expect(controller.results('split')).toHaveLength(1); scope.context.tab = null; scope.targets = []; await controller.prepare(); expect(controller.results('split')).toEqual([]);
        scope = splitScope(); scope.targets = []; await controller.prepare(); expect(controller.results('split')).toEqual([]);
    });
    it('never resolves a helper/newtab renderer to a previous content tab', async () => {
        await mount({ newTab: true }); expect(controller.results('split')).toEqual([]); expect(api.runtime.sendMessage).not.toHaveBeenCalled();
    });
    it('does not preselect, distinguishes duplicate URLs/titles by exact ID/native position, and requires explicit choice', async () => {
        await mount(); invoke();
        expect(picker().getAttribute('aria-modal')).toBe('true'); expect(picker().getAttribute('aria-labelledby')).toBeTruthy();
        expect(options().map(option => option.getAttribute('aria-selected'))).toEqual(['false', 'false']);
        expect(options()[0].textContent).toContain('Tab 10 • Position 2'); expect(options()[1].textContent).toContain('Tab 11 • Position 3');
        expect(picker().querySelector('[data-split-confirm]').disabled).toBe(true);
        fire(picker(), 'keydown', { target: options()[0] }); await flush(); expect(mutations()).toHaveLength(0);
        fire(options()[1], 'click'); const selected = options()[1]; expect(selected.getAttribute('aria-selected')).toBe('true');
        fire(picker(), 'keydown', { target: selected }); await controller.operation;
        expect(mutations()).toHaveLength(1); expect(mutations()[0][0].fields.target).toEqual(splitScope().targets[1]); expect(showSuccess).toHaveBeenCalledOnce();
    });
    it('does not confirm another selected target when Enter is pressed on an unselected focused option', async () => {
        await mount(); invoke(); fire(options()[0], 'click'); options()[1].focus();
        fire(picker(), 'keydown', { target: options()[1] }); await flush(); expect(mutations()).toHaveLength(0);
        fire(picker(), 'keydown', { target: options()[1], key: ' ' }); fire(picker(), 'keydown', { target: options()[1] }); await controller.operation;
        expect(mutations()[0][0].fields.target.id).toBe(11);
    });
    it('supports deliberate keyboard selection and wraps focus within the picker', async () => {
        await mount(); invoke(); fire(picker(), 'keydown', { target: options()[0], key: 'ArrowDown' }); expect(options()[1].getAttribute('aria-selected')).toBe('true');
        expect(document.activeElement).toBe(options()[1]); const confirm = picker().querySelector('[data-split-confirm]'); confirm.focus();
        const event = fire(picker(), 'keydown', { target: confirm, key: 'Tab' }); expect(event.preventDefault).toHaveBeenCalled(); expect(document.activeElement).toBe(options()[0]);
        fire(picker(), 'keydown', { target: options()[0], key: 'Tab', shiftKey: true }); expect(document.activeElement).toBe(confirm);
    });
    it.each(['Escape', 'Cancel'])('dismisses %s without mutation and restores draft/focus', async method => {
        await mount(); input.value = 'split draft'; invoke();
        if (method === 'Escape') fire(picker(), 'keydown', { key: 'Escape' }); else fire(picker().querySelector('[data-split-cancel]'), 'click');
        await controller.operation; expect(picker()).toBeNull(); expect(input.value).toBe('split draft'); expect(document.activeElement).toBe(input); expect(input.hidden).toBe(false); expect(mutations()).toHaveLength(0);
    });
    it.each([{ isTrusted: false }, { repeat: true }, { isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { altKey: true }, { metaKey: true }])('blocks untrusted/repeated/IME/modified invocation %j', async patch => {
        await mount(); invoke(patch); expect(picker()).toBeNull(); expect(mutations()).toHaveLength(0);
    });
    it('rejects synthetic choice/confirm and held Enter', async () => {
        await mount(); invoke(); options()[0].click(); fire(picker(), 'keydown', { target: options()[0], key: ' ', isTrusted: false });
        expect(picker().querySelector('[data-split-confirm]').disabled).toBe(true);
        fire(options()[0], 'click'); picker().querySelector('[data-split-confirm]').click(); fire(picker(), 'keydown', { target: options()[0], repeat: true });
        await flush(); expect(mutations()).toHaveLength(0);
    });
    it('cancels selection immediately when native context invalidates, with no replay', async () => {
        await mount(); const result = controller.results('split')[0]; invoke(); fire(options()[0], 'click'); controller.invalidate();
        expect(picker()).toBeNull(); expect(controller.scope).toBeNull(); await controller.operation;
        controller.invoke(result, { type: 'click', button: 0, isTrusted: true }); expect(mutations()).toHaveLength(0); expect(showError).toHaveBeenCalledOnce();
    });
    it('cancels during refresh and rejects late stale reads', async () => {
        await mount(); invoke(); fire(options()[1], 'click'); await controller.prepare(); await controller.operation; await controller.ready;
        expect(picker()).toBeNull(); expect(mutations()).toHaveLength(0);
        let resolve; api.runtime.sendMessage.mockImplementationOnce(() => new Promise(done => { resolve = done; })); const old = controller.prepare();
        scope = splitScope(true); await controller.prepare(); resolve({ success: true, scope: splitScope() }); await old;
        expect(controller.results('end split')[0].metadata.splitAction.command).toBe('endSplitView');
    });
    it('ends exact pair once without picker and no automatic replay after success', async () => {
        scope = splitScope(true); await mount(); const result = controller.results('end split')[0]; invoke(); invoke(); await controller.operation;
        expect(picker()).toBeNull(); expect(mutations()).toHaveLength(1); expect(mutations()[0][0].fields).toEqual({}); expect(showSuccess).toHaveBeenCalledWith('Split ended. Both tabs stay open.');
    });
    it('suppresses late results on pairing change and disposal', async () => {
        scope = splitScope(true); await mount(); let resolve; api.runtime.sendMessage.mockImplementationOnce(() => new Promise(done => { resolve = done; })); invoke();
        listeners[0]({ arcifyBridgePairingGeneration: { newValue: 'new' } }, 'local'); controller.dispose(); resolve({ success: true, result: splitResult('endSplitView', scope) }); await controller.operation;
        expect(showSuccess).not.toHaveBeenCalled(); expect(mutations()).toHaveLength(1);
    });
    it('does not retry failure, timeout, or malformed acknowledgement', async () => {
        scope = splitScope(true); await mount(); api.runtime.sendMessage.mockResolvedValueOnce({ success: true, result: { ...splitResult('endSplitView', scope), tabIds: [9, 11] } }); invoke(); await controller.operation;
        expect(showError).toHaveBeenCalledOnce(); expect(showSuccess).not.toHaveBeenCalled(); expect(controller.results('split')).toEqual([]); expect(mutations()).toHaveLength(1);
    });
    it('uses a bounded shrinkable layout for long identical URLs/titles', async () => {
        scope.targets.forEach(tab => { tab.title = 'x'.repeat(1024); tab.url = `https://example.test/${'z'.repeat(1000)}`; }); await mount(); invoke();
        expect(picker().style.gridTemplateColumns).toBe('minmax(0,1fr)'); expect(picker().style.minWidth).toBe('0'); expect(picker().style.maxWidth).toBe('100%'); expect(picker().style.overflow).toBe('auto');
        expect(options()[0].style.overflowWrap).toBe('anywhere'); expect(picker().querySelector('style').textContent).toContain('max-width:100%');
    });
});
