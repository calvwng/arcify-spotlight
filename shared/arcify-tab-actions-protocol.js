/** Optional live-tab actions have their own context; Space actions v1 stays unchanged. */
import { bridgeError, isSafeUrl, isWindowId } from './arcify-bridge-protocol.js';
import { exactKeys, validateActionContext, validateActionScope, sameActionContext } from './arcify-space-actions-protocol.js';
export { exactKeys };
export const TAB_ACTIONS_FEATURE = 'tabActionsV1';
export const TAB_ACTION_TYPE = 'arcify-tab-action';
export const TAB_ACTION_COMMANDS = ['renameCurrentTab', 'editCurrentPinUrl', 'duplicateCurrentTab', 'copyCurrentLink', 'setCurrentTabMuted'];
export const isTabActionResult = result => result?.type === TAB_ACTION_TYPE;
export const sameTabActionContext = sameActionContext;
const invalid = message => { throw bridgeError('INVALID_RESPONSE', message || 'Arcify returned invalid tab action context. Refresh Spotlight.'); };
const text = (value, limit) => typeof value === 'string' && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value);
export const validTabTitle = (value, saved = false) => text(value, 256) && value === value.trim() && (!saved || Boolean(value));
export const validTabUrl = value => typeof value === 'string' && value === value.trim() && !/[\s\x00-\x20\x7f\\]/.test(value) &&
    (value === 'about:blank' || /^(?:https?|file|chrome):\/\//i.test(value)) && isSafeUrl(value);
// Normalize in the prompt before dispatch so Chrome's canonical bookmark URL
// and the exact wire acknowledgement agree (including a bare host's slash).
export function normalizeTabActionUrl(value) {
    if (!validTabUrl(value)) throw bridgeError('INVALID_REQUEST', 'Enter a complete supported URL without spaces.');
    const parsed = new URL(value);
    if (parsed.protocol === 'chrome:') {
        parsed.hostname = parsed.hostname.toLowerCase();
        if (!parsed.pathname) parsed.pathname = '/';
    }
    return parsed.href;
}
export function validateTabActionContext(context, windowId, tabId) {
    if (!exactKeys(context, ['windowId', 'spaceId', 'bookmarkFolderId', 'pairingGeneration', 'sourceTabId', 'tab'])) invalid();
    if (context.tab === null) { validateActionContext(context, windowId, tabId); return context; }
    const tab = context.tab;
    if (!exactKeys(tab, ['id', 'url', 'title', 'section', 'bookmark', 'alias', 'muted']) || !text(tab.alias, 1024) || typeof tab.muted !== 'boolean' ||
        tab.section === 'saved' && tab.alias !== '') invalid();
    const { alias, muted, ...base } = tab;
    validateActionContext({ ...context, tab: base }, windowId, tabId);
    return context;
}
export function validateTabActionScope(scope) {
    if (!exactKeys(scope, ['peerId', 'generation', 'context'])) invalid();
    validateTabActionContext(scope.context, scope.context?.windowId, scope.context?.sourceTabId);
    const tab = scope.context.tab;
    const base = tab && Object.fromEntries(Object.entries(tab).filter(([key]) => !['alias', 'muted'].includes(key)));
    validateActionScope({ ...scope, context: { ...scope.context, tab: base } });
    return scope;
}
export function tabActionFields(command) {
    return command === 'renameCurrentTab' ? ['title'] : command === 'editCurrentPinUrl' ? ['url'] : command === 'setCurrentTabMuted' ? ['muted'] : [];
}
export function validateTabActionPayload(command, payload) {
    if (!TAB_ACTION_COMMANDS.includes(command) || !exactKeys(payload, ['context', ...tabActionFields(command)])) throw bridgeError('INVALID_REQUEST', 'Invalid Arcify tab action.');
    const context = validateTabActionContext(payload.context, payload.context?.windowId, payload.context?.sourceTabId);
    if (!context.tab || command === 'editCurrentPinUrl' && context.tab.section !== 'saved' || command === 'duplicateCurrentTab' && context.tab.section !== 'today')
        throw bridgeError('INVALID_REQUEST', 'That action is unavailable for this exact tab.');
    if (command === 'renameCurrentTab' && !validTabTitle(payload.title, context.tab.section === 'saved')) throw bridgeError('INVALID_REQUEST', 'Use a name of up to 256 characters without control characters. A saved pin needs a name.');
    if (command === 'editCurrentPinUrl' && (!validTabUrl(payload.url) || normalizeTabActionUrl(payload.url) !== payload.url)) throw bridgeError('INVALID_REQUEST', 'Enter a complete supported URL without spaces.');
    if (command === 'setCurrentTabMuted' && (typeof payload.muted !== 'boolean' || payload.muted === context.tab.muted)) throw bridgeError('INVALID_REQUEST', 'Choose the current mute or unmute action again.');
    return payload;
}
export function tabActionResultFields(command) {
    return command === 'renameCurrentTab' ? ['tabId', 'bookmarkId', 'title'] : command === 'editCurrentPinUrl' ? ['tabId', 'bookmarkId', 'url'] :
        command === 'copyCurrentLink' ? ['tabId', 'copied', 'url'] : command === 'setCurrentTabMuted' ? ['tabId', 'muted'] : ['tabId'];
}
export function validateTabActionResult(command, result, context, fields = {}) {
    if (!TAB_ACTION_COMMANDS.includes(command) || !context?.tab || !exactKeys(result, ['command', ...tabActionResultFields(command)]) || result.command !== command ||
        !isWindowId(result.tabId) || (command === 'duplicateCurrentTab' ? result.tabId === context.sourceTabId : result.tabId !== context.sourceTabId) ||
        ['renameCurrentTab', 'editCurrentPinUrl'].includes(command) && result.bookmarkId !== (context.tab.bookmark?.id ?? null) ||
        command === 'renameCurrentTab' && result.title !== fields.title || command === 'editCurrentPinUrl' && result.url !== fields.url ||
        command === 'copyCurrentLink' && (result.copied !== true || result.url !== context.tab.url) ||
        command === 'setCurrentTabMuted' && (typeof result.muted !== 'boolean' || result.muted !== fields.muted))
        invalid('Arcify did not confirm this exact tab action. Check its state before trying again.');
    return result;
}
