/** Renderer-only action choices and prompts. Navigation and sidebar gestures stay separate. */
import { PEER_KEY, PAIRING_GENERATION_KEY, bridgeError } from './arcify-bridge-protocol.js';
import { SPACE_NAVIGATION_COMMANDS, SPACE_ACTION_TYPE, isSpaceActionResult, validateActionScope, sameActionContext, validFolderTitle, exactKeys, validateActionResult } from './arcify-space-actions-protocol.js';
export { isSpaceActionResult };
export const ACTION_DEFINITIONS = {
    switchSpace: { title: 'Switch Space', subtitle: 'Choose an existing Space • Focus its last open tab', action: 'Choose Space…', icon: 'space', terms: ['switch', 'change', 'select', 'choose', 'go', 'to', 'another', 'existing', 'space', 'workspace', 'arcify', 'the'] },
    moveCurrentTodayTab: { title: 'Move current tab to another Space', subtitle: 'Exact Today tab • Append at the visible bottom • Keep this Space selected', action: 'Choose Space…', icon: 'move', terms: ['move', 'current', 'this', 'today', 'tab', 'to', 'another', 'existing', 'space', 'workspace', 'arcify', 'the'] },
    openSettings: { title: 'Open Arcify settings', subtitle: 'Arcify settings • This tab stays open', action: 'Open settings', icon: 'settings', terms: ['open', 'show', 'arcify', 'settings', 'preferences', 'options', 'the'] },
    createSpaceFolder: { title: 'Create folder in this Space', subtitle: 'Choose a name • Selected Arcify Space', action: 'Create folder', icon: 'folder', terms: ['create', 'make', 'new', 'add', 'named', 'folder', 'in', 'this', 'selected', 'space', 'arcify', 'a', 'the'] },
    pinCurrentTab: { title: 'Pin current tab to this Space', subtitle: 'Save this exact Today tab as a Space pin', action: 'Pin tab', icon: 'pin', terms: ['pin', 'save', 'current', 'this', 'tab', 'to', 'space', 'arcify', 'the'] },
    removeCurrentPin: { title: 'Remove current saved Space pin', subtitle: 'Delete the saved bookmark • All linked tabs stay open as Today', action: 'Remove pin…', icon: 'remove', terms: ['remove', 'unpin', 'delete', 'current', 'this', 'saved', 'space', 'pin', 'tab', 'bookmark', 'arcify', 'from', 'the'] }
};
function oneEdit(a, b) {
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0; while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
    if (i === Math.min(a.length, b.length)) return true;
    if (a.length !== b.length) return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
    return a.slice(i + 1) === b.slice(i + 1) || a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
}
export function matchActionQuery(query, terms) {
    const text = query.trim().toLowerCase();
    if (!text) return 0;
    if (text.length > 80 || !/^[a-z]+(?:\s+[a-z]+)*$/.test(text)) return null;
    const words = text.split(/\s+/);
    if (words.length > 8) return null;
    let total = 0;
    for (const word of words) {
        let best = 0;
        for (const term of terms) {
            if (word === term) best = 1;
            else if (word.length >= 2 && term.startsWith(word)) best = Math.max(best, .9 + .09 * word.length / term.length);
            else if (word.length >= 3 && (word[0] === term[0] || word[0] === term[1] && word[1] === term[0])) {
                for (const candidate of word.length >= 4 ? [term, term.slice(0, word.length), term.slice(0, word.length + 1)] : [term]) {
                    if (oneEdit(word, candidate)) best = Math.max(best, (1 - 1 / Math.max(word.length, candidate.length)) * (candidate === term ? 1 : .95));
                }
            }
        }
        if (!best) return null;
        total += best;
    }
    return total / words.length;
}
export const trustedActionGesture = event => event?.isTrusted === true && !event.repeat && !event.isComposing && event.keyCode !== 229 &&
    !event.ctrlKey && !event.metaKey && !event.altKey && ((event.type === 'keydown' && event.key === 'Enter') || (event.type === 'click' && event.button === 0));
const UNKNOWN = 'Arcify did not confirm this action. Check the selected Space before trying again.';

