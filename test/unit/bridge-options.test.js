// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { initializeBridgeOptions } from '../../options.js';

const OWN_ID = 'a'.repeat(32);
const PEER_ID = 'b'.repeat(32);
const html = readFileSync(resolve(process.cwd(), 'options.html'), 'utf8');

function response(state = 'disabled', peerId = '', message = 'The connection is disabled.') {
    return {
        success: true,
        status: { configured: !!peerId, peerId, status: state, message }
    };
}

describe('Arcify bridge options', () => {
    let runtime;
    let peerInput;
    let form;
    let status;

    beforeEach(() => {
        const page = new DOMParser().parseFromString(html, 'text/html');
        document.body.replaceChildren(...page.body.childNodes);
        runtime = { id: OWN_ID, sendMessage: vi.fn().mockResolvedValue(response()) };
        peerInput = document.getElementById('arcify-peer-id');
        form = document.getElementById('bridge-settings-form');
        status = document.getElementById('connection-status');
    });

    function editPeerId(value) {
        peerInput.value = value;
        peerInput.dispatchEvent(new Event('input', { bubbles: true }));
    }

    it('shows this extension ID and loads disabled status through its own background', async () => {
        const options = initializeBridgeOptions({ document, runtime });
        await options.ready;

        expect(document.getElementById('spotlight-extension-id').value).toBe(OWN_ID);
        expect(runtime.sendMessage).toHaveBeenCalledExactlyOnceWith({ action: 'arcifyBridgeStatus' });
        expect(peerInput.value).toBe('');
        expect(status.dataset.state).toBe('disabled');
        expect(status.getAttribute('role')).toBe('status');
        expect(status.getAttribute('aria-live')).toBe('polite');
        expect(chrome.storage.local.set).not.toHaveBeenCalled();
    });

    it('loads the saved peer ID and displays the background connection result', async () => {
        runtime.sendMessage.mockResolvedValue(response('connected', PEER_ID, 'Arcify is connected.'));
        const options = initializeBridgeOptions({ document, runtime });
        await options.ready;

        expect(peerInput.value).toBe(PEER_ID);
        expect(status.dataset.state).toBe('connected');
        expect(status.textContent).toContain('Arcify is connected.');
    });

    it.each(['abc', 'q'.repeat(32), 'B'.repeat(32), 'b'.repeat(31), 'b'.repeat(33)])(
        'rejects invalid peer ID %s without changing configuration', async (invalidId) => {
            const options = initializeBridgeOptions({ document, runtime });
            await options.ready;
            editPeerId(invalidId);
            await options.save();

            expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
            expect(peerInput.getAttribute('aria-invalid')).toBe('true');
            expect(document.activeElement).toBe(peerInput);
            expect(status.textContent).toContain('32 lowercase letters from a to p');
        }
    );

    it('rejects its own extension ID', async () => {
        const options = initializeBridgeOptions({ document, runtime });
        await options.ready;
        editPeerId(OWN_ID);
        await options.save();

        expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
        expect(status.textContent).toContain('Spotlight’s own ID');
    });

    it('trims and saves a peer using the internal configure request', async () => {
        const options = initializeBridgeOptions({ document, runtime });
        await options.ready;
        runtime.sendMessage.mockResolvedValue(response('connected', PEER_ID, 'Paired.'));
        editPeerId(`  ${PEER_ID}  `);
        await options.save();

        expect(runtime.sendMessage).toHaveBeenLastCalledWith({ action: 'arcifyBridgeConfigure', peerId: PEER_ID });
        expect(runtime.sendMessage.mock.calls.every(args => args.length === 1)).toBe(true);
        expect(peerInput.value).toBe(PEER_ID);
        expect(status.dataset.state).toBe('connected');
    });

    it('saves an empty input as disabled', async () => {
        const options = initializeBridgeOptions({ document, runtime });
        await options.ready;
        editPeerId('  ');
        await options.save();

        expect(runtime.sendMessage).toHaveBeenLastCalledWith({ action: 'arcifyBridgeConfigure', peerId: '' });
        expect(peerInput.value).toBe('');
        expect(status.dataset.state).toBe('disabled');
    });

    it('disconnects by clearing configuration and removes the displayed peer', async () => {
        runtime.sendMessage.mockResolvedValueOnce(response('connected', PEER_ID, 'Paired.'));
        const options = initializeBridgeOptions({ document, runtime });
        await options.ready;
        await options.disconnect();

        expect(runtime.sendMessage).toHaveBeenLastCalledWith({ action: 'arcifyBridgeConfigure', peerId: '' });
        expect(peerInput.value).toBe('');
        expect(status.dataset.state).toBe('disabled');
    });

    it('refreshes status without overwriting an unsaved peer ID', async () => {
        const options = initializeBridgeOptions({ document, runtime });
        await options.ready;
        editPeerId(PEER_ID);
        await options.refresh();

        expect(runtime.sendMessage).toHaveBeenLastCalledWith({ action: 'arcifyBridgeStatus' });
        expect(peerInput.value).toBe(PEER_ID);
    });

    it('wires form submission, refresh, and disconnect controls', async () => {
        const options = initializeBridgeOptions({ document, runtime });
        await options.ready;
        editPeerId(PEER_ID);
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await vi.waitFor(() => expect(form.getAttribute('aria-busy')).toBe('false'));
        expect(runtime.sendMessage).toHaveBeenLastCalledWith({ action: 'arcifyBridgeConfigure', peerId: PEER_ID });

        document.getElementById('refresh-connection').click();
        await vi.waitFor(() => expect(form.getAttribute('aria-busy')).toBe('false'));
        expect(runtime.sendMessage).toHaveBeenLastCalledWith({ action: 'arcifyBridgeStatus' });

        document.getElementById('disconnect-connection').click();
        await vi.waitFor(() => expect(form.getAttribute('aria-busy')).toBe('false'));
        expect(runtime.sendMessage).toHaveBeenLastCalledWith({ action: 'arcifyBridgeConfigure', peerId: '' });
    });

    it('blocks overlapping actions while a request is pending', async () => {
        let complete;
        runtime.sendMessage.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
        const options = initializeBridgeOptions({ document, runtime });

        expect(form.getAttribute('aria-busy')).toBe('true');
        expect([...form.querySelectorAll('button, input')].every(control => control.disabled)).toBe(true);
        await options.refresh();
        await options.save();
        await options.disconnect();
        expect(runtime.sendMessage).toHaveBeenCalledTimes(1);

        complete(response());
        await options.ready;
        expect(form.getAttribute('aria-busy')).toBe('false');
        expect([...form.querySelectorAll('button, input')].every(control => !control.disabled)).toBe(true);
    });

    it.each(['unavailable', 'error'])(
        'shows %s status and renders peer-provided text safely', async (state) => {
            const message = '<img src=x onerror="alert(1)"><script>alert(1)</script>';
            runtime.sendMessage.mockResolvedValue(response(state, PEER_ID, message));
            const options = initializeBridgeOptions({ document, runtime });
            await options.ready;

            expect(status.dataset.state).toBe(state);
            expect(document.getElementById('connection-status-message').textContent).toBe(message);
            expect(status.querySelector('img, script')).toBeNull();
        }
    );

    it('shows configuration errors without losing input and allows retry', async () => {
        const options = initializeBridgeOptions({ document, runtime });
        await options.ready;
        editPeerId(PEER_ID);
        runtime.sendMessage.mockResolvedValueOnce({ success: false, error: 'Settings could not be saved.' });
        await options.save();

        expect(status.textContent).toContain('Settings could not be saved.');
        expect(peerInput.value).toBe(PEER_ID);
        expect(peerInput.disabled).toBe(false);

        runtime.sendMessage.mockResolvedValueOnce(response('connected', PEER_ID, 'Paired.'));
        await options.save();
        expect(status.dataset.state).toBe('connected');
    });

    it('recovers from a rejected runtime request', async () => {
        runtime.sendMessage.mockRejectedValueOnce(new Error('Extension context invalidated.'));
        const options = initializeBridgeOptions({ document, runtime });
        await options.ready;

        expect(status.textContent).toContain('Extension context invalidated.');
        expect(form.getAttribute('aria-busy')).toBe('false');
        await options.refresh();
        expect(status.dataset.state).toBe('disabled');
    });

    it.each([undefined, { success: true }, { success: true, status: { status: 'connected' } }])(
        'handles malformed runtime responses', async (invalidResponse) => {
            runtime.sendMessage.mockResolvedValue(invalidResponse);
            const options = initializeBridgeOptions({ document, runtime });
            await options.ready;

            expect(status.dataset.state).toBe('error');
            expect(peerInput.disabled).toBe(false);
        }
    );

    it('explains how to open the page if the runtime is unavailable', async () => {
        const options = initializeBridgeOptions({ document, runtime: null });
        await options.ready;

        expect(status.textContent).toContain('Open this page from Arcify Spotlight’s extension settings.');
    });
});
