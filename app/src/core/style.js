/* =============== STYLE + LAYERS ================================
   Display attributes, kept separate from geometry and constraints.

   Every entity carries its own style (`entity.style`), taken from the
   drawing style when it was drawn, as in Paint.NET. Layers are display
   groups only: visibility, lock, opacity, order.

   Layers never affect solving (except that locked geometry is held
   still): constraints may freely link entities on different layers.
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

export const STYLE_KEYS = ['color', 'lineWidth', 'lineStyle', 'fill', 'fillOpacity'];

const isHex = (c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);

/** Style of an entity that has none of its own. */
export const DEFAULT_STYLE = { color: '#111418', lineWidth: 1.4, lineStyle: 'solid', fill: null, fillOpacity: 0.35 };

/** A layer is a display group only: it carries no colours or line
 *  settings (those belong to each entity, set from the drawing style
 *  when it was drawn). */
export class Layer {
  constructor(name = 'Layer', props = {}) {
    this.id = props.id || newId('ly');
    this.name = name;
    this.opacity = Number.isFinite(props.opacity) ? props.opacity : 1;
    this.visible = props.visible !== false;
    this.locked = !!props.locked;
  }
  toJSON() {
    return { id: this.id, name: this.name, opacity: this.opacity, visible: this.visible, locked: this.locked };
  }
  static fromJSON(o) { return new Layer(o.name || 'Layer', o); }
}

/** Keep only known, valid style keys. Returns null when nothing is left so
 *  entities without overrides serialise without a `style` field. */
export function cleanStyle(style) {
  if (!style || typeof style !== 'object') return null;
  const out = {};
  if (isHex(style.color)) out.color = style.color;
  if (Number.isFinite(style.lineWidth) && style.lineWidth > 0) out.lineWidth = style.lineWidth;
  if (LINE_STYLES[style.lineStyle]) out.lineStyle = style.lineStyle;
  if (style.fill === 'none' || isHex(style.fill)) out.fill = style.fill;
  if (Number.isFinite(style.fillOpacity)) out.fillOpacity = Math.min(1, Math.max(0, style.fillOpacity));
  return Object.keys(out).length ? out : null;
}

/** Effective style for an entity: its own style over the defaults.
 *  `fill` resolves to a colour or null. */
export function resolveStyle(entity) {
  const s = entity?.style || {};
  const fill = s.fill !== undefined ? s.fill : DEFAULT_STYLE.fill;
  return {
    color: s.color ?? DEFAULT_STYLE.color,
    lineWidth: s.lineWidth ?? DEFAULT_STYLE.lineWidth,
    lineStyle: s.lineStyle ?? DEFAULT_STYLE.lineStyle,
    fill: fill === 'none' ? null : (fill || null),
    fillOpacity: s.fillOpacity ?? DEFAULT_STYLE.fillOpacity,
  };
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
