/** Optional, exact-identity Space actions. This is separate from navigation. */
import { bridgeError, isWindowId, isSafeUrl, isExtensionId } from './arcify-bridge-protocol.js';
export const SPACE_ACTIONS_FEATURE = 'spaceActionsV1';
export const SPACE_NAVIGATION_FEATURE = 'spaceNavigationV1';
export const SPACE_NAVIGATION_COMMANDS = ['switchSpace', 'moveCurrentTodayTab'];
export const SPACE_ACTION_TYPE = 'arcify-space-action';
export const SPACE_ACTION_COMMANDS = ['openSettings', 'createSpaceFolder', 'pinCurrentTab', 'removeCurrentPin'];
export const ALL_SPACE_ACTION_COMMANDS = [...SPACE_ACTION_COMMANDS, ...SPACE_NAVIGATION_COMMANDS];
export const isSpaceActionResult = result => result?.type === SPACE_ACTION_TYPE;
export const isActionId = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
export const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const title = value => typeof value === 'string' && value.length <= 1024 && !/[\x00-\x1f\x7f]/.test(value);
export const validFolderTitle = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && value === value.trim() && !/[\x00-\x1f\x7f]/.test(value);
export const validGeneration = value => value === null || isActionId(value);
const invalid = () => { throw bridgeError('INVALID_RESPONSE', 'Arcify returned invalid action context. Refresh Spotlight before trying again.'); };
export function validateActionContext(context, windowId, tabId) {
    if (!exactKeys(context, ['windowId', 'spaceId', 'bookmarkFolderId', 'pairingGeneration', 'sourceTabId', 'tab']) ||
        !isWindowId(context.windowId) || context.windowId !== windowId || !isActionId(context.spaceId) ||
        !isActionId(context.bookmarkFolderId) || !validGeneration(context.pairingGeneration) ||
        !isWindowId(context.sourceTabId) || context.sourceTabId !== tabId) invalid();
    const tab = context.tab;
    if (tab === null) return context;
    if (!exactKeys(tab, ['id', 'url', 'title', 'section', 'bookmark']) || tab.id !== tabId ||
        !isSafeUrl(tab.url) || !title(tab.title) || !['today', 'saved'].includes(tab.section)) invalid();
    if (tab.section === 'today') {
        if (tab.bookmark !== null) invalid();
    } else if (!exactKeys(tab.bookmark, ['id', 'parentId', 'title', 'url']) || !isActionId(tab.bookmark.id) ||
        !isActionId(tab.bookmark.parentId) || !title(tab.bookmark.title) || !isSafeUrl(tab.bookmark.url)) invalid();
    return context;
}
export function validateNavigationContext(value, context) {
    if (!exactKeys(value, ['destinations', 'inverted', 'sourceUrl']) || typeof value.inverted !== 'boolean'
        || typeof value.sourceUrl !== 'string' || !value.sourceUrl || value.sourceUrl.length > 16384 || /[\x00-\x1f\x7f]/.test(value.sourceUrl)
        || context.tab && context.tab.url !== value.sourceUrl || !Array.isArray(value.destinations) || value.destinations.length > 1000) invalid();
    const ids = new Set(), folders = new Set();
    for (const target of value.destinations) {
        if (!exactKeys(target, ['spaceId', 'bookmarkFolderId', 'name']) || !isActionId(target.spaceId) || !isActionId(target.bookmarkFolderId)
            || target.spaceId === context.spaceId || target.bookmarkFolderId === context.bookmarkFolderId || !title(target.name)
            || ids.has(target.spaceId) || folders.has(target.bookmarkFolderId)) invalid();
        ids.add(target.spaceId); folders.add(target.bookmarkFolderId);
    }
    return value;
}
export function validateActionScope(scope) {
    if (!exactKeys(scope, ['peerId', 'generation', 'context', ...(Object.hasOwn(scope || {}, 'navigation') ? ['navigation'] : [])]) || !isExtensionId(scope.peerId) || !validGeneration(scope.generation)) invalid();
    validateActionContext(scope.context, scope.context?.windowId, scope.context?.sourceTabId);
    if (Object.hasOwn(scope, 'navigation')) validateNavigationContext(scope.navigation, scope.context);
    return scope;
}
// Field-order-independent equality, including exact bookmark/tab identities and metadata.
export function sameActionContext(a, b) {
    const canonical = value => value && typeof value === 'object'
        ? JSON.stringify(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : JSON.stringify(value);
    return canonical(a) === canonical(b);
}
export function validateActionPayload(command, payload) {
    const navigation = SPACE_NAVIGATION_COMMANDS.includes(command);
    const keys = navigation ? ['context', 'destination', 'sourceUrl', ...(command === 'moveCurrentTodayTab' ? ['inverted'] : [])] : command === 'createSpaceFolder' ? ['context', 'title'] : command === 'removeCurrentPin' ? ['context', 'confirmed'] : ['context'];
    if (!ALL_SPACE_ACTION_COMMANDS.includes(command) || !exactKeys(payload, keys)) throw bridgeError('INVALID_REQUEST', 'Invalid Arcify action.');
    validateActionContext(payload.context, payload.context?.windowId, payload.context?.sourceTabId);
    if (navigation && (!exactKeys(payload.destination, ['spaceId', 'bookmarkFolderId']) || !isActionId(payload.destination.spaceId)
        || !isActionId(payload.destination.bookmarkFolderId) || payload.destination.spaceId === payload.context.spaceId
        || payload.destination.bookmarkFolderId === payload.context.bookmarkFolderId || typeof payload.sourceUrl !== 'string'
        || !payload.sourceUrl || payload.sourceUrl.length > 16384 || /[\x00-\x1f\x7f]/.test(payload.sourceUrl)
        || command === 'moveCurrentTodayTab' && (payload.context.tab?.section !== 'today' || typeof payload.inverted !== 'boolean')))
        throw bridgeError('INVALID_REQUEST', 'Choose another existing Space for this exact tab.');
    if (command === 'createSpaceFolder' && !validFolderTitle(payload.title)) throw bridgeError('INVALID_REQUEST', 'Enter a folder name of 1–256 characters without control characters.');
    if (command === 'removeCurrentPin' && (payload.confirmed !== true || payload.context.tab?.section !== 'saved') ||
        command === 'pinCurrentTab' && payload.context.tab?.section !== 'today') throw bridgeError('INVALID_REQUEST', 'That action is not available for this exact tab.');
    return payload;
}
export function validateActionResult(command, result, context, fields = {}) {
    if (SPACE_NAVIGATION_COMMANDS.includes(command)) {
        if (!exactKeys(result, ['command', 'spaceId', 'tabId']) || result.command !== command || !isActionId(result.spaceId)
            || result.spaceId !== fields.destination?.spaceId || !(command === 'switchSpace' && result.tabId === null || isWindowId(result.tabId))
            || command === 'moveCurrentTodayTab' && result.tabId !== context.sourceTabId)
            throw bridgeError('INVALID_RESPONSE', 'Arcify did not confirm the chosen Space action. Check Arcify before trying again.');
        return result;
    }
    const identityKeys = command === 'createSpaceFolder' ? ['folderId'] : command === 'openSettings' ? ['tabId'] : ['tabId', 'bookmarkId'];
    if (!ALL_SPACE_ACTION_COMMANDS.includes(command) || !exactKeys(result, ['command', ...identityKeys]) || result.command !== command ||
        identityKeys.some(key => key === 'tabId' ? !isWindowId(result[key]) : !isActionId(result[key])) ||
        ['pinCurrentTab', 'removeCurrentPin'].includes(command) && result.tabId !== context.sourceTabId ||
        command === 'removeCurrentPin' && result.bookmarkId !== context.tab?.bookmark?.id) {
        throw bridgeError('INVALID_RESPONSE', 'Arcify did not confirm the action. Check its state before trying again.');
    }
    return result;
}
