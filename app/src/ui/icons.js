/* =============== ICON LIBRARY ==================================
   One set for the whole interface, drawn to the same rules so every
   button reads as part of one tool:

   - 24×24 grid, ~2px padding, outline style, round caps and joins.
   - Stroke is non-scaling (see .ic in styles.css): every icon has the
     same 1.5px line weight whatever size it is shown at.
   - Sketch vocabulary shared with the canvas: a filled dot is a sketch
     point / click point, a small "+" is a centre, a dashed line is
     construction or a reference axis.
   ============================================================ */

const dot = (x, y, r = 1.9) => `<circle cx="${x}" cy="${y}" r="${r}" fill="currentColor" stroke="none"/>`;
const centre = (x, y, s = 2.5) => `<path d="M${x - s} ${y}h${2 * s}M${x} ${y - s}v${2 * s}"/>`;
const dash = 'stroke-dasharray="2.5 2.5"';
const dimArrows = '<path d="M5 6v12M19 6v12"/><path d="M5 12h14"/><path d="M8 9.5L5.2 12 8 14.5M16 9.5l2.8 2.5-2.8 2.5"/>';

export const ICONS = {
  /* ---- Tools ---- */
  select: '<path d="M6 3.5l12.5 7.6-5.6 1.3 3.2 6.4-2.5 1.2-3.1-6.4L6.4 17.8z" fill="currentColor" fill-opacity="0.18"/>',
  line: '<path d="M5 19L19 5"/>' + dot(5, 19) + dot(19, 5),
  centerLine: '<path d="M3.5 12h17"/>' + dot(3.5, 12) + dot(20.5, 12) + '<path d="M12 8.5v7"/>',
  rectangle: '<rect x="4" y="6" width="16" height="12" rx="0.5"/>' + dot(4, 18) + dot(20, 6),
  centerRectangle: '<rect x="4" y="6" width="16" height="12" rx="0.5"/>' + centre(12, 12) + dot(20, 6),
  circle: '<circle cx="12" cy="12" r="8"/>' + centre(12, 12) + dot(20, 12),
  threePointCircle: '<circle cx="12" cy="12" r="8"/>' + dot(12, 4) + dot(19, 16) + dot(5, 16),
  arc: '<path d="M19.5 18A13.5 13.5 0 0 0 6 4.5"/>' + `<path d="M6 18h13.5M6 18V4.5" ${dash} opacity="0.55"/>` + dot(19.5, 18) + dot(6, 4.5) + dot(6, 18, 1.5),
  hexagon: '<path d="M12 3.5l7.4 4.25v8.5L12 20.5l-7.4-4.25v-8.5z"/>' + centre(12, 12),
  point: dot(12, 12, 2.8) + '<path d="M12 3.5v3.5M12 17v3.5M3.5 12H7M17 12h3.5"/>',
  smartdim: dimArrows,
  fill: '<path d="M11 3.5l7.5 7.5-6.5 6.5a2 2 0 0 1-2.8 0L4.5 12.8a2 2 0 0 1 0-2.8z"/><path d="M5 11h13"/><path d="M20 14.5s1.8 2.2 1.8 3.5a1.8 1.8 0 0 1-3.6 0c0-1.3 1.8-3.5 1.8-3.5z" fill="currentColor"/>',
  erase: '<path d="M8.5 19.5l-4-4a1.8 1.8 0 0 1 0-2.6l8.4-8.4a1.8 1.8 0 0 1 2.6 0l4.5 4.5a1.8 1.8 0 0 1 0 2.6l-8.4 8.4"/><path d="M8.5 19.5H20"/><path d="M8.6 8.8l6.6 6.6"/>',

  /* ---- File / edit ---- */
  new: '<path d="M14 3.5H7a1.5 1.5 0 0 0-1.5 1.5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8z"/><path d="M14 3.5V8h4.5"/><path d="M12 11v6M9 14h6"/>',
  import: '<path d="M3.5 18V6a1.5 1.5 0 0 1 1.5-1.5h4l2 2.5h8a1.5 1.5 0 0 1 1.5 1.5V18a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18z"/><path d="M12 10.5v6M9.5 14l2.5 2.5 2.5-2.5"/>',
  save: '<path d="M5 3.5h11l3.5 3.5v12a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V5A1.5 1.5 0 0 1 5 3.5z"/><path d="M7.5 3.5v5h8v-5"/><path d="M7 20.5v-6h10v6"/>',
  export: '<path d="M12 15V4M8 8l4-4 4 4"/><path d="M4.5 14v4.5A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5V14"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  solve: '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v4.5h-4.5"/><path d="M9 12.2l2.2 2.2 4-4.2"/>',

  /* ---- View ---- */
  grid: '<rect x="4" y="4" width="16" height="16" rx="1.5"/><path d="M4 9.33h16M4 14.67h16M9.33 4v16M14.67 4v16"/>',
  snap: '<path d="M5 4h4.5v7.5a2.5 2.5 0 0 0 5 0V4H19v7.5a7 7 0 0 1-14 0z"/><path d="M5 8h4.5M14.5 8H19"/>',
  dimensions: dimArrows,
  'zoom-fit': '<path d="M8 4H5.5A1.5 1.5 0 0 0 4 5.5V8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16M16 20h2.5a1.5 1.5 0 0 0 1.5-1.5V16"/><rect x="8.5" y="8.5" width="7" height="7" rx="1"/>',
  'zoom-reset': '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.2 15.2L20 20"/><path d="M9.3 8.6l1.6-1.1v6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  'reset-layout': '<rect x="3.5" y="4" width="17" height="16" rx="1.5"/><path d="M3.5 8.5h17M10 8.5V20"/>',

  /* ---- Windows ---- */
  tools: '<rect x="4" y="4" width="6.5" height="6.5" rx="1"/><circle cx="17" cy="7.25" r="3.25"/><path d="M7.25 13.5l3.5 6.5h-7z"/><path d="M13.5 17h7M17 13.5v7"/>',
  colors: '<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.8-1 1.3-2-.6-1.1 0-2.5 1.3-2.5h2.4a3.5 3.5 0 0 0 3.5-3.5c0-5-3.8-9-8.5-9z"/>' + dot(7.8, 11.5, 1.3) + dot(10.5, 7.5, 1.3) + dot(15, 8, 1.3),
  layers: '<path d="M12 3.5l8.5 4.5-8.5 4.5L3.5 8z"/><path d="M3.5 12l8.5 4.5 8.5-4.5"/><path d="M3.5 16l8.5 4.5 8.5-4.5"/>',
  props: '<path d="M4 6.5h9M17 6.5h3M4 12h3M11 12h9M4 17.5h11M19 17.5h1"/><circle cx="15" cy="6.5" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17.5" r="2"/>',
  equations: '<path d="M17.5 5h-11l6 7-6 7h11"/>',

  /* ---- Operations / styles ---- */
  mirror: `<path d="M12 3v18" ${dash}/><path d="M9 7.5L3.5 17H9z"/><path d="M15 7.5l5.5 9.5H15z" fill="currentColor" fill-opacity="0.18"/>`,
  offset: '<path d="M3.5 19a8.5 8.5 0 0 1 17 0"/><path d="M8.5 19a3.5 3.5 0 0 1 7 0" stroke-dasharray="2.5 2.5"/>' + dot(3.5, 19, 1.6) + dot(20.5, 19, 1.6),
  construction: `<path d="M5 19L19 5" ${dash}/>` + dot(5, 19) + dot(19, 5),
  'apply-style': '<path d="M14.5 4.5l5 5-8 8-5-5z"/><path d="M6.5 12.5L4 20l7.5-2.5"/><path d="M17 7l2.5-2.5"/>',
  'pick-style': '<path d="M16.5 3.8a2.3 2.3 0 0 1 3.2 3.2L17 9.7l.8.8-1.6 1.6-4.3-4.3 1.6-1.6.8.8z"/><path d="M12.5 9L5.5 16v2.5H8l7-7"/>',
  flip: '<path d="M7 4L4 7l3 3"/><path d="M4 7h12"/><path d="M17 20l3-3-3-3"/><path d="M20 17H8"/>',

  /* ---- Generic UI ---- */
  eye: '<path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  eyeOff: '<path d="M3.5 3.5l17 17"/><path d="M10.6 5.6A10 10 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.4 3.1"/><path d="M6.6 6.6C3.9 8.3 2.5 12 2.5 12s3.5 6.5 9.5 6.5a9.5 9.5 0 0 0 5.3-1.6"/><path d="M10 10a2.8 2.8 0 0 0 4 4"/>',
  trash: '<path d="M4 7h16"/><path d="M9.5 7V4.5h5V7"/><path d="M6 7l1 12.5a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5L18 7"/><path d="M10 11v6M14 11v6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  check: '<path d="M20 6.5L9.5 17 4 11.5"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="1.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  unlock: '<rect x="5" y="10.5" width="14" height="10" rx="1.5"/><path d="M8 10.5V8a4 4 0 0 1 7.7-1.5"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  none: '<circle cx="12" cy="12" r="8"/><path d="M6.5 17.5l11-11"/>',
  tag: '<path d="M3.5 12V4.5a1 1 0 0 1 1-1H12l8.5 8.5-8.5 8.5z"/>' + dot(8, 8, 1.4),

  /* ---- Relations (Properties window) ---- */
  'rel-horizontal': '<path d="M4 12h16"/>' + dot(4, 12) + dot(20, 12),
  'rel-vertical': '<path d="M12 4v16"/>' + dot(12, 4) + dot(12, 20),
  'rel-fix': '<path d="M12 4v10"/><path d="M5 14h14M8 17.5h8M10.5 21h3"/>' + dot(12, 4, 2.2),
  'rel-coincident': '<circle cx="12" cy="12" r="5.5"/>' + dot(12, 12, 2.2),
  'rel-collinear': '<path d="M3 15.5L9 12.5M15 9.5l6-3"/><path d="M9 12.5l6-3" stroke-dasharray="2 2"/>' + dot(3, 15.5) + dot(21, 6.5),
  'rel-parallel': '<path d="M4 15L14 5M10 19L20 9"/>',
  'rel-perpendicular': '<path d="M4 19.5h16M12 19.5V4.5"/><path d="M12 15.5h4v4"/>',
  'rel-equal': '<path d="M5 9h14M5 15h14"/>',
  'rel-concentric': '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/>' + dot(12, 12, 1.4),
  'rel-tangent': '<circle cx="12" cy="14" r="6"/><path d="M3 8h18"/>' + dot(12, 8, 1.7),
  'rel-midpoint': '<path d="M4 15h16"/>' + dot(4, 15) + dot(20, 15) + '<path d="M12 15l-3-5h6z"/>',
  'rel-symmetric': `<path d="M12 3v18" ${dash}/>` + dot(5, 12) + dot(19, 12) + '<path d="M7.5 12h2M14.5 12h2"/>',
  'rel-pointOnLine': '<path d="M4 19L20 5"/>' + dot(12, 12, 2.6),
  'rel-pointOnCircle': '<circle cx="12" cy="12" r="8"/>' + dot(17.66, 6.34, 2.6),

  /* ---- Dimensions (Properties window) ---- */
  'dim-distance': dimArrows,
  'dim-radius': '<circle cx="12" cy="12" r="8"/>' + dot(12, 12, 1.5) + '<path d="M12 12l5.2-5.2"/><path d="M13.8 6.8h3.6v3.6"/>',
  'dim-diameter': '<circle cx="12" cy="12" r="8"/><path d="M6.8 17.2L17.2 6.8"/><path d="M13.8 6.8h3.6v3.6M10.2 17.2H6.6v-3.6"/>',
  'dim-angle': '<path d="M4 19h16M4 19L15 5"/><path d="M12 19a8 8 0 0 0-2.8-6.1"/>',
  'dim-pointLine': '<path d="M3.5 19.5h17"/>' + dot(12, 5) + '<path d="M12 8v8.5M9.5 14l2.5 2.5 2.5-2.5"/>',
};

