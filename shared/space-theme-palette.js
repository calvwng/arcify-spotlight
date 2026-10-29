// Shared presentation semantics: keep identical in Arcify and Spotlight.
const normalizeCustomTint = value => typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : null;
const DEFAULT_SPACE_COLORS = {grey:'#cccccc'};
const rgb = hex => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
const mix = (first, second, weight) => '#' + rgb(first).map((channel, index) =>
    Math.round(channel * (1 - weight) + rgb(second)[index] * weight).toString(16).padStart(2, '0')).join('');
export function luminance(hex) {
    const channels = rgb(hex).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
}
export const contrastRatio = (first, second) => (Math.max(luminance(first), luminance(second)) + .05) / (Math.min(luminance(first), luminance(second)) + .05);
export const contrastText = background => contrastRatio(background, '#16191f') >= contrastRatio(background, '#ffffff') ? '#16191f' : '#ffffff';

// A tint is adapted to the selected appearance, rather than forcing pure white
// into a dark surface or making black text unreadable on a custom black Space.
// All rendered colors are generated from validated sRGB hex, including markers.
export function deriveSpaceTheme(value, mode = 'light') {
    const tint = normalizeCustomTint(value) || DEFAULT_SPACE_COLORS.grey;
    const dark = mode === 'dark';
    const surface = dark ? mix('#17191f', tint, .22) : mix('#ffffff', tint, .35);
    const text = contrastText(surface);
    const hover = mix(surface, text, dark ? .08 : .06);
    const selected = mix(surface, text, dark ? .16 : .13);
    const secondary = mix(surface, dark ? '#000000' : '#ffffff', .12);
    const marker = text;
    return { tint, surface, secondary, text, muted: mix(surface, text, .80), hover, selected,
        selectedText: contrastText(selected), marker, border: mix(surface, text, .48),
        panel: dark ? '#24262d' : '#ffffff', panelText: dark ? '#f6f7fb' : '#16191f',
        panelMuted: dark ? '#c7cbd5' : '#505664', panelHover: dark ? '#383c46' : '#edf0f5',
        input: dark ? '#191b21' : '#f7f8fb', danger: dark ? '#ffb4b4' : '#a71929' };
}
