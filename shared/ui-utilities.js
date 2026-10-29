import { SETTINGS_DEFINITION } from './spotlight-settings-action.js';
import { TRANSIENT_ACTION_DEFINITION } from './arcify-transient-actions-ui.js';
import { SPLIT_ACTION_DEFINITIONS } from './arcify-split-actions-ui.js';
import { archiveActionDefinition } from './arcify-archive-actions-ui.js';
import { tabActionDefinition } from './arcify-tab-actions-ui.js';
import { ACTION_DEFINITIONS } from './arcify-space-actions-ui.js';
/**
 * UI Utilities - Shared spotlight UI functions and formatting
 * 
 * Purpose: Provides consistent UI utilities, result formatting, and display helpers for spotlight components
 * Key Functions: URL detection/normalization, instant suggestions, result formatting, favicon handling, accent colors
 * Architecture: Static utility class with pure functions for UI operations
 * 
 * Critical Notes:
 * - Consolidates duplicate code from overlay.js, popup.js, and data providers
 * - Handles complex URL detection including chrome:// protocols and localhost
 * - Provides dynamic accent color CSS generation matching active space colors
 * - Central location for all spotlight display logic and formatting
 */

import { ResultType, SpotlightTabMode } from './search-types.js';
import { websiteNameExtractor } from './website-name-extractor.js';
import { BASE_SCORES } from './scoring-constants.js';
import { Utils } from '../utils.js';
import { Logger } from '../logger.js';
import { normalizeBrowserPageUrl } from './browser-page-url.js';

