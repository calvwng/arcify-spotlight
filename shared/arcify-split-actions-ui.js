/** Renderer-only, explicitly chosen native Split actions. */
import { PEER_KEY, PAIRING_GENERATION_KEY, bridgeError } from './arcify-bridge-protocol.js';
import { matchActionQuery, trustedActionGesture } from './arcify-space-actions-ui.js';
import { SPLIT_ACTION_TYPE, isSplitActionResult, exactKeys, validateSplitScope, validateSplitResult, sameSplitContext } from './arcify-split-actions-protocol.js';
export { isSplitActionResult };
export const SPLIT_ACTION_DEFINITIONS = {
    createSplitView: { title: 'Split current tab', subtitle: 'Choose another Today tab in this Space', action: 'Choose tab…', icon: 'split', terms: ['split', 'view', 'side', 'by', 'side', 'current', 'this', 'today', 'tab', 'the'] },
    endSplitView: { title: 'End Split', subtitle: 'Keep both tabs open in this Space', action: 'End Split', icon: 'split', terms: ['end', 'stop', 'unsplit', 'close', 'split', 'view', 'current', 'this', 'tab', 'the'] }
};
const UNKNOWN = 'Arcify did not confirm this Split action. Check Arcify before trying again.';
export function mountSplitPicker(parent, input) {
    const document = parent.ownerDocument;
    let active = null;
    const close = (value, restoreFocus = true) => {
        if (!active) return;
        const current = active; active = null; current.element.remove();
        for (const [element, previous] of current.inert) { element.inert = previous.inert; element.hidden = previous.hidden; element.style.display = previous.display; }
        current.resolve(value);
        if (restoreFocus && input.isConnected) input.focus();
    };
    return {
        show(targets) {
            if (active || !targets.length) return Promise.resolve(null);
            const choices = structuredClone(targets);
            return new Promise(resolve => {
                let selected = null;
                const element = document.createElement('section'); element.className = 'arcify-split-action-prompt';
                element.setAttribute('role', 'dialog'); element.setAttribute('aria-modal', 'true');
                const id = `arcify-split-${crypto.randomUUID()}`;
                element.setAttribute('aria-labelledby', `${id}-title`); element.setAttribute('aria-describedby', `${id}-description`);
                element.style.cssText = 'box-sizing:border-box;min-width:0;max-width:100%;padding:16px 20px;display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:auto auto minmax(0,1fr) auto;gap:12px;overflow:auto;max-height:320px;';
                Object.assign(element.style, { background: '#2d2d2d', color: '#fff', font: '14px/1.5 system-ui' });
                element.style.maxHeight = `${Math.min(420, Math.floor((document.defaultView?.parent?.innerHeight || 700) * .6))}px`;
                const style = document.createElement('style'); style.textContent = '.arcify-split-action-prompt > *, .arcify-split-action-prompt button { min-width:0;max-width:100%;box-sizing:border-box;overflow-wrap:anywhere; } .arcify-split-action-prompt :focus-visible { outline:2px solid #a8c7fa; outline-offset:2px; } .arcify-split-action-prompt [aria-selected="true"] { background:#3e4c66 !important; }';
                const heading = document.createElement('h2'); heading.id = `${id}-title`; heading.textContent = 'Choose a tab to split'; heading.style.cssText = 'font:600 16px/1.4 system-ui;margin:0';
                const description = document.createElement('p'); description.id = `${id}-description`; description.style.margin = '0'; description.textContent = 'Choose one Today tab, then confirm. Arcify may move it next to the current tab. Both tabs stay open.';
                const list = document.createElement('div'); list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', 'Compatible Today tabs'); list.style.cssText = 'min-height:0;min-width:0;overflow:auto;display:grid;gap:6px;';
                const buttons = document.createElement('div'); buttons.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;';
                const cancel = document.createElement('button'); cancel.type = 'button'; cancel.dataset.splitCancel = ''; cancel.textContent = 'Cancel';
                const confirm = document.createElement('button'); confirm.type = 'button'; confirm.dataset.splitConfirm = ''; confirm.textContent = 'Split tabs'; confirm.disabled = true;
                for (const button of [cancel, confirm]) {
                    button.style.cssText = 'border:1px solid #888;border-radius:6px;padding:6px 12px;cursor:pointer';
                    Object.assign(button.style, { font: 'inherit', color: 'inherit', background: '#414141' });
                }
                const options = choices.map(target => {
                    const option = document.createElement('button'); option.type = 'button'; option.setAttribute('role', 'option'); option.setAttribute('aria-selected', 'false'); option.dataset.splitTargetId = String(target.id);
                    option.style.cssText = 'min-width:0;max-width:100%;text-align:left;border:1px solid #888;border-radius:6px;padding:8px;overflow-wrap:anywhere;';
                    Object.assign(option.style, { font: 'inherit', color: 'inherit', background: '#202020' });
                    const title = document.createElement('div'); title.textContent = target.title || target.url;
                    const detail = document.createElement('div'); detail.textContent = `Tab ${target.id} • Position ${target.index + 1} • ${target.url}`; detail.style.cssText = 'font-size:12px;color:#d5d5d5;';
                    option.append(title, detail); list.append(option);
                    option.addEventListener('click', event => { if (trustedActionGesture(event)) choose(option); });
                    return option;
                });
                const choose = option => {
                    selected = choices[options.indexOf(option)];
                    options.forEach(item => item.setAttribute('aria-selected', String(item === option)));
                    confirm.disabled = !selected;
                };
                const submit = event => { if (trustedActionGesture(event) && selected) close(selected); };
                cancel.addEventListener('click', event => { if (trustedActionGesture(event)) close(null); });
                confirm.addEventListener('click', submit);
                buttons.append(cancel, confirm); element.append(style, heading, description, list, buttons);
                const inert = [...parent.children].map(child => [child, { inert: child.inert, hidden: child.hidden, display: child.style.display }]);
                for (const [child] of inert) { child.inert = true; child.hidden = true; child.style.display = 'none'; }
                active = { element, resolve, inert }; parent.append(element);
                element.addEventListener('keydown', event => {
                    event.stopPropagation();
                    if (event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey) return;
                    const trustedKey = event.isTrusted === true && !event.repeat;
                    if (event.key === 'Escape') { event.preventDefault(); if (trustedKey) close(null); }
                    if (event.key === 'Enter') { event.preventDefault(); if (event.target === cancel && trustedActionGesture(event)) close(null); else if (event.target === confirm || options.includes(event.target) && selected?.id === choices[options.indexOf(event.target)].id) submit(event); }
                    if (['ArrowDown', 'ArrowUp', 'Home', 'End', ' '].includes(event.key) && options.includes(event.target)) {
                        event.preventDefault();
                        if (!trustedKey) return;
                        const index = options.indexOf(event.target);
                        const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : event.key === ' ' ? index : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
                        choose(options[next]); options[next].focus();
                    }
                    if (event.key === 'Tab') {
                        const controls = [...options, cancel, ...(confirm.disabled ? [] : [confirm])], index = controls.indexOf(document.activeElement);
                        if (event.shiftKey && index <= 0) { event.preventDefault(); controls.at(-1).focus(); }
                        else if (!event.shiftKey && index === controls.length - 1) { event.preventDefault(); controls[0].focus(); }
                    }
                });
                options[0].focus(); // Focus is not a selection; Enter alone cannot create a split.
            });
        },
        cancel: () => close(null), get active() { return Boolean(active); }, dispose: () => close(null, false)
    };
}
export class SplitActionController {
    constructor({ api = chrome, parent, input, tabId, newTab = false, onChange = () => {}, showError = () => {}, showSuccess = () => {}, timeoutMs = 35000 }) {
        Object.assign(this, { api, tabId, newTab, onChange, showError, showSuccess, timeoutMs });
        this.picker = mountSplitPicker(parent, input);
        this.revision = 0; this.readRevision = 0; this.scope = null; this.disposed = false; this.pending = false; this.dispatching = false;
        this.onStorage = (changes, area) => {
            if (area !== 'local' || ![PEER_KEY, PAIRING_GENERATION_KEY].some(key => Object.hasOwn(changes, key))) return;
            this.invalidate(true); this.ready = this.prepare();
        };
        api.storage.onChanged.addListener(this.onStorage);
        this.ready = this.prepare();
    }
    invalidate(pairingChanged = false) {
        if (this.disposed) return;
        if (!this.dispatching || pairingChanged) this.revision++;
        this.readRevision++; this.scope = null; this.picker.cancel(); this.onChange();
    }
    async request(message) {
        let timer;
        try { return await Promise.race([this.api.runtime.sendMessage({ ...message, ...(this.tabId ? { tabId: this.tabId } : {}) }),
            new Promise((_, reject) => { timer = setTimeout(() => reject(bridgeError('TIMEOUT', UNKNOWN)), this.timeoutMs); })]); }
        finally { clearTimeout(timer); }
    }
    async prepare() {
        if (this.disposed) return;
        if (this.pending) { this.refreshAfter = true; if (!this.dispatching) this.invalidate(); return; }
        this.invalidate();
        const revision = this.revision, readRevision = ++this.readRevision;
        try {
            // Helper/new-tab surfaces never stand in for a previously active tab.
            if (this.newTab) return;
            const response = await this.request({ action: 'arcifySplitActionsContext' });
            if (this.disposed || revision !== this.revision || readRevision !== this.readRevision) return;
            if (!exactKeys(response, ['success', 'scope']) || response.success !== true) throw new Error(response?.error || UNKNOWN);
            this.scope = response.scope === null ? null : validateSplitScope(response.scope);
        } catch { if (!this.disposed && revision === this.revision && readRevision === this.readRevision) this.scope = null; }
        finally { if (!this.disposed && revision === this.revision && readRevision === this.readRevision) this.onChange(); }
    }
    results(query = '') {
        if (!this.scope?.context.tab || this.disposed || this.pending) return [];
        const command = this.scope.context.pair.length ? 'endSplitView' : this.scope.targets.length ? 'createSplitView' : null;
        if (!command) return [];
        const definition = SPLIT_ACTION_DEFINITIONS[command], matchScore = matchActionQuery(query, definition.terms);
        return matchScore === null ? [] : [{ type: SPLIT_ACTION_TYPE, title: definition.title, url: '', domain: '', metadata: { splitAction: { command, scope: structuredClone(this.scope) }, matchScore } }];
    }
    matches(result) {
        const action = result?.metadata?.splitAction;
        return Boolean(isSplitActionResult(result) && action && this.scope && sameSplitContext(action.scope, this.scope) &&
            action.command === (this.scope.context.pair.length ? 'endSplitView' : this.scope.targets.length ? 'createSplitView' : null));
    }
    invoke(result, event) {
        if (!isSplitActionResult(result)) return false;
        if (!trustedActionGesture(event) || this.disposed || this.pending) return true;
        if (!this.matches(result)) { this.showError('The Split choices changed. Refresh Spotlight and choose again.'); return true; }
        this.pending = true; this.readRevision++;
        this.operation = this.perform(result.metadata.splitAction, this.revision);
        return true;
    }
    async perform(action, revision) {
        let succeeded = false;
        try {
            const target = action.command === 'createSplitView' ? await this.picker.show(action.scope.targets) : undefined;
            if (target === null || this.disposed || revision !== this.revision) return;
            this.dispatching = true; this.scope = null; this.onChange();
            const response = await this.request({ action: 'arcifySplitAction', command: action.command, scope: action.scope, fields: target ? { target } : {} });
            if (this.disposed || revision !== this.revision) return;
            if (!exactKeys(response, ['success', 'result']) || response.success !== true) throw bridgeError(response?.errorCode || 'UNKNOWN_RESULT', response?.error || UNKNOWN);
            validateSplitResult(action.command, response.result, action.scope.context, target);
            succeeded = true;
            this.showSuccess(action.command === 'createSplitView' ? 'Split created. Both tabs stay open.' : 'Split ended. Both tabs stay open.');
        } catch (error) { if (!this.disposed && revision === this.revision) { this.scope = null; this.onChange(); this.showError(error.message || UNKNOWN); } }
        finally {
            this.pending = false; this.dispatching = false;
            const refresh = this.refreshAfter || succeeded; this.refreshAfter = false;
            if (!this.disposed && refresh) this.ready = this.prepare();
        }
    }
    dispose() {
        this.disposed = true; this.revision++; this.readRevision++; this.scope = null; this.picker.dispose();
        try { this.api.storage.onChanged.removeListener(this.onStorage); } catch { /* Extension may have reloaded. */ }
    }
}
