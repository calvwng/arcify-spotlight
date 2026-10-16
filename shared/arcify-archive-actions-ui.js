/** Renderer Archive actions. Opening must stay on the original trusted gesture stack. */
import { PEER_KEY, PAIRING_GENERATION_KEY, bridgeError } from './arcify-bridge-protocol.js';
import { matchActionQuery, trustedActionGesture } from './arcify-space-actions-ui.js';
import { ARCHIVE_ACTION_TYPE, ARCHIVE_OPEN_TYPE, isArchiveResult, exactKeys, archiveId, validateArchiveScope, validateArchiveResult, sameArchiveScope } from './arcify-archive-actions-protocol.js';
export { isArchiveResult };
const UNKNOWN = 'Arcify did not confirm this Archive action. Check Arcify before trying again.';
const OPEN_TERMS = ['open', 'show', 'archive', 'archived', 'arcify', 'the'];
const ARCHIVE_WORDS = new Set(['archive', 'archived', 'reopen', 'restore', 'tab', 'tabs', 'from', 'the']);
export function matchArchiveEntryQuery(query, entry) {
    const text = query.trim().toLocaleLowerCase();
    if (!text || text.length > 256 || /[\x00-\x1f\x7f]|:\/\/|^www\./.test(text)) return null;
    const words = text.split(/\s+/), names = words.filter(word => !ARCHIVE_WORDS.has(word));
    if (!names.length) return words.some(word => ['archive', 'archived', 'reopen', 'restore'].includes(word)) ? .95 : null;
    const title = entry.title.toLocaleLowerCase();
    return names.every(word => word.length >= 2 && title.includes(word)) ? 1 : null;
}
export function archiveActionDefinition(result) {
    const action = result?.metadata?.archiveAction;
    if (action?.command === 'openArchive') return { title: 'Open Archive', subtitle: 'Arcify Archive • Browse archived tabs', action: 'Open Archive', icon: 'archive' };
    const entry = action?.scope?.entries?.find(item => item.entryId === action.entryId);
    return entry ? { title: `Reopen ${entry.title || entry.url}`, subtitle: `Archive • ${action.spaceName}`, action: 'Reopen tab', icon: 'archive' }
        : { title: 'Unavailable archived tab', subtitle: '', action: '', icon: 'archive' };
}
function validateSpaceNames(value, scope) {
    if (!Array.isArray(value) || value.length > 1000) throw new Error('Invalid Archive Space names.');
    const ids = new Set();
    for (const item of value) {
        if (!exactKeys(item, ['spaceId', 'name']) || !archiveId(item.spaceId) || ids.has(item.spaceId) ||
            typeof item.name !== 'string' || item.name.length > 1024 || /[\x00-\x1f\x7f]/.test(item.name)) throw new Error('Invalid Archive Space names.');
        ids.add(item.spaceId);
    }
    if (scope && (!ids.has(scope.context.spaceId) || scope.entries.some(entry => !ids.has(entry.spaceId)))) throw new Error('Missing original Archive Space.');
    return new Map(value.map(item => [item.spaceId, item.name]));
}
export class ArchiveActionController {
    constructor({ api = chrome, tabId, newTab = false, onChange = () => {}, showError = () => {}, showSuccess = () => {}, timeoutMs = 10000 } = {}) {
        Object.assign(this, { api, tabId, newTab, onChange, showError, showSuccess, timeoutMs });
        this.revision = 0; this.readRevision = 0; this.scope = null; this.spaceNames = new Map(); this.disposed = false; this.pending = false;
        this.onStorage = (changes, area) => {
            if (area !== 'local' || ![PEER_KEY, PAIRING_GENERATION_KEY].some(key => Object.hasOwn(changes, key))) return;
            this.revision++; this.readRevision++; this.scope = null; this.spaceNames.clear(); this.onChange();
            this.ready = this.prepare();
        };
        api.storage.onChanged.addListener(this.onStorage);
        this.ready = this.prepare();
    }
    async request(message) {
        let timer;
        try {
            return await Promise.race([this.api.runtime.sendMessage({ ...message, ...(this.tabId ? { tabId: this.tabId } : {}) }),
                new Promise((_, reject) => { timer = setTimeout(() => reject(bridgeError('TIMEOUT', UNKNOWN)), this.timeoutMs); })]);
        } finally { clearTimeout(timer); }
    }
    async prepare() {
        if (this.disposed || this.pending) return;
        const revision = this.revision, readRevision = ++this.readRevision;
        // Requesting a view rotates private Arcify tokens. Retire the old view first.
        this.scope = null; this.spaceNames.clear(); this.onChange();
        try {
            if (this.newTab && !this.tabId) {
                const tab = await this.api.tabs.getCurrent();
                if (!Number.isSafeInteger(tab?.id) || tab.id <= 0) return;
                this.tabId = tab.id;
            }
            const response = await this.request({ action: 'arcifyArchiveContext' });
            if (this.disposed || revision !== this.revision || readRevision !== this.readRevision) return;
            if (!exactKeys(response, ['success', 'scope', 'spaceNames']) || response.success !== true) throw new Error(response?.error || UNKNOWN);
            const scope = response.scope === null ? null : validateArchiveScope(response.scope);
            this.spaceNames = validateSpaceNames(response.spaceNames, scope);
            this.scope = scope;
        } catch {
            if (!this.disposed && revision === this.revision && readRevision === this.readRevision) this.scope = null;
        } finally { if (!this.disposed && revision === this.revision && readRevision === this.readRevision) this.onChange(); }
    }
    results(query = '') {
        if (!this.scope || this.disposed || this.pending || !query.trim()) return [];
        const capturedScope = structuredClone(this.scope);
        const result = (command, entryId, matchScore, entry = null) => {
            const row = { type: ARCHIVE_ACTION_TYPE, url: '', domain: '', metadata: { archiveAction: {
                command, scope: capturedScope, entryId, spaceName: this.spaceNames.get(entry?.spaceId || this.scope.context.spaceId) || 'Unnamed Space'
            }, matchScore } };
            return { ...row, title: archiveActionDefinition(row).title };
        };
        const openMatch = /\barch/i.test(query) ? matchActionQuery(query, OPEN_TERMS) : null;
        const results = this.scope.openIntent && openMatch !== null ? [result('openArchive', null, openMatch)] : [];
        for (const entry of this.scope.entries) {
            const score = matchArchiveEntryQuery(query, entry);
            if (score !== null) results.push(result('reopenArchivedTab', entry.entryId, score, entry));
        }
        return results;
    }
    matches(result) {
        const action = result?.metadata?.archiveAction;
        return Boolean(isArchiveResult(result) && this.scope && action && sameArchiveScope(action.scope, this.scope) &&
            (action.command === 'openArchive' ? action.entryId === null && this.scope.openIntent :
                action.command === 'reopenArchivedTab' && this.scope.entries.some(entry => entry.entryId === action.entryId)));
    }
    invoke(result, event) {
        if (!isArchiveResult(result)) return false;
        if (!trustedActionGesture(event) || this.disposed || this.pending) return true;
        if (!this.matches(result)) { this.showError('The Archive context changed. Refresh Spotlight and choose the action again.'); return true; }
        const action = result.metadata.archiveAction, revision = this.revision;
        this.pending = true; this.readRevision++; this.scope = null;
        if (action.command === 'openArchive') this.open(action, revision);
        else this.operation = this.reopen(action, revision);
        this.onChange();
        return true;
    }
    open(action, revision) {
        const request = { type: ARCHIVE_OPEN_TYPE, version: 1, requestId: crypto.randomUUID(), token: action.scope.openIntent };
        let settled = false, resolve;
        this.operation = new Promise(done => { resolve = done; });
        const finish = error => {
            if (settled) return;
            settled = true; clearTimeout(this.timer); this.pending = false;
            if (!this.disposed && revision === this.revision) {
                this.scope = null; this.onChange();
                if (error) this.showError(error); else this.showSuccess('Arcify Archive opened.');
            }
            resolve();
        };
        this.timer = setTimeout(() => finish(UNKNOWN), this.timeoutMs);
        try {
            // No await, background relay, or queued mutation before this call.
            this.api.runtime.sendMessage(action.scope.peerId, request, response => {
                if (this.api.runtime.lastError) return finish(UNKNOWN);
                const base = ['type', 'version', 'requestId', 'role', 'ok'];
                if (response?.type !== ARCHIVE_OPEN_TYPE || response.version !== 1 || response.requestId !== request.requestId || response.role !== 'arcify') return finish(UNKNOWN);
                if (response.ok === false && exactKeys(response, [...base, 'error']) && exactKeys(response.error, ['code', 'message']) &&
                    archiveId(response.error.code) && typeof response.error.message === 'string' && response.error.message.length <= 2048)
                    return finish(response.error.message || UNKNOWN);
                // Success means the authenticated native sidebar confirmed its Archive popup.
                if (!exactKeys(response, [...base, 'displayed']) || response.ok !== true || response.displayed !== true) return finish(UNKNOWN);
                finish();
            });
        } catch { finish(UNKNOWN); }
    }
    async reopen(action, revision) {
        try {
            const response = await this.request({ action: 'arcifyArchiveReopen', scope: action.scope, entryId: action.entryId });
            if (this.disposed || revision !== this.revision) return;
            if (!exactKeys(response, ['success', 'result']) || response.success !== true) throw new Error(response?.error || UNKNOWN);
            const result = validateArchiveResult(response.result, action.scope, action.entryId);
            if (result.status === 'partial') this.showError(result.warning);
            else this.showSuccess(`Archived tab reopened in ${action.spaceName}.`);
        } catch (error) {
            if (!this.disposed && revision === this.revision) this.showError(error.message || UNKNOWN);
        } finally {
            this.pending = false;
            if (!this.disposed && revision === this.revision) { this.scope = null; this.onChange(); }
        }
    }
    dispose() {
        this.disposed = true; this.revision++; this.readRevision++; this.scope = null; clearTimeout(this.timer);
        try { this.api.storage.onChanged.removeListener(this.onStorage); } catch { /* Reloaded extension. */ }
    }
}
