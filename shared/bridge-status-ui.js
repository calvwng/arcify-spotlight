/** Small shared connection/error surface used by overlay and new-tab. */
import { SpotlightMessageClient } from './message-client.js';

export function mountBridgeStatus(parent) {
    const row = document.createElement('div');
    row.className = 'arcify-bridge-status';
    row.style.cssText = 'display:flex;gap:8px;align-items:center;padding:8px 12px;font:12px/1.4 system-ui,sans-serif;color:inherit;opacity:.8;';
    const label = document.createElement('span');
    label.setAttribute('role', 'status');
    label.setAttribute('aria-live', 'polite');
    label.style.flex = '1';
    const settings = document.createElement('button');
    settings.type = 'button';
    settings.textContent = 'Connection settings';
    settings.style.cssText = 'font:inherit;color:inherit;background:transparent;border:1px solid currentColor;border-radius:6px;padding:3px 7px;cursor:pointer;';
    row.append(label, settings);
    parent.append(row);
    let disposed = false;
    let revision = 0;
    let actionError = false;
    const setError = (message, explicit) => {
        if (!explicit && actionError) return;
        actionError = explicit;
        revision++;
        if (!disposed) { label.textContent = message; row.dataset.state = 'error'; }
    };
    const showError = message => setError(message, true);
    // A passive suggestion refresh must not erase a failed action's recovery
    // guidance after its callback has already reported the concrete failure.
    const unsubscribe = SpotlightMessageClient.onError((message, source) => {
        if (source === 'discovery') {
            if (actionError || disposed) return;
            revision++;
            label.textContent = message;
            row.dataset.state = message.startsWith('Arcify paired:') ? 'connected' : 'bookmark-fallback';
        } else setError(message, source === 'action');
    });
    settings.addEventListener('click', async () => {
        try {
            const response = await chrome.runtime.sendMessage({ action: 'arcifyBridgeOpenSettings' });
            if (!response?.success) showError(response?.error || 'Could not open connection settings. Open Spotlight details in chrome://extensions.');
        }
        catch { showError('Could not open connection settings. Open Spotlight details in chrome://extensions.'); }
    });
    label.textContent = 'Checking Arcify connection…';
    const startRevision = revision;
    chrome.runtime.sendMessage({ action: 'arcifyBridgeStatus' }).then(response => {
        if (disposed || revision !== startRevision) return;
        if (!response?.success) { setError(response?.error || 'Could not check the Arcify connection.', false); return; }
        row.dataset.state = response.status.status;
        label.textContent = response.status.status === 'disabled' ? 'Standalone Spotlight' : response.status.message;
    }).catch(() => {
        if (!disposed && revision === startRevision) setError('Could not check the Arcify connection.', false);
    });
    return { showError, showSuccess(message) { actionError = false; revision++; if (!disposed) { label.textContent = message; row.dataset.state = 'connected'; } }, dispose() { disposed = true; unsubscribe(); row.remove(); } };
}
