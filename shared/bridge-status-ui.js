/** Small shared connection/error surface used by overlay and new-tab. */
import { SpotlightSettingsActionController } from './spotlight-settings-action.js';
import { SpotlightMessageClient } from './message-client.js';

export function mountBridgeStatus(parent, { input } = {}) {
    const row = document.createElement('div');
    row.className = 'arcify-bridge-status';
    row.style.cssText = 'display:flex;gap:8px;align-items:center;padding:8px 12px;font:12px/1.4 system-ui,sans-serif;color:inherit;opacity:.8;';
    const label = document.createElement('span');
    label.setAttribute('role', 'status');
    label.setAttribute('aria-live', 'polite');
    label.style.flex = '1';
    const settings = document.createElement('button');
    settings.type = 'button';
    settings.textContent = 'Spotlight settings';
    settings.style.cssText = 'font:inherit;color:inherit;background:transparent;border:1px solid currentColor;border-radius:6px;padding:3px 7px;cursor:pointer;';
    row.append(label, settings);
    parent.append(row);
    let disposed = false;
    let passiveRevision = 0;
    let actionError = false;
    let actionSuccess = false;
    let passiveStatus = { message: 'Checking Arcify connection.', state: 'checking' };
    const render = ({ message, state }) => {
        if (!disposed) { label.textContent = message; row.dataset.state = state; }
    };
    const clearSuccess = () => {
        if (disposed || !actionSuccess) return;
        actionSuccess = false;
        render(passiveStatus);
    };
    // Only a new query dismisses completion. URL previews do not emit input.
    input?.addEventListener('input', clearSuccess);
    const setError = (message, explicit) => {
        if (!explicit) { passiveRevision++; passiveStatus = { message, state: 'error' }; }
        if (!explicit && actionError) return;
        actionError = explicit;
        actionSuccess = false;
        if (!disposed) { label.textContent = message; row.dataset.state = 'error'; }
    };
    const showError = message => setError(message, true);
    // A passive suggestion refresh must not erase a failed action's recovery
    // guidance after its callback has already reported the concrete failure.
    const unsubscribe = SpotlightMessageClient.onError((message, source) => {
        if (source === 'discovery') {
            if (disposed) return;
            passiveRevision++;
            passiveStatus = { message, state: message.startsWith('Arcify paired:') ? 'connected' : 'bookmark-fallback' };
            if (!actionError && !actionSuccess) render(passiveStatus);
        } else setError(message, source === 'action');
    });
    const settingsActions = new SpotlightSettingsActionController({ showError,
        showSuccess(message) { actionError = false; actionSuccess = true; render({ message, state: 'connected' }); } });
    settings.addEventListener('click', event => settingsActions.invoke(settingsActions.results('Spotlight settings')[0], event));
    label.textContent = 'Checking Arcify connection…';
    const initialPassiveRevision = passiveRevision;
    const finishInitialStatus = status => {
        if (disposed || passiveRevision !== initialPassiveRevision) return;
        passiveStatus = status;
        passiveRevision++;
        if (!actionError && !actionSuccess) render(passiveStatus);
    };
    chrome.runtime.sendMessage({ action: 'arcifyBridgeStatus' }).then(response => {
        if (!response?.success || !response.status) {
            finishInitialStatus({ state: 'error', message: response?.error || 'Could not check the Arcify connection.' });
            return;
        }
        finishInitialStatus({ state: response.status.status,
            message: response.status.status === 'disabled' ? 'Standalone Spotlight' : response.status.message });
    }).catch(() => finishInitialStatus({ state: 'error', message: 'Could not check the Arcify connection.' }));
    return { settingsActions, showError, showSuccess(message) { actionError = false; actionSuccess = true; if (!disposed) { label.textContent = message; row.dataset.state = 'connected'; } }, dispose() { settingsActions.dispose(); disposed = true; input?.removeEventListener('input', clearSuccess); unsubscribe(); row.remove(); } };
}
