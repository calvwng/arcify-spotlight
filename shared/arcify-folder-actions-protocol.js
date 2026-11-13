import { isWindowId } from './arcify-bridge-protocol.js';
import { exactKeys } from './arcify-space-actions-protocol.js';
const isTabId = isWindowId;
const isId = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
const boundedText = (value, limit) => typeof value === 'string' && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value);
export function isFolderActionContext(value) {
    if (!exactKeys(value, ['windowId', 'sourceTabId', 'pairingGeneration', 'spaceId', 'bookmarkFolderId', 'folder', 'ancestors', 'syncTabGroups'])
        || !isWindowId(value.windowId) || !isTabId(value.sourceTabId) || !(value.pairingGeneration === null || isId(value.pairingGeneration))
        || !isId(value.spaceId) || !isId(value.bookmarkFolderId) || typeof value.syncTabGroups !== 'boolean'
        || !Array.isArray(value.ancestors) || value.ancestors.length > 32) return false;
    const seen = new Set();
    const tree = (node, depth = 0) => {
        if (!exactKeys(node, ['id', 'parentId', 'title', 'url', 'children']) || !isId(node.id) || !isId(node.parentId)
            || !boundedText(node.title, 4096) || !(node.url === null || boundedText(node.url, 16384) && node.url.length > 0)
            || !Array.isArray(node.children) || node.url !== null && node.children.length || depth > 32 || seen.size >= 2000 || seen.has(node.id)) return false;
        seen.add(node.id);
        return node.children.every(child => child?.parentId === node.id && tree(child, depth + 1));
    };
    if (!tree(value.folder) || value.folder.url !== null) return false;
    let parentId = value.folder.parentId;
    for (const ancestor of value.ancestors) {
        if (!exactKeys(ancestor, ['id', 'parentId', 'title']) || !isId(ancestor.id) || !isId(ancestor.parentId)
            || !boundedText(ancestor.title, 4096) || ancestor.id !== parentId || seen.has(ancestor.id)) return false;
        seen.add(ancestor.id); parentId = ancestor.parentId;
    }
    if (value.folder.id === value.bookmarkFolderId ? value.ancestors.length !== 0
        : value.ancestors.at(-1)?.id !== value.bookmarkFolderId) return false;
    return JSON.stringify(value).length <= 1000000;
}
