/* =============== STYLE + LAYERS ================================
   Display attributes, kept separate from geometry and constraints.

   A Layer is a display group shared by every sketch in a project
   (like layers in Paint.NET or AutoCAD). It carries default style plus
   visibility / lock / opacity. Entities point at a layer by id and may
   override any style key through `entity.style`.

   Layers never affect solving: constraints may freely link entities
   that live on different layers.
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

/** Colours handed to new layers in turn. */
const LAYER_COLORS = ['#1f7ad6', '#d63a3a', '#14946b', '#e07b00', '#8a4fd1', '#0f9fb5', '#c2307a', '#6aa121'];

export const STYLE_KEYS = ['color', 'lineWidth', 'lineStyle', 'fill', 'fillOpacity'];

const isHex = (c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);

export class Layer {
  constructor(name = 'Layer', props = {}) {
    this.id = props.id || newId('ly');
    this.name = name;
    this.color = isHex(props.color) ? props.color : '#1f7ad6';
    this.lineWidth = Number.isFinite(props.lineWidth) ? props.lineWidth : 1.4;
    this.lineStyle = LINE_STYLES[props.lineStyle] ? props.lineStyle : 'solid';
    this.fill = isHex(props.fill) ? props.fill : null;           // null = no fill
    this.fillOpacity = Number.isFinite(props.fillOpacity) ? props.fillOpacity : 0.25;
    this.opacity = Number.isFinite(props.opacity) ? props.opacity : 1;
    this.visible = props.visible !== false;
    this.locked = !!props.locked;
  }
  toJSON() {
    const o = {
      id: this.id, name: this.name, color: this.color, lineWidth: this.lineWidth,
      lineStyle: this.lineStyle, fillOpacity: this.fillOpacity, opacity: this.opacity,
      visible: this.visible, locked: this.locked,
    };
    if (this.fill) o.fill = this.fill;
    return o;
  }
  static fromJSON(o) { return new Layer(o.name || 'Layer', o); }
  static nextColor(index) { return LAYER_COLORS[index % LAYER_COLORS.length]; }
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

/** Effective style for an entity: its own overrides on top of its layer.
 *  `fill` resolves to a colour or null ('none' overrides a layer fill). */
export function resolveStyle(entity, layer) {
  const s = entity?.style || {};
  const base = layer || { color: '#1f7ad6', lineWidth: 1.4, lineStyle: 'solid', fill: null, fillOpacity: 0.25 };
  const fill = s.fill !== undefined ? s.fill : base.fill;
  return {
    color: s.color ?? base.color,
    lineWidth: s.lineWidth ?? base.lineWidth,
    lineStyle: s.lineStyle ?? base.lineStyle,
    fill: fill === 'none' ? null : (fill || null),
    fillOpacity: s.fillOpacity ?? base.fillOpacity,
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
