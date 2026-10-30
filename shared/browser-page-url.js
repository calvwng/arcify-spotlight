/** Exact browser-page navigation boundary, shared verbatim by the paired builds. */
const SETTINGS_PATHS = new Set([
    '', '/', '/appearance', '/search', '/searchEngines', '/privacy', '/security',
    '/content', '/languages', '/downloads', '/accessibility', '/system', '/help'
]);
const ROOT_PAGES = new Set(['history', 'downloads', 'bookmarks', 'extensions', 'version', 'newtab', 'new-tab-page']);
export const isBrowserPageInput = value => typeof value === 'string' && /^(?:chrome|helium):/i.test(value);

// Helium's override-chrome-protocol.patch maps helium WebUI to chrome WebUI.
// Use the canonical tabs API address in both browsers. Do not repair malformed
// input or allow arbitrary WebUI commands (quit, restart, crash, flags, etc.).
export function normalizeBrowserPageUrl(value) {
    if (typeof value !== 'string' || value.length > 2048 || /[\s\\\x00-\x1f\x7f]/.test(value)) return null;
    const match = /^(chrome|helium):\/\/([a-z-]+)(\/[^?#]*)?(\?[^#]*)?$/i.exec(value);
    if (!match) return null;
    const host = match[2].toLowerCase(), path = match[3] || '', query = match[4] || '';
    if (host === 'settings') {
        if (!SETTINGS_PATHS.has(path) || query) return null;
    } else {
        if (!ROOT_PAGES.has(host) || !['', '/'].includes(path)) return null;
        // Existing saved-folder results use this exact bookmarks UI route.
        if (query && !(host === 'bookmarks' && /^\?id=\d{1,20}$/.test(query))) return null;
    }
    return `chrome://${host}${path}${query}`;
}
