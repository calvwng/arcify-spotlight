// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountBridgeStatus } from '../../shared/bridge-status-ui.js';
import { SpotlightMessageClient } from '../../shared/message-client.js';

function statusResponse(status = 'disabled', message = 'Connection disabled.') {
    return { success: true, status: { configured: status !== 'disabled', peerId: '', status, message } };
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

async function flushMessages() {
    // Flush the status request's then/catch chain without real-time polling.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

describe('Shared Arcify bridge status surface', () => {
    let parent;
    let runtime;
    let mounted;

    beforeEach(() => {
        document.body.replaceChildren();
        parent = document.createElement('main');
        document.body.append(parent);
        runtime = { sendMessage: vi.fn().mockResolvedValue(statusResponse()) };
        vi.stubGlobal('chrome', { runtime });
        mounted = [];
    });

    afterEach(() => {
        mounted.forEach(surface => surface.dispose());
        vi.unstubAllGlobals();
    });

    function mount() {
        const surface = mountBridgeStatus(parent);
        mounted.push(surface);
        return {
            surface,
            row: parent.querySelector('.arcify-bridge-status'),
            label: parent.querySelector('[role="status"]'),
            button: parent.querySelector('button')
        };
    }

    it('starts with a polite checking label and asks only its own background for status', async () => {
        const { label } = mount();
        expect(label.textContent).toBe('Checking Arcify connection…');
        expect(label.getAttribute('aria-live')).toBe('polite');
        expect(runtime.sendMessage).toHaveBeenCalledExactlyOnceWith({ action: 'arcifyBridgeStatus' });
        await flushMessages();
    });

    it.each([
        ['disabled', 'Ignored disabled detail.', 'Standalone Spotlight'],
        ['connected', 'Arcify is connected.', 'Arcify is connected.'],
        ['pending', 'Arcify ID saved. Save Spotlight’s ID in Arcify, then refresh status.', 'Arcify ID saved. Save Spotlight’s ID in Arcify, then refresh status.'],
        ['unavailable', 'Reload Arcify to reconnect.', 'Reload Arcify to reconnect.'],
        ['error', 'The paired ID is invalid.', 'The paired ID is invalid.']
    ])('renders %s connection state', async (state, message, expected) => {
        runtime.sendMessage.mockResolvedValue(statusResponse(state, message));
        const { row, label } = mount();
        await flushMessages();
        expect(row.dataset.state).toBe(state);
        expect(label.textContent).toBe(expected);
    });

    it('renders peer status and action error strings as text, never markup', async () => {
        const unsafe = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
        runtime.sendMessage.mockResolvedValue(statusResponse('connected', unsafe));
        const { row, label } = mount();
        await flushMessages();
        expect(label.textContent).toBe(unsafe);
        expect(row.querySelector('img, script')).toBeNull();

        SpotlightMessageClient.reportError(unsafe);
        expect(label.textContent).toBe(unsafe);
        expect(row.dataset.state).toBe('error');
        expect(row.querySelector('img, script')).toBeNull();
    });

    it('keeps connected-state bookmark warnings visible to the user', async () => {
        const message = 'Connected to Arcify. Bookmarks for Work are unavailable; live tabs and spaces are still available.';
        const response = statusResponse('connected', message);
        response.status.warnings = [{ code: 'BOOKMARKS_UNAVAILABLE', spaceId: 'work', message: 'Bookmarks for Work are unavailable.' }];
        runtime.sendMessage.mockResolvedValueOnce(response);
        const { row, label } = mount();
        await flushMessages();
        expect(row.dataset.state).toBe('connected');
        expect(label.textContent).toBe(message);
        expect(label.textContent).toContain('Bookmarks for Work are unavailable');
    });

    it('opens connection settings through the internal action', async () => {
        const { button } = mount();
        await flushMessages();
        runtime.sendMessage.mockResolvedValue({ success: true });
        expect(button.type).toBe('button');
        expect(button.textContent).toBe('Connection settings');
        button.click();
        await flushMessages();
        expect(runtime.sendMessage).toHaveBeenLastCalledWith({ action: 'arcifyBridgeOpenSettings' });
        expect(runtime.sendMessage.mock.calls.every(args => args.length === 1)).toBe(true);
    });

    it('shows a useful error if opening settings rejects', async () => {
        const { button, label, row } = mount();
        await flushMessages();
        runtime.sendMessage.mockRejectedValueOnce(new Error('No background worker.'));
        button.click();
        await flushMessages();
        expect(row.dataset.state).toBe('error');
        expect(label.textContent).toContain('Could not open connection settings.');
        expect(label.textContent).toContain('chrome://extensions');
    });

    it.each([undefined, { success: false, error: 'Settings could not be opened.' }])(
        'shows an error if opening settings is not confirmed (%j)', async (response) => {
            const { button, label, row } = mount();
            await flushMessages();
            runtime.sendMessage.mockResolvedValueOnce(response);
            button.click();
            await flushMessages();
            expect(row.dataset.state).toBe('error');
            expect(label.textContent).toMatch(/settings/i);
        }
    );

    it('subscribes to action errors reported by the message client', async () => {
        const { row, label } = mount();
        await flushMessages();
        SpotlightMessageClient.reportError('The tab was closed. Search again.');
        expect(row.dataset.state).toBe('error');
        expect(label.textContent).toBe('The tab was closed. Search again.');
    });

    it.each(['resolve', 'reject'])('does not let a late initial status %s replace a newer action error', async (settle) => {
        const pending = deferred();
        runtime.sendMessage.mockReturnValueOnce(pending.promise);
        const { row, label } = mount();
        SpotlightMessageClient.reportError('The action timed out. Check your tabs before trying again.');
        if (settle === 'resolve') pending.resolve(statusResponse('connected', 'Connected.'));
        else pending.reject(new Error('Status check failed later.'));
        await flushMessages();

        expect(row.dataset.state).toBe('error');
        expect(label.textContent).toBe('The action timed out. Check your tabs before trying again.');
    });

    it.each(['resolve', 'reject'])('disposes its row and listener and ignores a late status %s', async (settle) => {
        const before = SpotlightMessageClient.errorListeners.size;
        const pending = deferred();
        runtime.sendMessage.mockReturnValueOnce(pending.promise);
        const { surface, row, label } = mount();
        expect(SpotlightMessageClient.errorListeners.size).toBe(before + 1);
        surface.dispose();
        expect(parent.contains(row)).toBe(false);
        expect(SpotlightMessageClient.errorListeners.size).toBe(before);
        SpotlightMessageClient.reportError('This should not reach a disposed view.');
        if (settle === 'resolve') pending.resolve(statusResponse('connected', 'Connected.'));
        else pending.reject(new Error('Late rejection.'));
        await flushMessages();
        expect(label.textContent).toBe('Checking Arcify connection…');
        expect(row.dataset.state).toBeUndefined();
    });

    it('shows a generic error for a rejected initial request', async () => {
        runtime.sendMessage.mockRejectedValueOnce(new Error('Extension context invalidated.'));
        const { row, label } = mount();
        await flushMessages();
        expect(row.dataset.state).toBe('error');
        expect(label.textContent).toBe('Could not check the Arcify connection.');
    });

    it.each([
        [undefined, 'Could not check the Arcify connection.'],
        [{ success: false }, 'Could not check the Arcify connection.'],
        [{ success: false, error: 'Invalid companion ID.' }, 'Invalid companion ID.'],
        [{ success: true }, 'Could not check the Arcify connection.']
    ])('handles a missing or unsuccessful initial response (%j)', async (response, expected) => {
        runtime.sendMessage.mockResolvedValueOnce(response);
        const { row, label } = mount();
        await flushMessages();
        expect(row.dataset.state).toBe('error');
        expect(label.textContent).toBe(expected);
    });
});

describe('action errors retain their recovery guidance', () => {
let status;
afterEach(() => { status?.dispose(); document.body.replaceChildren(); vi.unstubAllGlobals(); });
function mount(response = Promise.resolve({success:true,status:{status:'connected',message:'Connected'}})) {
    vi.stubGlobal('chrome',{runtime:{sendMessage:vi.fn(() => response)}});
    status = mountBridgeStatus(document.body);
    return document.querySelector('.arcify-bridge-status');
}
    it('keeps a revoked sidebar action error when a later passive result refresh fails', async () => {
        const row = mount(); await Promise.resolve();
        status.showError('This extension is not paired. Use the Arcify toolbar button.');
        SpotlightMessageClient.reportError('This extension is not paired with Arcify.');
        expect(row.dataset.state).toBe('error');
        expect(row.textContent).toContain('toolbar button');
    });
    it('lets a later explicit action error replace the earlier failure', () => {
        const row = mount(); status.showError('First action'); status.showError('Second action');
        expect(row.textContent).toContain('Second action');
    });
    it('allows passive errors normally and after a confirmed action success', () => {
        const row = mount(); SpotlightMessageClient.reportError('Fresh snapshot failed');
        expect(row.textContent).toContain('Fresh snapshot failed');
        status.showError('Action failed'); status.showSuccess('Arcify sidebar opened.');
        expect(row.dataset.state).toBe('connected');
        SpotlightMessageClient.reportError('Later snapshot failed');
        expect(row.textContent).toContain('Later snapshot failed');
    });
    it('does not let delayed initial status overwrite a user action failure', async () => {
        let finish; const row = mount(new Promise(resolve => { finish=resolve; }));
        status.showError('Use the toolbar'); finish({success:true,status:{status:'connected',message:'Connected'}});
        await Promise.resolve(); expect(row.textContent).toContain('Use the toolbar');
    });
    it('removes its passive listener when disposed', () => {
        const row=mount(); status.dispose(); SpotlightMessageClient.reportError('late error');
        expect(row.isConnected).toBe(false); expect(row.textContent).not.toContain('late error');
    });
    it.each(['rejected','missing','failed-response'])('shows a later ordinary result failure after sidebar recovery (%s)', async outcome => {
        const row=mount(); await flushMessages(); status.showError('Use the old sidebar toolbar fallback.');
        const send=chrome.runtime.sendMessage;
        if(outcome === 'rejected') send.mockRejectedValueOnce(new Error('Transport failed'));
        else send.mockResolvedValueOnce(outcome === 'missing' ? undefined : {success:false,error:'The selected tab was closed.'});
        const response=await SpotlightMessageClient.handleResultDetailed({type:'open-tab'},'current-tab');
        expect(response.success).toBe(false);
        expect(row.textContent).not.toContain('old sidebar');
        expect(row.textContent).toContain(outcome === 'failed-response' ? 'selected tab was closed' : 'Check your tabs before trying again');
        SpotlightMessageClient.reportError('A later passive refresh failed.');
        expect(row.textContent).not.toContain('passive refresh');
    });

});
