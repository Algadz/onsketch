/* =============== TOOL + ACTION DEFINITIONS =====================
   One list drives the Tools window, the options bar title and the
   status bar, so labels and shortcuts can't drift apart.
   ============================================================ */
const svg = (inner, extra = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"') =>
  `<svg viewBox="0 0 24 24" ${extra}>${inner}</svg>`;

export const TOOL_ICONS = {
  select: svg('<path d="M5 3l13 8-5 1 3 7-2 1-3-7-4 4z"/>', 'fill="currentColor"'),
  line: svg('<line x1="4" y1="20" x2="20" y2="4"/><circle cx="4" cy="20" r="1.6" fill="currentColor"/><circle cx="20" cy="4" r="1.6" fill="currentColor"/>'),
  centerLine: svg('<line x1="4" y1="12" x2="20" y2="12"/><circle cx="4" cy="12" r="1.5" fill="currentColor"/><circle cx="20" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/>'),
  rectangle: svg('<rect x="4" y="6" width="16" height="12"/>'),
  centerRectangle: svg('<rect x="4" y="6" width="16" height="12"/><path d="M4 12h16M12 6v12" stroke-dasharray="3 3"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/>'),
  circle: svg('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/>'),
  threePointCircle: svg('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="4" r="1.4" fill="currentColor"/><circle cx="19" cy="15" r="1.4" fill="currentColor"/><circle cx="5" cy="15" r="1.4" fill="currentColor"/>'),
  hexagon: svg('<path d="M12 3.5l7.4 4.25v8.5L12 20.5l-7.4-4.25v-8.5z"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/>'),
  arc: svg('<path d="M20 12a8 8 0 0 0-8-8"/><path d="M12 12h8M12 12V4" stroke-dasharray="3 3"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="20" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="4" r="1.4" fill="currentColor"/>'),
  point: svg('<circle cx="12" cy="12" r="3"/>', 'fill="currentColor"'),
  smartdim: svg('<path d="M4 7v10M20 7v10"/><path d="M4 12h16"/><path d="M7 9.5L4 12l3 2.5M17 9.5l3 2.5-3 2.5"/>'),
  pen: svg('<path d="M4 20l1-4L16 5l3 3L8 19z"/><path d="M14 7l3 3"/><path d="M4 20l4-1"/>'),
  marker: svg('<path d="M9 15l-3 3v2h4l3-3"/><path d="M9 15l6-10 4 4-10 6z"/><path d="M4 21h16" stroke-width="3" opacity="0.45"/>'),
  eraser: svg('<path d="M9 20h11"/><path d="M4.5 15.5l9-9a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8L11 19H8z"/><path d="M9 11l5 5"/>'),
  fill: svg('<path d="M5 11l7-7 7 7-7 7z"/><path d="M5 11h14"/><path d="M19.5 15.5s1.5 2 1.5 3a1.5 1.5 0 0 1-3 0c0-1 1.5-3 1.5-3z" fill="currentColor"/>'),
};

export const ACTION_ICONS = {
  new: svg('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h4"/><path d="M9 14h6M12 11v6"/>'),
  import: svg('<path d="M3 7h6l2 2h10v10H3z"/><path d="M12 16v-5M9.5 13.5L12 16l2.5-2.5"/>'),
  save: svg('<path d="M5 4h12l2 2v14H5z"/><path d="M8 4v6h8V4"/><path d="M8 20v-6h8v6"/>'),
  export: svg('<path d="M12 15V4"/><path d="M8 8l4-4 4 4"/><path d="M5 14v5h14v-5"/>'),
  undo: svg('<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>'),
  redo: svg('<path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 15-6.7L21 13"/>'),
  solve: svg('<path d="M20 6L9 17l-5-5"/>'),
  grid: svg('<path d="M4 4h16v16H4z"/><path d="M4 10h16M4 16h16M10 4v16M16 4v16"/>', 'fill="none" stroke="currentColor" stroke-width="1.6"'),
  snap: svg('<path d="M12 4v4M12 16v4M4 12h4M16 12h4"/><circle cx="12" cy="12" r="3"/>'),
  dimensions: svg('<path d="M4 7v10M20 7v10"/><path d="M4 12h16"/><path d="M7 9.5L4 12l3 2.5M17 9.5l3 2.5-3 2.5"/>'),
  relations: svg('<circle cx="7" cy="7" r="2.2" fill="currentColor"/><circle cx="17" cy="17" r="2.2" fill="currentColor"/><path d="M8.6 8.6l6.8 6.8" stroke-dasharray="2 2"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><path d="M15 7h4"/>'),
  'color-mode': svg('<path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.6-.9 1.2-1.8-.5-1-.1-2.2 1.1-2.2H17a4 4 0 0 0 4-4c0-5-4-10-9-10z"/><circle cx="7.5" cy="11" r="1.2" fill="currentColor"/><circle cx="10.5" cy="7" r="1.2" fill="currentColor"/><circle cx="15" cy="7.5" r="1.2" fill="currentColor"/>'),
  'zoom-fit': svg('<path d="M8 4H4v4M16 4h4v4M8 20H4v-4M16 20h4v-4"/><path d="M9 9h6v6H9z"/>'),
  'zoom-reset': svg('<circle cx="11" cy="11" r="6"/><path d="M16 16l4 4"/><path d="M11 8v6"/>'),
  mirror: svg('<path d="M12 4v16"/><path d="M5 7l5 5-5 5z"/><path d="M19 7l-5 5 5 5z"/>'),
  offset: svg('<path d="M5 17c4-8 10-8 14 0"/><path d="M7 12c3-5 7-5 10 0"/><path d="M5 17h14"/>'),
  construction: svg('<path d="M4 17h16" stroke-dasharray="3 3"/><path d="M6 7h12"/>'),
  'reset-layout': svg('<rect x="3" y="4" width="7" height="7" rx="1"/><rect x="14" y="4" width="7" height="16" rx="1"/><rect x="3" y="14" width="7" height="6" rx="1"/>'),
  'apply-style': svg('<path d="M4 20l4-1 10-10-3-3L5 16z"/><path d="M14 5l3 3"/><circle cx="19" cy="18" r="2.5" fill="currentColor"/>'),
  'pick-style': svg('<path d="M14 4l6 6-2 2-6-6z"/><path d="M12 6l-7 7v4h4l7-7"/>'),
};

export const WINDOW_ICONS = {
  tools: svg('<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>'),
  colors: svg('<rect x="3" y="3" width="11" height="11" rx="2" fill="currentColor"/><rect x="10" y="10" width="11" height="11" rx="2"/>'),
  layers: svg('<path d="M12 4l9 5-9 5-9-5z"/><path d="M3 14l9 5 9-5"/>'),
  props: svg('<path d="M4 6h16M4 12h16M4 18h10"/>'),
  equations: svg('<path d="M17 5H7l6 7-6 7h10"/>'),
  sketch: svg('<path d="M4 20l1-4L16 5l3 3L8 19z"/><path d="M14 7l3 3"/><path d="M13 20c2-1.5 4-1.5 7 0"/>'),
};

/** Drawing / editing tools, in Tools-window order. */
export const TOOLS = [
  { id: 'select',           label: 'Select',          key: 'S',       group: 'pick' },
  { id: 'line',             label: 'Line',            key: 'L',       group: 'sketch' },
  { id: 'centerLine',       label: 'Centerpoint line', key: 'Shift+L', group: 'sketch' },
  { id: 'rectangle',        label: 'Rectangle',       key: 'R',       group: 'sketch' },
  { id: 'centerRectangle',  label: 'Center rectangle', key: 'Shift+R', group: 'sketch' },
  { id: 'circle',           label: 'Circle',          key: 'C',       group: 'sketch' },
  { id: 'threePointCircle', label: '3-point circle',  key: 'Shift+C', group: 'sketch' },
  { id: 'arc',              label: 'Centerpoint arc', key: 'A',       group: 'sketch' },
  { id: 'hexagon',          label: 'Polygon',         key: 'H',       group: 'sketch' },
  { id: 'point',            label: 'Point',           key: 'P',       group: 'sketch' },
  { id: 'smartdim',         label: 'Smart Dimension', key: 'D',       group: 'dimension' },
  { id: 'fill',             label: 'Fill',            key: 'B',       group: 'paint' },
  { id: 'pen',              label: 'Pen',             key: 'N',       group: 'freehand' },
  { id: 'marker',           label: 'Marker',          key: 'G',       group: 'freehand' },
  { id: 'eraser',           label: 'Eraser',          key: 'E',       group: 'freehand' },
];

export const DRAW_TOOLS = new Set(TOOLS.filter(t => t.group === 'sketch').map(t => t.id));
export const toolDef = (id) => TOOLS.find(t => t.id === id) || { id, label: id, key: '' };
