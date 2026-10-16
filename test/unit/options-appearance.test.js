// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeOptionsAppearance, initializeBridgeOptions, OPTIONS_APPEARANCE_KEY } from '../../options.js';

const html = readFileSync(resolve(process.cwd(), 'options.html'), 'utf8');
const bootstrap = readFileSync(resolve(process.cwd(), 'shared/options-appearance.js'), 'utf8');
const css = readFileSync(resolve(process.cwd(), 'options.css'), 'utf8');
let controller;

function mount() {
    const page = new DOMParser().parseFromString(html, 'text/html');
    document.body.replaceChildren(...page.body.childNodes);
    document.documentElement.removeAttribute('data-appearance');
}

function choose(value) {
    const select = document.getElementById('options-appearance');
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
}

beforeEach(() => { mount(); localStorage.clear(); });
afterEach(() => { controller?.destroy(); controller = undefined; });

describe('options appearance', () => {
    it('defaults to System without writing a preference', () => {
        const storage = { getItem: vi.fn(), setItem: vi.fn() };
        controller = initializeOptionsAppearance({ document, storage });
        expect(document.documentElement.dataset.appearance).toBe('system');
        expect(document.getElementById('options-appearance').value).toBe('system');
        expect(storage.setItem).not.toHaveBeenCalled();
    });

    it.each(['system', 'light', 'dark'])('persists %s and restores it on reopening options', appearance => {
        controller = initializeOptionsAppearance({ document });
        choose(appearance);
        expect(localStorage.getItem(OPTIONS_APPEARANCE_KEY)).toBe(appearance);
        expect(document.documentElement.dataset.appearance).toBe(appearance);
        expect(document.getElementById('appearance-message').textContent).toBe('');
        controller.destroy();
        mount();
        controller = initializeOptionsAppearance({ document });
        expect(document.documentElement.dataset.appearance).toBe(appearance);
        expect(document.getElementById('options-appearance').value).toBe(appearance);
    });

    it.each(['auto', 'DARK', '<script>', ''])('treats an invalid stored preference %s as System', value => {
        localStorage.setItem(OPTIONS_APPEARANCE_KEY, value);
        controller = initializeOptionsAppearance({ document });
        expect(document.documentElement.dataset.appearance).toBe('system');
        expect(document.getElementById('options-appearance').value).toBe('system');
    });

    it('allows repeated changes including a return to System', () => {
        controller = initializeOptionsAppearance({ document });
        for (const value of ['dark', 'light', 'dark', 'system']) {
            choose(value);
            expect(document.documentElement.dataset.appearance).toBe(value);
            expect(localStorage.getItem(OPTIONS_APPEARANCE_KEY)).toBe(value);
        }
    });

    it('continues in System when the storage getter is blocked', () => {
        const window = { get localStorage() { throw new Error('Blocked'); }, addEventListener: vi.fn(), removeEventListener: vi.fn() };
        controller = initializeOptionsAppearance({ document, window });
        expect(document.documentElement.dataset.appearance).toBe('system');
        choose('dark');
        expect(document.documentElement.dataset.appearance).toBe('dark');
        expect(document.getElementById('appearance-message').textContent).toContain('could not be saved');
    });

    it('applies a session-only choice and reports failed persistence', () => {
        const storage = { getItem: vi.fn(() => { throw new Error('Blocked'); }), setItem: vi.fn(() => { throw new Error('Quota'); }) };
        controller = initializeOptionsAppearance({ document, storage });
        choose('light');
        expect(document.documentElement.dataset.appearance).toBe('light');
        expect(document.getElementById('appearance-message').textContent).toContain('could not be saved');
        expect(document.getElementById('options-appearance').disabled).toBe(false);
    });

    it('clears an actionable save error after a later successful change without a lasting success notice', () => {
        const storage = { getItem: vi.fn(), setItem: vi.fn().mockImplementationOnce(() => { throw new Error('Quota'); }) };
        controller = initializeOptionsAppearance({ document, storage });
        choose('dark');
        expect(document.getElementById('appearance-message').textContent).toContain('could not be saved');
        choose('light');
        expect(document.getElementById('appearance-message').textContent).toBe('');
        expect(document.getElementById('options-appearance').value).toBe('light');
        expect(storage.setItem).toHaveBeenLastCalledWith(OPTIONS_APPEARANCE_KEY, 'light');
    });

    it('synchronizes appearance across options windows and handles cleared storage', () => {
        controller = initializeOptionsAppearance({ document });
        window.dispatchEvent(new StorageEvent('storage', { key: OPTIONS_APPEARANCE_KEY, newValue: 'dark', storageArea: localStorage }));
        expect(document.documentElement.dataset.appearance).toBe('dark');
        expect(document.getElementById('options-appearance').value).toBe('dark');
        window.dispatchEvent(new StorageEvent('storage', { key: null, newValue: null, storageArea: localStorage }));
        expect(document.documentElement.dataset.appearance).toBe('system');
    });

    it('ignores changes for other keys or storage areas and removes listeners on cleanup', () => {
        controller = initializeOptionsAppearance({ document });
        window.dispatchEvent(new StorageEvent('storage', { key: 'arcifyBridgePeerId', newValue: 'dark', storageArea: localStorage }));
        window.dispatchEvent(new StorageEvent('storage', { key: OPTIONS_APPEARANCE_KEY, newValue: 'dark', storageArea: sessionStorage }));
        expect(document.documentElement.dataset.appearance).toBe('system');
        controller.destroy();
        choose('dark');
        window.dispatchEvent(new StorageEvent('storage', { key: OPTIONS_APPEARANCE_KEY, newValue: 'dark', storageArea: localStorage }));
        expect(document.documentElement.dataset.appearance).toBe('system');
        expect(localStorage.getItem(OPTIONS_APPEARANCE_KEY)).toBeNull();
    });

    it('does not send bridge requests or overwrite an unsaved pairing ID', async () => {
        const runtime = { id: 'a'.repeat(32), sendMessage: vi.fn().mockResolvedValue({ success: true, status: { configured: false, peerId: '', status: 'disabled', message: 'Disabled' } }) };
        const bridge = initializeBridgeOptions({ document, runtime });
        await bridge.ready;
        const input = document.getElementById('arcify-peer-id');
        input.value = 'b'.repeat(32);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        controller = initializeOptionsAppearance({ document });
        choose('dark');
        expect(input.value).toBe('b'.repeat(32));
        expect(runtime.sendMessage).toHaveBeenCalledExactlyOnceWith({ action: 'arcifyBridgeStatus' });
        expect(document.getElementById('connection-status').dataset.state).toBe('disabled');
        expect(chrome.storage.local.set).not.toHaveBeenCalled();
    });

    it('is safe to initialize without an options page', () => {
        document.body.replaceChildren();
        expect(initializeOptionsAppearance({ document })).toBeNull();
        expect(initializeOptionsAppearance({ document: null })).toBeNull();
    });
});

