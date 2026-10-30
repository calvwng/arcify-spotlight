import { isExtensionId, bridgeError } from './arcify-bridge-protocol.js';

// No windows, tabs, URLs or saved links ever cross this witness-only endpoint.
export const WITNESS_TYPE = 'arcify-favorite-witness';
export const WITNESS_VERSION = 1;
export const WITNESS_CAPABILITY = 'favoriteContinuityWitnessV1';
export const WITNESS_SESSION_KEY = 'arcifyFavoriteWitness';
export const isToken = value => typeof value === 'string' && /^[\w-]{16,80}$/.test(value);
export const isRevision = value => Number.isSafeInteger(value) && value > 0;
export function validateWitnessRequest(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.type !== WITNESS_TYPE
        || value.version !== WITNESS_VERSION || !isToken(value.requestId) || !['read', 'write'].includes(value.command)
        || !isToken(value.epoch) || !isToken(value.writerGeneration) || !isRevision(value.revision)
        || Object.keys(value).some(key => !['type', 'version', 'requestId', 'command', 'epoch', 'writerGeneration', 'revision', 'expectedPeerGeneration', 'expectedRevision'].includes(key))) {
        throw bridgeError('INVALID_REQUEST', 'Invalid Favorite continuity receipt.');
    }
    if ((value.expectedPeerGeneration !== undefined || value.expectedRevision !== undefined)
        && (value.command !== 'write' || !isToken(value.expectedPeerGeneration) || !isRevision(value.expectedRevision)
            || value.revision !== value.expectedRevision + 1)) throw bridgeError('INVALID_REQUEST', 'Invalid conditional witness commit.');
    return value;
}
export function witnessResponse(request, data) {
    return { type: WITNESS_TYPE, version: WITNESS_VERSION, requestId: request?.requestId, role: 'spotlight', ...data };
}
export function sendWitnessRequest(peerId, command, receipt, { api = chrome, timeout = 1500 } = {}) {
    if (!isExtensionId(peerId)) return Promise.reject(bridgeError('NOT_CONFIGURED', 'No paired Spotlight witness.'));
    const request = { type: WITNESS_TYPE, version: WITNESS_VERSION, requestId: crypto.randomUUID(), command, ...receipt };
    validateWitnessRequest(request);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(bridgeError('TIMEOUT', 'Favorite continuity witness timed out.')), timeout);
        try {
            api.runtime.sendMessage(peerId, request, response => {
                clearTimeout(timer);
                if (api.runtime.lastError) return reject(bridgeError('UNAVAILABLE', 'Favorite continuity witness unavailable.'));
                if (!response || response.type !== WITNESS_TYPE || response.version !== WITNESS_VERSION
                    || response.requestId !== request.requestId || response.role !== 'spotlight' || typeof response.ok !== 'boolean')
                    return reject(bridgeError('INVALID_RESPONSE', 'Invalid Favorite continuity witness response.'));
                if (!response.ok) return reject(bridgeError(response.error?.code || 'FAILED', 'Favorite continuity witness rejected the receipt.'));
                if (typeof response.matched !== 'boolean' || !isToken(response.peerGeneration)
                    || response.epoch !== request.epoch || response.writerGeneration !== request.writerGeneration || response.revision !== request.revision
                    || Object.keys(response).some(key => !['type', 'version', 'requestId', 'role', 'ok', 'matched', 'peerGeneration', 'epoch', 'writerGeneration', 'revision'].includes(key)))
                    return reject(bridgeError('INVALID_RESPONSE', 'Favorite continuity witness receipt did not match.'));
                resolve(response);
            });
        } catch (error) { clearTimeout(timer); reject(error); }
    });
}
