import { vi } from 'vitest';

/**
 * Chrome API mock scaffolding for unit tests
 * Each method is a vi.fn() that returns a resolved Promise with empty/default data
 */

// Private listener storage for runtime.onMessage
let runtimeMessageListeners = [];
let externalMessageListeners = [];

export const chromeMock = {
  tabs: {
    query: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockResolvedValue({}),
    create: vi.fn().mockResolvedValue({ id: 1 }),
    get: vi.fn().mockResolvedValue({}),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    group: vi.fn().mockResolvedValue(1),
    onActivated: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    },
    onRemoved: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    }
  },

  commands: {
    onCommand: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    }
  },

  storage: {
    local: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined)
    },
    sync: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined)
    },
    onChanged: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    }
  },

  bookmarks: {
    search: vi.fn().mockResolvedValue([]),
    getChildren: vi.fn().mockResolvedValue([]),
    getSubTree: vi.fn().mockResolvedValue([]),
    getTree: vi.fn().mockResolvedValue([]),
    remove: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue({}),
    onCreated: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    },
    onRemoved: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    },
    onMoved: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    },
    onChanged: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    },
    onImportBegan: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    },
    onImportEnded: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    }
  },

  history: {
    search: vi.fn().mockResolvedValue([])
  },

  runtime: {
    id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    openOptionsPage: vi.fn().mockResolvedValue(undefined),
    onMessageExternal: {
      addListener: vi.fn(callback => externalMessageListeners.push(callback)),
      callListeners: (message, sender = {}, sendResponse = vi.fn()) => {
        let asyncResponse = false;
        for (const listener of externalMessageListeners) if (listener(message, sender, sendResponse) === true) asyncResponse = true;
        return { asyncResponse, sendResponse };
      }
    },
    sendMessage: vi.fn().mockResolvedValue(undefined),
    onMessage: {
      addListener: vi.fn((callback) => {
        runtimeMessageListeners.push(callback);
      }),
      removeListener: vi.fn((callback) => {
        const idx = runtimeMessageListeners.indexOf(callback);
        if (idx > -1) runtimeMessageListeners.splice(idx, 1);
      }),
      hasListener: vi.fn((callback) => runtimeMessageListeners.includes(callback)),
      hasListeners: vi.fn(() => runtimeMessageListeners.length > 0),
      callListeners: (message, sender = {}, sendResponse = vi.fn()) => {
        let asyncResponse = false;
        for (const listener of runtimeMessageListeners) {
          const result = listener(message, sender, sendResponse);
          if (result === true) asyncResponse = true;
        }
        return { asyncResponse, sendResponse };
      },
      clearListeners: () => {
        runtimeMessageListeners = [];
      }
    },
    onInstalled: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    },
    getURL: vi.fn((path) => `chrome-extension://mock-id/${path}`)
  },

  tabGroups: {
    get: vi.fn().mockResolvedValue({ color: 'grey', title: '' }),
    query: vi.fn().mockResolvedValue([]),
    TAB_GROUP_ID_NONE: -1
  },

  windows: {
    get: vi.fn().mockImplementation(async id => ({ id })),
    getLastFocused: vi.fn().mockResolvedValue({ id: 1 }),
    update: vi.fn().mockResolvedValue({}),
    getCurrent: vi.fn().mockResolvedValue({ id: 1 })
  },

  search: {
    query: vi.fn().mockResolvedValue(undefined)
  },

  topSites: {
    get: vi.fn().mockResolvedValue([])
  }
};

/**
 * Reset all Chrome API mocks to their initial state
 */