export class SpotlightUtils {
    // Helper to properly prefix URLs with protocol
    static normalizeURL(url) {
        const browserPage = normalizeBrowserPageUrl(url);
        if (browserPage !== null) return browserPage;
        // Return as-is if it already has a protocol (http, https, chrome, etc.)
        if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) {
            return url;
        }
        // Default to https for URLs without protocol
        return `https://${url}`;
    }

    // URL detection utility (consolidated from multiple files)
    static isURL(text) {
        // Check if it's already a complete URL
        try {
            new URL(text);
            return true;
        } catch {
            // Continue to other checks
        }

        // Check for domain-like patterns
        const domainPattern = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/;
        if (domainPattern.test(text)) {
            return true;
        }

        // Check for localhost
        if (text === 'localhost' || text.startsWith('localhost:')) {
            return true;
        }

        // Check for IP addresses
        if (/^(\d{1,3}\.){3}\d{1,3}(:\d+)?$/.test(text)) {
            const parts = text.split(':')[0].split('.');
            return parts.every(part => {
                const num = parseInt(part, 10);
                return num >= 0 && num <= 255;
            });
        }

        // Common URL patterns without protocol
        if (/^[a-zA-Z0-9-]+\.(com|org|net|edu|gov|mil|int|co|io|ly|me|tv|app|dev|ai)([/\?#].*)?$/.test(text)) {
            return true;
        }

        return false;
    }

    // Generate instant suggestion based on current input (consolidated from overlay.js and popup.js)
    static generateInstantSuggestion(query) {
        const trimmedQuery = query.trim();

        if (!trimmedQuery) {
            return null;
        }
        if (SpotlightUtils.isURL(trimmedQuery)) {
            // Create URL suggestion
            const url = SpotlightUtils.normalizeURL(trimmedQuery);
            const websiteName = SpotlightUtils.extractWebsiteName(url);
            return {
                type: ResultType.URL_SUGGESTION,
                title: websiteName,
                url: url,
                score: BASE_SCORES.INSTANT_URL_SUGGESTION, // Use centralized scoring
                metadata: { originalInput: trimmedQuery },
                domain: '',
                favicon: null
            };
        } else {
            // Create search suggestion  
            return {
                type: ResultType.SEARCH_QUERY,
                title: `Search for "${trimmedQuery}"`,
                url: '',
                score: BASE_SCORES.INSTANT_SEARCH_QUERY, // Use centralized scoring
                metadata: { query: trimmedQuery },
                domain: '',
                favicon: null
            };
        }
    }

    // Escape both text and quoted HTML attributes; textContent serialization alone
    // leaves quotes unescaped and is unsafe inside generated title attributes.
    static escapeHtml(text) {
        const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
        return String(text ?? '').replace(/[&<>"']/g, character => entities[character]);
    }

    // Extract website name from URL for better display
    static extractWebsiteName(url) {
        try {
            return websiteNameExtractor.extractWebsiteName(url);
        } catch (error) {
            Logger.error('[SpotlightUtils] Error extracting website name:', error);
            // Fallback to basic hostname parsing
            try {
                const normalizedUrl = SpotlightUtils.normalizeURL(url);
                const urlObj = new URL(normalizedUrl);
                let hostname = urlObj.hostname;

                // Remove www. prefix for cleaner display
                if (hostname.startsWith('www.')) {
                    hostname = hostname.substring(4);
                }

                // Capitalize first letter for better presentation
                return hostname.charAt(0).toUpperCase() + hostname.slice(1);
            } catch {
                // Final fallback to original URL
                return url;
            }
        }
    }

    // Get favicon URL with fallback (consolidated from overlay.js and popup.js)
    static getFaviconUrl(result) {
        if (['spotlight-settings-action', 'arcify-space-action', 'arcify-tab-action', 'arcify-archive-action', 'arcify-split-action', 'arcify-transient-action'].includes(result.type)) {
            const icon = result.type === 'spotlight-settings-action' ? 'settings' : result.type === 'arcify-transient-action' ? 'window' : result.type === 'arcify-split-action' ? 'split' : result.type === 'arcify-archive-action' ? 'archive' : result.type === 'arcify-tab-action' ? tabActionDefinition(result.metadata?.tabAction?.command, result.metadata?.tabAction?.scope?.context)?.icon : ACTION_DEFINITIONS[result.metadata?.spaceAction?.command]?.icon;
            const paths = {
                window: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18M6 7h1m2 0h1"/>',
                split: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',
                archive: '<rect x="3" y="3" width="18" height="5" rx="1"/><path d="M5 8v13h14V8M9 12h6"/>',
                rename: '<path d="m4 17 11-11 3 3-11 11H4Zm10-10 3 3M4 22h16"/>',
                link: '<path d="m10 14 4-4M9 17l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m3-1 2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0"/>',
                duplicate: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
                mute: '<path d="M4 9h4l5-4v14l-5-4H4Zm13 0 5 6m0-6-5 6"/>',
                space: '<rect x="3" y="4" width="7" height="16" rx="1"/><path d="M13 12h8m-3-3 3 3-3 3"/>',
                move: '<path d="M3 7V5h7l2 2h9v13H3Z"/><path d="M7 14h10m-3-3 3 3-3 3"/>',
                settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2"/><circle cx="12" cy="12" r="7"/>',
                folder: '<path d="M3 7V5h7l2 2h9v13H3Z"/><path d="M12 10v7m-3-3h6"/>',
                pin: '<path d="m9 3 6 0-1 6 4 4H6l4-4Zm3 10v8"/>',
                remove: '<path d="M4 7h16M9 7V3h6v4M6 7l1 14h10l1-14M10 10v7m4-7v7"/>'
            };
            return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#858585" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[icon] || paths.settings}</svg>`)}`;
        }
        if (result.type === 'arcify-sidebar-command') {
            // SVGs loaded through <img> cannot inherit the row's currentColor.
            // This neutral has at least 3.5:1 contrast on both the current
            // #2d2d2d surface and white, without depending on host-page theme.
            return `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#858585" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg>')}`;
        }
        if (result.type === ResultType.SAVED_FAVORITE) {
            return `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#858585" stroke-width="1.8" stroke-linejoin="round"><path d="m12 3 2.8 5.7 6.3.9-4.6 4.5 1.1 6.3-5.6-3-5.6 3 1.1-6.3L3 9.6l6.2-.9Z"/></svg>')}`;
        }
        if (result.favicon && result.favicon.startsWith('http')) {
            return result.favicon;
        }

        // Special handling for autocomplete suggestions
        if (result.type === ResultType.AUTOCOMPLETE_SUGGESTION) {
            if (result.metadata?.isUrl && result.url) {
                // For URL autocomplete suggestions, get the website favicon
                try {
                    return Utils.getFaviconUrl(result.url, "64");
                } catch {
                    // Fallback to search icon if URL parsing fails
                }
            }
            // For search autocomplete suggestions, use search icon
            return `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.35-4.35"></path></svg>')}`;
        }

        if (result.url) {
            try {
                return Utils.getFaviconUrl(result.url, "64");
            } catch {
                // Fallback for invalid URLs
            }
        }

        return `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.35-4.35"></path></svg>')}`;
    }

    // Format result for display (moved from SearchEngine and duplicated code)
    static formatResult(result, mode, activeGroupName = null) {
        if (result.type === 'spotlight-settings-action') return SETTINGS_DEFINITION;
        if (result.type === 'arcify-transient-action') return { ...TRANSIENT_ACTION_DEFINITION, subtitle: `${TRANSIENT_ACTION_DEFINITION.subtitle} • ${result.metadata?.transientAction?.url || ''}` };
        if (result.type === 'arcify-split-action') return SPLIT_ACTION_DEFINITIONS[result.metadata?.splitAction?.command] || { title: 'Unavailable Split action', subtitle: '', action: '' };
        if (result.type === 'arcify-archive-action') return archiveActionDefinition(result);
        if (result.type === 'arcify-tab-action') return tabActionDefinition(result.metadata?.tabAction?.command, result.metadata?.tabAction?.scope?.context) || { title: 'Unavailable tab action', subtitle: '', action: '' };
        if (result.type === 'arcify-space-action') {
            const definition = ACTION_DEFINITIONS[result.metadata?.spaceAction?.command];
            return definition || { title: 'Unavailable Arcify action', subtitle: '', action: '' };
        }
        if (result.type === 'arcify-sidebar-command') {
            return { title: 'Open Arcify sidebar', subtitle: 'Arcify sidebar • This tab stays open', action: 'Open Sidebar' };
        }
        if (result.metadata?.bookmarkFallback) {
            const saved = result.metadata.bookmarkFallback;
            return { title: result.title, subtitle: (result.metadata.savedBookmark ? 'Saved bookmarks: ' : 'Bookmarks: ') + saved.path,
                action: saved.folder ? 'View Folder' : 'Open Bookmark URL' };
        }
        const owner = result.metadata?.arcifyBridge;
        if (owner?.kind === 'remoteToday') return { title: result.title, subtitle: `${result.metadata.spaceName || 'Space'} · Window ${owner.ownerWindowId}`, action: 'Open in owning window' };
        if (owner) {
            const action = owner.kind === 'space' ? 'Switch Workspace'
                : owner.kind === 'bookmark' ? 'Open Pinned Tab'
                : owner.kind === 'favorite' ? (result.metadata.tabId ? 'Switch to Favorite' : 'Open Favorite') : 'Switch to Tab';
            return { title: result.title, subtitle: owner.kind === 'space' ? 'Arcify workspace'
                : owner.kind === 'favorite' ? `Saved Favorite • ${result.domain || result.url}` : result.domain, action };
        }

        const formatters = {
            [ResultType.URL_SUGGESTION]: {
                title: result.title,
                subtitle: result.url,
                action: '↵'
            },
            [ResultType.SEARCH_QUERY]: {
                title: result.title,
                subtitle: '',
                action: '↵'
            },
            [ResultType.AUTOCOMPLETE_SUGGESTION]: {
                title: result.title,
                subtitle: result.metadata?.isUrl ? result.url : '',
                action: '↵'
            },
            [ResultType.OPEN_TAB]: {
                title: result.title,
                subtitle: result.domain,
                action: result.metadata?.groupName
                    ? (result.metadata?.isArcify && result.metadata?.spaceName === result.metadata?.groupName
                        ? 'Open Pinned Tab' : 'Open Tab')
                    : (mode === SpotlightTabMode.NEW_TAB ? 'Switch to Tab' : '↵')
            },
            [ResultType.PINNED_TAB]: {
                title: result.title,
                subtitle: result.domain,
                action: 'Open Pinned Tab'
            },
            [ResultType.BOOKMARK]: {
                title: result.title,
                subtitle: result.domain,
                action: (result.metadata?.isArcify && result.metadata?.spaceName === activeGroupName)
                    ? 'Open Pinned Tab' : '↵'
            },
            [ResultType.HISTORY]: {
                title: result.title,
                subtitle: result.domain,
                action: '↵'
            },
            [ResultType.TOP_SITE]: {
                title: result.title,
                subtitle: result.domain,
                action: '↵'
            }
        };

        Logger.log('---- Formatting result type', result.type);

        return formatters[result.type] || {
            title: result.title,
            subtitle: result.url,
            action: '↵'
        };
    }

    // Helper function to convert hex color to RGB string
    static hexToRgb(hex) {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        if (!result) return null;
        return `${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}`;
    }

    // Generate accent color CSS based on active space color (from overlay.js)
    //
    // selector: where the custom properties get defined. Defaults to ':root' for
    // extension pages (newtab). The overlay must pass ':host' -- it renders inside a
    // shadow root, where ':root' matches nothing and every var() would fall back to
    // an empty value (colorless hover/selection states, no error).
    static async getAccentColorCSS(spaceColor, selector = ':root') {
        // Default RGB values for each color name (matching --chrome-*-color variables in styles.css)
        const defaultColorMap = {
            grey: '204, 204, 204',
            blue: '139, 179, 243',
            red: '255, 158, 151',
            yellow: '255, 226, 159',
            green: '139, 218, 153',
            pink: '251, 170, 215',
            purple: '214, 166, 255',
            cyan: '165, 226, 234',
            orange: '255, 176, 103'
        };

        let rgb = defaultColorMap[spaceColor] || defaultColorMap.purple;

        // Try to get overridden color from settings
        try {
            const settings = await chrome.storage.sync.get(['colorOverrides']);
            if (settings.colorOverrides && settings.colorOverrides[spaceColor]) {
                const hexColor = settings.colorOverrides[spaceColor];
                const rgbValue = this.hexToRgb(hexColor);
                if (rgbValue) {
                    rgb = rgbValue;
                }
            }
        } catch (error) {
            Logger.error('Error getting color overrides:', error);
        }

        return `
            ${selector} {
                --spotlight-accent-color: rgb(${rgb});
                --spotlight-accent-color-15: rgba(${rgb}, 0.15);
                --spotlight-accent-color-20: rgba(${rgb}, 0.2);
                --spotlight-accent-color-80: rgba(${rgb}, 0.8);
            }
        `;
    }

    // Check if two results are duplicates based on URL (for deduplication)
    static areResultsDuplicate(result1, result2) {
        if (!result1 || !result2) return false;

        // Compare normalized URLs for URL-based results
        if (result1.url && result2.url) {
            const url1 = result1.url.toLowerCase().replace(/\/+$/, ''); // Remove trailing slashes
            const url2 = result2.url.toLowerCase().replace(/\/+$/, '');
            return url1 === url2;
        }

        // Compare titles for search queries
        if (result1.type === 'search-query' && result2.type === 'search-query') {
            return result1.title === result2.title;
        }

        return false;
    }

    // Setup favicon error handling (consolidated pattern from overlay.js and popup.js)
    static setupFaviconErrorHandling(container) {
        const faviconImages = container.querySelectorAll('.arcify-spotlight-result-favicon[data-fallback-icon="true"]');
        faviconImages.forEach(img => {
            img.addEventListener('error', function () {
                this.src = SpotlightUtils.getFaviconUrl({ url: null, favicon: null });
            });
        });
    }

    // DEBUG: Format debug info for result items (easy to remove)
    static formatDebugInfo(result) {
        // Debug mode controlled by build: true for dev builds, false for prod builds
        const DEBUG_ENABLED = __DEBUG_ENABLED__;

        if (!DEBUG_ENABLED) {
            return '';
        }

        const score = result.score || 0;
        const type = result.type || 'unknown';
        const fuzzyMatch = result.metadata?.fuzzyMatch ? ' (fuzzy)' : '';

        return `<span style="color: #888; font-size: 10px; margin-left: 8px;">[${type}:${score}${fuzzyMatch}]</span>`;
    }

    // Get chip background and text colors for a given Chrome tab group color name
    // Uses 15% opacity tint as background, full color as text -- all pass WCAG 3:1 contrast on #2D2D2D
    static getChipColors(colorName) {
        const chipColorMap = {
            grey:   { bg: 'rgba(204, 204, 204, 0.15)', text: 'rgb(204, 204, 204)' },
            blue:   { bg: 'rgba(139, 179, 243, 0.15)', text: 'rgb(139, 179, 243)' },
            red:    { bg: 'rgba(255, 158, 151, 0.15)', text: 'rgb(255, 158, 151)' },
            yellow: { bg: 'rgba(255, 226, 159, 0.15)', text: 'rgb(255, 226, 159)' },
            green:  { bg: 'rgba(139, 218, 153, 0.15)', text: 'rgb(139, 218, 153)' },
            pink:   { bg: 'rgba(251, 170, 215, 0.15)', text: 'rgb(251, 170, 215)' },
            purple: { bg: 'rgba(214, 166, 255, 0.15)', text: 'rgb(214, 166, 255)' },
            cyan:   { bg: 'rgba(165, 226, 234, 0.15)', text: 'rgb(165, 226, 234)' },
            orange: { bg: 'rgba(255, 176, 103, 0.15)', text: 'rgb(255, 176, 103)' }
        };
        return chipColorMap[colorName] || chipColorMap.grey;
    }

    // Bridge results use authoritative workspace metadata, including closed pins.
    // Standalone results keep the existing Chrome tab-group presentation.
    static generateSpaceChipHTML(result) {
        const groupName = result.metadata?.groupName;
        const spaceName = result.metadata?.spaceName;
        const isBridge = Boolean(result.metadata?.arcifyBridge);

        const chipName = isBridge ? spaceName
            : (spaceName && spaceName === groupName) ? spaceName : groupName;
        if (typeof chipName !== 'string' || !chipName) return '';
        const chipColor = (isBridge ? result.metadata?.spaceColor : result.metadata?.groupColor) || 'grey';
        const chipColors = SpotlightUtils.getChipColors(chipColor);
        const truncatedName = chipName.length > 18 ? chipName.substring(0, 18) + '\u2026' : chipName;

        return `<span class="arcify-space-chip" style="background:${chipColors.bg};color:${chipColors.text}" title="${SpotlightUtils.escapeHtml(chipName)}">${SpotlightUtils.escapeHtml(truncatedName)}</span>`;
    }
}
