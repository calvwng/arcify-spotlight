// test/integration/setup.js
// Integration test setup - uses REAL timers (per user decision)
// This is different from unit test setup which uses fake timers
import { beforeEach, afterEach, vi } from 'vitest';
import { chromeMock, resetChromeMocks } from '../mocks/chrome.js';

// IMPORTANT: Do NOT call vi.useFakeTimers() here
// Integration tests use real timers for realistic behavior

// Set global chrome mock
globalThis.chrome = chromeMock;

// Reset state between tests
beforeEach(() => {
  resetChromeMocks();
  // Integration coverage must not race the production 3s autocomplete timeout.
  // Autocomplete response parsing and failure paths have their own unit coverage.
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ['', []] }));
  vi.resetModules(); // Clear module cache for fresh imports
});

afterEach(() => {
  vi.unstubAllGlobals();
  chromeMock.runtime.onMessage.clearListeners();
});