/** Relation / dimension kind → icon name used in the Properties window. */
const KIND_ICONS = {
  horizontal: 'rel-horizontal', pointRefHorizontal: 'rel-horizontal',
  vertical: 'rel-vertical', pointRefVertical: 'rel-vertical',
  fix: 'rel-fix', arcEndpointFix: 'rel-fix',
  coincident: 'rel-coincident', arcEndpointCoincident: 'rel-coincident', arcEndpointArcEndpointCoincident: 'rel-coincident',
  collinear: 'rel-collinear',
  parallel: 'rel-parallel',
  perpendicular: 'rel-perpendicular',
  equal: 'rel-equal', equalLength: 'rel-equal', equalRadius: 'rel-equal',
  concentric: 'rel-concentric',
  tangent: 'rel-tangent',
  midpoint: 'rel-midpoint', arcEndpointMidpoint: 'rel-midpoint',
  symmetric: 'rel-symmetric',
  pointOnLine: 'rel-pointOnLine', arcEndpointOnLine: 'rel-pointOnLine',
  pointOnCircle: 'rel-pointOnCircle', arcEndpointOnCircle: 'rel-pointOnCircle',
  distance: 'dim-distance', curveDistance: 'dim-distance', offsetDistance: 'dim-distance',
  radius: 'dim-radius', diameter: 'dim-diameter', angle: 'dim-angle',
  pointLineDistance: 'dim-pointLine',
  offset: 'offset',
};

/** Inline SVG for an icon. `cls` adds classes next to `.ic`. */
export function icon(name, cls = '') {
  return `<svg class="ic${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name] || ''}</svg>`;
}

/** Back-compat alias used across the app. */
export const uiIcon = icon;

/** Icon for a constraint / dimension kind. */
export const kindIcon = (kind) => icon(KIND_ICONS[kind] || 'tag');

/** Icon for a sketch entity (selection lists, context menu). */
export function entityIcon(e) {
  const k = e?.constructor?.kind;
  const name = k === 'point' ? 'point' : k === 'line' ? 'line' : k === 'circle' ? 'circle' : k === 'arc' ? 'arc' : 'tag';
  return icon(name);
}
