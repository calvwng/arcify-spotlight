/**
 * Runs before the stylesheet/body so an explicit appearance is applied before
 * first paint. System CSS remains the safe default if storage is unavailable.
 * Keep this small classic script compatible with extension CSP (no inline JS).
 */
(() => {
    let appearance = 'system';
    try {
        const saved = localStorage.getItem('spotlightOptionsAppearance');
        if (saved === 'light' || saved === 'dark') appearance = saved;
    } catch {
        // Browser policy can block localStorage. The page still follows system.
    }
    document.documentElement.dataset.appearance = appearance;
})();
