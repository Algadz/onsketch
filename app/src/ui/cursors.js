/* =============== FILL TOOL CURSORS =============================
   The Fill tool's cursor: a paint drop in the current fill colour whose
   point is the hotspot (the exact click point). A white halo keeps it
   readable on light and dark canvases; erase mode adds an "×" badge.
   ============================================================ */


const INK = '#1b2028';
const HALO = '#ffffff';

/** Draw each path twice: a wide white halo, then the dark outline. */
const haloed = (d, fill = 'none', w = 1.6) =>
  `<path d="${d}" fill="none" stroke="${HALO}" stroke-width="${w + 2.4}" stroke-linejoin="round" stroke-linecap="round"/>` +
  `<path d="${d}" fill="${fill}" stroke="${INK}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"/>`;

const eraseBadge = (cx, cy) =>
  `<circle cx="${cx}" cy="${cy}" r="5.2" fill="${HALO}" stroke="${INK}" stroke-width="1.3"/>` +
  `<path d="M${cx - 2.2} ${cy - 2.2}l4.4 4.4M${cx + 2.2} ${cy - 2.2}l-4.4 4.4" stroke="#d63a3a" stroke-width="1.6" stroke-linecap="round"/>`;

const DESIGNS = {
  // 32×32, hotspot at the point of the drop (top-left).
  drop: (color, erase) => ({
    hot: [3, 3],
    svg:
      // sides tangent to the round part, so it reads as a drop
      haloed('M3 3 L19.9 9.5 A8 8 0 1 1 9.5 19.9 Z', color, 1.5) +
      `<path d="M13.5 15 a4.5 4.5 0 0 1 3.5 -3" stroke="${HALO}" stroke-width="1.6" fill="none" stroke-linecap="round" opacity="0.85"/>` +
      (erase ? eraseBadge(25, 25) : ''),
  }),
};

/** CSS `cursor` value for the Fill tool. */
export function fillCursor(color, erase = false) {
  const { hot, svg } = DESIGNS.drop(color || '#1f7ad6', erase);
  const doc = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">${svg}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(doc)}") ${hot[0]} ${hot[1]}, crosshair`;
}