export function resetChromeMocks() {
  chromeMock.tabs.query.mockClear().mockResolvedValue([]);
  chromeMock.tabs.update.mockClear().mockResolvedValue({});
  chromeMock.tabs.create.mockClear().mockResolvedValue({ id: 1 });
  chromeMock.tabs.get.mockClear().mockResolvedValue({});
  chromeMock.tabs.sendMessage.mockClear().mockResolvedValue(undefined);
  chromeMock.tabs.group.mockClear().mockResolvedValue(1);
  chromeMock.tabs.onActivated.addListener.mockClear();
  chromeMock.tabs.onActivated.removeListener.mockClear();
  chromeMock.tabs.onRemoved.addListener.mockClear();
  chromeMock.tabs.onRemoved.removeListener.mockClear();

  chromeMock.commands.onCommand.addListener.mockClear();
  chromeMock.commands.onCommand.removeListener.mockClear();

  chromeMock.storage.local.get.mockClear().mockResolvedValue({});
  chromeMock.storage.local.set.mockClear().mockResolvedValue(undefined);
  chromeMock.storage.local.remove.mockClear().mockResolvedValue(undefined);
  chromeMock.storage.sync.get.mockClear().mockResolvedValue({});
  chromeMock.storage.sync.set.mockClear().mockResolvedValue(undefined);
  chromeMock.storage.onChanged.addListener.mockClear();
  chromeMock.storage.onChanged.removeListener.mockClear();

  chromeMock.bookmarks.search.mockClear().mockResolvedValue([]);
  chromeMock.bookmarks.getChildren.mockClear().mockResolvedValue([]);
  chromeMock.bookmarks.getSubTree.mockClear().mockResolvedValue([]);
  chromeMock.bookmarks.getTree.mockClear().mockResolvedValue([]);
  chromeMock.bookmarks.remove.mockClear().mockResolvedValue(undefined);
  chromeMock.bookmarks.update.mockClear().mockResolvedValue({});
  chromeMock.bookmarks.onCreated.addListener.mockClear();
  chromeMock.bookmarks.onCreated.removeListener.mockClear();
  chromeMock.bookmarks.onRemoved.addListener.mockClear();
  chromeMock.bookmarks.onRemoved.removeListener.mockClear();
  chromeMock.bookmarks.onMoved.addListener.mockClear();
  chromeMock.bookmarks.onMoved.removeListener.mockClear();
  chromeMock.bookmarks.onChanged.addListener.mockClear();
  chromeMock.bookmarks.onChanged.removeListener.mockClear();
  chromeMock.bookmarks.onImportBegan.addListener.mockClear();
  chromeMock.bookmarks.onImportBegan.removeListener.mockClear();
  chromeMock.bookmarks.onImportEnded.addListener.mockClear();
  chromeMock.bookmarks.onImportEnded.removeListener.mockClear();

  chromeMock.history.search.mockClear().mockResolvedValue([]);

  chromeMock.runtime.openOptionsPage.mockClear();
  chromeMock.runtime.onMessageExternal.addListener.mockClear();
  externalMessageListeners = [];
  chromeMock.runtime.sendMessage.mockClear().mockResolvedValue(undefined);
  chromeMock.runtime.onInstalled.addListener.mockClear();
  chromeMock.runtime.onInstalled.removeListener.mockClear();
  chromeMock.runtime.onMessage.addListener.mockClear();
  chromeMock.runtime.onMessage.removeListener.mockClear();
  chromeMock.runtime.onMessage.hasListener.mockClear();
  chromeMock.runtime.onMessage.hasListeners.mockClear();
  runtimeMessageListeners = [];

  chromeMock.tabGroups.get.mockClear().mockResolvedValue({ color: 'grey', title: '' });
  chromeMock.tabGroups.query.mockClear().mockResolvedValue([]);

  chromeMock.windows.get.mockClear().mockImplementation(async id => ({ id }));
  chromeMock.windows.getLastFocused.mockClear().mockResolvedValue({ id: 1 });
  chromeMock.windows.update.mockClear().mockResolvedValue({});
  chromeMock.windows.getCurrent.mockClear().mockResolvedValue({ id: 1 });

  chromeMock.search.query.mockClear().mockResolvedValue(undefined);
  chromeMock.topSites.get.mockClear().mockResolvedValue([]);
}
