/** Optional Archive actions. Opaque identities are never inferred from a URL or row index. */
import { bridgeError, isWindowId, isExtensionId } from './arcify-bridge-protocol.js';
import { exactKeys, sameActionContext } from './arcify-space-actions-protocol.js';
import { validTabUrl } from './arcify-tab-actions-protocol.js';
export { exactKeys };
export const ARCHIVE_ACTIONS_FEATURE = 'archiveActionsV1';
export const ARCHIVE_ACTION_TYPE = 'arcify-archive-action';
export const ARCHIVE_OPEN_TYPE = 'arcify-archive-open';
export const isArchiveResult = result => result?.type === ARCHIVE_ACTION_TYPE;
export const sameArchiveScope = sameActionContext;
const text = (value, max) => typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
export const archiveId = value => text(value, 200) && Boolean(value);
const generation = value => value === null || archiveId(value);
const invalid = () => { throw bridgeError('INVALID_RESPONSE', 'Arcify returned invalid Archive context. Refresh Spotlight before trying again.'); };
export function validateArchiveContext(context, windowId, tabId) {
    if (!exactKeys(context, ['windowId', 'spaceId', 'bookmarkFolderId', 'sourceTabId', 'sourceUrl', 'pairingGeneration']) ||
        !isWindowId(context.windowId) || context.windowId !== windowId || !isWindowId(context.sourceTabId) || context.sourceTabId !== tabId ||
        !archiveId(context.spaceId) || !archiveId(context.bookmarkFolderId) || !generation(context.pairingGeneration) ||
        !text(context.sourceUrl, 16384) || !context.sourceUrl) invalid();
    return context;
}
export function validateArchiveActions(value, windowId, tabId) {
    if (!exactKeys(value, ['context', 'viewId', 'openIntent', 'entries']) || !archiveId(value.viewId) ||
        !(value.openIntent === null || archiveId(value.openIntent)) || !Array.isArray(value.entries) || value.entries.length > 1000) invalid();
    validateArchiveContext(value.context, windowId, tabId);
    const ids = new Set();
    for (const entry of value.entries) {
        if (!exactKeys(entry, ['entryId', 'title', 'url', 'spaceId', 'bookmarkFolderId', 'archivedAt']) ||
            !archiveId(entry.entryId) || ids.has(entry.entryId) || !text(entry.title, 1024) || !validTabUrl(entry.url) ||
            !archiveId(entry.spaceId) || !archiveId(entry.bookmarkFolderId) || !Number.isFinite(entry.archivedAt) || entry.archivedAt < 0) invalid();
        ids.add(entry.entryId);
    }
    return value;
}
export function validateArchiveScope(scope) {
    if (!exactKeys(scope, ['peerId', 'generation', 'context', 'viewId', 'openIntent', 'entries']) || !isExtensionId(scope.peerId) || !generation(scope.generation)) invalid();
    const { peerId, generation: ignored, ...actions } = scope;
    validateArchiveActions(actions, scope.context?.windowId, scope.context?.sourceTabId);
    return scope;
}
export function validateArchiveResult(result, scope, entryId) {
    const entry = scope.entries.find(item => item.entryId === entryId);
    if (!entry || !exactKeys(result, ['entryId', 'tabId', 'spaceId', 'windowId', 'consumed', 'status', 'warning']) ||
        result.entryId !== entry.entryId || result.spaceId !== entry.spaceId || result.windowId !== scope.context.windowId ||
        !(result.tabId === null || isWindowId(result.tabId)) || result.consumed !== true || !['reopened', 'partial'].includes(result.status) ||
        result.status === 'reopened' && (result.tabId === null || result.warning !== null) ||
        result.status === 'partial' && (!text(result.warning, 2048) || !result.warning.trim()))
        throw bridgeError('INVALID_RESPONSE', 'Arcify did not confirm this exact archived entry. Check Arcify before trying again.');
    return result;
}
