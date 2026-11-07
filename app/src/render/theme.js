/* =============== CANVAS THEMES =================================
   Every colour the canvas renderer paints comes from here, so light
   and dark modes stay consistent. The DOM chrome uses the matching
   CSS custom properties in styles.css.
   ============================================================ */

/** Palette "ink" colour. Drawn as the theme's foreground, so black
 *  geometry stays visible on a dark canvas (AutoCAD's colour 7 rule). */
export const INK = '#111418';

export const THEMES = {
  light: {
    name: 'light',
    gridFine: '#e8ecf1',
    gridMajor: '#cdd3db',
    origin: '#a7afba',
    ink: '#111418',
    under: '#1f7ad6',
    fully: '#111418',
    over: '#d63a3a',
    construction: '#c44b8a',
    hover: '#ffae5a',
    selected: '#ff8a1e',
    inactive: '#7a828c',
    preview: '#1f7ad6',
    previewHalo: '#ffffff',
    accent: '#2563a5',
    accentFill: 'rgba(37,99,165,0.08)',
    pickFill: 'rgba(255,138,30,0.18)',
    dim: '#1c2026',
    dimGrey: 'rgba(120,128,140,0.85)',
    dimGreyText: '#7a828c',
    dimSelectedText: '#bf5b00',
    textHalo: 'rgba(255,255,255,0.85)',
  },
  dark: {
    name: 'dark',
    gridFine: '#252b34',
    gridMajor: '#343c48',
    origin: '#5d6877',
    ink: '#e6e9ee',
    under: '#5aa9ff',
    fully: '#e6e9ee',
    over: '#ff6464',
    construction: '#e27bb4',
    hover: '#ffbe7a',
    selected: '#ff9a3c',
    inactive: '#77808c',
    preview: '#5aa9ff',
    previewHalo: '#15191f',
    accent: '#5aa9ff',
    accentFill: 'rgba(90,169,255,0.10)',
    pickFill: 'rgba(255,154,60,0.22)',
    dim: '#d6dbe2',
    dimGrey: 'rgba(150,158,170,0.85)',
    dimGreyText: '#8a94a1',
    dimSelectedText: '#ffb066',
    textHalo: 'rgba(21,25,31,0.85)',
  },
};

export function getTheme(name) { return THEMES[name] || THEMES.light; }
