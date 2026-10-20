/** Closing a helper tab must never undo a switch to an empty workspace. */
export function shouldCloseNewTab(result, response) {
    if (!response?.success) return false;
    if (response.bridge) {
        return Number.isSafeInteger(response.tabId) && response.tabId > 0 &&
            Number.isSafeInteger(response.sourceTabId) && response.tabId !== response.sourceTabId;
    }
    return result.type === 'open-tab' || result.type === 'pinned-tab';
}
