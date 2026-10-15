// Protocol v1 is deliberately extension-to-extension only. No website origin is trusted.
export const BRIDGE_TYPE = 'arcify-bridge';
export const BRIDGE_VERSION = 1;
export const PEER_KEY = 'arcifyBridgePeerId';
export const PAIRING_GENERATION_KEY = 'arcifyBridgePairingGeneration';
export const GLOBAL_FAVORITES_FEATURE = 'globalFavoritesV1';
export const isExtensionId = value => typeof value === 'string' && /^[a-p]{32}$/.test(value);
export const isWindowId = value => Number.isSafeInteger(value) && value > 0;
const isId = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
const isTabId = isWindowId;
export function bridgeError(code, message) { return Object.assign(new Error(message), { code }); }
export function trustedSender(sender, peerId) {
    return isExtensionId(peerId) && sender?.id === peerId
        && (!sender.url || sender.url.startsWith(`chrome-extension://${peerId}/`))
        && (!sender.origin || sender.origin === `chrome-extension://${peerId}`);
}
export function isSafeUrl(value) {
    if (typeof value !== 'string' || value.length > 16384) return false;
    if (value === 'about:blank') return true;
    try { return ['http:', 'https:', 'file:', 'chrome:'].includes(new URL(value).protocol); }
    catch { return false; }
}
// Saved Favorites preserve the narrower bookmark-drop HTTP(S) boundary.
export function isFavoriteUrl(value) {
    if (typeof value !== 'string' || value.length > 16384) return false;
    try { return ['http:', 'https:'].includes(new URL(value).protocol); }
    catch { return false; }
}
const commandFields = {
    hello: [], snapshot: [], invalidate: [], activateSpace: ['spaceId'], activateTab: ['tabId'],
    openTab: ['url', 'spaceId'], navigateTab: ['tabId', 'url'],
    openBookmark: ['spaceId', 'bookmarkId'], openFavorite: ['favoriteId'], launch: ['mode'], startupSuggestion: ['tabId']
};
export function validateRequest(message, commands) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.type !== BRIDGE_TYPE)
        throw bridgeError('INVALID_REQUEST', 'Invalid bridge message.');
    if (message.version !== BRIDGE_VERSION) throw bridgeError('VERSION_MISMATCH', 'Install matching protocol v1 builds of both extensions.');
    if (typeof message.requestId !== 'string' || !/^[\w.:-]{1,80}$/.test(message.requestId)
        || !isWindowId(message.windowId) || !commands.includes(message.command))
        throw bridgeError('INVALID_REQUEST', 'Invalid request ID, window, or command.');
    const fields = ['type', 'version', 'requestId', 'windowId', 'command', 'supportedFeatures', ...commandFields[message.command]];
    if (Object.keys(message).some(key => !fields.includes(key))) throw bridgeError('INVALID_REQUEST', 'Unexpected request field.');
    if (message.supportedFeatures !== undefined && (!Array.isArray(message.supportedFeatures)
        || message.supportedFeatures.length !== 1 || message.supportedFeatures[0] !== GLOBAL_FAVORITES_FEATURE))
        throw bridgeError('INVALID_REQUEST', 'Invalid supported feature marker.');
    if (['activateSpace', 'openBookmark'].includes(message.command) && !isId(message.spaceId)
        || message.command === 'openTab' && message.spaceId !== undefined && !isId(message.spaceId)
        || ['activateTab', 'navigateTab', 'startupSuggestion'].includes(message.command) && !isTabId(message.tabId)
        || ['openTab', 'navigateTab'].includes(message.command) && !isSafeUrl(message.url)
        || message.command === 'openBookmark' && !isId(message.bookmarkId)
        || message.command === 'openFavorite' && !isId(message.favoriteId)
        || message.command === 'launch' && !['current-tab', 'new-tab'].includes(message.mode))
        throw bridgeError('INVALID_REQUEST', 'Invalid command payload.');
    return message;
}
export function responseFor(request, role, payload = {}) {
    return { type: BRIDGE_TYPE, version: BRIDGE_VERSION, requestId: request?.requestId, role, ...payload };
}
export function sendBridgeRequest(peerId, command, payload, { role = 'spotlight', timeout = 5000 } = {}) {
    if (!isExtensionId(peerId)) return Promise.reject(bridgeError('NOT_CONFIGURED', 'Pair the companion extension in settings first.'));
    const request = { type: BRIDGE_TYPE, version: BRIDGE_VERSION, requestId: crypto.randomUUID(), command, ...payload };
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(bridgeError('TIMEOUT', 'Companion timed out. Check its state before trying an action again.')), timeout);
        chrome.runtime.sendMessage(peerId, request, response => {
            clearTimeout(timer);
            if (chrome.runtime.lastError) return reject(bridgeError('UNAVAILABLE', 'Companion unavailable. Check its ID and reload both extensions.'));
            if (response?.version !== BRIDGE_VERSION) return reject(bridgeError('VERSION_MISMATCH', 'Install matching protocol v1 builds of both extensions.'));
            if (response?.type !== BRIDGE_TYPE || response.requestId !== request.requestId || response.role !== role || typeof response.ok !== 'boolean')
                return reject(bridgeError('INVALID_RESPONSE', 'Companion returned an invalid response.'));
            if (!response.ok) return reject(bridgeError(response.error?.code || 'FAILED', response.error?.message || 'Companion request failed.'));
            resolve(response);
        });
    });
}