/** Inline modal inside either the isolated overlay document or the new-tab page. */
export function mountSpaceActionPrompt(parent, input) {
    const document = parent.ownerDocument;
    let active = null;
    const close = (value, restoreFocus = true) => {
        if (!active) return;
        const current = active; active = null;
        current.element.remove();
        for (const [element, previous] of current.inert) { element.inert = previous.inert; element.hidden = previous.hidden; element.style.display = previous.display; }
        current.resolve(value);
        if (restoreFocus && input.isConnected) input.focus();
    };
    const show = (command, context, navigation) => {
        if (active) return Promise.resolve(null);
        return new Promise(resolve => {
            const element = document.createElement('section');
            element.className = 'arcify-space-action-prompt';
            element.setAttribute('role', 'dialog'); element.setAttribute('aria-modal', 'true');
            const id = `arcify-action-${crypto.randomUUID()}`;
            element.setAttribute('aria-labelledby', `${id}-title`); element.setAttribute('aria-describedby', `${id}-description`);
            element.style.cssText = 'padding:16px 20px;display:grid;gap:12px;background:#2d2d2d;color:#fff;font:14px/1.5 system-ui;';
            const heading = document.createElement('h2'); heading.id = `${id}-title`; heading.style.cssText = 'font:600 16px/1.4 system-ui;margin:0';
            const description = document.createElement('p'); description.id = `${id}-description`; description.style.margin = '0';
            const choosing = SPACE_NAVIGATION_COMMANDS.includes(command), moving = command === 'moveCurrentTodayTab';
            const removing = command === 'removeCurrentPin';
            heading.textContent = choosing ? moving ? 'Move current Today tab' : 'Switch Space' : removing ? 'Remove saved Space pin?' : 'Create a folder';
            description.textContent = choosing ? moving
                ? 'Choose another existing Space. This exact tab goes to its visible bottom; the selected Space and browser focus stay as they are.'
                : 'Choose another existing Space. Its last open tab in this window will be focused; an empty Space leaves the current tab open.' : removing
                ? `Delete the saved bookmark “${context.tab.bookmark.title || context.tab.bookmark.url}” from this Space? Every live tab linked to this exact pin will stay open as Today. Other same-address pins are unchanged.`
                : 'Create a named folder at the root of the currently selected Arcify Space.';
            const style = document.createElement('style');
            style.textContent = '.arcify-space-action-prompt :focus-visible { outline: 2px solid #a8c7fa; outline-offset: 2px; }';
            element.append(style, heading, description);
            let name, destination;
            if (choosing) {
                const label = document.createElement('label'); label.textContent = 'Destination Space'; label.htmlFor = `${id}-destination`;
                destination = document.createElement('select'); destination.id = label.htmlFor; destination.dataset.spaceDestination = '';
                destination.style.cssText = 'font:inherit;color:inherit;background:#202020;border:1px solid #888;border-radius:6px;padding:8px;';
                const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Choose a Space…'; placeholder.disabled = true; placeholder.selected = true; destination.append(placeholder);
                for (const [index, target] of navigation.destinations.entries()) {
                    const option = document.createElement('option'); option.value = String(index);
                    option.textContent = navigation.destinations.filter(item => item.name === target.name).length > 1 ? `${target.name} (${target.spaceId})` : target.name || target.spaceId;
                    destination.append(option);
                }
                element.append(label, destination);
            }
            if (!removing && !choosing) {
                const label = document.createElement('label'); label.textContent = 'Folder name'; label.htmlFor = `${id}-name`;
                name = document.createElement('input'); name.id = label.htmlFor; name.type = 'text'; name.maxLength = 256; name.autocomplete = 'off';
                name.style.cssText = 'font:inherit;color:inherit;background:#202020;border:1px solid #888;border-radius:6px;padding:8px;';
                element.append(label, name);
            }
            const error = document.createElement('div'); error.setAttribute('role', 'alert'); error.style.color = '#ffb7b7';
            const buttons = document.createElement('div'); buttons.style.cssText = 'display:flex;justify-content:flex-end;gap:8px';
            const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel';
            const confirm = document.createElement('button'); confirm.type = 'button'; confirm.textContent = choosing ? moving ? 'Move tab' : 'Switch Space' : removing ? 'Remove saved pin' : 'Create folder';
            confirm.dataset.actionConfirm = command; cancel.dataset.actionCancel = '';
            for (const button of [cancel, confirm]) button.style.cssText = 'font:inherit;color:inherit;background:#414141;border:1px solid #888;border-radius:6px;padding:6px 12px;cursor:pointer';
            buttons.append(cancel, confirm); element.append(error, buttons);
            const inert = [...parent.children].map(child => [child, { inert: child.inert, hidden: child.hidden, display: child.style.display }]);
            for (const [child] of inert) { child.inert = true; child.hidden = true; child.style.display = 'none'; }
            active = { element, resolve, inert }; parent.append(element);
            const submit = event => {
                if (!trustedActionGesture(event)) return;
                if (choosing) {
                    const target = navigation.destinations.find((_, index) => String(index) === destination.value);
                    if (!target) { error.textContent = 'Choose a destination Space first.'; destination.focus(); return; }
                    close({ destination: { spaceId: target.spaceId, bookmarkFolderId: target.bookmarkFolderId } }); return;
                }
                const title = name?.value.trim();
                if (name && !validFolderTitle(title)) { error.textContent = 'Enter a folder name of 1–256 characters without control characters.'; name.focus(); return; }
                close(removing ? { confirmed: true } : { title });
            };
            cancel.addEventListener('click', event => { if (trustedActionGesture(event)) close(null); });
            confirm.addEventListener('click', submit);
            element.addEventListener('keydown', event => {
                // Stop at this modal, including Escape, before overlay close/navigation.
                event.stopPropagation();
                if (event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey) return;
                if (event.key === 'Escape') { event.preventDefault(); if (event.isTrusted && !event.repeat) close(null); }
                if (event.key === 'Enter') {
                    event.preventDefault();
                    if (!trustedActionGesture(event)) return;
                    if (event.target === cancel) close(null);
                    else if (event.target === confirm || name && event.target === name || destination && event.target === destination) submit(event);
                }
                if (event.key === 'Tab') {
                    const controls = [destination, name, cancel, confirm].filter(Boolean);
                    const index = controls.indexOf(document.activeElement);
                    if (event.shiftKey && index <= 0) { event.preventDefault(); controls.at(-1).focus(); }
                    else if (!event.shiftKey && index === controls.length - 1) { event.preventDefault(); controls[0].focus(); }
                }
            });
            // A destructive prompt is safe under a held Enter key; Cancel owns initial focus.
            (choosing ? destination : removing ? cancel : name).focus();
        });
    };
    return { show, cancel: () => close(null), get active() { return Boolean(active); }, dispose: () => close(null, false) };
}

