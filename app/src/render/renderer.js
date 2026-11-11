import { EPS, TAU, angleArcFromPoints, angleSectorForValue, drawDirectedArcPath, lineIntersection, normalizeAngleValue } from '../core/math.js';
import { Arc, Circle, Line, Point } from '../core/entities.js';
import { CONSTRAINT_GLYPHS, distanceFrame } from '../core/constraints.js';
import { resolveStyle, dashFor, withAlpha } from '../core/style.js';
import { getTheme, INK } from './theme.js';
import { BOX_PAD, PAPER, TEXT_LINE, isText, textBox, textCorners, textFont, textLines } from '../core/strokes.js';
import { headSize, headedEnds, isArrow } from '../core/arrows.js';
import { imageCorners, imageElement, isImage } from '../core/images.js';

function roundRect(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export class Renderer {
  constructor(canvas, view) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.view = view;
    this.dpr = window.devicePixelRatio || 1;
    this.lastDimRects = [];
    this.theme = getTheme('light');
  }
  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.view.cssW = r.width; this.view.cssH = r.height;
    this.canvas.width  = Math.floor(r.width  * this.dpr);
    this.canvas.height = Math.floor(r.height * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }
  drawGrid(showGrid, background = null) {
    const ctx = this.ctx, v = this.view;
    this.background = background;            // "paper" text boxes match it
    ctx.clearRect(0, 0, v.cssW, v.cssH);
    if (background) {
      ctx.fillStyle = background === INK ? this.theme.ink : background;
      ctx.fillRect(0, 0, v.cssW, v.cssH);
    }
    if (!showGrid) return;
    let unit = 1;
    while (unit * v.zoom < 12) unit *= 10;
    while (unit * v.zoom > 120) unit /= 10;
    const tl = v.screenToWorld({x:0,y:0}), br = v.screenToWorld({x:v.cssW,y:v.cssH});
    const minX = Math.floor(tl.x / unit) * unit;
    const maxX = Math.ceil (br.x / unit) * unit;
    const minY = Math.floor(br.y / unit) * unit;
    const maxY = Math.ceil (tl.y / unit) * unit;

    ctx.strokeStyle = this.theme.gridFine; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = minX; x <= maxX + EPS; x += unit) {
      const sx = v.worldToScreen({x,y:0}).x + 0.5;
      ctx.moveTo(sx, 0); ctx.lineTo(sx, v.cssH);
    }
    for (let y = minY; y <= maxY + EPS; y += unit) {
      const sy = v.worldToScreen({x:0,y}).y + 0.5;
      ctx.moveTo(0, sy); ctx.lineTo(v.cssW, sy);
    }
    ctx.stroke();

    ctx.strokeStyle = this.theme.gridMajor;
    ctx.beginPath();
    const major = unit * 10;
    const mMinX = Math.floor(tl.x / major) * major;
    const mMaxX = Math.ceil (br.x / major) * major;
    const mMinY = Math.floor(br.y / major) * major;
    const mMaxY = Math.ceil (tl.y / major) * major;
    for (let x = mMinX; x <= mMaxX + EPS; x += major) {
      const sx = v.worldToScreen({x,y:0}).x + 0.5;
      ctx.moveTo(sx, 0); ctx.lineTo(sx, v.cssH);
    }
    for (let y = mMinY; y <= mMaxY + EPS; y += major) {
      const sy = v.worldToScreen({x:0,y}).y + 0.5;
      ctx.moveTo(0, sy); ctx.lineTo(v.cssW, sy);
    }
    ctx.stroke();

    const o = v.worldToScreen({x:0,y:0});
    ctx.strokeStyle = this.theme.origin; ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(o.x - 7, o.y); ctx.lineTo(o.x + 7, o.y);
    ctx.moveTo(o.x, o.y - 7); ctx.lineTo(o.x, o.y + 7);
    ctx.stroke();
  }

  /** Stroke style for one entity. Colour always shows state, as in
   *  SolidWorks: blue under-defined, black fully defined, red over-defined,
   *  pink construction, orange hover / selection, grey on other sketches
   *  and for vertices on layers other than the active one (not editable). Weight and line type come from
   *  the entity's own style. */
  styleFor(entity, isActive, owner = null) {
    const t = this.theme;
    const st = resolveStyle(owner && !entity.style ? owner : entity);
    const construction = entity.construction || (owner && owner.construction);
    let color = t.under;
    if (entity.status === 'fully') color = t.fully;
    if (entity.status === 'over')  color = t.over;
    if (!isActive) color = t.inactive;
    if (entity.locked && entity instanceof Point) color = t.inactive;
    if (construction)    color = t.construction;
    if (entity.hover)    color = t.hover;
    if (entity.selected) color = t.selected;
    const width = st.lineWidth + (entity.selected ? 0.6 : 0);
    return {
      color,
      width,
      dashed: !!construction,
      dash: construction ? [6, 4] : dashFor(st.lineStyle, width),
    };
  }


  /** Draws fills, then strokes, layer by layer (bottom to top). Hidden
   *  layers and sketches are skipped; layer opacity multiplies in. */
  /** @param fillDisplay  layerId → { painted:[{color,opacity,region}] } */
  drawEntities(project, fillDisplay = new Map()) {
    const ctx = this.ctx, v = this.view;
    const activeId = project.activeSketchId;
    // One pass to bucket entities by layer, then draw layers bottom → top.
    const buckets = new Map(project.layers.map(l => [l, new Map()]));
    const slot = (layer, s) => {
      const bySketch = buckets.get(layer);
      if (!bySketch.has(s)) bySketch.set(s, { ents: [] });
      return bySketch.get(s);
    };
    for (const s of project.sketches) {
      if (!s.visible) continue;
      for (const e of s.entities) slot(project.layerOf(e), s).ents.push(e);
    }
    const paintSketch = project.active();
    for (const [layerId] of fillDisplay) { const l = project.layer(layerId); if (l && paintSketch) slot(l, paintSketch); }
    // Freehand strokes, grouped by layer, drawn on top of the layer's shapes.
    const inkByLayer = new Map();
    for (const st of paintSketch?.strokes || []) {
      const l = project.layer(st.layerId); if (!l) continue;
      if (!inkByLayer.has(l.id)) { inkByLayer.set(l.id, []); slot(l, paintSketch); }
      inkByLayer.get(l.id).push(st);
    }
    for (const layer of project.layers) {
      if (!layer.visible) continue;
      for (const [s, { ents }] of buckets.get(layer)) {
        const isActive = s.id === activeId;
        const alpha = layer.opacity * (isActive ? 1 : 0.55);
        ctx.globalAlpha = alpha;
        const paint = s === paintSketch ? fillDisplay.get(layer.id) : null;
        if (paint) for (const p of paint.painted) this._drawPaint(p);
        for (const e of ents) {
          e.draw(ctx, v, this.styleFor(e, isActive));
          for (const c of e.children()) c.draw(ctx, v, this.styleFor(c, isActive, e));
        }
        if (s === paintSketch) for (const st of inkByLayer.get(layer.id) || []) this.drawStroke(st);
        ctx.globalAlpha = 1;
      }
    }
  }

  /** A freehand stroke: one path through the midpoints of its samples
   *  (quadratic smoothing), so marker ink doesn't darken where it
   *  overlaps itself. Never thinner than a hairline on screen. */
  drawStroke(st) {
    if (isText(st)) { this.drawTextItem(st); return; }
    if (isArrow(st)) { this.drawArrow(st); return; }
    if (isImage(st)) { this.drawImageItem(st); return; }
    const ctx = this.ctx, v = this.view;
    const pts = st.points.map(p => v.worldToScreen(p));
    if (!pts.length) return;
    ctx.save();
    ctx.globalAlpha *= st.opacity ?? 1;
    ctx.strokeStyle = st.color === INK ? this.theme.ink : st.color;
    ctx.fillStyle = ctx.strokeStyle;
    const w = Math.max(0.75, st.width * v.zoom);
    if (pts.length === 1 || (pts.length === 2 && Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) < 0.5)) {
      ctx.beginPath(); ctx.arc(pts[0].x, pts[0].y, w / 2, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      if (st.selected) this._drawInkSelection(pts, w);
      return;
    }
    ctx.lineWidth = w;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    const end = pts[pts.length - 1];
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
    ctx.restore();
    if (st.selected) this._drawInkSelection(pts, w);
  }

  /** A text: one canvas line per text line, top-left at its point, in
   *  world size (it scales with zoom). Skipped while the inline editor
   *  shows it. */
  drawTextItem(st) {
    if (st._editing) return;
    const ctx = this.ctx, v = this.view;
    const p = v.worldToScreen(st.points[0]);
    const px = st.size * v.zoom;
    const tb = textBox(st);
    const ink = st.color === INK ? this.theme.ink : st.color;
    ctx.save();
    ctx.globalAlpha *= st.opacity ?? 1;
    // The text's own frame: origin at its top-left, x along the line, y
    // down the lines (screen y is down, so a CCW world angle is −angle).
    ctx.translate(p.x, p.y);
    if (st.angle) ctx.rotate(-st.angle);
    if (st.box) {
      const m = st.size * BOX_PAD * v.zoom;
      ctx.beginPath();
      roundRect(ctx, -m, -m, tb.w * v.zoom + 2 * m, tb.h * v.zoom + 2 * m, Math.min(6, px * 0.25));
      ctx.fillStyle = this.boxColor(st.box.color);
      ctx.fill();
      if (st.box.border) {
        ctx.lineWidth = Math.max(1, px * 0.06);
        ctx.strokeStyle = ink;
        ctx.stroke();
      }
    }
    if (px >= 0.5) {
      ctx.fillStyle = ink;
      ctx.font = textFont(px, st.bold);
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      textLines(st).forEach((line, i) => ctx.fillText(line, 0, (i + 0.5) * px * TEXT_LINE));
    }
    ctx.restore();
    if (st.selected) this._drawInkSelection(textCorners(st).map(q => v.worldToScreen(q)), 0);
  }

  /** An imported picture, mapped onto its three corner points (so it
   *  turns, stretches and mirrors with them), with its transparency.
   *  A dashed frame stands in while it loads or when its data is missing. */
  drawImageItem(st) {
    const ctx = this.ctx, v = this.view;
    const [a, b, c] = st.points.map(p => v.worldToScreen(p));
    const img = imageElement(st.image);
    ctx.save();
    ctx.globalAlpha *= st.opacity ?? 1;
    if (img) {
      const W = img.naturalWidth, H = img.naturalHeight;
      ctx.transform((b.x - a.x) / W, (b.y - a.y) / W, (c.x - a.x) / H, (c.y - a.y) / H, a.x, a.y);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0);
    } else {
      const q = imageCorners(st).map(p => v.worldToScreen(p));
      ctx.beginPath();
      q.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.fillStyle = withAlpha(this.theme.ink, 0.06);
      ctx.fill();
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = withAlpha(this.theme.ink, 0.45);
      ctx.stroke();
      ctx.beginPath(); ctx.moveTo(q[0].x, q[0].y); ctx.lineTo(q[2].x, q[2].y); ctx.moveTo(q[1].x, q[1].y); ctx.lineTo(q[3].x, q[3].y);
      ctx.stroke();
    }
    ctx.restore();
    if (st.selected) this._drawInkSelection(imageCorners(st).map(p => v.worldToScreen(p)), 0);
  }

  /** An arrow: a straight line from tail to tip with a head at the
   *  tip (and the tail for 'both'): filled, open or a dot. A filled head
   *  ends the line at its base so the tip stays sharp. */
  drawArrow(st) {
    const ctx = this.ctx, v = this.view;
    const [t0, t1] = st.points.map(p => v.worldToScreen(p));
    const w = Math.max(0.75, st.width * v.zoom);
    const len = Math.hypot(t1.x - t0.x, t1.y - t0.y);
    const ink = st.color === INK ? this.theme.ink : st.color;
    ctx.save();
    ctx.globalAlpha *= st.opacity ?? 1;
    ctx.strokeStyle = ink; ctx.fillStyle = ink;
    ctx.lineWidth = w; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (len < 0.5) { ctx.beginPath(); ctx.arc(t0.x, t0.y, w / 2, 0, Math.PI * 2); ctx.fill(); ctx.restore(); return; }
    const ux = (t1.x - t0.x) / len, uy = (t1.y - t0.y) / len;
    const hs = headSize(w);
    const head = st.head || 'filled';
    // never let the heads eat more than 45 % of the line each
    const hl = Math.min(hs.len, len * 0.45), hh = hs.half * (hl / hs.len);
    const [hasTail, hasTip] = headedEnds(st);
    const inset = (on) => (on && head === 'filled' ? hl * 0.9 : on && head === 'dot' ? hh * 0.8 : 0);
    const a = { x: t0.x + ux * inset(hasTail), y: t0.y + uy * inset(hasTail) };
    const b = { x: t1.x - ux * inset(hasTip), y: t1.y - uy * inset(hasTip) };
    if (st.dash) ctx.setLineDash([w * 3.2, w * 2.4]);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.setLineDash([]);
    const drawHead = (tip, dx, dy) => {
      ctx.beginPath();
      if (head === 'dot') {
        ctx.arc(tip.x, tip.y, Math.max(w * 0.9, hh * 0.8), 0, Math.PI * 2);
        ctx.fill();
        return;
      }
      const bx = tip.x - dx * hl, by = tip.y - dy * hl;
      ctx.moveTo(bx - dy * hh, by + dx * hh);
      ctx.lineTo(tip.x, tip.y);
      ctx.lineTo(bx + dy * hh, by - dx * hh);
      if (head === 'filled') { ctx.closePath(); ctx.fill(); ctx.stroke(); } else ctx.stroke();
    };
    if (hasTip) drawHead(t1, ux, uy);
    if (hasTail) drawHead(t0, -ux, -uy);
    ctx.restore();
    if (st.selected) this._drawInkSelection([t0, t1], hs.half * 2);
  }

  /** Handles at both ends of a selected arrow; an attached end is a
   *  filled dot (it sits on a shape). */
  drawArrowHandles(item, scale = 1) {
    const ctx = this.ctx, v = this.view;
    ctx.save();
    ctx.globalAlpha = 1;
    item.points.forEach((p, i) => {
      const q = v.worldToScreen(p);
      const attached = !!(item.at && item.at[i]);
      ctx.beginPath(); ctx.arc(q.x, q.y, 5 * scale, 0, Math.PI * 2);
      ctx.fillStyle = attached ? this.theme.selected : this.theme.previewHalo;
      ctx.fill();
      ctx.lineWidth = 1.5; ctx.strokeStyle = this.theme.selected; ctx.stroke();
    });
    ctx.restore();
  }

  /** Transform box around selected ink: dashed frame, square handles at
   *  the corners and edge middles, and a round turn handle on a stem
   *  above the top edge. `corners` are the 4 screen corners (TL, TR, BR,
   *  BL), `turn` the turn handle's screen position. */
  drawTransformBox(corners, turn, scale = 1, label = null) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = this.theme.selected;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    corners.forEach((c, i) => (i ? ctx.lineTo(c.x, c.y) : ctx.moveTo(c.x, c.y)));
    ctx.closePath(); ctx.stroke();
    ctx.setLineDash([]);
    const topMid = { x: (corners[0].x + corners[1].x) / 2, y: (corners[0].y + corners[1].y) / 2 };
    ctx.beginPath(); ctx.moveTo(topMid.x, topMid.y); ctx.lineTo(turn.x, turn.y); ctx.stroke();
    const hs = 4 * scale;
    const square = (p) => { ctx.beginPath(); ctx.rect(p.x - hs, p.y - hs, hs * 2, hs * 2); ctx.fill(); ctx.stroke(); };
    ctx.fillStyle = this.theme.previewHalo;
    for (let i = 0; i < 4; i++) {
      const a = corners[i], b = corners[(i + 1) % 4];
      square(a);
      square({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    }
    // turn handle: a circle with a small curved arrow
    const r = 6 * scale;
    ctx.beginPath(); ctx.arc(turn.x, turn.y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(turn.x, turn.y, r * 0.5, -Math.PI * 0.9, Math.PI * 0.4); ctx.stroke();
    if (label) {
      ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillStyle = this.theme.selected;
      ctx.fillText(label, turn.x, turn.y - r - 4);
    }
    ctx.restore();
  }

  /** Fill colour of a text box: 'paper' is the canvas colour. */
  boxColor(c) {
    if (c === PAPER) return this.background ? (this.background === INK ? this.theme.ink : this.background) : this.theme.paper;
    return c === INK ? this.theme.ink : c;
  }

  /** Selected linked ink: a dotted leader from the ink to the spot it
   *  follows, and a small ring there. */
  drawInkLink(from, to) {
    const ctx = this.ctx, v = this.view;
    const a = v.worldToScreen(from), b = v.worldToScreen(to);
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = this.theme.selected;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = this.theme.previewHalo;
    ctx.beginPath(); ctx.arc(b.x, b.y, 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  /** Selected ink: a dashed box around it, in the selection colour. */
  _drawInkSelection(pts, w) {
    const ctx = this.ctx;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) { if (p.x < x0) x0 = p.x; if (p.y < y0) y0 = p.y; if (p.x > x1) x1 = p.x; if (p.y > y1) y1 = p.y; }
    const m = w / 2 + 4;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = this.theme.selected;
    ctx.strokeRect(x0 - m, y0 - m, x1 - x0 + 2 * m, y1 - y0 + 2 * m);
    ctx.restore();
  }

  /** Brush footprint under the cursor for the Sketch tools. */
  drawBrush(b) {
    const ctx = this.ctx, v = this.view;
    const c = v.worldToScreen(b.center);
    const r = Math.max(2, b.r * v.zoom);
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = this.theme.previewHalo;
    ctx.beginPath(); ctx.arc(c.x, c.y, r + 1, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = b.erase ? this.theme.over : this.theme.preview;
    if (b.erase) ctx.setLineDash([3, 2]);
    ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }

  /** A painted area: outline and holes, even-odd. */
  _drawPaint(p) {
    const ctx = this.ctx, v = this.view;
    ctx.save();
    ctx.beginPath();
    for (const loop of [p.region.outer, ...p.region.holes]) {
      loop.forEach((q, i) => { const s = v.worldToScreen(q); if (i) ctx.lineTo(s.x, s.y); else ctx.moveTo(s.x, s.y); });
      ctx.closePath();
    }
    ctx.fillStyle = withAlpha(p.color === INK ? this.theme.ink : p.color, p.opacity ?? 1);
    ctx.fill('evenodd');
    ctx.restore();
  }












  drawSnapMarker(snap) {
    if (!snap) return;
    const v = this.view, ctx = this.ctx;
    const s = v.worldToScreen(snap);
    ctx.save();
    ctx.strokeStyle = this.theme.preview; ctx.fillStyle = this.theme.previewHalo; ctx.lineWidth = 1.4;
    ctx.beginPath();
    if (snap.kind === 'endpoint')      ctx.rect(s.x-5, s.y-5, 10, 10);
    else if (snap.kind === 'midpoint') { ctx.moveTo(s.x, s.y-6); ctx.lineTo(s.x+6, s.y); ctx.lineTo(s.x, s.y+6); ctx.lineTo(s.x-6, s.y); ctx.closePath(); }
    else if (snap.kind === 'center')   ctx.arc(s.x, s.y, 5, 0, TAU);
    else                                ctx.arc(s.x, s.y, 4, 0, TAU);
    ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  drawTempPath(pathPoints, dashed=false, color=null) {
    if (!pathPoints || pathPoints.length < 2) return;
    const v = this.view, ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = color ? (color === INK ? this.theme.ink : color) : this.theme.preview; ctx.lineWidth = color ? 1.6 : 1.2;
    if (dashed) ctx.setLineDash([5, 4]);
    ctx.beginPath();
    const a = v.worldToScreen(pathPoints[0]);
    ctx.moveTo(a.x, a.y);
    for (let i = 1; i < pathPoints.length; i++) {
      const p = v.worldToScreen(pathPoints[i]);
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    ctx.restore();
  }

  drawTempCircle(center, radius, color=null) {
    const v = this.view, ctx = this.ctx;
    const c = v.worldToScreen(center);
    ctx.save();
    ctx.strokeStyle = color ? (color === INK ? this.theme.ink : color) : this.theme.preview; ctx.lineWidth = color ? 1.6 : 1.2;
    if (!color) ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.arc(c.x, c.y, radius * v.zoom, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  drawTempArc(center, radius, a0, a1, clockwise=false) {
    const v = this.view, ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = this.theme.preview; ctx.lineWidth = 1.2;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    drawDirectedArcPath(ctx, v, center, radius, a0, a1, clockwise);
    ctx.stroke();
    ctx.restore();
  }

  drawTempPoint(point) {
    if (!point) return;
    const v = this.view, ctx = this.ctx;
    const p = v.worldToScreen(point);
    ctx.save();
    ctx.fillStyle = this.theme.preview;
    ctx.strokeStyle = this.theme.previewHalo;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, TAU);
    ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  drawSelectionBox(box) {
    if (!box) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = this.theme.accent;
    ctx.fillStyle = this.theme.accentFill;
    ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.rect(box.x, box.y, box.w, box.h);
    ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  drawDimPicks(picks) {
    if (!picks || !picks.length) return;
    const v = this.view, ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = this.theme.selected;
    ctx.fillStyle = this.theme.pickFill;
    ctx.lineWidth = 2;
    for (const e of picks) {
      if (e instanceof Point) {
        const p = v.worldToScreen(e);
        ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, TAU);
        ctx.fill(); ctx.stroke();
      } else if (e instanceof Line) {
        const a = v.worldToScreen(e.p1), b = v.worldToScreen(e.p2);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        ctx.stroke();
      } else if (e instanceof Circle) {
        const c = v.worldToScreen(e.center);
        ctx.beginPath(); ctx.arc(c.x, c.y, e.r * v.zoom, 0, TAU);
        ctx.stroke();
      } else if (e instanceof Arc) {
        e.syncEnds();
        ctx.beginPath(); drawDirectedArcPath(ctx, v, e.center, e.r, e.a0, e.a1, e.clockwise);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /* ----- Dimension labels on the canvas ----- */
  /** @param layerState (c) => 'active' | 'inactive' | 'hidden': dimensions
   *  belong to a layer; hidden ones aren't drawn, inactive ones are drawn
   *  grey and can't be picked (no hit rectangle). */
  /* ---------------- Relation badges ----------------
     Every geometric relation (coincident, horizontal, parallel, …) is
     shown as a small badge where it acts: at the point it ties, at the
     middle of each line it relates, or on the circle. Badges sharing a
     spot are lined up side by side. Like dimensions they follow their
     layer: hidden with it, grey when inactive, pickable only on the
     active layer. */

  /** World anchors of a relation: [{ x, y, kind:'point'|'line'|'circle', nx, ny }]. */
  _relationAnchors(c, entMap) {
    const P = (id) => { const e = entMap.get(id); return e && Number.isFinite(e.x) ? e : null; };
    const L = (l) => { const a = P(l?.a), b = P(l?.b); return a && b ? { a, b } : null; };
    const arcEnd = (ref) => {
      const arc = entMap.get(ref?.arcId); if (!arc || !arc.syncEnds) return null;
      arc.syncEnds(); return ref.which === 'end' ? arc.end : arc.start;
    };
    const ptRef = (ref) => ref?.pointId ? P(ref.pointId) : arcEnd(ref);
    const atPoint = (p) => p ? [{ x: p.x, y: p.y, kind: 'point' }] : [];
    const atLine = (l) => {
      if (!l) return [];
      const dx = l.b.x - l.a.x, dy = l.b.y - l.a.y, len = Math.hypot(dx, dy) || 1;
      return [{ x: (l.a.x + l.b.x) / 2, y: (l.a.y + l.b.y) / 2, kind: 'line', nx: -dy / len, ny: dx / len }];
    };
    const lineById = (id) => { const e = entMap.get(id); return e instanceof Line ? { a: e.p1, b: e.p2 } : null; };
    const atCircle = (id) => { const e = entMap.get(id); return e && e.center && Number.isFinite(e.r) ? [{ x: e.center.x, y: e.center.y + e.r, kind: 'circle' }] : []; };
    switch (c.kind) {
      case 'coincident': return atPoint(P(c.p1));
      case 'fix': case 'midpoint': case 'pointOnLine': case 'pointOnCircle': return atPoint(P(c.pointId));
      case 'arcEndpointCoincident': case 'arcEndpointFix': case 'arcEndpointMidpoint':
      case 'arcEndpointOnLine': case 'arcEndpointOnCircle': return atPoint(arcEnd(c.ref));
      case 'arcEndpointArcEndpointCoincident': return atPoint(arcEnd(c.ref1));
      case 'symmetric': return [...atPoint(P(c.p1)), ...atPoint(P(c.p2))];
      case 'concentric': return atPoint(P(c.p1));
      case 'horizontal': case 'vertical': return atLine(lineById(c.lineId) || L({ a: c.p1, b: c.p2 }));
      case 'pointRefHorizontal': case 'pointRefVertical': {
        const a = ptRef(c.ref1), b = ptRef(c.ref2);
        return a && b ? atLine({ a, b }) : [];
      }
      case 'parallel': case 'perpendicular': case 'collinear': case 'equalLength':
        return [...atLine(L(c.l1)), ...atLine(L(c.l2))];
      case 'equalRadius': return [...atCircle(c.c1), ...atCircle(c.c2)];
      case 'tangent': return [...atLine(L(c.l)), ...atCircle(c.circleId)];
      case 'tangentCC': return [...atCircle(c.c1), ...atCircle(c.c2)];
    }
    return [];
  }

  drawRelations(sketch, entMap, redundantIds, layerState = () => 'active') {
    this.lastRelRects = [];
    if (!sketch) return;
    const ctx = this.ctx, v = this.view, t = this.theme;
    const slots = new Map();                 // anchor key → badges placed there
    const size = this.badgeSize || 15;   // larger for touch (touch.js)
    ctx.save();
    ctx.font = '600 10px ui-sans-serif, system-ui, -apple-system, "Segoe UI"';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const c of sketch.constraints) {
      const glyph = CONSTRAINT_GLYPHS[c.kind];
      if (!glyph || c.kind === 'offset' || c.value != null) continue;   // dimensions are drawn elsewhere
      const st = layerState(c);
      if (st === 'hidden') continue;
      const anchors = this._relationAnchors(c, entMap);
      if (!anchors.length) continue;
      const lit = c.selected || c.hover;          // hover: from the Properties list
      const colour = lit ? t.selected
        : st !== 'active' ? t.dimGrey
        : (redundantIds && redundantIds.has(c.id)) ? t.over : t.accent;
      for (const an of anchors) {
        const sp = v.worldToScreen(an);
        let ox = 11, oy = -13;
        if (an.kind === 'line') { ox = an.nx * 13; oy = -an.ny * 13; }
        if (an.kind === 'circle') { ox = 0; oy = -12; }
        const key = Math.round(sp.x + ox) + ',' + Math.round(sp.y + oy);
        const n = slots.get(key) || 0;
        slots.set(key, n + 1);
        const x = sp.x + ox + n * (size + 2) - size / 2, y = sp.y + oy - size / 2;
        ctx.globalAlpha = st === 'active' ? 1 : 0.7;
        ctx.fillStyle = t.previewHalo;
        ctx.strokeStyle = colour;
        ctx.lineWidth = lit ? 1.6 : 1;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x, y, size, size, 3); else ctx.rect(x, y, size, size);
        ctx.fill(); ctx.stroke();
        ctx.fillStyle = colour;
        ctx.fillText(glyph, x + size / 2, y + size / 2 + 0.5);
        if (lit) {                            // show what it ties
          ctx.beginPath(); ctx.arc(sp.x, sp.y, 5, 0, TAU); ctx.stroke();
        }
        if (st === 'active') this.lastRelRects.push({ constraint: c, x, y, w: size, h: size });
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  drawDimensions(sketch, entMap, redundantIds, layerState = () => 'active') {
    if (!sketch) return;
    // remember the screen-space rect of every label we draw so the app can
    // hit-test them for click-to-edit / drag-to-move
    this.lastDimRects = [];
    for (const c of sketch.constraints) {
      const st = layerState(c);
      if (st === 'hidden') continue;
      this._recordRects = st === 'active';
      const grey = st !== 'active' || c.driven || (redundantIds && redundantIds.has(c.id));
      switch (c.kind) {
        case 'distance':          this._drawDistance(c, entMap, grey); break;
        case 'curveDistance':     this._drawCurveDistance(c, entMap, grey); break;
        case 'pointLineDistance': this._drawPLDistance(c, entMap, grey); break;
        case 'offsetDistance':    this._drawOffsetDistance(c, entMap, grey); break;
        case 'radius':            this._drawRadius(c, entMap, grey); break;
        case 'angle':             this._drawAngle(c, entMap, grey); break;
      }
    }
    this._recordRects = true;
  }

  /** Draw a SmartDim preview that follows the cursor — synthesises a
   *  fake constraint + entity map and reuses the committed-dimension
   *  drawing routines so the preview looks identical to what gets
   *  saved. */
  drawDimPreview(preview) {
    if (!preview) return;
    if (preview.kind === 'distance') {
      const fake = { p1:'_a', p2:'_b', value: preview.value, axis: preview.axis || null,
                      labelOffset: preview.offset, labelParallel: preview.parallel };
      const map = new Map([['_a', preview.p1], ['_b', preview.p2]]);
      this._drawDistance(fake, map, false);
    } else if (preview.kind === 'curveDistance') {
      const fake = {
        c1:'_c1', c2:'_c2', mode: preview.mode, value: preview.value,
        labelOffset: preview.offset, labelParallel: preview.parallel,
        labelAngle: preview.angle, labelDist: preview.dist
      };
      const map = new Map([['_c1', preview.c1], ['_c2', preview.c2]]);
      this._drawCurveDistance(fake, map, false);
    } else if (preview.kind === 'pointLineDistance') {
      const fake = { pointId:'_p', l:{a:'_la', b:'_lb'}, value: preview.value,
                      labelOffset: preview.offset, labelParallel: preview.parallel };
      const map = new Map([['_p', preview.p], ['_la', preview.line.p1], ['_lb', preview.line.p2]]);
      this._drawPLDistance(fake, map, false);
    } else if (preview.kind === 'radius' || preview.kind === 'diameter') {
      const fake = {
        circleId:'_c',
        value: preview.kind === 'diameter' ? preview.value / 2 : preview.value,
        labelAngle: preview.angle,
        labelDist:  preview.dist,
        isDiameter: preview.kind === 'diameter'
      };
      const map = new Map([['_c', preview.circle]]);
      this._drawRadius(fake, map, false);
    } else if (preview.kind === 'angle') {
      const fake = {
        l1: preview.l1Ref || { a:preview.l1.p1.id, b:preview.l1.p2.id },
        l2: preview.l2Ref || { a:preview.l2.p1.id, b:preview.l2.p2.id },
        value: preview.value, labelDist: preview.dist,
        labelMidAngle: preview.midAngle
      };
      const map = new Map([
        [preview.l1.p1.id, preview.l1.p1], [preview.l1.p2.id, preview.l1.p2],
        [preview.l2.p1.id, preview.l2.p1], [preview.l2.p2.id, preview.l2.p2]
      ]);
      this._drawAngle(fake, map, false);
    }
  }

  /** Dimension label text, decorated by the app (Σ for equations,
   *  names when shown). Previews pass objects without a name. */
  _label(c, text) {
    return this.labelFor && c && c.id ? this.labelFor(c, text) : text;
  }

  _dimColors(grey, selected = false) {
    return selected
      ? { stroke: this.theme.selected, fill: this.theme.selected, text: this.theme.dimSelectedText }
      : grey
      ? { stroke: this.theme.dimGrey, fill: this.theme.dimGrey, text: this.theme.dimGreyText }
      : { stroke: this.theme.dim, fill: this.theme.dim, text: this.theme.dim };
  }

  _drawArrow(ctx, tip, dir) {
    // dir is a screen-space unit vector pointing AWAY from tip (along the
    // dimension line). Arrow head points back toward tip.
    const len = 7, spread = 0.38;
    const cs = Math.cos(spread), sn = Math.sin(spread);
    const ax = tip.x + len * (dir.x*cs - dir.y*sn);
    const ay = tip.y + len * (dir.y*cs + dir.x*sn);
    const bx = tip.x + len * (dir.x*cs + dir.y*sn);
    const by = tip.y + len * (dir.y*cs - dir.x*sn);
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y); ctx.lineTo(ax, ay); ctx.lineTo(bx, by);
    ctx.closePath(); ctx.fill();
  }

  _drawText(ctx, x, y, text, color, angleRad = 0) {
    ctx.save();
    ctx.translate(x, y);
    let a = angleRad;
    if (a > Math.PI/2)  a -= Math.PI;
    if (a < -Math.PI/2) a += Math.PI;
    ctx.rotate(a);
    ctx.font = '11px ui-sans-serif, system-ui, -apple-system, "Segoe UI"';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Subtle stroke under the text so it stays legible over grid / lines
    // without painting a hard white background rectangle.
    ctx.lineWidth = 3;
    ctx.strokeStyle = this.theme.textHalo;
    ctx.lineJoin = 'round';
    ctx.strokeText(text, 0, 0);
    ctx.fillStyle = color;
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }

  _drawDistance(c, entMap, grey, recordAs) {
    const p1 = entMap.get(c.p1), p2 = entMap.get(c.p2);
    if (!p1 || !p2) return;
    // Aligned (true length), or horizontal / vertical distance: one frame.
    const fr = distanceFrame(p1, p2, c.axis);
    const len = fr.len;
    if (len < EPS) return;
    const v = this.view, ctx = this.ctx;

    const offsetWorld   = (c.labelOffset   != null) ? c.labelOffset   : (12 / v.zoom);
    const parallelWorld = (c.labelParallel != null) ? c.labelParallel : 0;
    const { x: nx, y: ny } = fr.n;  // normal: the label is offset along it
    const { x: tx, y: ty } = fr.t;  // direction the value is measured in

    // Feet of the extension lines on the dim line; the text rides at the
    // midpoint + tangent * parallel.
    const a = { x: fr.a0.x + nx * offsetWorld, y: fr.a0.y + ny * offsetWorld };
    const b = { x: fr.b0.x + nx * offsetWorld, y: fr.b0.y + ny * offsetWorld };
    const labelMid = {
      x: fr.mid.x + nx * offsetWorld + tx * parallelWorld,
      y: fr.mid.y + ny * offsetWorld + ty * parallelWorld
    };

    const pa = v.worldToScreen(a), pb = v.worldToScreen(b);
    const pp1 = v.worldToScreen(p1), pp2 = v.worldToScreen(p2);
    const plab = v.worldToScreen(labelMid);

    const target = recordAs || c;
    const cols = this._dimColors(grey, !!(target.selected || target.hover));
    ctx.save();
    ctx.strokeStyle = cols.stroke; ctx.fillStyle = cols.fill; ctx.lineWidth = 1;

    // Extension lines from each anchor to its foot (small gap at the
    // anchor, a little past the dim line). For horizontal / vertical
    // dimensions the two have different lengths.
    ctx.beginPath();
    for (const [from, to] of [[pp1, pa], [pp2, pb]]) {
      const ux = to.x - from.x, uy = to.y - from.y, ul = Math.hypot(ux, uy);
      if (ul < 1e-6) continue;
      const e = { x: ux / ul, y: uy / ul };
      ctx.moveTo(from.x + e.x * 4, from.y + e.y * 4);
      ctx.lineTo(to.x + e.x * 4, to.y + e.y * 4);
    }

    // The dim line spans from foot a to foot b, but if the label sits past
    // one of the feet (cursor was dragged outside the segment) we extend
    // the line out to the label so the text is on the line.
    const segLen = len; // = |b - a| in world
    const tParam = parallelWorld / segLen + 0.5; // 0=at a, 1=at b
    let dimStart = pa, dimEnd = pb;
    if (tParam < 0)      dimStart = plab;
    else if (tParam > 1) dimEnd   = plab;
    ctx.moveTo(dimStart.x, dimStart.y); ctx.lineTo(dimEnd.x, dimEnd.y);
    ctx.stroke();

    // Arrows always sit at the feet, pointing inward toward each other.
    const dxs = pb.x - pa.x, dys = pb.y - pa.y;
    const dl  = Math.hypot(dxs, dys) || 1;
    const dir = { x: dxs/dl, y: dys/dl };
    this._drawArrow(ctx, pa, dir);
    this._drawArrow(ctx, pb, { x: -dir.x, y: -dir.y });

    const text = this._label(recordAs || c, (c.value != null) ? Number(c.value).toFixed(2) : len.toFixed(2));
    this._drawText(ctx, plab.x, plab.y, text, cols.text, Math.atan2(dys, dxs));
    ctx.restore();

    if (this.lastDimRects && this._recordRects !== false) {
      ctx.font = '11px ui-sans-serif, system-ui, -apple-system, "Segoe UI"';
      const w = ctx.measureText(text).width;
      this.lastDimRects.push({
        constraint: target,
        x: plab.x - w/2 - 4, y: plab.y - 9, w: w + 8, h: 18
      });
    }
  }

  _drawPLDistance(c, entMap, grey) {
    const pt = entMap.get(c.pointId);
    const la = entMap.get(c.l.a), lb = entMap.get(c.l.b);
    if (!pt || !la || !lb) return;
    const dx = lb.x - la.x, dy = lb.y - la.y;
    const len2 = dx*dx + dy*dy;
    if (len2 < EPS) return;
    const t = ((pt.x - la.x)*dx + (pt.y - la.y)*dy) / len2;
    const foot = { x: la.x + t*dx, y: la.y + t*dy };
    // Render as a distance dim between the point and its foot, carrying
    // the constraint's labelOffset through so the dim line stays where
    // the user placed it. Record under the original PLD constraint so
    // hit-testing finds it.
    this._drawDistance(
      { p1: '_a', p2: '_b', value: c.value,
        labelOffset: c.labelOffset, labelParallel: c.labelParallel },
      new Map([['_a', pt], ['_b', foot]]),
      grey,
      c
    );
  }

  _drawOffsetDistance(c, entMap, grey) {
    // Render one shared dimension annotation using the first pair,
    // but register `c` (not a fake) for hit-testing so clicking/dragging
    // the label edits the real OffsetDistanceConstraint.
    if (!c.pairs || !c.pairs.length) return;
    const first = c.pairs[0];
    if (first.kind === 'line') {
      const src = entMap.get(first.sourceEntityId);
      const dst = entMap.get(first.targetEntityId);
      const la = src instanceof Line ? src.p1 : entMap.get(first.l.a);
      const lb = src instanceof Line ? src.p2 : entMap.get(first.l.b);
      const pt = dst instanceof Line
        ? { x:(dst.p1.x + dst.p2.x) / 2, y:(dst.p1.y + dst.p2.y) / 2 }
        : entMap.get(first.pointId);
      if (!pt || !la || !lb) return;
      const dx = lb.x - la.x, dy = lb.y - la.y;
      const len2 = dx*dx + dy*dy; if (len2 < EPS) return;
      const t = ((pt.x - la.x)*dx + (pt.y - la.y)*dy) / len2;
      const foot = { x: la.x + t*dx, y: la.y + t*dy };
      this._drawDistance(
        { p1:'_a', p2:'_b', value:c.value, labelOffset:c.labelOffset, labelParallel:c.labelParallel },
        new Map([['_a', pt], ['_b', foot]]),
        grey, c
      );
    } else {
      const a = entMap.get(first.c1), b = entMap.get(first.c2);
      if (!a || !b) return;
      const outer = a.r >= b.r ? a : b;
      const inner = outer === a ? b : a;
      const angle = (c.labelAngle != null) ? c.labelAngle : Math.PI / 6;
      const labelDist = (c.labelDist != null) ? c.labelDist : (outer.r + 14 / this.view.zoom);
      const p1 = { x: inner.center.x + inner.r * Math.cos(angle), y: inner.center.y + inner.r * Math.sin(angle) };
      const p2 = { x: outer.center.x + outer.r * Math.cos(angle), y: outer.center.y + outer.r * Math.sin(angle) };
      this._drawDistance(
        { p1:'_a', p2:'_b', value:c.value, labelOffset:0,
          labelParallel: labelDist - (inner.r + outer.r) / 2 },
        new Map([['_a', p1], ['_b', p2]]),
        grey, c
      );
    }
  }

  _drawCurveDistance(c, entMap, grey) {
    const a = entMap.get(c.c1), b = entMap.get(c.c2);
    if (!a || !b) return;
    if (c.mode === 'gap') {
      const dx = b.center.x - a.center.x, dy = b.center.y - a.center.y;
      const d = Math.hypot(dx, dy);
      if (d < EPS) return;
      const ux = dx / d, uy = dy / d;
      const p1 = { x: a.center.x + ux * a.r, y: a.center.y + uy * a.r };
      const p2 = { x: b.center.x - ux * b.r, y: b.center.y - uy * b.r };
      this._drawDistance(
        { p1:'_a', p2:'_b', value:c.value, labelOffset:c.labelOffset, labelParallel:c.labelParallel },
        new Map([['_a', p1], ['_b', p2]]),
        grey,
        c
      );
      return;
    }

    const outer = a.r >= b.r ? a : b;
    const inner = outer === a ? b : a;
    const angle = (c.labelAngle != null) ? c.labelAngle : Math.PI / 6;
    const labelDist = (c.labelDist != null) ? c.labelDist : (outer.r + 14 / this.view.zoom);
    const p1 = { x: inner.center.x + inner.r * Math.cos(angle), y: inner.center.y + inner.r * Math.sin(angle) };
    const p2 = { x: outer.center.x + outer.r * Math.cos(angle), y: outer.center.y + outer.r * Math.sin(angle) };
    const fake = {
      p1:'_a', p2:'_b', value:c.value,
      labelOffset:0,
      labelParallel: labelDist - (inner.r + outer.r) / 2
    };
    this._drawDistance(fake, new Map([['_a', p1], ['_b', p2]]), grey, c);
  }

  _drawRadius(c, entMap, grey) {
    const circ = entMap.get(c.circleId);
    if (!circ) return;
    const center = circ.center;
    const r = circ.r;
    const v = this.view, ctx = this.ctx;
    const cols = this._dimColors(grey, !!(c.selected || c.hover));

    const angle = (c.labelAngle != null) ? c.labelAngle : Math.PI/6;
    // labelDist controls inside-vs-outside placement based on cursor
    // distance from center. Inside (labelDist < r) → label inside the
    // circle, arrow at rim points outward. Outside (labelDist >= r) →
    // label past the rim, arrow at rim points inward at the center.
    let labelDist;
    if (c.labelDist != null) {
      labelDist = c.labelDist;
    } else {
      const radPx = r * v.zoom;
      labelDist = (radPx > 60) ? Math.max(r * 0.45, r - 26 / v.zoom) : (r + 14 / v.zoom);
    }
    const insideMode = labelDist < r;
    const rim   = { x: center.x + r * Math.cos(angle),         y: center.y + r * Math.sin(angle) };
    const label = { x: center.x + labelDist * Math.cos(angle), y: center.y + labelDist * Math.sin(angle) };
    const pcen = v.worldToScreen(center);
    const prim = v.worldToScreen(rim);
    const plab = v.worldToScreen(label);

    let arrowDir;
    if (insideMode) {
      const dxs = prim.x - pcen.x, dys = prim.y - pcen.y;
      const dl = Math.hypot(dxs, dys) || 1;
      arrowDir = { x: dxs / dl, y: dys / dl };
    } else {
      const dxs = pcen.x - prim.x, dys = pcen.y - prim.y;
      const dl = Math.hypot(dxs, dys) || 1;
      arrowDir = { x: dxs / dl, y: dys / dl };
    }

    ctx.save();
    ctx.strokeStyle = cols.stroke; ctx.fillStyle = cols.fill; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plab.x, plab.y); ctx.lineTo(prim.x, prim.y);
    ctx.stroke();
    this._drawArrow(ctx, prim, arrowDir);

    const radius = c.value ?? r;
    const txt = this._label(c, c.isDiameter
      ? '⌀' + Number(radius * 2).toFixed(2)
      : 'R' + Number(radius).toFixed(2));
    this._drawText(ctx, plab.x, plab.y, txt, cols.text, 0);
    ctx.restore();

    if (this.lastDimRects && this._recordRects !== false) {
      ctx.font = '11px ui-sans-serif, system-ui, -apple-system, "Segoe UI"';
      const w = ctx.measureText(txt).width;
      this.lastDimRects.push({ constraint: c, x: plab.x - w/2 - 4, y: plab.y - 9, w: w + 8, h: 18 });
    }
  }

  _drawAngle(c, entMap, grey) {
    const a1 = entMap.get(c.l1.a), b1 = entMap.get(c.l1.b);
    const a2 = entMap.get(c.l2.a), b2 = entMap.get(c.l2.b);
    if (!a1 || !b1 || !a2 || !b2) return;
    const inter = lineIntersection(a1, b1, a2, b2);
    if (!inter) return;

    const v = this.view, ctx = this.ctx;
    const cols = this._dimColors(grey, !!(c.selected || c.hover));
    const sector = angleSectorForValue(
      { p1:a1, p2:b1 },
      { p1:a2, p2:b2 },
      c.value ?? angleArcFromPoints(a1, b1, a2, b2).span,
      c.labelMidAngle
    );
    if (!sector) return;
    const arc = sector;
    const e1a = entMap.get(sector.l1Ref.a), e1b = entMap.get(sector.l1Ref.b);
    const e2a = entMap.get(sector.l2Ref.a), e2b = entMap.get(sector.l2Ref.b);
    if (!e1a || !e1b || !e2a || !e2b) return;
    const pinter = v.worldToScreen(inter);
    const radPx = Math.max(10, (c.labelDist != null) ? c.labelDist * v.zoom : 32);
    const labelDistWorld = radPx / v.zoom;

    ctx.save();
    ctx.strokeStyle = cols.stroke; ctx.fillStyle = cols.fill; ctx.lineWidth = 1;
    // Canvas y is flipped relative to math angles — negate for arc().
    ctx.beginPath();
    ctx.arc(pinter.x, pinter.y, radPx, -arc.start, -arc.end, true);
    ctx.stroke();

    // Dashed extension lines linking each measured line segment to the
    // arc-touch point on its bounding ray. Drawn whenever the segment
    // doesn't naturally cover that point — e.g. the arc radius is past
    // the segment's far end, or the segment lies on the opposite side
    // of the intersection from the picked sector. Three cases per line:
    //   labelDist in [tLo, tHi]  → no extension (segment covers it)
    //   labelDist >  tHi         → extension from far endpoint outward
    //   labelDist <  tLo         → extension from near endpoint inward
    // The "wrong-sector" case (both projections negative) falls into the
    // second branch and the resulting dashed line passes through inter.
    const drawAngleExtension = (pA, pB) => {
      const dx = pB.x - pA.x, dy = pB.y - pA.y;
      const dlen = Math.hypot(dx, dy);
      if (dlen < EPS) return;
      const dxN = dx / dlen, dyN = dy / dlen;
      const tA = (pA.x - inter.x) * dxN + (pA.y - inter.y) * dyN;
      const tB = (pB.x - inter.x) * dxN + (pB.y - inter.y) * dyN;
      const tLo = Math.min(tA, tB), tHi = Math.max(tA, tB);
      // Small tolerance so floating-point chatter doesn't make the
      // extension flicker on/off when labelDist is right at an endpoint.
      const tol = 0.5 / v.zoom;
      if (labelDistWorld >= tLo - tol && labelDistWorld <= tHi + tol) return;
      // The segment endpoint closest to the arc point along the ray.
      const nearT = Math.abs(tA - labelDistWorld) < Math.abs(tB - labelDistWorld) ? tA : tB;
      const fromWorld = { x: inter.x + nearT * dxN, y: inter.y + nearT * dyN };
      const toWorld   = { x: inter.x + labelDistWorld * dxN, y: inter.y + labelDistWorld * dyN };
      const sFrom = v.worldToScreen(fromWorld), sTo = v.worldToScreen(toWorld);
      const sdx = sTo.x - sFrom.x, sdy = sTo.y - sFrom.y;
      const sl  = Math.hypot(sdx, sdy);
      // Skip very short extensions — they read as noise rather than
      // intent. 3px is roughly the threshold where the dash pattern
      // would only show a single tick anyway.
      if (sl < 3) return;
      // 4px gap at the segment endpoint, matching the convention used
      // by distance dim extension lines.
      const gap = Math.min(4, sl / 3);
      const ux = sdx / sl, uy = sdy / sl;
      ctx.save();
      ctx.strokeStyle = cols.stroke;
      ctx.lineWidth = 0.8;
      ctx.setLineDash([5, 3]);
      ctx.beginPath();
      ctx.moveTo(sFrom.x + ux * gap, sFrom.y + uy * gap);
      ctx.lineTo(sTo.x, sTo.y);
      ctx.stroke();
      ctx.restore();
    };
    drawAngleExtension(e1a, e1b);
    drawAngleExtension(e2a, e2b);

    const midAng = arc.midAngle;
    const value = normalizeAngleValue(c.value ?? arc.span);
    const txt = this._label(c, (value * 180 / Math.PI).toFixed(1) + '°');
    const tx = pinter.x + (radPx + 12) * Math.cos(midAng);
    const ty = pinter.y - (radPx + 12) * Math.sin(midAng); // flip y
    this._drawText(ctx, tx, ty, txt, cols.text, 0);
    ctx.restore();

    if (this.lastDimRects && this._recordRects !== false) {
      ctx.font = '11px ui-sans-serif, system-ui, -apple-system, "Segoe UI"';
      const w = ctx.measureText(txt).width;
      this.lastDimRects.push({ constraint: c, x: tx - w/2 - 4, y: ty - 9, w: w + 8, h: 18 });
    }
  }
}
