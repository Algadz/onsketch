/* =============== CANVAS CURSORS ================================
   Every canvas cursor is built from the same three parts so they read
   as one family (and match the toolbar icons):

   - a pointer:    an arrow (Select, pick operations), a precision
                   crosshair (drawing, dimensioning, placing) or a
                   paint drop (Fill, in the current fill colour);
   - an optional badge at the lower right: the active tool's icon from
     icons.js, or what's under the pointer (line, circle, dimension…);
   - a white halo under the dark ink, so cursors stay readable on light
     and dark canvases alike.

   Hand cursors (grab / grabbing) and not-allowed stay the system ones:
   they're universal, and the OS draws them at the right scale.
   ============================================================ */
import { ICONS } from './icons.js';

const INK = '#1b2028';
const HALO = '#ffffff';
const WARN = '#d63a3a';
const SIZE = 32;

/** Paths drawn twice: a wide white halo, then the ink. */
const haloed = (d, { fill = 'none', w = 1.5 } = {}) =>
  `<path d="${d}" fill="none" stroke="${HALO}" stroke-width="${w + 2.6}" stroke-linejoin="round" stroke-linecap="round"/>` +
  `<path d="${d}" fill="${fill}" stroke="${INK}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"/>`;

/** Badge-only simplifications: guides that read at toolbar size turn to
 *  noise at 14px. */
const BADGE_OVERRIDES = {
  arc: '<path d="M19.5 18A13.5 13.5 0 0 0 6 4.5"/><circle cx="19.5" cy="18" r="2" fill="currentColor" stroke="none"/><circle cx="6" cy="4.5" r="2" fill="currentColor" stroke="none"/><path d="M4 18h4M6 16v4"/>',
};

/** An icons.js icon, 14px, in the lower-right corner, haloed. */
function badge(name, color = INK) {
  const inner = BADGE_OVERRIDES[name] || ICONS[name];
  if (!inner) return '';
  const s = 14 / 24;                         // icon grid → badge px
  const g = (stroke, w, colour) =>
    `<g transform="translate(17.5 17.5) scale(${s})" fill="none" stroke="${stroke}" stroke-width="${w / s}" ` +
    `stroke-linecap="round" stroke-linejoin="round" color="${colour}">${inner}</g>`;
  return g(HALO, 3.8, HALO) + g(color, 1.35, color);
}

const POINTERS = {
  // Arrow, tip at (2, 2).
  arrow: { hot: [2, 2], svg: haloed('M2 2v17l4.4-4.2 3.1 6.9 3-1.3-3-6.8h6.1z', { fill: INK, w: 1.2 }) },
  // Precision crosshair with an open centre, centred on (11, 11).
  cross: {
    hot: [11, 11],
    svg: haloed('M11 1.5v6.5M11 14v6.5M1.5 11H8M14 11h6.5') +
      `<circle cx="11" cy="11" r="1.6" fill="${HALO}"/><circle cx="11" cy="11" r="0.9" fill="${INK}"/>`,
  },
};

const cache = new Map();
function build(key, hot, svg) {
  let v = cache.get(key);
  if (!v) {
    const doc = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">${svg}</svg>`;
    v = `url("data:image/svg+xml,${encodeURIComponent(doc)}") ${hot[0]} ${hot[1]}`;
    cache.set(key, v);
  }
  return v;
}

/** Select-style arrow, with an optional badge (icon name). */
export function arrowCursor(badgeName = null) {
  const p = POINTERS.arrow;
  return build('arrow:' + badgeName, p.hot, p.svg + (badgeName ? badge(badgeName) : '')) + ', default';
}

/** Precision crosshair for placing geometry, with the tool's icon.
 *  `invalid` swaps the badge for a red "no" sign (e.g. a zero-length line). */
export function crossCursor(badgeName = null, invalid = false) {
  const p = POINTERS.cross;
  const b = invalid ? badge('none', WARN) : badgeName ? badge(badgeName) : '';
  return build(`cross:${badgeName}:${invalid}`, p.hot, p.svg + b) + ', crosshair';
}

/** Fill tool: a paint drop in the fill colour, its point on the click
 *  spot; erase mode carries the eraser badge. */
export function fillCursor(color, erase = false) {
  const c = /^#[0-9a-f]{3,8}$/i.test(color || '') ? color : '#1f7ad6';
  const svg =
    // sides tangent to the round part, so it reads as a drop
    haloed('M3 3 L19.9 9.5 A8 8 0 1 1 9.5 19.9 Z', { fill: c }) +
    `<path d="M13.5 15 a4.5 4.5 0 0 1 3.5 -3" stroke="${HALO}" stroke-width="1.6" fill="none" stroke-linecap="round" opacity="0.85"/>` +
    (erase ? badge('erase') : '');
  return build(`fill:${c}:${erase}`, [3, 3], svg) + ', crosshair';
}

/** Readable names for snap kinds, shown in the label beside the cursor. */
export const SNAP_LABELS = {
  endpoint: 'Endpoint',
  midpoint: 'Midpoint',
  center: 'Center',
  quadrant: 'Quadrant',
  origin: 'Origin',
  'on-line': 'On line',
  'on-circle': 'On circle',
};