describe('early appearance bootstrap and live CSS', () => {
    it('runs a CSP-compatible external classic script before the stylesheet and body', () => {
        const source = html.indexOf('<script src="shared/options-appearance.js"></script>');
        expect(source).toBeGreaterThan(0);
        expect(source).toBeLessThan(html.indexOf('<link rel="stylesheet"'));
        expect(source).toBeLessThan(html.indexOf('<body>'));
        expect(html).not.toMatch(/<script[^>]*>\s*[^<\s]/);
    });

    it.each([['dark', 'dark'], ['light', 'light'], ['system', 'system'], [null, 'system'], ['invalid', 'system']])('applies %s before body initialization', (saved, expected) => {
        vm.runInNewContext(bootstrap, { document, localStorage: { getItem: () => saved } });
        expect(document.documentElement.dataset.appearance).toBe(expected);
    });

    it('falls back safely when early storage access is blocked', () => {
        vm.runInNewContext(bootstrap, { document, get localStorage() { throw new Error('Blocked'); } });
        expect(document.documentElement.dataset.appearance).toBe('system');
    });

    it('keeps explicit and device-dark palettes identical and exempts explicit light from the media rule', () => {
        const explicit = css.match(/:root\[data-appearance="dark"\]\s*\{([^}]+)\}/)[1];
        const system = css.match(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-appearance="light"\]\)\s*\{([^}]+)\}/)[1];
        expect(explicit.replace(/\s+/g, '')).toBe(system.replace(/\s+/g, ''));
        expect(explicit).toContain('color-scheme: dark;');
        expect(css.match(/^:root\s*\{([^}]+)\}/)[1]).toContain('color-scheme: light;');
    });
});

function palette(selector) {
    const block = css.match(selector)[1];
    return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[\da-f]{6});/g)].map(([, key, value]) => [key, value]));
}
function luminance(hex) {
    const rgb = hex.match(/[\da-f]{2}/g).map(channel => parseInt(channel, 16) / 255).map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
function contrast(a, b) {
    const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (values[0] + 0.05) / (values[1] + 0.05);
}

describe.each([
    ['light', palette(/^:root\s*\{([^}]+)\}/)],
    ['dark', palette(/:root\[data-appearance="dark"\]\s*\{([^}]+)\}/)]
])('%s options contrast', (_name, colors) => {
    it.each(['page-bg', 'surface-bg', 'control-bg', 'readonly-bg', 'status-bg', 'success-bg', 'pending-bg', 'warning-bg', 'error-bg'])('keeps main text readable on %s', background => {
        expect(contrast(colors.text, colors[background])).toBeGreaterThanOrEqual(4.5);
    });
    it.each([['muted', 'surface-bg'], ['muted', 'control-bg'], ['link', 'surface-bg'], ['accent-text', 'accent'], ['disabled-text', 'disabled-bg'], ['selection-text', 'selection-bg']])('keeps %s readable on %s', (foreground, background) => {
        expect(contrast(colors[foreground], colors[background])).toBeGreaterThanOrEqual(4.5);
    });
    it.each(['focus', 'control-border'])('distinguishes %s from its surface', foreground => {
        expect(contrast(colors[foreground], colors['surface-bg'])).toBeGreaterThanOrEqual(3);
    });
});
