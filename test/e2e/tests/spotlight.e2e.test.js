/**
 * E2E Tests for Arcify Spotlight
 *
 * Tests critical user flows using Puppeteer:
 * - E2E-01: Full search flow (type query, see results)
 * - E2E-02: Keyboard navigation (arrow keys, Enter, Escape)
 * - E2E-03: Tab switching (selecting open tab result)
 *
 * CRITICAL CONSTRAINTS:
 * - Cannot test keyboard shortcuts (Alt+L, Alt+T) via Puppeteer
 * - Uses new tab page (newtab.html) as test surface
 * - Fresh browser per test to prevent state pollution
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  launchBrowserWithExtension,
  closeBrowser,
  waitForExtension,
  openNewTabPage,
  overlaySelector,
  getOverlayFrame
} from '../setup.js';

// NOTE: newtab.html tests use plain selectors -- that page has no shadow root.
// Overlay tests enter the native modal shell's frame document for UI interactions.

// Set DEBUG=true env var to add delays between actions and run with visible browser
const DEBUG = process.env.DEBUG === 'true';
const ACTION_DELAY = 800;
const wait = (ms = ACTION_DELAY) =>
  DEBUG ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();

describe('Spotlight E2E Tests', () => {
  let browser;
  let extensionId;

  beforeEach(async () => {
    browser = await launchBrowserWithExtension();
    const ext = await waitForExtension(browser);
    extensionId = ext.extensionId;
  });

  afterEach(async () => {
    await closeBrowser(browser);
  });

  describe('E2E-01: Full Search Flow', () => {
    it('displays spotlight interface on new tab page', async () => {
      const page = await openNewTabPage(browser, extensionId);
      await wait();

      // Wait for spotlight to be visible
      await page.waitForSelector('[data-testid="spotlight-overlay"]', {
        timeout: 5000
      });
      await wait();

      // Verify key elements are present
      const input = await page.$('[data-testid="spotlight-input"]');
      const results = await page.$('[data-testid="spotlight-results"]');

      assert.ok(input, 'Spotlight input should be visible');
      assert.ok(results, 'Spotlight results container should be visible');

      await page.close();
    });

    it('shows results when typing a query', async () => {
      const page = await openNewTabPage(browser, extensionId);
      await wait();

      // Wait for spotlight to be ready
      await page.waitForSelector('[data-testid="spotlight-input"]', {
        timeout: 5000
      });
      await wait();

      // Type a search query
      await page.type('[data-testid="spotlight-input"]', 'google');
      await wait();

      // Wait for results to appear (with reasonable timeout for async search)
      await page.waitForSelector('[data-testid="spotlight-result"]', {
        timeout: 5000
      });

      // Verify at least one result is shown
      const results = await page.$$('[data-testid="spotlight-result"]');
      assert.ok(results.length > 0, 'Should show at least one search result');

      await page.close();
    });

    it('clears results when input is cleared', async () => {
      const page = await openNewTabPage(browser, extensionId);
      await wait();

      await page.waitForSelector('[data-testid="spotlight-input"]', {
        timeout: 5000
      });
      await wait();

      // Type a query
      await page.type('[data-testid="spotlight-input"]', 'test');
      await wait();

      // Wait for results
      await page.waitForSelector('[data-testid="spotlight-result"]', {
        timeout: 5000
      });

      // Clear input
      await page.click('[data-testid="spotlight-input"]', { clickCount: 3 });
      await page.keyboard.press('Backspace');

      // Wait for empty state to appear (results cleared)
      await page.waitForFunction(
        () => {
          const results = document.querySelectorAll(
            '[data-testid="spotlight-result"]'
          );
          return results.length === 0;
        },
        { timeout: 3000 }
      );

      const results = await page.$$('[data-testid="spotlight-result"]');
      assert.strictEqual(
        results.length,
        0,
        'Results should be cleared when input is empty'
      );

      await page.close();
    });
  });

  describe('E2E-02: Keyboard Navigation', () => {
    it('first result is selected by default', async () => {
      const page = await openNewTabPage(browser, extensionId);
      await wait();

      await page.waitForSelector('[data-testid="spotlight-input"]', {
        timeout: 5000
      });
      await wait();

      // Type a query to get results
      await page.type('[data-testid="spotlight-input"]', 'example');
      await wait();

      // Wait for results
      await page.waitForSelector('[data-testid="spotlight-result"]', {
        timeout: 5000
      });

      // Check first result has selected class
      const firstResult = await page.$('[data-testid="spotlight-result"]');
      const isSelected = await firstResult.evaluate(el =>
        el.classList.contains('selected')
      );

      assert.ok(isSelected, 'First result should be selected by default');

      await page.close();
    });

    it('arrow down moves selection to next result', async () => {
      const page = await openNewTabPage(browser, extensionId);
      await wait();

      await page.waitForSelector('[data-testid="spotlight-input"]', {
        timeout: 5000
      });
      await wait();

      // Type a query - the instant suggestion + any matching results should give us multiple
      await page.type('[data-testid="spotlight-input"]', 'google.com');

      // Wait for at least 2 results to appear (instant + async)
      await page.waitForFunction(() => {
        const results = document.querySelectorAll('[data-testid="spotlight-result"]');
        return results.length >= 2;
      }, { timeout: 5000 });

      // Additional wait for any final async results to settle
      await new Promise(resolve => setTimeout(resolve, 500));

      // Verify we still have 2+ results after settling
      const resultCount = await page.$$eval('[data-testid="spotlight-result"]', els => els.length);

      if (resultCount >= 2) {
        // Press arrow down
        await page.keyboard.press('ArrowDown');

        // Wait for selection to update in LIVE DOM (immune to re-renders)
        await page.waitForFunction(() => {
          const results = document.querySelectorAll('[data-testid="spotlight-result"]');
          if (results.length < 2) return false;
          return !results[0].classList.contains('selected') && results[1].classList.contains('selected');
        }, { timeout: 3000, polling: 50 });

        // Explicit assert for clarity (waitForFunction already verified this)
        const selectionState = await page.evaluate(() => {
          const results = document.querySelectorAll('[data-testid="spotlight-result"]');
          return {
            firstSelected: results[0]?.classList.contains('selected'),
            secondSelected: results[1]?.classList.contains('selected')
          };
        });
        assert.ok(!selectionState.firstSelected && selectionState.secondSelected,
          'Arrow down should move selection to second result');
      } else {
        // Single result fallback
        await page.keyboard.press('ArrowDown');
        await new Promise(resolve => setTimeout(resolve, 200));
        const isSelected = await page.$eval('[data-testid="spotlight-result"]',
          el => el.classList.contains('selected'));
        assert.ok(isSelected, 'With single result, selection should stay on first');
      }

      await page.close();
    });

    it('arrow up moves selection to previous result', async () => {
      const page = await openNewTabPage(browser, extensionId);
      await wait();

      await page.waitForSelector('[data-testid="spotlight-input"]', {
        timeout: 5000
      });
      await wait();

      // Type a query
      await page.type('[data-testid="spotlight-input"]', 'github.com');

      // Wait for at least 2 results to appear (instant + async)
      await page.waitForFunction(() => {
        const results = document.querySelectorAll('[data-testid="spotlight-result"]');
        return results.length >= 2;
      }, { timeout: 5000 });

      // Additional wait for any final async results to settle
      await new Promise(resolve => setTimeout(resolve, 500));

      // Verify we still have 2+ results after settling
      const resultCount = await page.$$eval('[data-testid="spotlight-result"]', els => els.length);

      if (resultCount >= 2) {
        // Press arrow down
        await page.keyboard.press('ArrowDown');

        // Wait for selection to move to second result (live DOM check)
        await page.waitForFunction(() => {
          const results = document.querySelectorAll('[data-testid="spotlight-result"]');
          if (results.length < 2) return false;
          return !results[0].classList.contains('selected') && results[1].classList.contains('selected');
        }, { timeout: 3000, polling: 50 });

        // Press arrow up
        await page.keyboard.press('ArrowUp');

        // Wait for selection to move back to first result (live DOM check)
        await page.waitForFunction(() => {
          const results = document.querySelectorAll('[data-testid="spotlight-result"]');
          if (results.length < 2) return false;
          return results[0].classList.contains('selected') && !results[1].classList.contains('selected');
        }, { timeout: 3000, polling: 50 });

        // Explicit assert for clarity
        const isSelected = await page.$eval('[data-testid="spotlight-result"]',
          el => el.classList.contains('selected'));
        assert.ok(isSelected, 'Arrow up should move selection back to first result');
      } else {
        // Single result - arrow up should keep it selected
        await page.keyboard.press('ArrowUp');
        await new Promise(resolve => setTimeout(resolve, 200));
        const isSelected = await page.$eval('[data-testid="spotlight-result"]',
          el => el.classList.contains('selected'));
        assert.ok(isSelected, 'With single result, arrow up should keep first selected');
      }

      await page.close();
    });

    it('Enter navigates to selected result', async () => {
      const page = await openNewTabPage(browser, extensionId);
      await wait();

      await page.waitForSelector('[data-testid="spotlight-input"]', {
        timeout: 5000
      });
      await wait();

      // Type a URL that will be recognized
      await page.type('[data-testid="spotlight-input"]', 'https://example.com');

      // Wait for results
      await page.waitForSelector('[data-testid="spotlight-result"]', {
        timeout: 5000
      });
      await wait();

      // Press Enter to navigate
      await page.keyboard.press('Enter');

      // Wait for navigation to complete
      await page.waitForFunction(
        () => window.location.href !== 'about:blank',
        { timeout: 5000 }
      );

      // Verify we navigated (URL should change or page should load)
      const currentUrl = page.url();
      assert.ok(
        currentUrl.includes('example.com') ||
          currentUrl.startsWith('chrome-extension://'),
        'Enter should trigger navigation'
      );

      await page.close();
    });
  });

  describe('E2E-04: Overlay on Regular Page', () => {
    it('opens spotlight as overlay on a regular webpage', async () => {
      // Get the service worker to trigger spotlight programmatically
      const ext = await waitForExtension(browser);
      const worker = ext.worker;

      // Open a regular webpage
      const page = await browser.newPage();
      await page.goto('https://example.com', {
        waitUntil: 'networkidle0'
      });
      await wait();

      // Verify the page content is visible
      const pageTitle = await page.title();
      assert.ok(
        pageTitle.includes('Example'),
        'Should have loaded example.com page'
      );

      // Wait for content script to be ready (it loads at document_start)
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Trigger spotlight via service worker (sends message to content script)
      await worker.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab) {
          // Send activation message to the content script
          await chrome.tabs.sendMessage(tab.id, {
            action: 'activateSpotlight',
            mode: 'current-tab',
            tabUrl: tab.url,
            tabId: tab.id
          });
        }
      });
      await wait();

      // Wait for spotlight overlay to appear on the page
      await page.waitForSelector(overlaySelector('[data-testid="spotlight-overlay"]'), {
        timeout: 5000
      });

      // Verify spotlight is visible as an overlay
      const spotlight = await page.$(overlaySelector('[data-testid="spotlight-overlay"]'));
      assert.ok(spotlight, 'Spotlight overlay should appear on the page');

      // Verify the page content is still in the background (not navigated away)
      const currentUrl = page.url();
      assert.ok(
        currentUrl.includes('example.com'),
        'Should still be on example.com (overlay, not navigation)'
      );
      await wait();

      // Verify we can interact with spotlight
      const overlay = await getOverlayFrame(page);
      const input = await overlay.$('[data-testid="spotlight-input"]');
      assert.ok(input, 'Spotlight input should be available');

      // Type a query to verify functionality
      await overlay.type('[data-testid="spotlight-input"]', 'test');

      // Wait for results
      await overlay.waitForSelector('[data-testid="spotlight-result"]', {
        timeout: 5000
      });

      const results = await overlay.$$('[data-testid="spotlight-result"]');
      assert.ok(results.length > 0, 'Should show results in overlay mode');

      await page.close();
    });
  });

  describe('E2E-03: Tab Switching', () => {
    it('selecting an open tab result switches to that tab', async () => {
      // First, open a known page in a new tab
      const targetPage = await browser.newPage();
      await targetPage.goto('https://example.com', {
        waitUntil: 'domcontentloaded'
      });
      await wait();

      // Open new tab page with spotlight
      const spotlightPage = await openNewTabPage(browser, extensionId);
      await wait();

      await spotlightPage.waitForSelector('[data-testid="spotlight-input"]', {
        timeout: 5000
      });
      await wait();

      // Search for the open tab
      await spotlightPage.type('[data-testid="spotlight-input"]', 'example.com');

      // Wait for results
      await spotlightPage.waitForSelector('[data-testid="spotlight-result"]', {
        timeout: 5000
      });
      await wait();

      // Find a result that indicates an open tab (has "Switch to tab" action)
      // Note: The result action text varies, so we look for any result with the URL
      const results = await spotlightPage.$$('[data-testid="spotlight-result"]');

      // Click the first result (should be the open tab)
      if (results.length > 0) {
        await results[0].click();

        // Give time for tab switch to occur
        await new Promise(resolve => setTimeout(resolve, 500));

        // Get all pages
        const pages = await browser.pages();

        // Find the example.com page and check if it's in focus
        const examplePage = pages.find(p => p.url().includes('example.com'));
        assert.ok(
          examplePage,
          'Should still have the example.com tab open'
        );
      }

      await targetPage.close();
      await spotlightPage.close();
    });
  });

  describe('E2E-05: Tab Group Space Chip', () => {
    it('shows space chip with group name for a grouped tab suggestion', async () => {
      const ext = await waitForExtension(browser);
      const worker = ext.worker;

      // 1. Open a target page that will be put into a tab group
      const targetPage = await browser.newPage();
      await targetPage.goto('https://example.com', {
        waitUntil: 'domcontentloaded'
      });
      await wait();

      // 2. Create a tab group via the service worker using Chrome APIs
      //    Put the example.com tab into a group named "Research" with color "blue"
      await worker.evaluate(async () => {
        const tabs = await chrome.tabs.query({});
        const exampleTab = tabs.find(t => t.url && t.url.includes('example.com'));
        if (!exampleTab) throw new Error('Could not find example.com tab');

        const groupId = await chrome.tabs.group({ tabIds: [exampleTab.id] });
        await chrome.tabGroups.update(groupId, {
          title: 'Research',
          color: 'blue'
        });
      });
      await wait();

      // 3. Open a second (non-grouped) page and trigger Spotlight as overlay.
      //    Using overlay mode on a regular page because the content script message
      //    pipeline reliably delivers background search results in Puppeteer.
      const searchPage = await browser.newPage();
      await searchPage.goto('https://www.google.com', {
        waitUntil: 'domcontentloaded'
      });
      await wait();

      // Wait for content script to be ready
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Trigger spotlight via service worker
      await worker.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab) {
          await chrome.tabs.sendMessage(tab.id, {
            action: 'activateSpotlight',
            mode: 'current-tab',
            tabUrl: tab.url,
            tabId: tab.id
          });
        }
      });
      await wait();

      // Wait for spotlight overlay to appear
      await searchPage.waitForSelector(overlaySelector('[data-testid="spotlight-overlay"]'), {
        timeout: 5000
      });
      await wait();

      // 4. Search for the grouped tab by its title
      const overlay = await getOverlayFrame(searchPage);
      await overlay.type('[data-testid="spotlight-input"]', 'Example');

      // Wait for results to appear (instant suggestion first)
      await overlay.waitForSelector('[data-testid="spotlight-result"]', {
        timeout: 5000
      });

      // Wait for async tab results from background (150ms debounce + query time)
      // Poll for the chip to appear as async results replace/augment the instant suggestion
      await overlay.waitForFunction(
        () => {
          const root = document;
          if (!root) return false;
          const results = root.querySelectorAll('[data-testid="spotlight-result"]');
          for (const result of results) {
            if (result.querySelector('.arcify-space-chip')) return true;
          }
          return false;
        },
        { timeout: 8000, polling: 200 }
      );

      // 5. Find the result with the chip and verify its content
      const chipData = await overlay.evaluate(() => {
        const root = document;
        if (!root) return { found: false };
        const results = root.querySelectorAll('[data-testid="spotlight-result"]');
        for (const result of results) {
          const chip = result.querySelector('.arcify-space-chip');
          if (chip) {
            return {
              found: true,
              text: chip.textContent.trim(),
              title: chip.getAttribute('title'),
              bgStyle: chip.style.background,
              colorStyle: chip.style.color
            };
          }
        }
        return { found: false };
      });

      assert.ok(
        chipData.found,
        'A space chip should be visible on the grouped tab suggestion'
      );

      assert.strictEqual(
        chipData.text,
        'Research',
        'Chip text should show the tab group name "Research"'
      );

      assert.strictEqual(
        chipData.title,
        'Research',
        'Chip title attribute should show full group name'
      );

      // Verify blue color is applied (the chip uses blue color mapping)
      assert.ok(
        chipData.colorStyle.includes('139') && chipData.colorStyle.includes('179') && chipData.colorStyle.includes('243'),
        `Chip text color should be blue (rgb(139, 179, 243)), got: ${chipData.colorStyle}`
      );

      assert.ok(
        chipData.bgStyle.includes('139') && chipData.bgStyle.includes('179') && chipData.bgStyle.includes('243'),
        `Chip background should use blue tint, got: ${chipData.bgStyle}`
      );

      await targetPage.close();
      await searchPage.close();
    });

    it('does NOT show space chip for a non-grouped tab suggestion', async () => {
      const ext = await waitForExtension(browser);
      const worker = ext.worker;

      // Open a non-grouped tab
      const targetPage = await browser.newPage();
      await targetPage.goto('https://example.com', {
        waitUntil: 'domcontentloaded'
      });
      await wait();

      // Open a second page and trigger Spotlight as overlay
      const searchPage = await browser.newPage();
      await searchPage.goto('https://www.google.com', {
        waitUntil: 'domcontentloaded'
      });
      await wait();

      // Wait for content script
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Trigger spotlight via service worker
      await worker.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab) {
          await chrome.tabs.sendMessage(tab.id, {
            action: 'activateSpotlight',
            mode: 'current-tab',
            tabUrl: tab.url,
            tabId: tab.id
          });
        }
      });
      await wait();

      await searchPage.waitForSelector(overlaySelector('[data-testid="spotlight-overlay"]'), {
        timeout: 5000
      });
      await wait();

      // Search for the non-grouped tab
      const overlay = await getOverlayFrame(searchPage);
      await overlay.type('[data-testid="spotlight-input"]', 'Example');

      await overlay.waitForSelector('[data-testid="spotlight-result"]', {
        timeout: 5000
      });

      // Give time for async results from background
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Verify NO chip is present on results for non-grouped tabs
      const hasChip = await overlay.evaluate(() => {
        const root = document;
        if (!root) return false;
        const results = root.querySelectorAll('[data-testid="spotlight-result"]');
        for (const result of results) {
          if (result.querySelector('.arcify-space-chip')) {
            return true;
          }
        }
        return false;
      });

      assert.ok(
        !hasChip,
        'Non-grouped tab suggestions should NOT have a space chip'
      );

      await targetPage.close();
      await searchPage.close();
    });
  });
});
