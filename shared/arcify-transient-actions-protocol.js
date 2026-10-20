/** Optional Little Arc action identity. All URL policy lives in the bridge protocol. */
import { bridgeError, isExtensionId, isWindowId } from './arcify-bridge-protocol.js';
import { exactKeys, isActionId, validGeneration, sameActionContext } from './arcify-space-actions-protocol.js';
export { exactKeys, sameActionContext as sameTransientContext };
export const TRANSIENT_WINDOWS_FEATURE = 'transientWindowsV1';
export const TRANSIENT_ACTION_TYPE = 'arcify-transient-action';
export const isTransientActionResult = result => result?.type === TRANSIENT_ACTION_TYPE;
export const TRANSIENT_UNKNOWN = 'Arcify did not confirm Little Arc. Check for an existing temporary window before trying again.';
const invalid = () => { throw bridgeError('INVALID_RESPONSE', 'The Little Arc context is invalid. Reopen Spotlight.'); };
export function validateTransientScope(scope) {
    if (!exactKeys(scope, ['peerId', 'generation', 'epoch', 'viewId', 'context']) || !isExtensionId(scope.peerId) ||
        !validGeneration(scope.generation) || !Number.isSafeInteger(scope.epoch) || scope.epoch < 0 || !isActionId(scope.viewId)) invalid();
    const context = scope.context;
    if (!exactKeys(context, ['windowId', 'sourceTabId', 'sourceUrl', 'spaceId', 'bookmarkFolderId']) ||
        !isWindowId(context.windowId) || !isWindowId(context.sourceTabId) || typeof context.sourceUrl !== 'string' ||
        !context.sourceUrl || context.sourceUrl.length > 16384 || /[\x00-\x1f\x7f]/.test(context.sourceUrl) ||
        !(context.spaceId === null || isActionId(context.spaceId)) || !(context.bookmarkFolderId === null || isActionId(context.bookmarkFolderId)) ||
        (context.spaceId === null) !== (context.bookmarkFolderId === null)) invalid();
    return scope;
}
export function validateTransientResult(result, context) {
    if (!exactKeys(result, ['tabId', 'transientWindowId', 'token']) || !isWindowId(result.tabId) ||
        result.tabId === context.sourceTabId || !isWindowId(result.transientWindowId) || result.transientWindowId === context.windowId ||
        !isActionId(result.token) || /[\x00-\x1f\x7f]/.test(result.token)) throw bridgeError('INVALID_RESPONSE', TRANSIENT_UNKNOWN);
    return result;
}
