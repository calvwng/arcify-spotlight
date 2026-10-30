/** Optional native Split actions. Identity never comes from a URL or result position. */
import { bridgeError, isWindowId, isExtensionId } from './arcify-bridge-protocol.js';
import { exactKeys, isActionId, validGeneration, sameActionContext } from './arcify-space-actions-protocol.js';
import { validTabUrl } from './arcify-tab-actions-protocol.js';
import { isBrowserNewTabAlias } from './active-newtab-reuse.js';
export { exactKeys };
export const SPLIT_ACTIONS_FEATURE = 'splitActionsV1';
export const SPLIT_ACTION_TYPE = 'arcify-split-action';
export const SPLIT_ACTION_COMMANDS = ['createSplitView', 'endSplitView'];
export const isSplitActionResult = result => result?.type === SPLIT_ACTION_TYPE;
export const sameSplitContext = sameActionContext;
const invalid = () => { throw bridgeError('INVALID_RESPONSE', 'Arcify returned invalid Split context. Refresh Spotlight before trying again.'); };
export const isSplitContentUrl = url => validTabUrl(url) && !isBrowserNewTabAlias(url.split(/[?#]/)[0]);
export function validateSplitDescriptor(tab) {
    if (!exactKeys(tab, ['id', 'url', 'title', 'index', 'groupId', 'pinned', 'splitViewId']) || !isWindowId(tab.id) ||
        !isSplitContentUrl(tab.url) || typeof tab.title !== 'string' || tab.title.length > 1024 || /[\x00-\x1f\x7f]/.test(tab.title) ||
        !Number.isSafeInteger(tab.index) || tab.index < 0 || !Number.isSafeInteger(tab.groupId) || tab.groupId < -1 ||
        tab.pinned !== false || !Number.isSafeInteger(tab.splitViewId) || tab.splitViewId < -1) invalid();
    return tab;
}
export function validateSplitContext(context, windowId, tabId) {
    if (!exactKeys(context, ['windowId', 'spaceId', 'bookmarkFolderId', 'pairingGeneration', 'sourceTabId', 'tab', 'pair']) ||
        !isWindowId(context.windowId) || context.windowId !== windowId || !isWindowId(context.sourceTabId) || context.sourceTabId !== tabId ||
        !isActionId(context.spaceId) || !isActionId(context.bookmarkFolderId) || !validGeneration(context.pairingGeneration) || !Array.isArray(context.pair)) invalid();
    if (context.tab === null) { if (context.pair.length) invalid(); return context; }
    validateSplitDescriptor(context.tab);
    if (context.tab.id !== tabId) invalid();
    if (context.tab.splitViewId === -1) { if (context.pair.length) invalid(); return context; }
    if (context.pair.length !== 2) invalid();
    context.pair.forEach(validateSplitDescriptor);
    const [left, right] = context.pair;
    if (left.id === right.id || right.index !== left.index + 1 || left.groupId !== right.groupId || left.splitViewId !== right.splitViewId ||
        left.splitViewId !== context.tab.splitViewId || !context.pair.some(tab => sameSplitContext(tab, context.tab))) invalid();
    return context;
}
export function validateSplitTargets(targets, context) {
    if (!Array.isArray(targets) || targets.length > 1000 || (!context.tab || context.pair.length) && targets.length) invalid();
    const ids = new Set(), positions = new Set([context.tab?.index]);
    for (const tab of targets) {
        validateSplitDescriptor(tab);
        if (ids.has(tab.id) || positions.has(tab.index) || tab.id === context.sourceTabId || tab.groupId !== context.tab.groupId || tab.splitViewId !== -1) invalid();
        ids.add(tab.id); positions.add(tab.index);
    }
    return targets;
}
export function validateSplitScope(scope) {
    if (!exactKeys(scope, ['peerId', 'generation', 'epoch', 'context', 'targets']) || !isExtensionId(scope.peerId) || !validGeneration(scope.generation) || !Number.isSafeInteger(scope.epoch) || scope.epoch < 0) invalid();
    validateSplitContext(scope.context, scope.context?.windowId, scope.context?.sourceTabId);
    validateSplitTargets(scope.targets, scope.context);
    return scope;
}
export function validateSplitPayload(command, payload) {
    if (!SPLIT_ACTION_COMMANDS.includes(command) || !exactKeys(payload, ['context', ...(command === 'createSplitView' ? ['target'] : [])]))
        throw bridgeError('INVALID_REQUEST', 'Invalid Split request.');
    const context = validateSplitContext(payload.context, payload.context?.windowId, payload.context?.sourceTabId);
    if (!context.tab || (command === 'endSplitView' ? context.pair.length !== 2 : context.pair.length !== 0))
        throw bridgeError('INVALID_REQUEST', 'Choose an available Split action for this exact tab.');
    if (command === 'createSplitView') validateSplitTargets([payload.target], context);
    return payload;
}
export function validateSplitResult(command, result, context, target) {
    const action = command === 'createSplitView' ? 'create' : command === 'endSplitView' ? 'end' : null;
    const pair = action === 'create' ? [context.tab, target].sort((a, b) => a.index - b.index) : context.pair;
    if (!action || !exactKeys(result, ['action', 'windowId', 'spaceId', 'sourceTabId', 'tabIds', 'splitViewId', 'reordered']) ||
        result.action !== action || result.windowId !== context.windowId || result.spaceId !== context.spaceId || result.sourceTabId !== context.sourceTabId ||
        !Array.isArray(result.tabIds) || result.tabIds.length !== 2 || !pair?.every((tab, i) => tab?.id === result.tabIds[i]) ||
        !Number.isSafeInteger(result.splitViewId) || (action === 'create' ? result.splitViewId < 0 : result.splitViewId !== -1) ||
        typeof result.reordered !== 'boolean' || result.reordered !== (action === 'create' && Math.abs(context.tab.index - target.index) !== 1))
        throw bridgeError('INVALID_RESPONSE', 'Arcify did not confirm this exact Split action. Check Arcify before trying again.');
    return result;
}
