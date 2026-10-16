/** Renderer-only tab actions. Every mutation is exact-context and one-shot. */
import { PEER_KEY, PAIRING_GENERATION_KEY, bridgeError } from './arcify-bridge-protocol.js';
import { matchActionQuery, trustedActionGesture } from './arcify-space-actions-ui.js';
import { TAB_ACTION_TYPE, isTabActionResult, validateTabActionScope, sameTabActionContext, validTabTitle, validTabUrl, normalizeTabActionUrl, exactKeys, validateTabActionResult } from './arcify-tab-actions-protocol.js';
export { isTabActionResult };
export const TAB_ACTION_DEFINITIONS = {
    renameCurrentTab: { title: 'Rename current tab', subtitle: 'Choose a name for this exact Today tab', action: 'Rename…', icon: 'rename', terms: ['rename', 'name', 'change', 'title', 'current', 'this', 'today', 'tab', 'saved', 'space', 'pin', 'bookmark', 'the'] },
    editCurrentPinUrl: { title: 'Edit saved pin URL', subtitle: 'Update the saved URL • Keep this page and saved title', action: 'Edit URL…', icon: 'link', terms: ['edit', 'change', 'update', 'url', 'address', 'link', 'saved', 'current', 'this', 'space', 'pin', 'bookmark', 'the'] },
    duplicateCurrentTab: { title: 'Duplicate current tab', subtitle: 'Create another Today tab in this Space', action: 'Duplicate', icon: 'duplicate', terms: ['duplicate', 'clone', 'current', 'this', 'today', 'tab', 'the'] },
    copyCurrentLink: { title: 'Copy current link', subtitle: 'Copy the live page URL to the clipboard', action: 'Copy link', icon: 'link', terms: ['copy', 'current', 'this', 'tab', 'page', 'link', 'url', 'address', 'clipboard', 'the'] },
    setCurrentTabMuted: { title: 'Mute current tab', subtitle: 'Mute this exact live tab', action: 'Mute', icon: 'mute', terms: ['mute', 'current', 'this', 'tab', 'audio', 'sound', 'the'] }
};
export function tabActionDefinition(command, context) {
    const definition = TAB_ACTION_DEFINITIONS[command];
    if (command === 'renameCurrentTab' && context?.tab?.section === 'saved') return { ...definition, title: 'Rename saved Space pin', subtitle: 'Change the exact saved bookmark title' };
    if (command === 'setCurrentTabMuted' && context?.tab?.muted) return { ...definition, title: 'Unmute current tab', subtitle: 'Unmute this exact live tab', action: 'Unmute', terms: ['unmute', 'restore', 'current', 'this', 'tab', 'audio', 'sound', 'the'] };
    return definition;
}
const UNKNOWN = 'Arcify did not confirm this tab action. Check Arcify before trying again.';

