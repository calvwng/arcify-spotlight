import { boundedOverlayDelivery, VALIDATE_OVERLAY_RECOVERY } from './overlay-recovery.js';

// Isolated-world singleton. Reinjection must not register another activation
// listener or interpret a leftover legacy mode global as an instruction to open.
export const OVERLAY_RECEIVER_KEY = '__arcifySpotlightReceiverV1';
const OWNER_ATTRIBUTE = 'data-arcify-spotlight-owner';

export function markOverlayHost(host, extensionId) {
    host.setAttribute(OWNER_ATTRIBUTE, extensionId);
}

export function installOverlayReceiver({ api = chrome, scope = window, activate, disposeInvalidated }) {
    const previous = scope[OVERLAY_RECEIVER_KEY];
    if (previous?.isLive()) return previous;
    const runtime = api.runtime;
    const extensionId = runtime.id;
    const receiver = {
        isLive() {
            try { return runtime.id === extensionId && !!extensionId && runtime.onMessage.hasListener(listener); }
            catch { return false; }
        },
        ownsGlobals: () => scope[OVERLAY_RECEIVER_KEY] === receiver,
        disposeInvalidated() {
            if (receiver.isLive()) return false;
            disposeInvalidated();
            return true;
        },
        async validateRecovery(options) {
            let valid = false;
            try {
                const response = await boundedOverlayDelivery(runtime.sendMessage({
                    action: VALIDATE_OVERLAY_RECOVERY, requestId: options.recoveryRequestId
                }));
                valid = response?.valid === true && options.expectedUrl === scope.location.href;
            } catch { /* Expired request, invalidated worker, or source change. */ }
            if (!valid) throw Object.assign(new Error('The recovery source is no longer current.'), { changed: true });
        },
        prepareRecovery(options) {
            if (options.expectedUrl !== undefined && options.expectedUrl !== scope.location.href)
                throw Object.assign(new Error('The source document changed.'), { changed: true });
            const hosts = [...scope.document.querySelectorAll('#arcify-spotlight-host')];
            if (!hosts.length) return null;
            // Do not guess ownership of legacy or page-created nodes. A live
            // singleton is reused above. Only an explicitly recovered orphan of
            // this extension is eligible, and multiple drafts are never discarded.
            if (!options.recovery || hosts.length !== 1 || hosts[0].getAttribute(OWNER_ATTRIBUTE) !== extensionId)
                throw new Error('An existing Spotlight surface could not be safely recovered.');
            const host = hosts[0];
            const dialog = host.shadowRoot?.getElementById('arcify-spotlight-dialog');
            const frame = dialog?.querySelector('iframe[data-testid="spotlight-frame"]');
            let input;
            try { input = frame?.contentDocument?.querySelector('input[data-testid="spotlight-input"]'); }
            catch { /* Never destroy an unreadable draft. */ }
            if (!dialog || !input || previous?.isLive()) throw new Error('The existing Spotlight draft is unavailable.');
            return {
                readDraft() {
                    if (previous?.isLive()) throw new Error('The existing Spotlight receiver is still live.');
                    return host.isConnected && dialog.open ? { value: input.value, start: input.selectionStart,
                        end: input.selectionEnd, direction: input.selectionDirection } : null;
                },
                retire() {
                    // Called only after the replacement modal opened successfully.
                    // This cleanup cannot clear a live receiver or a newer host.
                    if (previous?.isLive()) return false;
                    try { previous?.disposeInvalidated(); } catch { /* Old APIs may already be invalid. */ }
                    host.remove();
                    return true;
                }
            };
        }
    };
    const listener = (message, sender, sendResponse) => {
        if (message?.action !== 'activateSpotlight' || sender?.id !== extensionId) return false;
        activate(message.mode, message).then(
            state => sendResponse({ success: true, ...state }),
            error => sendResponse({ success: false, error: error.message, ...(error.changed ? { changed: true } : {}) })
        );
        return true;
    };
    runtime.onMessage.addListener(listener);
    scope[OVERLAY_RECEIVER_KEY] = receiver;
    return receiver;
}
