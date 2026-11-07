export function installPeekOptions({ api = chrome, document = globalThis.document } = {}) {
    const checkbox = document.getElementById('peek-enabled'), iframe = document.getElementById('peek-iframe-enabled'), status = document.getElementById('peek-options-status');
    if (!checkbox) return;
    const controls = disabled => { checkbox.disabled = disabled; if (iframe) iframe.disabled = disabled || !checkbox.checked; };
    controls(true);
    const ready = api.storage.local.get(['peekEnabled', 'peekIframeEnabled']).then(value => {
        checkbox.checked = value.peekEnabled === true; if (iframe) iframe.checked = value.peekIframeEnabled === true; controls(false);
    }, () => { status.textContent = 'Could not read Shift-click settings.'; });
    const change = (control, key) => async event => {
        if (!event.isTrusted || control.disabled) return;
        const enabled = control.checked; controls(true);
        try {
            await api.storage.local.set({ [key]: enabled }); const saved = await api.storage.local.get(key); if (saved[key] !== enabled) throw Error();
            status.textContent = !checkbox.checked ? 'Shift-click link opening disabled.' : iframe?.checked
                ? 'Experimental iframe Peek enabled. Shift-click a web link after pairing both extensions.'
                : 'Little Arc enabled. Shift-click a web link after pairing both extensions. Use its header to place the same page in a Space.';
        } catch { status.textContent = 'Could not confirm the setting. Reload this page to check it.'; }
        finally { controls(false); }
    };
    checkbox.addEventListener('change', change(checkbox, 'peekEnabled'));
    iframe?.addEventListener('change', change(iframe, 'peekIframeEnabled'));
    return { ready };
}
