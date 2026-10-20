/**
 * A shadow tree isolates CSS, but not composed keyboard events: an existing page
 * window-capture listener runs before any listener on our input or shadow root.
 * A separate document is the event boundary. Keep the native modal in the parent
 * document (top layer/inert backdrop), with the actual UI in an initial about:blank
 * frame. No injected frame script, event replay, host hook, or extra permission.
 * Event callbacks stay in the content script and receive the original trusted event.
 */
export function createOverlaySurface(css, accentCSS, markup) {
    const host = document.createElement('div');
    host.id = 'arcify-spotlight-host';
    host.setAttribute('style', 'all: initial !important; display: contents !important;');
    const shadow = host.attachShadow({ mode: 'open' });
    const shellStyle = document.createElement('style');
    shellStyle.textContent = `
        :host { all: initial !important; display: contents !important; }
        dialog {
            position: fixed; margin: 0; top: 35vh; left: 50%;
            transform: translateX(-50%); border: 0; padding: 0;
            background: transparent; border-radius: 12px; width: 650px;
            max-width: 90vw; max-height: 60vh; overflow: hidden;
            box-shadow: 0 20px 60px rgba(0,0,0,.5);
            animation: spotlight-show .2s ease-out;
        }
        dialog::backdrop { background: transparent; }
        iframe { display: block; border: 0; width: 100%; height: 140px; max-height: 60vh; }
        @keyframes spotlight-show {
            from { opacity: 0; transform: translateX(-50%) scale(.95); }
            to { opacity: 1; transform: translateX(-50%) scale(1); }
        }
        @media (prefers-reduced-motion: reduce) { dialog { animation: none; } }
    `;
    const dialog = document.createElement('dialog');
    dialog.id = 'arcify-spotlight-dialog';
    dialog.dataset.testid = 'spotlight-overlay';
    dialog.setAttribute('aria-label', 'Spotlight');
    const frame = document.createElement('iframe');
    frame.title = 'Spotlight search';
    frame.dataset.testid = 'spotlight-frame';
    // Leave src/srcdoc unset: no navigation, remote resource, or script execution.
    dialog.append(frame);
    shadow.append(shellStyle, dialog);
    document.body.append(host);
    try {
        const frameDocument = frame.contentDocument;
        if (!frameDocument?.body) {
            throw new Error('Could not create the Spotlight input document.');
        }
        frameDocument.documentElement.lang = document.documentElement.lang || 'en';
        frameDocument.title = 'Spotlight';
        const styleSheet = frameDocument.createElement('style');
        styleSheet.id = 'arcify-spotlight-styles';
        styleSheet.textContent = css;
        const accentStyleSheet = frameDocument.createElement('style');
        accentStyleSheet.id = 'arcify-spotlight-accent-styles';
        accentStyleSheet.textContent = accentCSS;
        frameDocument.head.append(styleSheet, accentStyleSheet);
        const content = frameDocument.createElement('div');
        content.id = 'arcify-spotlight-content';
        content.innerHTML = markup;
        frameDocument.body.append(content);
        const resize = () => {
            // Measure content, not document scrollHeight (which includes frame height
            // and prevents shrinking when results disappear).
            frame.style.height = `${Math.ceil(content.getBoundingClientRect().height)}px`;
        };
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
        observer?.observe(content);
        return { host, dialog, frame, frameDocument, content, accentStyleSheet,
            resize, dispose: () => observer?.disconnect() };
    } catch (error) {
        host.remove();
        throw error;
    }
}

export function isComposingKey(event) {
    // keyCode 229 covers browsers' IME start/end events whose isComposing is false.
    return event.isComposing || event.keyCode === 229;
}

/** Keep Tab in the modal frame; do not cancel native typing/editing/browser keys. */
export function containOverlayFocus(frameDocument, onClose) {
    const onKeyDown = event => {
        if (isComposingKey(event) || event.ctrlKey || event.metaKey || event.altKey) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
        } else if (event.key === 'Tab') {
            const controls = [...frameDocument.querySelectorAll('input, button, a[href], [tabindex]')]
                .filter(element => !element.disabled && element.tabIndex >= 0 && element.getClientRects().length);
            if (!controls.length) return;
            const current = controls.indexOf(frameDocument.activeElement);
            if (event.shiftKey && current <= 0) {
                event.preventDefault();
                controls.at(-1).focus();
            } else if (!event.shiftKey && (current === -1 || current === controls.length - 1)) {
                event.preventDefault();
                controls[0].focus();
            }
        }
    };
    frameDocument.addEventListener('keydown', onKeyDown);
    return () => frameDocument.removeEventListener('keydown', onKeyDown);
}
