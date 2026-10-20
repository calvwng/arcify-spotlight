import { describe, it, expect, vi, afterEach } from 'vitest';
import { createFavoriteWitness } from '../../shared/favorite-witness.js';
import { WITNESS_TYPE, WITNESS_SESSION_KEY, validateWitnessRequest, sendWitnessRequest, witnessResponse } from '../../shared/favorite-witness-protocol.js';
import { PEER_KEY, PAIRING_GENERATION_KEY as GENERATION } from '../../shared/arcify-bridge-protocol.js';
const ARC = 'a'.repeat(32), OTHER = 'c'.repeat(32), PEER = 'b'.repeat(32);
const token = () => crypto.randomUUID();
const clone = value => structuredClone(value);
const message = (command = 'write', changes = {}) => ({ type: WITNESS_TYPE, version: 1, requestId: token(), command,
    epoch: 'epoch-1234567890123456', writerGeneration: 'writer-1234567890123456', revision: 1, ...changes });
function fixture() {
    const local = { [PEER_KEY]: ARC, [GENERATION]: token() }, session = {};
    const f = { local, session };
    const area = data => ({ get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, clone(data[key])])),
        set: async values => { await f.onSet?.(data, values); Object.assign(data, clone(values)); } });
    f.api = { storage: { local: area(local), session: area(session) } };
    f.witness = createFavoriteWitness(f.api);
    f.call = request => f.witness.handle(request, { id: ARC, origin: `chrome-extension://${ARC}` });
    return f;
}

describe('opaque session-only Favorite witness', () => {
    it('stores only opaque scope/epoch/revision and answers a matching read', async () => {
        const f = fixture(); expect((await f.call(message())).ok).toBe(true);
        expect(Object.keys(f.session[WITNESS_SESSION_KEY]).sort()).toEqual(['version', 'peerId', 'peerGeneration', 'epoch', 'writerGeneration', 'revision'].sort());
        expect((await f.call(message('read'))).matched).toBe(true);
        expect(Object.keys(f.local).sort()).toEqual([PEER_KEY, GENERATION].sort());
    });
    it('missing session read neither generates a witness nor enrollment', async () => {
        const f = fixture(); expect((await f.call(message('read'))).matched).toBe(false); expect(f.session).toEqual({});
        delete f.local[GENERATION]; expect((await f.call(message('read'))).ok).toBe(false); expect(f.local[GENERATION]).toBeUndefined();
    });
    it.each([{ id: OTHER }, { id: ARC, origin: 'https://evil.test' }, { id: ARC, url: 'https://evil.test' }, {}])('rejects unpaired or website sender %j', async sender => {
        const f = fixture(); expect((await f.witness.handle(message(), sender)).error.code).toBe('UNAUTHORIZED'); expect(f.session).toEqual({});
    });
    it.each([{ version: 2 }, { epoch: 'short' }, { revision: 0 }, { revision: 1.5 }, { command: 'erase' }, { url: 'https://private.test/' },
        { expectedPeerGeneration: token() }, { expectedRevision: 1 }, { expectedRevision: 1, expectedPeerGeneration: token(), revision: 3 }])('rejects malformed request %j', async change => {
        const f = fixture(); expect((await f.call(message('write', change))).error.code).toBe('INVALID_REQUEST'); expect(f.session).toEqual({});
    });
    it('rejects older revisions, wrong epoch reads, and old conditional commits', async () => {
        const f = fixture(); await f.call(message());
        expect((await f.call(message('write', { revision: 2 }))).ok).toBe(true);
        expect((await f.call(message())).error.code).toBe('STALE_RECEIPT');
        expect((await f.call(message('read', { epoch: token(), revision: 2 }))).matched).toBe(false);
        expect((await f.call(message('write', { revision: 2, expectedRevision: 1, expectedPeerGeneration: f.local[GENERATION] }))).error.code).toBe('STALE_RECEIPT');
    });
    it('CAS requires exact current generation, epoch, writer generation and previous revision', async () => {
        const f = fixture(); await f.call(message()); const generation = f.local[GENERATION];
        for (const change of [{ epoch: token() }, { writerGeneration: token() }, { expectedPeerGeneration: token() }]) {
            expect((await f.call(message('write', { revision: 2, expectedRevision: 1, expectedPeerGeneration: generation, ...change }))).error.code).toBe('STALE_RECEIPT');
        }
        expect((await f.call(message('write', { revision: 2, expectedRevision: 1, expectedPeerGeneration: generation }))).ok).toBe(true);
    });
    it('offline A to B to A settings revoke old receipts even when session clearing fails', async () => {
        const f = fixture(); await f.call(message()); const oldGeneration = f.local[GENERATION];
        f.onSet = async data => { if (data === f.session) throw new Error('session failed'); };
        await expect(f.witness.configure(OTHER)).rejects.toThrow('session failed');
        await expect(f.witness.configure(ARC)).rejects.toThrow('session failed');
        expect(f.local[GENERATION]).not.toBe(oldGeneration);
        expect((await f.call(message('read'))).matched).toBe(false);
    });
    it('pairing change during the session write rejects its acknowledgement and scopes stale writes out', async () => {
        const f = fixture(); f.onSet = async data => { if (data === f.session) f.local[GENERATION] = token(); };
        expect((await f.call(message())).error.code).toBe('UNAUTHORIZED');
        f.onSet = null; expect((await f.call(message('read'))).matched).toBe(false);
    });
});

describe('bounded witness transport', () => {
    afterEach(() => vi.useRealTimers());
    it('rejects malformed, wrong role, stale correlation and wrong revision replies', async () => {
        for (const changes of [{ type: 'wrong' }, { role: 'arcify' }, { requestId: token() }, { revision: 2 }, { epoch: token() }, { extra: true }, { matched: 'true' }]) {
            const api = { runtime: { sendMessage(peer, request, callback) { callback({ ...witnessResponse(request, { ok: true, matched: true, peerGeneration: token(), epoch: request.epoch, writerGeneration: request.writerGeneration, revision: request.revision }), ...changes }); } } };
            await expect(sendWitnessRequest(PEER, 'read', { epoch: token(), writerGeneration: token(), revision: 1 }, { api })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
        }
    });
    it('times out once and ignores late callbacks without reenrollment', async () => {
        vi.useFakeTimers(); let callback, request; const sendMessage = vi.fn((peer, value, reply) => { callback = reply; request = value; });
        const pending = sendWitnessRequest(PEER, 'read', { epoch: token(), writerGeneration: token(), revision: 1 }, { api: { runtime: { sendMessage } }, timeout: 10 });
        const failed = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' }); await vi.advanceTimersByTimeAsync(11); await failed;
        callback(witnessResponse(request, { ok: true, matched: true, peerGeneration: token(), epoch: request.epoch, writerGeneration: request.writerGeneration, revision: request.revision }));
        expect(sendMessage).toHaveBeenCalledTimes(1);
    });
});
