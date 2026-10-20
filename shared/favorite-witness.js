import { PEER_KEY, PAIRING_GENERATION_KEY, trustedSender, bridgeError } from './arcify-bridge-protocol.js';
import { WITNESS_TYPE, WITNESS_SESSION_KEY, isToken, validateWitnessRequest, witnessResponse } from './favorite-witness-protocol.js';

// The only persisted witness is this opaque receipt in storage.session. Losing
// Spotlight's extension session deliberately destroys all attestations.
export function createFavoriteWitness(api = chrome) {
    let chain = Promise.resolve();
    const serial = operation => {
        const pending = chain.then(operation); chain = pending.catch(() => {}); return pending;
    };
    const config = async () => {
        const settings = await api.storage.local.get([PEER_KEY, PAIRING_GENERATION_KEY]);
        return { peerId: settings[PEER_KEY], generation: settings[PAIRING_GENERATION_KEY] };
    };
    const same = (a, b) => a.peerId === b.peerId && a.generation === b.generation;
    const handle = async (request, sender) => {
        const pairing = await config();
        if (!trustedSender(sender, pairing.peerId)) throw bridgeError('UNAUTHORIZED', 'Only the paired Arcify may use this witness.');
        validateWitnessRequest(request);
        // Legacy manually configured peers need to save their pairing once. A
        // read-only recovery check never creates a new generation or receipt.
        if (!isToken(pairing.generation)) {
            if (request.command !== 'write') throw bridgeError('UNSUPPORTED', 'No surviving witness pairing generation.');
            pairing.generation = crypto.randomUUID();
            await api.storage.local.set({ [PAIRING_GENERATION_KEY]: pairing.generation });
            if (!same(pairing, await config())) throw bridgeError('UNAUTHORIZED', 'Pairing changed during witness enrollment.');
        }
        const { [WITNESS_SESSION_KEY]: old } = await api.storage.session.get(WITNESS_SESSION_KEY);
        const scoped = old?.version === 1 && old.peerId === pairing.peerId && old.peerGeneration === pairing.generation;
        const equal = scoped && old.epoch === request.epoch && old.writerGeneration === request.writerGeneration && old.revision === request.revision;
        if (request.command === 'write') {
            if (request.expectedPeerGeneration !== undefined && (!scoped || request.expectedPeerGeneration !== pairing.generation
                || old.epoch !== request.epoch || old.writerGeneration !== request.writerGeneration || old.revision !== request.expectedRevision))
                throw bridgeError('STALE_RECEIPT', 'Recovery proof was revoked or superseded.');
            if (scoped && old.epoch === request.epoch && old.writerGeneration === request.writerGeneration && old.revision > request.revision)
                throw bridgeError('STALE_RECEIPT', 'An older ownership revision cannot replace the witness.');
            if (!same(pairing, await config())) throw bridgeError('UNAUTHORIZED', 'Pairing changed during the witness request.');
            await api.storage.session.set({ [WITNESS_SESSION_KEY]: { version: 1, peerId: pairing.peerId, peerGeneration: pairing.generation,
                epoch: request.epoch, writerGeneration: request.writerGeneration, revision: request.revision } });
        }
        if (!same(pairing, await config())) throw bridgeError('UNAUTHORIZED', 'Pairing changed during the witness request.');
        return witnessResponse(request, { ok: true, matched: request.command === 'write' || equal,
            peerGeneration: pairing.generation, epoch: request.epoch, writerGeneration: request.writerGeneration, revision: request.revision });
    };
    return {
        handle: (request, sender) => serial(() => handle(request, sender)).catch(error => witnessResponse(request,
            { ok: false, error: { code: error.code || 'FAILED' } })),
        // Called before acknowledging a settings change. The generation rotates
        // in the SAME durable write as the ID, including A → B → A and disconnect.
        configure: peerId => serial(async () => {
            await api.storage.local.set({ [PEER_KEY]: peerId, [PAIRING_GENERATION_KEY]: crypto.randomUUID() });
            await api.storage.session.set({ [WITNESS_SESSION_KEY]: null });
        }),
        invalidate: () => serial(() => api.storage.session.set({ [WITNESS_SESSION_KEY]: null }))
    };
}
export function installFavoriteWitness(api = chrome, witness = createFavoriteWitness(api)) {
    api.runtime.onMessageExternal.addListener((request, sender, respond) => {
        if (request?.type !== WITNESS_TYPE) return false;
        witness.handle(request, sender).then(respond); return true;
    });
    return witness;
}
