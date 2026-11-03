import { PEER_KEY, PAIRING_GENERATION_KEY, isExtensionId } from './arcify-bridge-protocol.js';

export const DIM_KEY = 'littleArcDimSource';
export const DIM_STRENGTH_KEY = 'littleArcDimStrength';
export const DIM_PREFERENCES_TYPE = 'arcifyLittleArcDimmingPreferences';
export const DIM_AUTHORIZATION_TYPE = 'arcifyLittleArcDimmingAuthorization';
export const DIM_DEFAULT_STRENGTH = 55;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
export const validDimStrength = value => Number.isInteger(value) && value >= 15 && value <= 90;
export const validDimPreference = value => exact(value, ['enabled', 'strength']) && typeof value.enabled === 'boolean' && validDimStrength(value.strength);
const same = (a, b) => a.enabled === b.enabled && a.strength === b.strength;

/** Reading does not migrate or write either preference. Malformed saved data is not a default. */
export function readDimmingPreference(values) {
    const enabled = values[DIM_KEY] === undefined ? false : values[DIM_KEY];
    const strength = values[DIM_STRENGTH_KEY] === undefined ? DIM_DEFAULT_STRENGTH : values[DIM_STRENGTH_KEY];
    if (typeof enabled !== 'boolean' || !validDimStrength(strength)) fail('INVALID_PREFERENCE', 'Saved source dimming settings are invalid. They were not overwritten. Repair the saved settings before trying again.');
    return { enabled, strength };
}

/** Only the paired Arcify background can proxy a verified trusted controller. */
export function installDimmingPreferences(api = chrome, { authorizationTimeoutMs = 2000 } = {}) {
    let tail = Promise.resolve(), epoch = 0, preferenceEpoch = 0, disposed = false;
    const pairing = async () => {
        const value = await api.storage.local.get([PEER_KEY, PAIRING_GENERATION_KEY]);
        return { peerId: value[PEER_KEY], generation: value[PAIRING_GENERATION_KEY] ?? null };
    };
    const authorized = (sender, pair) => isExtensionId(pair.peerId) && sender?.id === pair.peerId && !sender.tab
        && (!sender.url || sender.url === `chrome-extension://${pair.peerId}/background.js`)
        && (!sender.origin || sender.origin === `chrome-extension://${pair.peerId}`);
    const changed = (changes, area) => {
        if (area !== 'local') return;
        if ([PEER_KEY, PAIRING_GENERATION_KEY].some(key => Object.hasOwn(changes, key))) ++epoch;
        if ([DIM_KEY, DIM_STRENGTH_KEY].some(key => Object.hasOwn(changes, key))) ++preferenceEpoch;
    };
    api.storage.onChanged.addListener(changed);
    const listener = (request, sender, respond) => {
        if (request?.type !== DIM_PREFERENCES_TYPE) return;
        const envelope = { type: DIM_PREFERENCES_TYPE, version: 1, requestId: request.requestId };
        const handle = async () => {
            request = structuredClone(request);
            const keys = request.action === 'get' ? ['type', 'version', 'requestId', 'action'] : ['type', 'version', 'requestId', 'action', 'expected', 'preference'];
            if (!exact(request, keys) || request.version !== 1 || !uuid(request.requestId) || !['get', 'set'].includes(request.action)
                || request.action === 'set' && (!validDimPreference(request.expected) || !validDimPreference(request.preference))) fail('INVALID_REQUEST', 'Invalid source dimming request.');
            const revision = epoch, pair = await pairing();
            const check = async () => {
                const current = await pairing();
                if (disposed || epoch !== revision || !authorized(sender, pair) || current.peerId !== pair.peerId || current.generation !== pair.generation) fail('UNAUTHORIZED', 'Little Arc pairing changed. Reopen its settings.');
            };
            await check();
            const authorize = async () => {
                let timer, result;
                try {
                    result = await Promise.race([
                        api.runtime.sendMessage(pair.peerId, { type: DIM_AUTHORIZATION_TYPE, version: 1, requestId: request.requestId, action: 'verify', request: structuredClone(request) }),
                        new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Source dimming authorization timed out. Nothing was saved; reopen settings.'), { code: 'UNAUTHORIZED' })), authorizationTimeoutMs); })
                    ]);
                } finally { clearTimeout(timer); }
                if (disposed || epoch !== revision || !exact(result, ['type', 'version', 'requestId', 'authorized'])
                    || result.type !== DIM_AUTHORIZATION_TYPE || result.version !== 1 || result.requestId !== request.requestId || result.authorized !== true) fail('UNAUTHORIZED', 'Little Arc settings closed or changed. Nothing was saved; reopen settings.');
            };
            const run = async () => {
                await check();
                const preferenceRevision = preferenceEpoch;
                const unchanged = () => { if (preferenceRevision !== preferenceEpoch) fail('STALE_PREFERENCE', 'Source dimming changed elsewhere. Refresh these settings before saving.'); };
                const before = readDimmingPreference(await api.storage.local.get([DIM_KEY, DIM_STRENGTH_KEY]));
                await check();
                unchanged();
                if (request.action === 'get') { await authorize(); unchanged(); return before; }
                if (!same(before, request.expected)) fail('STALE_PREFERENCE', 'Source dimming changed elsewhere. Refresh these settings before saving.');
                if (same(before, request.preference)) { await authorize(); unchanged(); return before; }
                // A queued request is not durable authority. Obtain one final
                // controller-bound proof, then dispatch without another await.
                await authorize();
                if (disposed || epoch !== revision) fail('UNAUTHORIZED', 'Little Arc pairing changed before saving. Reopen settings.');
                unchanged();
                await api.storage.local.set({ [DIM_KEY]: request.preference.enabled, [DIM_STRENGTH_KEY]: request.preference.strength });
                await check();
                const saved = readDimmingPreference(await api.storage.local.get([DIM_KEY, DIM_STRENGTH_KEY]));
                await check();
                if (!same(saved, request.preference)) fail('UNCONFIRMED', 'Source dimming save was not confirmed. Reopen settings to check it; nothing was retried.');
                return saved;
            };
            const result = tail.then(run); tail = result.catch(() => {}); return result;
        };
        handle().then(preference => respond({ ...envelope, success: true, preference }), error => respond({ ...envelope, success: false,
            error: { code: error.code || 'UNCONFIRMED', message: error.code ? error.message : 'Source dimming settings could not be confirmed. Reopen settings; nothing was retried.' } }));
        return true;
    };
    api.runtime.onMessageExternal.addListener(listener);
    return { dispose() { disposed = true; ++epoch; api.storage.onChanged.removeListener(changed); api.runtime.onMessageExternal.removeListener(listener); } };
}
