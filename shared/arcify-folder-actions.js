import { isFolderActionContext } from './arcify-folder-actions-protocol.js';
import { exactKeys } from './arcify-space-actions-protocol.js';
import { ArcifySpaceActionsClient, resolveSpaceActionSource } from './arcify-space-actions.js';
import { GLOBAL_FAVORITES_FEATURE, bridgeError, isExtensionId } from './arcify-bridge-protocol.js';
import { validateSnapshot } from './arcify-bridge.js';
const FEATURE = 'folderActionsV1';
const COMMANDS = ['createChildFolder', 'renameSavedFolder', 'deleteEmptyFolder', 'moveSavedFolderToSpace'];
const fail = message => { throw bridgeError('STALE_CONTEXT', message); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export class ArcifyFolderActionsClient extends ArcifySpaceActionsClient {
    async readFolder(source, folderId, expected = null) {
        if (typeof folderId !== 'string' || !folderId || folderId.length > 200) fail('Invalid folder identity.');
        const pairing = await this.pairing();
        if (!pairing.peerId) return null;
        if (expected && (expected.peerId !== pairing.peerId || expected.generation !== pairing.generation)) fail('Arcify pairing changed. Browse the folder again.');
        let hello;
        try { hello = await this.call(pairing, 'hello', { windowId: source.windowId, supportedFeatures: [GLOBAL_FAVORITES_FEATURE, FEATURE] }); }
        catch (error) { if (error.code === 'INVALID_REQUEST') return null; throw error; }
        if (hello.extensionId !== pairing.peerId || !Array.isArray(hello.capabilities) || !hello.capabilities.includes(FEATURE)) return null;
        const response = await this.call(pairing, 'folderActionContext', { windowId: source.windowId, tabId: source.tabId, folderId, supportedFeatures: [GLOBAL_FAVORITES_FEATURE, FEATURE] });
        const context = response.folderContext;
        validateSnapshot(response.snapshot, source.windowId, { allowOrdinaryFavorites: true });
        const space = response.snapshot.spaces.find(item => item.id === context?.spaceId);
        if (!exactKeys(response, ['type','version','requestId','role','ok','extensionId','snapshot','folderContext']) || !isFolderActionContext(context) || response.extensionId !== pairing.peerId || context?.windowId !== source.windowId || context.sourceTabId !== source.tabId || context.folder?.id !== folderId || context.folder.url !== null || !Array.isArray(context.folder.children) || !Array.isArray(context.ancestors) || typeof context.syncTabGroups !== 'boolean' || context.spaceId !== response.snapshot.activeSpaceId || space?.bookmarkFolderId !== context.bookmarkFolderId) fail('Arcify returned a conflicting folder.');
        return { ...pairing, context, destinations: response.snapshot.spaces.filter(space => space.id !== context.spaceId).map(space => ({spaceId: space.id, bookmarkFolderId: space.bookmarkFolderId, name: space.name})) };
    }
    async executeFolder(source, scope, command, fields, beforeDispatch) {
        if (!COMMANDS.includes(command) || !exactKeys(scope, ['peerId','generation','context','destinations']) || !isFolderActionContext(scope.context) || !isExtensionId(scope.peerId) || !(scope.generation === null || typeof scope.generation === 'string' && scope.generation.length <= 200) || !fields || typeof fields !== 'object') fail('Invalid folder action.');
        if (command === 'moveSavedFolderToSpace' ? !exactKeys(fields, ['destination']) || !exactKeys(fields.destination, ['spaceId','bookmarkFolderId']) || !Array.isArray(scope.destinations) || !scope.destinations.some(item => item.spaceId === fields.destination.spaceId && item.bookmarkFolderId === fields.destination.bookmarkFolderId) : command === 'deleteEmptyFolder' ? fields.confirmed !== true || Object.keys(fields).length !== 1 : typeof fields.title !== 'string' || !fields.title.trim() || fields.title.length > 256 || /[\u0000-\u001f\u007f]/.test(fields.title) || Object.keys(fields).length !== 1) fail('Invalid folder action fields.');
        return this.bridge.serializeAction(async () => {
            const fresh = await this.readFolder(source, scope.context.folder.id, scope);
            if (!fresh || !same(fresh.context, scope.context)) fail('The folder or selected Space changed. Browse it again.');
            if (command === 'moveSavedFolderToSpace') {
                const selected = scope.destinations.find(item => item.spaceId === fields.destination.spaceId);
                if (!same(selected, fresh.destinations.find(item => item.spaceId === selected.spaceId))) fail('The destination Space changed. Choose it again.');
            }
            await beforeDispatch();
            const response = await this.call(fresh, command, { windowId: source.windowId, context: scope.context, ...fields, supportedFeatures: [GLOBAL_FAVORITES_FEATURE, FEATURE] });
            if (!exactKeys(response, ['type','version','requestId','role','ok','snapshot','folderId', ...(command === 'moveSavedFolderToSpace' ? ['destinationSpaceId'] : [])]) || typeof response.folderId !== 'string' || command !== 'createChildFolder' && response.folderId !== scope.context.folder.id) fail('Arcify did not confirm the folder action. Inspect it before trying again.');
            validateSnapshot(response.snapshot, source.windowId, { allowOrdinaryFavorites: true });
            if (command === 'moveSavedFolderToSpace' && (response.destinationSpaceId !== fields.destination.spaceId || response.snapshot.activeSpaceId !== scope.context.spaceId)) fail('Arcify did not confirm the requested folder move. Inspect it before trying again.');
            return { folderId: response.folderId };
        });
    }
}
export function installArcifyFolderMessages(api, bridge, sourceOptions) {
    const client = new ArcifyFolderActionsClient(api, bridge);
    api.runtime.onMessage.addListener((message, sender, respond) => {
        if (!['arcifyFolderContext', 'arcifyFolderAction'].includes(message?.action)) return false;
        (async () => {
            const keys = message.action === 'arcifyFolderContext' ? ['action','folderId'] : ['action','scope','command','fields'];
            if (!exactKeys(message, [...keys, ...(Object.hasOwn(message, 'tabId') ? ['tabId'] : [])])) fail('Invalid folder request.');
            const source = await resolveSpaceActionSource(api, message, sender, sourceOptions);
            const check = async () => { const fresh = await resolveSpaceActionSource(api, message, sender, sourceOptions); if (fresh.windowId !== source.windowId) fail('The source window changed. Reopen Spotlight.'); };
            if (message.action === 'arcifyFolderContext') {
                if (typeof message.folderId !== 'string' || !/^\d+$/.test(message.folderId)) fail('Invalid folder.');
                const scope = await client.readFolder(source, message.folderId); await check(); return { scope };
            }
            return { result: await client.executeFolder(source, message.scope, message.command, message.fields, check) };
        })().then(result => respond({ success: true, ...result }), error => respond({ success: false, error: error.message, errorCode: error.code }));
        return true;
    });
}
