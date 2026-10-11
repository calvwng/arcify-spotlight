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
    const showError = message => {
        revision++;
        if (!disposed) { label.textContent = message; row.dataset.state = 'error'; }
    };
    const unsubscribe = SpotlightMessageClient.onError(showError);
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
        if (!response?.success) { showError(response?.error || 'Could not check the Arcify connection.'); return; }
        row.dataset.state = response.status.status;
        label.textContent = response.status.status === 'disabled' ? 'Standalone Spotlight' : response.status.message;
    }).catch(() => {
        if (!disposed && revision === startRevision) showError('Could not check the Arcify connection.');
    });
    return { showError, dispose() { disposed = true; unsubscribe(); row.remove(); } };
}