/** Cancellable name/URL prompt mounted inside the isolated Spotlight surface. */
export function mountTabActionPrompt(parent, input) {
    const document = parent.ownerDocument;
    let active = null;
    const close = (value, restoreFocus = true) => {
        if (!active) return;
        const current = active; active = null; current.element.remove();
        for (const [element, previous] of current.inert) { element.inert = previous.inert; element.hidden = previous.hidden; element.style.display = previous.display; }
        current.resolve(value);
        if (restoreFocus && input.isConnected) input.focus();
    };
    const show = (command, context) => {
        if (active || !context.tab || !['renameCurrentTab', 'editCurrentPinUrl'].includes(command)) return Promise.resolve(null);
        return new Promise(resolve => {
            const editUrl = command === 'editCurrentPinUrl', saved = context.tab.section === 'saved';
            const element = document.createElement('section'); element.className = 'arcify-tab-action-prompt';
            element.setAttribute('role', 'dialog'); element.setAttribute('aria-modal', 'true');
            const id = `arcify-tab-action-${crypto.randomUUID()}`;
            element.setAttribute('aria-labelledby', `${id}-title`); element.setAttribute('aria-describedby', `${id}-description`);
            const heading = document.createElement('h2'); heading.id = `${id}-title`; heading.style.cssText = 'font:600 16px/1.4 system-ui;margin:0';
            heading.textContent = editUrl ? 'Edit saved pin URL' : saved ? 'Rename saved Space pin' : 'Rename Today tab';
            const description = document.createElement('p'); description.id = `${id}-description`; description.style.margin = '0';
            description.textContent = editUrl ? 'Change the saved URL for this exact pin. Its saved title and the current page stay unchanged.' : saved ? 'Change the saved name for this exact pin and its linked tab display.' : 'Set a name for this Today tab. Leave it blank to use the page title.';
            // Native controls and long names must not expand the grid beyond its isolated frame.
            const style = document.createElement('style'); style.textContent = `
                .arcify-tab-action-prompt { box-sizing:border-box;min-width:0;max-width:100%;padding:16px 20px;display:grid;grid-template-columns:minmax(0,1fr);gap:12px;background:#2d2d2d;color:#fff;font:14px/1.5 system-ui; }
                .arcify-tab-action-prompt > *, .arcify-tab-action-prompt button { box-sizing:border-box;min-width:0;max-width:100%;overflow-wrap:anywhere; }
                .arcify-tab-action-prompt input, .arcify-tab-action-prompt select { width:100%; }
                .arcify-tab-action-prompt :focus-visible { outline:2px solid #a8c7fa; outline-offset:2px; }
            `;
            const label = document.createElement('label'); label.textContent = editUrl ? 'Saved URL' : 'Name'; label.htmlFor = `${id}-input`;
            const name = document.createElement('input'); name.id = label.htmlFor; name.type = 'text'; name.autocomplete = 'off'; name.dataset.tabActionInput = '';
            name.maxLength = editUrl ? 16384 : 256; name.value = editUrl ? context.tab.bookmark.url : saved ? context.tab.bookmark.title : context.tab.alias || context.tab.title;
            name.style.cssText = 'font:inherit;color:inherit;background:#202020;border:1px solid #888;border-radius:6px;padding:8px;';
            const error = document.createElement('div'); error.setAttribute('role', 'alert'); error.style.color = '#ffb7b7';
            const buttons = document.createElement('div'); buttons.style.cssText = 'display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px';
            const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel'; cancel.dataset.actionCancel = '';
            const confirm = document.createElement('button'); confirm.type = 'button'; confirm.textContent = editUrl ? 'Save URL' : 'Save name'; confirm.dataset.actionConfirm = command;
            for (const button of [cancel, confirm]) button.style.cssText = 'font:inherit;color:inherit;background:#414141;border:1px solid #888;border-radius:6px;padding:6px 12px;cursor:pointer';
            buttons.append(cancel, confirm); element.append(style, heading, description, label, name, error, buttons);
            const inert = [...parent.children].map(child => [child, { inert: child.inert, hidden: child.hidden, display: child.style.display }]);
            for (const [child] of inert) { child.inert = true; child.hidden = true; child.style.display = 'none'; }
            active = { element, resolve, inert }; parent.append(element);
            const submit = event => {
                if (!trustedActionGesture(event)) return;
                const value = name.value.trim();
                if (editUrl ? !validTabUrl(value) : !validTabTitle(value, saved)) { error.textContent = editUrl ? 'Enter a complete supported URL without spaces.' : 'Use a name of up to 256 characters without control characters. A saved pin needs a name.'; name.focus(); return; }
                close(editUrl ? { url: normalizeTabActionUrl(value) } : { title: value });
            };
            cancel.addEventListener('click', event => { if (trustedActionGesture(event)) close(null); });
            confirm.addEventListener('click', submit);
            element.addEventListener('keydown', event => {
                event.stopPropagation();
                if (event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey) return;
                if (event.key === 'Escape') { event.preventDefault(); if (event.isTrusted && !event.repeat) close(null); }
                if (event.key === 'Enter') { event.preventDefault(); if (!trustedActionGesture(event)) return; if (event.target === cancel) close(null); else if (event.target === confirm || event.target === name) submit(event); }
                if (event.key === 'Tab') {
                    const controls = [name, cancel, confirm], index = controls.indexOf(document.activeElement);
                    if (event.shiftKey && index <= 0) { event.preventDefault(); confirm.focus(); }
                    else if (!event.shiftKey && index === controls.length - 1) { event.preventDefault(); name.focus(); }
                }
            });
            name.focus(); name.select();
        });
    };
    return { show, cancel: () => close(null), get active() { return Boolean(active); }, dispose: () => close(null, false) };
}

