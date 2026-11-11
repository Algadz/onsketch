/* =============== STYLE + LAYERS ================================
   Display attributes, kept separate from geometry and constraints.

   Stroke colour always shows an entity's state (constraint status,
   construction, selection), as in SolidWorks. An entity's own style is
   only its line weight and line type, taken from the drawing style when
   it was drawn. Colour is added by the Fill tool. Layers are display
   groups only: visibility, opacity, order (and the active layer is where
   new shapes go).

   Layers never affect solving or editing: constraints freely link
   entities on different layers, which can share points.
   ============================================================ */
import { newId } from './entities.js';

/** Dash patterns in screen pixels, scaled by line width when drawn. */
export const LINE_STYLES = {
  solid:   { label: 'Solid',    dash: [] },
  dashed:  { label: 'Dashed',   dash: [6, 4] },
  dotted:  { label: 'Dotted',   dash: [1, 3] },
  dashdot: { label: 'Dash-dot', dash: [8, 3, 1.5, 3] },
  center:  { label: 'Center',   dash: [14, 3, 3, 3] },
};

export const LINE_WEIGHTS = [0.5, 1, 1.4, 2, 3, 4, 6];

/** Default swatches: neutral ramp, then saturated hues readable on light
 *  and dark canvases. */
export const PALETTE = [
  '#111418', '#4b5563', '#9ca3af', '#e5e7eb', '#ffffff',
  '#1f7ad6', '#0f9fb5', '#14946b', '#6aa121', '#c9a400',
  '#e07b00', '#d63a3a', '#c2307a', '#8a4fd1', '#5b5fd6',
];

/** What an entity's own style may set. Stroke colour always comes from
 *  the entity's state (constraint status, construction, selection);
 *  colour is added only by the Fill tool. */
export const STYLE_KEYS = ['lineWidth', 'lineStyle'];

const isHex = (c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);

/** Style of an entity that has none of its own. */
export const DEFAULT_STYLE = { lineWidth: 1.4, lineStyle: 'solid' };

/** A layer is a display group only: it carries no colours or line
 *  settings (those belong to each entity, set from the drawing style
 *  when it was drawn). */
export class Layer {
  constructor(name = 'Layer', props = {}) {
    this.id = props.id || newId('ly');
    this.name = name;
    this.opacity = Number.isFinite(props.opacity) ? props.opacity : 1;
    this.visible = props.visible !== false;
  }
  toJSON() {
    return { id: this.id, name: this.name, opacity: this.opacity, visible: this.visible };
  }
  static fromJSON(o) { return new Layer(o.name || 'Layer', o); }
}

/** Keep only known, valid style keys. Returns null when nothing is left so
 *  entities without overrides serialise without a `style` field. */
export function cleanStyle(style) {
  if (!style || typeof style !== 'object') return null;
  const out = {};
  if (Number.isFinite(style.lineWidth) && style.lineWidth > 0) out.lineWidth = style.lineWidth;
  if (LINE_STYLES[style.lineStyle]) out.lineStyle = style.lineStyle;
  return Object.keys(out).length ? out : null;
}

/** Effective line style for an entity: its own over the defaults. */
export function resolveStyle(entity) {
  const s = entity?.style || {};
  return {
    lineWidth: s.lineWidth ?? DEFAULT_STYLE.lineWidth,
    lineStyle: s.lineStyle ?? DEFAULT_STYLE.lineStyle,
  };
}

/** Fill colour an older file gave an entity (shape fill or layer fill),
 *  or null. Used once, on load, to turn it into a Fill-tool fill. */
export function legacyFill(style) {
  if (!style || !isHex(style.fill)) return null;
  return { color: style.fill, opacity: Number.isFinite(style.fillOpacity) ? Math.min(1, Math.max(0, style.fillOpacity)) : 0.35 };
}

/** Dash array in screen pixels for a line style at a given width. */
export function dashFor(lineStyle, width = 1) {
  const d = LINE_STYLES[lineStyle]?.dash || [];
  const k = Math.max(1, width * 0.8);
  return d.map(v => v * k);
}

/** "#rrggbb" + alpha → "rgba(...)". */
export function withAlpha(hex, alpha) {
  if (!isHex(hex)) return hex;
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}
