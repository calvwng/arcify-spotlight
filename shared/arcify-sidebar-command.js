/** Renderer-only gesture path. Preparation is async; invocation must never be. */
import { PEER_STORAGE_KEY, EXTENSION_ID } from './arcify-bridge.js';

export const SIDEBAR_RESULT_TYPE = 'arcify-sidebar-command';
export const isSidebarResult = result => result?.type === SIDEBAR_RESULT_TYPE;
export const SIDEBAR_FALLBACK = 'Open Arcify from its toolbar button instead.';
const SIDEBAR_TYPE = 'arcify-sidebar';
const validGesture = event => event?.isTrusted === true && !event.repeat && !event.isComposing &&
    ((event.type === 'keydown' && event.key === 'Enter') || (event.type === 'click' && event.button === 0));

export class SidebarCommandController {
    constructor({ api = chrome, tabId, newTab = false, onChange = () => {}, showError = () => {}, showSuccess = () => {}, timeoutMs = 5000 } = {}) {
        this.api = api;
        this.tabId = tabId;
        this.newTab = newTab;
        this.showSuccess = showSuccess;
        this.onChange = onChange;
        this.showError = showError;
        this.timeoutMs = timeoutMs;
        this.revision = 0;
        this.peerId = null;
        this.disposed = false;
        this.pending = false;
        this.prepared = false;
        this.onStorageChanged = (changes, area) => {
            if (area !== 'local' || !Object.hasOwn(changes, PEER_STORAGE_KEY)) return;
            // Invalidate before any asynchronous read. An older hello cannot resurrect it.
            this.revision++;
            this.peerId = null;
            this.prepared = false;
            this.onChange();
            this.ready = this.prepare();
        };
        api.storage.onChanged.addListener(this.onStorageChanged);
        this.ready = this.prepare();
    }

    async prepare() {
        const revision = ++this.revision;
        try {
            const stored = await this.api.storage.local.get(PEER_STORAGE_KEY);
            const peerId = stored[PEER_STORAGE_KEY];
            if (this.disposed || revision !== this.revision) return;
            if (!EXTENSION_ID.test(peerId || '') || peerId === this.api.runtime.id) return;
            if (this.newTab) {
                const tab = await this.api.tabs.getCurrent();
                if (this.disposed || revision !== this.revision || !Number.isSafeInteger(tab?.id) || tab.id <= 0) return;
                this.tabId = tab.id;
            }
            const response = await this.api.runtime.sendMessage({ action: 'arcifyBridgeStatus', ...(this.tabId ? { tabId: this.tabId } : {}) });
            if (this.disposed || revision !== this.revision) return;
            if (response?.success && response.status?.status === 'connected' && response.status.peerId === peerId &&
                Array.isArray(response.status.capabilities) && response.status.capabilities.includes('openSidebar')) this.peerId = peerId;
        } catch { /* The ordinary status surface explains unavailable pairing. */ }
        finally {
            if (!this.disposed && revision === this.revision) {
                this.prepared = true;
                this.onChange();
            }
        }
    }

    result(query = '') {
        if (!this.peerId || this.disposed) return null;
        const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
        if (!words.every(word => 'open arcify sidebar side panel'.includes(word))) return null;
        return { type: SIDEBAR_RESULT_TYPE, title: 'Open Arcify sidebar', url: '', domain: '',
            metadata: { sidebarPeerId: this.peerId } };
    }

    invoke(result, event) {
        if (!isSidebarResult(result)) return false;
        if (!validGesture(event) || this.disposed || this.pending) return true;
        if (!this.peerId || result.metadata?.sidebarPeerId !== this.peerId) {
            this.showError(`The Arcify connection changed. ${SIDEBAR_FALLBACK}`);
            return true;
        }
        const peerId = this.peerId;
        const revision = this.revision;
        const request = { type: SIDEBAR_TYPE, version: 1, requestId: crypto.randomUUID() };
        this.pending = true;
        let settled = false;
        const finish = error => {
            if (settled) return;
            settled = true;
            clearTimeout(this.timer);
            this.pending = false;
            if (this.disposed || this.revision !== revision) return;
            if (error) {
                // Never replay a failed/uncertain gesture, or silently route elsewhere.
                this.showError(`${error} ${SIDEBAR_FALLBACK}`);
                if (this.revision === revision) { this.peerId = null; this.onChange(); }
            } else {
                this.showSuccess('Arcify sidebar opened.');
            }
        };
        this.timer = setTimeout(() => finish('Arcify did not confirm opening the sidebar.'), this.timeoutMs);
        try {
            // Keep this call on the original trusted Enter/click stack. No await,
            // background relay, generic result action, or queued bridge mutation.
            this.api.runtime.sendMessage(peerId, request, response => {
                const runtimeError = this.api.runtime.lastError;
                if (runtimeError) return finish('Arcify is unavailable.');
                if (response?.type !== SIDEBAR_TYPE || response.version !== 1 || response.requestId !== request.requestId ||
                    response.role !== 'arcify' || typeof response.ok !== 'boolean') return finish('Arcify returned an invalid sidebar response.');
                if (!response.ok) return finish(response.error?.message || 'Arcify could not open the sidebar.');
                finish();
            });
        } catch { finish('Arcify is unavailable.'); }
        return true;
    }

    dispose() {
        this.disposed = true;
        this.revision++;
        this.peerId = null;
        clearTimeout(this.timer);
        this.api.storage.onChanged.removeListener(this.onStorageChanged);
    }
}
