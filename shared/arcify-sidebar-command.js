/** Renderer-only gesture path. Preparation is async; invocation must never be. */
import { PEER_STORAGE_KEY, EXTENSION_ID } from './arcify-bridge.js';

export const SIDEBAR_RESULT_TYPE = 'arcify-sidebar-command';
export const isSidebarResult = result => result?.type === SIDEBAR_RESULT_TYPE;
export const SIDEBAR_FALLBACK = 'Open Arcify from its toolbar button instead.';
const SIDEBAR_TYPE = 'arcify-sidebar';
const validGesture = event => event?.isTrusted === true && !event.repeat && !event.isComposing &&
    ((event.type === 'keydown' && event.key === 'Enter') || (event.type === 'click' && event.button === 0));

const SIDEBAR_TERMS = ['open', 'show', 'arcify', 'sidebar', 'side', 'panel'];

// A command match must account for every word. Whole-query fuzzy searches can
// mistake "sidebar documentation" for an instruction to open the sidebar.
// This small bounded edit check also recognizes adjacent transpositions, unlike
// raising the general data-search tolerance to accommodate short command typos.
function oneEditAway(word, term) {
    if (Math.abs(word.length - term.length) > 1) return false;
    let index = 0;
    while (index < Math.min(word.length, term.length) && word[index] === term[index]) index++;
    if (index === Math.min(word.length, term.length)) return true;
    if (word.length !== term.length) {
        return word.length > term.length
            ? word.slice(index + 1) === term.slice(index)
            : word.slice(index) === term.slice(index + 1);
    }
    return word.slice(index + 1) === term.slice(index + 1) ||
        (word[index] === term[index + 1] && word[index + 1] === term[index] &&
            word.slice(index + 2) === term.slice(index + 2));
}

export function matchSidebarQuery(query = '') {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return 0;
    if (normalized.length > 64 || !/^[a-z]+(?:\s+[a-z]+)*$/.test(normalized)) return null;
    const words = normalized.split(/\s+/);
    if (words.length > 6) return null;
    let total = 0;
    for (const word of words) {
        if (word.length < 2) return null;
        let best = 0;
        for (const term of SIDEBAR_TERMS) {
            if (word === term) best = 1;
            else if (term.startsWith(word)) best = Math.max(best, 0.9 + 0.09 * word.length / term.length);
            // Keep short, unrelated words from becoming commands through a
            // missing first letter (e.g. "pen" matching "open").
            else if (word.length >= 3 &&
                (word[0] === term[0] || (word[0] === term[1] && word[1] === term[0]))) {
                // Longer partial words may contain a typo too: "arcfi" is an
                // adjacent transposition in the partial "arcif".
                const candidates = word.length >= 4
                    ? [term, term.slice(0, word.length), term.slice(0, word.length + 1)] : [term];
                for (const candidate of candidates) {
                    if (oneEditAway(word, candidate)) best = Math.max(best,
                        (1 - 1 / Math.max(word.length, candidate.length)) * (candidate === term ? 1 : 0.95));
                }
            }
        }
        if (!best) return null;
        total += best;
    }
    return total / words.length;
}

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
        const matchScore = matchSidebarQuery(query);
        if (matchScore === null) return null;
        return { type: SIDEBAR_RESULT_TYPE, title: 'Open Arcify sidebar', url: '', domain: '',
            metadata: { sidebarPeerId: this.peerId, matchScore } };
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
