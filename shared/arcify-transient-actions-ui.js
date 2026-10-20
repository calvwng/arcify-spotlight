/** Explicit URL action. Ordinary URL navigation remains the primary result. */
import { PEER_KEY, PAIRING_GENERATION_KEY, bridgeError, isTransientUrl } from './arcify-bridge-protocol.js';
import { trustedActionGesture } from './arcify-space-actions-ui.js';
import { TRANSIENT_ACTION_TYPE, TRANSIENT_UNKNOWN, isTransientActionResult, exactKeys, sameTransientContext, validateTransientScope, validateTransientResult } from './arcify-transient-actions-protocol.js';
export { isTransientActionResult };
export const TRANSIENT_ACTION_DEFINITION = { title: 'Open link in Little Arc', subtitle: 'After restart: no control tab → ordinary tabs', action: 'Open Little Arc', icon: 'window' };
export function transientUrlFromQuery(query = '') {
    const text = query.trim(), url = text.replace(/^little\s+arc\s+/i, '');
    return isTransientUrl(url) ? url : null;
}
export class TransientActionController {
    constructor({ api = chrome, tabId, newTab = false, onChange = () => {}, showError = () => {}, showSuccess = () => {}, timeoutMs = 35000 }) {
        Object.assign(this, { api, tabId, newTab, onChange, showError, showSuccess, timeoutMs });
        this.revision = 0; this.readRevision = 0; this.scope = null; this.queryUrl = null; this.disposed = false; this.pending = false; this.dispatching = false;
        this.onStorage = (changes, area) => {
            if (area !== 'local' || ![PEER_KEY, PAIRING_GENERATION_KEY].some(key => Object.hasOwn(changes, key))) return;
            this.invalidate(true); this.ready = this.prepare();
        };
        api.storage.onChanged.addListener(this.onStorage);
        this.ready = this.prepare();
    }
    invalidate(pairingChanged = false) {
        if (this.disposed) return;
        if (!this.dispatching || pairingChanged) this.revision++;
        this.readRevision++; this.scope = null; this.onChange();
    }
    async request(message) {
        let timer;
        try { return await Promise.race([this.api.runtime.sendMessage({ ...message, ...(this.tabId ? { tabId: this.tabId } : {}) }),
            new Promise((_, reject) => { timer = setTimeout(() => reject(bridgeError('TIMEOUT', TRANSIENT_UNKNOWN)), this.timeoutMs); })]); }
        finally { clearTimeout(timer); }
    }
    async prepare() {
        if (this.disposed) return;
        if (this.pending) { this.refreshAfter = true; return; }
        this.invalidate();
        const revision = this.revision, readRevision = ++this.readRevision;
        try {
            if (this.newTab && !this.tabId) {
                const tab = await this.api.tabs.getCurrent();
                if (!Number.isSafeInteger(tab?.id) || tab.id <= 0) return;
                this.tabId = tab.id;
            }
            if (this.disposed || revision !== this.revision || readRevision !== this.readRevision) return;
            const response = await this.request({ action: 'arcifyTransientContext' });
            if (this.disposed || revision !== this.revision || readRevision !== this.readRevision) return;
            if (!exactKeys(response, ['success', 'scope']) || response.success !== true) throw new Error(response?.error || TRANSIENT_UNKNOWN);
            this.scope = response.scope === null ? null : validateTransientScope(response.scope);
        } catch { if (!this.disposed && revision === this.revision && readRevision === this.readRevision) this.scope = null; }
        finally { if (!this.disposed && revision === this.revision && readRevision === this.readRevision) this.onChange(); }
    }
    results(query = '') {
        this.queryUrl = transientUrlFromQuery(query);
        if (!this.scope || !this.queryUrl || this.disposed || this.pending) return [];
        return [{ type: TRANSIENT_ACTION_TYPE, title: TRANSIENT_ACTION_DEFINITION.title, url: '', domain: '', metadata: {
            transientAction: { url: this.queryUrl, scope: structuredClone(this.scope) }, matchScore: 1 } }];
    }
    matches(result) {
        const action = result?.metadata?.transientAction;
        return Boolean(isTransientActionResult(result) && action && isTransientUrl(action.url) && action.url === this.queryUrl &&
            this.scope && sameTransientContext(action.scope, this.scope));
    }
    invoke(result, event) {
        if (!isTransientActionResult(result)) return false;
        if (!trustedActionGesture(event) || this.disposed || this.pending) return true;
        if (!this.matches(result)) { this.showError('The Little Arc choice changed. Reopen Spotlight and choose the link again.'); return true; }
        this.pending = true; this.readRevision++;
        this.operation = this.perform(result.metadata.transientAction, this.revision);
        return true;
    }
    async perform(action, revision) {
        let succeeded = false;
        try {
            this.dispatching = true; this.scope = null; this.onChange();
            const response = await this.request({ action: 'arcifyOpenTransient', scope: action.scope, url: action.url });
            if (this.disposed || revision !== this.revision) return;
            if (!exactKeys(response, ['success', 'result']) || response.success !== true) throw bridgeError(response?.errorCode || 'UNKNOWN_RESULT', response?.error || TRANSIENT_UNKNOWN);
            validateTransientResult(response.result, action.scope.context);
            succeeded = true;
            this.showSuccess('Opened in Little Arc. Choose a Space there when you’re ready.');
        } catch (error) { if (!this.disposed && revision === this.revision) this.showError(error.message || TRANSIENT_UNKNOWN); }
        finally {
            this.pending = false; this.dispatching = false;
            const refresh = this.refreshAfter || succeeded; this.refreshAfter = false;
            if (!this.disposed && refresh) this.ready = this.prepare();
        }
    }
    dispose() {
        this.disposed = true; this.revision++; this.readRevision++; this.scope = null;
        try { this.api.storage.onChanged.removeListener(this.onStorage); } catch { /* Extension may have reloaded. */ }
    }
}