export class TabActionController {
    constructor({ api = chrome, parent, input, tabId, newTab = false, onChange = () => {}, showError = () => {}, showSuccess = () => {}, timeoutMs = 35000 }) {
        Object.assign(this, { api, tabId, newTab, onChange, showError, showSuccess, timeoutMs });
        this.prompt = mountTabActionPrompt(parent, input);
        this.revision = 0; this.readRevision = 0; this.scope = null; this.disposed = false; this.pending = false;
        this.onStorage = (changes, area) => {
            if (area !== 'local' || ![PEER_KEY, PAIRING_GENERATION_KEY].some(key => Object.hasOwn(changes, key))) return;
            this.revision++; this.scope = null; this.prompt.cancel(); this.onChange(); this.ready = this.prepare();
        };
        api.storage.onChanged.addListener(this.onStorage);
        this.ready = this.prepare();
    }
    async request(message) {
        let timer;
        try {
            return await Promise.race([this.api.runtime.sendMessage({ ...message, ...(this.tabId ? { tabId: this.tabId } : {}) }),
                new Promise((_, reject) => { timer = setTimeout(() => reject(bridgeError('TIMEOUT', UNKNOWN)), this.timeoutMs); })]);
        } finally { clearTimeout(timer); }
    }
    async prepare() {
        const revision = this.revision, readRevision = ++this.readRevision;
        try {
            if (this.newTab && !this.tabId) {
                const tab = await this.api.tabs.getCurrent();
                if (!Number.isSafeInteger(tab?.id) || tab.id <= 0) return;
                this.tabId = tab.id;
            }
            const response = await this.request({ action: 'arcifyTabActionsContext' });
            if (this.disposed || revision !== this.revision || readRevision !== this.readRevision) return;
            if (!exactKeys(response, ['success', 'scope']) || response.success !== true) throw new Error(response?.error || 'Arcify actions are unavailable.');
            this.scope = response.scope === null ? null : validateTabActionScope(response.scope);
        } catch {
            if (!this.disposed && revision === this.revision && readRevision === this.readRevision) this.scope = null;
        } finally { if (!this.disposed && revision === this.revision && readRevision === this.readRevision) this.onChange(); }
    }
    results(query = '') {
        if (!this.scope?.context.tab || this.disposed) return [];
        return Object.keys(TAB_ACTION_DEFINITIONS).flatMap(command => {
            if (command === 'editCurrentPinUrl' && this.scope.context.tab.section !== 'saved' || command === 'duplicateCurrentTab' && this.scope.context.tab.section !== 'today') return [];
            const definition = tabActionDefinition(command, this.scope.context);
            const matchScore = matchActionQuery(query, definition.terms);
            if (matchScore === null) return [];
            return [{ type: TAB_ACTION_TYPE, title: definition.title, url: '', domain: '', metadata: {
                tabAction: { command, scope: structuredClone(this.scope) }, matchScore } }];
        });
    }
    matches(result) {
        const action = result?.metadata?.tabAction;
        return isTabActionResult(result) && action && Object.hasOwn(TAB_ACTION_DEFINITIONS, action.command) && this.scope &&
            sameTabActionContext(action.scope, this.scope);
    }
    invoke(result, event) {
        if (!isTabActionResult(result)) return false;
        if (!trustedActionGesture(event) || this.disposed || this.pending) return true;
        if (!this.matches(result)) { this.showError('The action context changed. Refresh Spotlight and choose the action again.'); return true; }
        this.pending = true;
        this.operation = this.perform(result.metadata.tabAction, this.revision);
        return true;
    }
    async perform(action, revision) {
        try {
            let fields = action.command === 'setCurrentTabMuted' ? { muted: !action.scope.context.tab.muted } : {};
            if (['renameCurrentTab', 'editCurrentPinUrl'].includes(action.command)) {
                fields = await this.prompt.show(action.command, action.scope.context);
                if (fields === null) return;
            }
            if (this.disposed || revision !== this.revision) return;
            const response = await this.request({ action: 'arcifyTabAction', command: action.command, scope: action.scope, fields });
            if (this.disposed || revision !== this.revision) return;
            if (!exactKeys(response, ['success', 'result']) || response.success !== true) throw bridgeError(response?.errorCode || 'UNKNOWN_RESULT', response?.error || UNKNOWN);
            validateTabActionResult(action.command, response.result, action.scope.context, fields);
            this.showSuccess({ renameCurrentTab: action.scope.context.tab.section === 'saved' ? 'Saved pin renamed.' : 'Today tab name updated.', editCurrentPinUrl: 'Saved URL updated. This tab stays on its current page.', duplicateCurrentTab: 'Tab duplicated in Today.', copyCurrentLink: 'Current link copied.', setCurrentTabMuted: fields.muted ? 'Current tab muted.' : 'Current tab unmuted.' }[action.command]);
            this.scope = null; this.onChange();
            this.ready = this.prepare();
        } catch (error) {
            if (!this.disposed && revision === this.revision) { this.scope = null; this.onChange(); this.showError(error.message || UNKNOWN); }
        } finally { this.pending = false; }
    }
    dispose() {
        this.disposed = true; this.revision++; this.readRevision++; this.scope = null;
        this.prompt.dispose();
        try { this.api.storage.onChanged.removeListener(this.onStorage); } catch { /* An extension reload may invalidate the old content-script API. */ }
    }
}