export class SpaceActionController {
    constructor({ api = chrome, parent, input, tabId, newTab = false, onChange = () => {}, showError = () => {}, showSuccess = () => {}, timeoutMs = 35000 }) {
        Object.assign(this, { api, tabId, newTab, onChange, showError, showSuccess, timeoutMs });
        this.prompt = mountSpaceActionPrompt(parent, input);
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
            const response = await this.request({ action: 'arcifySpaceActionsContext' });
            if (this.disposed || revision !== this.revision || readRevision !== this.readRevision) return;
            if (!exactKeys(response, ['success', 'scope']) || response.success !== true) throw new Error(response?.error || 'Arcify actions are unavailable.');
            this.scope = response.scope === null ? null : validateActionScope(response.scope);
        } catch {
            if (!this.disposed && revision === this.revision && readRevision === this.readRevision) this.scope = null;
        } finally { if (!this.disposed && revision === this.revision && readRevision === this.readRevision) this.onChange(); }
    }
    results(query = '') {
        if (!this.scope || this.disposed) return [];
        return Object.entries(ACTION_DEFINITIONS).flatMap(([command, definition]) => {
            if (SPACE_NAVIGATION_COMMANDS.includes(command) && !this.scope.navigation?.destinations.length
                || command === 'moveCurrentTodayTab' && this.scope.context.tab?.section !== 'today') return [];
            if (command === 'pinCurrentTab' && this.scope.context.tab?.section !== 'today' || command === 'removeCurrentPin' && this.scope.context.tab?.section !== 'saved') return [];
            if (command === 'removeCurrentPin' && query.trim() && !query.trim().split(/\s+/).some(word => matchActionQuery(word, ['remove', 'unpin', 'delete']) !== null)) return [];
            const matchScore = matchActionQuery(query, definition.terms);
            if (matchScore === null) return [];
            return [{ type: SPACE_ACTION_TYPE, title: definition.title, url: '', domain: '', metadata: {
                spaceAction: { command, scope: structuredClone(this.scope) }, matchScore } }];
        });
    }
    matches(result) {
        const action = result?.metadata?.spaceAction;
        return isSpaceActionResult(result) && action && Object.hasOwn(ACTION_DEFINITIONS, action.command) && this.scope &&
            sameActionContext(action.scope, this.scope);
    }
    invoke(result, event) {
        if (!isSpaceActionResult(result)) return false;
        if (!trustedActionGesture(event) || this.disposed || this.pending) return true;
        if (!this.matches(result)) { this.showError('The action context changed. Refresh Spotlight and choose the action again.'); return true; }
        this.pending = true;
        this.operation = this.perform(result.metadata.spaceAction, this.revision);
        return true;
    }
    async perform(action, revision) {
        try {
            let fields = {};
            if (['createSpaceFolder', 'removeCurrentPin', ...SPACE_NAVIGATION_COMMANDS].includes(action.command)) {
                fields = await this.prompt.show(action.command, action.scope.context, action.scope.navigation);
                if (fields === null) return;
            }
            if (this.disposed || revision !== this.revision) return;
            const response = await this.request({ action: 'arcifySpaceAction', command: action.command, scope: action.scope, fields });
            if (this.disposed || revision !== this.revision) return;
            if (!exactKeys(response, ['success', 'result']) || response.success !== true) throw bridgeError(response?.errorCode || 'UNKNOWN_RESULT', response?.error || UNKNOWN);
            validateActionResult(action.command, response.result, action.scope.context, fields);
            this.showSuccess({ switchSpace: 'Selected Space switched.', moveCurrentTodayTab: 'Current tab moved. This Space stays selected.', openSettings: 'Arcify settings opened. This tab stays open.', createSpaceFolder: 'Folder created in the selected Space.', pinCurrentTab: 'Current tab saved as a Space pin.', removeCurrentPin: 'Saved pin removed. All linked tabs stay open as Today.' }[action.command]);
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
