const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;
const STATUS_LABELS = {
    disabled: 'Disabled',
    connected: 'Connected',
    unavailable: 'Unavailable',
    error: 'Connection error'
};

/**
 * Keep configuration and connection checks in our background worker. It owns the
 * local arcifyBridgePeerId setting; this page never contacts a peer directly or
 * stores any Arcify snapshots.
 */
export function initializeBridgeOptions({
    document = globalThis.document,
    runtime = globalThis.chrome?.runtime
} = {}) {
    const form = document.getElementById('bridge-settings-form');
    if (!form) return null;

    const ownId = document.getElementById('spotlight-extension-id');
    const peerId = document.getElementById('arcify-peer-id');
    const disconnectButton = document.getElementById('disconnect-connection');
    const refreshButton = document.getElementById('refresh-connection');
    const statusRegion = document.getElementById('connection-status');
    const statusLabel = document.getElementById('connection-status-label');
    const statusMessage = document.getElementById('connection-status-message');
    const controls = form.querySelectorAll('button, input');
    let busy = false;
    let dirty = false;

    ownId.value = runtime?.id || 'Unavailable outside the extension';

    function showStatus(state, message) {
        statusRegion.dataset.state = state;
        statusLabel.textContent = state === 'checking' ? 'Checking connection…' : STATUS_LABELS[state];
        // Even error text can originate from a peer. Render only as plain text.
        statusMessage.textContent = message;
    }

    function setBusy(value) {
        busy = value;
        form.setAttribute('aria-busy', String(value));
        controls.forEach(control => { control.disabled = value; });
    }

    async function request(message, replaceInput = false) {
        if (busy) return;
        setBusy(true);
        showStatus('checking', 'Please wait while Spotlight checks the connection.');
        try {
            if (!runtime?.sendMessage) throw new Error('Open this page from Arcify Spotlight’s extension settings.');
            // One argument deliberately routes only to this extension.
            const response = await runtime.sendMessage(message);
            if (!response?.success) {
                throw new Error(typeof response?.error === 'string' ? response.error : 'Spotlight did not return a connection status. Try refreshing the status.');
            }
            const status = response.status;
            if (!status || !Object.hasOwn(STATUS_LABELS, status.status) ||
                typeof status.configured !== 'boolean' || typeof status.peerId !== 'string' ||
                typeof status.message !== 'string') {
                throw new Error('Spotlight returned an invalid connection status. Try reloading the extension.');
            }
            if (replaceInput || !dirty) {
                peerId.value = status.configured ? status.peerId : '';
                dirty = false;
                peerId.removeAttribute('aria-invalid');
            }
            showStatus(status.status, status.message);
        } catch (error) {
            showStatus('error', error instanceof Error ? error.message : 'The connection check failed. Try again.');
        } finally {
            setBusy(false);
        }
    }

    function refresh() {
        return request({ action: 'arcifyBridgeStatus' });
    }

    function save(event) {
        event?.preventDefault();
        if (busy) return;
        const value = peerId.value.trim();
        if (value && (!EXTENSION_ID_PATTERN.test(value) || value === runtime?.id)) {
            peerId.setAttribute('aria-invalid', 'true');
            showStatus('error', value === runtime?.id
                ? 'That is Spotlight’s own ID. Paste the ID for the Arcify sidebar extension instead.'
                : 'Enter a valid Arcify extension ID: exactly 32 lowercase letters from a to p.');
            peerId.focus();
            return;
        }
        peerId.removeAttribute('aria-invalid');
        return request({ action: 'arcifyBridgeConfigure', peerId: value }, true);
    }

    function disconnect() {
        return request({ action: 'arcifyBridgeConfigure', peerId: '' }, true);
    }

    peerId.addEventListener('input', () => {
        dirty = true;
        peerId.removeAttribute('aria-invalid');
    });
    form.addEventListener('submit', save);
    disconnectButton.addEventListener('click', disconnect);
    refreshButton.addEventListener('click', refresh);

    const ready = refresh();
    return { ready, refresh, save, disconnect };
}

if (globalThis.document?.getElementById('bridge-settings-form')) {
    initializeBridgeOptions();
}
