/** Real Chromium only. Run in the approved extension CI environment, never in a
 * browser/profile whose managed policy forbids loading unpacked extensions. */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { launchBrowserWithExtension, closeBrowser, waitForExtension, getOverlayFrame, overlaySelector } from '../setup.js';

const inputSelector = '[data-testid="spotlight-input"]';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

describe('real overlay keyboard isolation under strict host CSP', () => {
    let server, browser, worker, url;
    before(async () => {
        server = createServer((request, response) => {
            response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'none'; frame-src 'none'; connect-src 'none'");
            if (request.url === '/host.js') {
                response.setHeader('Content-Type', 'text/javascript');
                response.end(`window.hostKeys = []; window.hostShortcuts = 0;
                    for (const target of [window, document]) for (const capture of [true, false]) {
                        for (const type of ['keydown', 'keypress', 'keyup']) target.addEventListener(type, event => {
                            window.hostKeys.push([type, event.key, capture]);
                            if (event.key === 'w' && event.target.tagName !== 'INPUT') {
                                window.hostShortcuts++; event.preventDefault();
                            }
                        }, capture);
                    }
                    window.hostReady = true;`);
            } else {
                response.setHeader('Content-Type', 'text/html');
                response.end('<!doctype html><html lang="en"><head><title>Host shortcuts</title><script src="/host.js"></script></head><body><button id="previous">Previously focused</button></body></html>');
            }
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        url = `http://127.0.0.1:${server.address().port}/`;
        browser = await launchBrowserWithExtension();
        ({ worker } = await waitForExtension(browser));
    });
    after(async () => {
        await closeBrowser(browser);
        if (server) await new Promise(resolve => server.close(resolve));
    });

    it('retains real w typing/editing, Tab/Escape, frame sizing, and host shortcuts after close/reopen', async () => {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 1000 });
        await page.goto(url, { waitUntil: 'load' });
        assert.equal(await page.evaluate(() => window.hostReady), true);
        const activate = async () => {
            const response = await worker.evaluate(async hostUrl => {
                const [tab] = await chrome.tabs.query({ url: hostUrl });
                return chrome.tabs.sendMessage(tab.id, { action: 'activateSpotlight', mode: 'new-tab', tabId: tab.id, tabUrl: tab.url });
            }, url);
            assert.deepEqual(response, { success: true, open: true });
            return getOverlayFrame(page);
        };
        for (let cycle = 0; cycle < 2; cycle++) {
            await page.click('#previous');
            await page.evaluate(() => { window.hostKeys = []; window.hostShortcuts = 0; });
            const overlay = await activate();
            assert.equal(await overlay.$eval(inputSelector, input => input === document.activeElement), true);
            await page.keyboard.type('window with w');
            assert.equal(await overlay.$eval(inputSelector, input => input.value), 'window with w');
            await page.keyboard.down('Shift'); await page.keyboard.press('Home'); await page.keyboard.up('Shift');
            assert.deepEqual(await overlay.$eval(inputSelector, input => [input.selectionStart, input.selectionEnd]), [0, 'window with w'.length]);
            await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.press('c'); await page.keyboard.up('Control');
            await page.keyboard.press('Backspace');
            await page.keyboard.down('Control'); await page.keyboard.press('v'); await page.keyboard.up('Control');
            assert.equal(await overlay.$eval(inputSelector, input => input.value), 'window with w');
            assert.deepEqual(await page.evaluate(() => window.hostKeys), []);
            assert.equal(await overlay.$eval('.arcify-spotlight-container', node => getComputedStyle(node).backgroundColor), 'rgb(45, 45, 45)');
            await pause(400);
            const initialHeight = await page.$eval(overlaySelector('iframe'), frame => frame.getBoundingClientRect().height);
            await overlay.evaluate(() => { const spacer = document.createElement('div'); spacer.id = 'resize-check'; spacer.style.height = '30px'; document.getElementById('arcify-spotlight-content').append(spacer); });
            await page.waitForFunction((selector, height) => document.querySelector(selector).shadowRoot.querySelector('iframe').getBoundingClientRect().height > height, {}, '#arcify-spotlight-host', initialHeight);
            await overlay.$eval('#resize-check', node => node.remove());
            await page.waitForFunction((selector, height) => document.querySelector(selector).shadowRoot.querySelector('iframe').getBoundingClientRect().height <= height + 1, {}, '#arcify-spotlight-host', initialHeight);
            await overlay.focus(inputSelector);
            await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
            assert.equal(await overlay.evaluate(() => document.activeElement.textContent), 'Connection settings');
            await page.keyboard.press('Tab');
            assert.equal(await overlay.$eval(inputSelector, input => input === document.activeElement), true);
            await page.keyboard.press('Tab');
            assert.equal(await overlay.evaluate(() => document.activeElement.tagName), 'BUTTON');
            await overlay.focus('.arcify-bridge-status button');
            await page.keyboard.press('Escape');
            await page.waitForFunction(() => !document.querySelector('#arcify-spotlight-host')?.shadowRoot.querySelector('dialog').open);
            assert.equal(await page.evaluate(() => document.activeElement.id), 'previous');
            await page.keyboard.press('w');
            assert.ok(await page.evaluate(() => window.hostShortcuts > 0));
            await pause(250);
            assert.equal(await page.$('#arcify-spotlight-host'), null);
        }
        await page.close();
    });
});
