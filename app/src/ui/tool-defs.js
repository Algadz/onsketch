/* =============== TOOL + ACTION DEFINITIONS =====================
   One list drives the Tools window, the options bar title and the
   status bar, so labels and shortcuts can't drift apart.
   ============================================================ */
import { icon } from './icons.js';

const pick = (names) => Object.fromEntries(names.map(n => [n, icon(n)]));

export const TOOL_ICONS = pick(['select', 'line', 'centerLine', 'rectangle', 'centerRectangle', 'circle',
  'threePointCircle', 'hexagon', 'arc', 'point', 'dimension', 'fill']);

export const ACTION_ICONS = pick(['new', 'import', 'save', 'export', 'undo', 'redo', 'solve', 'grid', 'snap',
  'dimensions', 'zoom-fit', 'zoom-reset', 'mirror', 'offset', 'construction', 'reset-layout',
  'apply-style', 'pick-style']);

export const WINDOW_ICONS = pick(['tools', 'colors', 'layers', 'props', 'equations']);

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
  { id: 'dimension',        label: 'Dimension',       key: 'D',       group: 'dimension' },
  { id: 'fill',             label: 'Fill',            key: 'B',       group: 'paint' },
];

export const DRAW_TOOLS = new Set(TOOLS.filter(t => t.group === 'sketch').map(t => t.id));
export const toolDef = (id) => TOOLS.find(t => t.id === id) || { id, label: id, key: '' };
