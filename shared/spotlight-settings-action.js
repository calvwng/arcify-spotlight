import { matchActionQuery, trustedActionGesture } from './arcify-space-actions-ui.js';

export const SETTINGS_RESULT_TYPE = 'spotlight-settings-action';
export const SETTINGS_DEFINITION = { title: 'Spotlight settings', subtitle: 'Appearance, Shift-click and connection preferences', action: 'Open settings', icon: 'settings' };
export const isSettingsResult = result => result?.type === SETTINGS_RESULT_TYPE;
const TERMS = ['spotlight', 'settings', 'preferences', 'options', 'connection', 'pairing', 'connect', 'open', 'show', 'the'];
const FAILURE = 'Could not open Spotlight settings. Open Spotlight details in chrome://extensions.';
const TIMEOUT = 'Opening Spotlight settings was not confirmed. Check for an existing settings tab before trying again.';

/** Local options navigation; independent of Arcify pairing and tab/Space authority. */
export class SpotlightSettingsActionController {
    constructor({ api = chrome, showError = () => {}, showSuccess = () => {}, timeoutMs = 5000 } = {}) {
        Object.assign(this, { api, showError, showSuccess, timeoutMs });
        this.pending = false; this.disposed = false;
    }
    results(query = '') {
        if (this.disposed || !query.trim()) return [];
        const matchScore = matchActionQuery(query, TERMS);
        return matchScore === null ? [] : [{ type: SETTINGS_RESULT_TYPE, title: SETTINGS_DEFINITION.title, url: '', domain: '', metadata: { matchScore } }];
    }
    invoke(result, event) {
        if (!isSettingsResult(result)) return false;
        if (this.disposed || this.pending || !trustedActionGesture(event)) return true;
        this.pending = true;
        this.operation = this.perform();
        return true;
    }
    async perform() {
        try {
            const response = await Promise.race([
                this.api.runtime.sendMessage({ action: 'arcifyBridgeOpenSettings' }),
                new Promise((_, reject) => { this.timer = setTimeout(() => reject(new Error(TIMEOUT)), this.timeoutMs); })
            ]);
            if (this.disposed) return;
            if (response?.success !== true) throw new Error(FAILURE);
            this.showSuccess('Spotlight settings opened. This tab stays open.');
        } catch (error) {
            if (!this.disposed) this.showError(error?.message === TIMEOUT ? TIMEOUT : FAILURE);
        } finally { clearTimeout(this.timer); this.pending = false; }
    }
    dispose() { this.disposed = true; clearTimeout(this.timer); }
}
