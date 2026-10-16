import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const KEY = 'spotlightOptionsAppearance';
const BACKGROUNDS = { light: 'rgb(242, 245, 250)', dark: 'rgb(21, 25, 37)' };

/**
 * Import-safe hosted-browser acceptance helper. The caller supplies an already
 * authorized Puppeteer Browser with dist/ loaded in a disposable test profile.
 * This module never launches a browser or changes the OS appearance/permissions.
 * It restores its options preference and never submits a valid pairing change.
 */
export async function collectOptionsAppearanceEvidence({ browser, extensionId, outputDir }) {
    assert(browser?.newPage, 'An already running Puppeteer browser is required');
    assert(/^[a-p]{32}$/.test(extensionId), 'Use the actual loaded Spotlight extension ID');
    assert(outputDir, 'An evidence output directory is required');
    await mkdir(outputDir, { recursive: true });
    const url = `chrome-extension://${extensionId}/options.html`;
    const page = await browser.newPage();
    let secondPage;
    let original;
    let preferenceRead = false;
    const evidence = { screenshots: [], checks: [], states: [] };

    async function click(selector) {
        await page.bringToFront();
        await page.click(selector);
    }
    async function key(value) {
        await page.bringToFront();
        await page.keyboard.press(value);
    }
    async function chooseAppearance(value) {
        await click('#options-appearance');
        await key('Home');
        for (let index = 0; index < ['system', 'light', 'dark'].indexOf(value); index++) await key('ArrowDown');
        await key('Enter');
    }
    async function typePeerId(value) {
        await click('#arcify-peer-id');
        const modifier = await page.evaluate(() => /Mac/.test(navigator.platform) ? 'Meta' : 'Control');
        await page.bringToFront();
        await page.keyboard.down(modifier);
        try { await key('A'); } finally { await page.keyboard.up(modifier); }
        await key('Backspace');
        await page.bringToFront();
        await page.keyboard.type(value);
    }
    async function device(appearance) {
        await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: appearance }]);
    }
    async function expectAppearance(preference, resolved) {
        await page.waitForFunction((preference, background) => {
            const root = document.documentElement;
            return root.dataset.appearance === preference &&
                document.getElementById('options-appearance')?.value === preference &&
                getComputedStyle(root).backgroundColor === background;
        }, { polling: 100 }, preference, BACKGROUNDS[resolved]);
        const state = await page.evaluate(() => {
            const root = getComputedStyle(document.documentElement);
            const sample = selector => {
                const element = document.querySelector(selector);
                const style = getComputedStyle(element);
                return { background: style.backgroundColor, color: style.color, border: style.borderColor };
            };
            return {
                preference: document.documentElement.dataset.appearance,
                colorScheme: root.colorScheme,
                background: root.backgroundColor,
                color: root.color,
                card: sample('.card'), select: sample('#options-appearance'),
                input: sample('#arcify-peer-id'), readonly: sample('#spotlight-extension-id'),
                primaryButton: sample('#save-connection'), secondaryButton: sample('#refresh-connection'),
                hint: sample('.hint'), status: sample('#connection-status')
            };
        });
        assert.equal(state.colorScheme, resolved, 'Native controls must use the resolved appearance');
        evidence.states.push(state);
    }
    async function capture(name) {
        const filename = `spotlight-options-${name}.png`;
        await page.bringToFront();
        await page.screenshot({ path: path.join(outputDir, filename), fullPage: true });
        evidence.screenshots.push(filename);
    }

    try {
        await page.setViewport({ width: 1100, height: 900, deviceScaleFactor: 1 });
        await device('dark');
        await page.goto(url, { waitUntil: 'networkidle0' });
        original = await page.evaluate(key => localStorage.getItem(key), KEY);
        preferenceRead = true;
        await page.evaluate(key => localStorage.removeItem(key), KEY);
        await page.reload({ waitUntil: 'networkidle0' });
        await expectAppearance('system', 'dark');
        await capture('system-dark');
        evidence.checks.push('No saved preference defaults to System on a dark device');

        // No navigation: the CSS media query must react while the page is open.
        await device('light');
        await expectAppearance('system', 'light');
        await capture('system-light');
        evidence.checks.push('System follows a live dark-to-light device change');

        await chooseAppearance('dark');
        await expectAppearance('dark', 'dark');
        await page.reload({ waitUntil: 'networkidle0' });
        await expectAppearance('dark', 'dark');
        assert.equal(await page.evaluate(key => localStorage.getItem(key), KEY), 'dark');
        await capture('explicit-dark-on-light-device');
        evidence.checks.push('Explicit Dark overrides a light device and survives reload');

        await device('dark');
        await chooseAppearance('light');
        await expectAppearance('light', 'light');
        await page.reload({ waitUntil: 'networkidle0' });
        await expectAppearance('light', 'light');
        assert.equal(await page.evaluate(key => localStorage.getItem(key), KEY), 'light');
        await capture('explicit-light-on-dark-device');
        evidence.checks.push('Explicit Light overrides a dark device and survives reload');

        secondPage = await browser.newPage();
        await secondPage.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
        await secondPage.goto(url, { waitUntil: 'networkidle0' });
        await chooseAppearance('system');
        await expectAppearance('system', 'dark');
        await secondPage.waitForFunction(() => document.documentElement.dataset.appearance === 'system' && document.getElementById('options-appearance').value === 'system', { polling: 100 });
        await page.reload({ waitUntil: 'networkidle0' });
        await expectAppearance('system', 'dark');
        evidence.checks.push('Returning to System persists and synchronizes another open options page');

        // Exercise the actual invalid-ID flow without sending a configuration.
        await page.waitForSelector('#bridge-settings-form[aria-busy="false"]');
        const peerBefore = await page.$eval('#arcify-peer-id', input => input.value);
        await typePeerId('invalid');
        await click('#save-connection');
        await page.waitForSelector('#arcify-peer-id[aria-invalid="true"]');
        await capture('dark-validation-focus');
        await chooseAppearance('light');
        await expectAppearance('light', 'light');
        assert.equal(await page.$eval('#arcify-peer-id', input => input.value), 'invalid');
        assert.equal(await page.$eval('#connection-status', status => status.dataset.state), 'error');
        await capture('light-validation');
        await typePeerId(peerBefore);
        evidence.checks.push('Validation notices remain themed and appearance changes preserve unsaved pairing input');

        await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
        await chooseAppearance('system');
        await expectAppearance('system', 'dark');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Mobile layout must not overflow');
        await capture('mobile-system-dark');
        evidence.checks.push('Mobile controls remain inside the viewport');
        await writeFile(path.join(outputDir, 'spotlight-options-appearance.json'), `${JSON.stringify(evidence, null, 2)}\n`);
        return evidence;
    } finally {
        try {
            if (preferenceRead && !page.isClosed()) {
                await page.evaluate((key, value) => {
                    if (value === null) localStorage.removeItem(key);
                    else localStorage.setItem(key, value);
                }, KEY, original);
            }
        } finally {
            if (secondPage) await secondPage.close();
            await page.close();
        }
    }
}
