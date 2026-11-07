/* =============== FILL TOOL CURSORS =============================
   Custom cursors for the Fill tool, drawn as SVG with the current fill
   colour. Each has a white halo so it reads on light and dark canvases,
   and an "×" badge in erase mode. The hotspot (the exact click point)
   is noted per design.

     bucket     tilted paint bucket pouring a drop (Paint.NET-like);
                hotspot at the tip of the drop
     crosshair  precise crosshair with a small bucket badge;
                hotspot at the centre of the cross
     drop       a paint drop whose point is the hotspot
   ============================================================ */

export const FILL_CURSORS = {
  bucket: 'Bucket',
  crosshair: 'Crosshair',
  drop: 'Drop',
};

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
  // 32×32, hotspot at the bottom of the drop.
  bucket: (color, erase) => ({
    hot: [26, 29],
    svg:
      // bucket body (tilted square), filled white, with paint at its mouth
      haloed('M5 15 L15 5 L25 15 L15 25 Z', HALO) +
      `<path d="M7.5 15 L22.5 15 L15 22.5 Z" fill="${color}" opacity="0.95"/>` +
      haloed('M5 15 H25', 'none', 1.4) +
      // falling drop
      haloed('M26 18.5 C26 18.5 28.6 22.6 28.6 24.6 A2.6 2.6 0 0 1 23.4 24.6 C23.4 22.6 26 18.5 26 18.5 Z', color, 1.3) +
      (erase ? eraseBadge(8, 25) : ''),
  }),
  // 32×32, hotspot at the centre of the cross.
  crosshair: (color, erase) => ({
    hot: [9, 9],
    svg:
      haloed('M9 1.5 V6 M9 12 V16.5 M1.5 9 H6 M12 9 H16.5', 'none', 1.4) +
      `<circle cx="9" cy="9" r="1.2" fill="${INK}" stroke="${HALO}" stroke-width="0.8"/>` +
      // bucket badge
      haloed('M15.5 23 L22 16.5 L28.5 23 L22 29.5 Z', HALO, 1.3) +
      `<path d="M17.2 23 L26.8 23 L22 27.8 Z" fill="${color}"/>` +
      haloed('M15.5 23 H28.5', 'none', 1.1) +
      (erase ? eraseBadge(25, 10) : ''),
  }),
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
export function fillCursor(design, color, erase = false) {
  const make = DESIGNS[design] || DESIGNS.bucket;
  const { hot, svg } = make(color || '#1f7ad6', erase);
  const doc = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">${svg}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(doc)}") ${hot[0]} ${hot[1]}, crosshair`;
}

/** Same cursor as a standalone SVG string (for previews). */
export function fillCursorSvg(design, color, erase = false) {
  const { svg } = (DESIGNS[design] || DESIGNS.bucket)(color, erase);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">${svg}</svg>`;
}
