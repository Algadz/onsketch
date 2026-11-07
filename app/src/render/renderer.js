import { EPS, TAU, angleArcFromPoints, angleSectorForValue, drawDirectedArcPath, lineIntersection, normalizeAngleValue } from '../core/math.js';
import { Arc, Circle, Line, Point } from '../core/entities.js';
import { resolveStyle, dashFor, withAlpha } from '../core/style.js';
import { getTheme, INK } from './theme.js';
import { findFaceAt, geometryKey, interiorPoint } from '../core/regions.js';

export class Renderer {
  constructor(canvas, view) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.view = view;
    this.dpr = window.devicePixelRatio || 1;
    this.lastDimRects = [];
    this._regionCache = new Map();   // fill id → { key, region }
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
   *  and for vertices on locked layers. Weight and line type come from
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
  drawEntities(project) {
    const ctx = this.ctx, v = this.view;
    const activeId = project.activeSketchId;
    // One pass to bucket entities by layer, then draw layers bottom → top.
    const buckets = new Map(project.layers.map(l => [l, new Map()]));
    const slot = (layer, s) => {
      const bySketch = buckets.get(layer);
      if (!bySketch.has(s)) bySketch.set(s, { ents: [], fills: [] });
      return bySketch.get(s);
    };
    const byId = new Map();
    for (const s of project.sketches) {
      if (!s.visible) continue;
      for (const e of s.entities) { slot(project.layerOf(e), s).ents.push(e); byId.set(e.id, e); }
      for (const f of s.fills) { const l = project.layer(f.layerId); if (l) slot(l, s).fills.push(f); }
    }
    for (const layer of project.layers) {
      if (!layer.visible) continue;
      for (const [s, { ents, fills }] of buckets.get(layer)) {
        const isActive = s.id === activeId;
        const alpha = layer.opacity * (isActive ? 1 : 0.55);
        ctx.globalAlpha = alpha;
        for (const f of fills) this._drawRegionFill(f, byId);
        for (const e of ents) {
          e.draw(ctx, v, this.styleFor(e, isActive));
          for (const c of e.children()) c.draw(ctx, v, this.styleFor(c, isActive, e));
        }
        ctx.globalAlpha = 1;
      }
    }
  }

  /** A Fill-tool fill: its region is re-found from its boundary entities
   *  around its seed point, drawn even-odd (inner pieces are holes), and
   *  the seed is re-centred so it keeps tracking the region as the
   *  geometry moves. Not drawn if the region no longer closes. */
  _drawRegionFill(f, byId) {
    const ents = f.ids.map(id => byId.get(id)).filter(Boolean);
    const gk = geometryKey(ents);
    let hit = this._regionCache.get(f.id);
    if (!hit || hit.key !== gk + '|' + f.seed.x + ',' + f.seed.y) {
      const region = findFaceAt(ents, f.seed);
      const seed = region ? interiorPoint(region) : null;
      if (seed) f.seed = seed;
      hit = { key: gk + '|' + f.seed.x + ',' + f.seed.y, region };
      this._regionCache.set(f.id, hit);
    }
    const region = hit.region;
    if (!region) return;
    const ctx = this.ctx, v = this.view;
    ctx.save();
    ctx.beginPath();
    for (const loop of [region.outer, ...region.holes]) {
      loop.forEach((p, i) => { const q = v.worldToScreen(p); if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); });
      ctx.closePath();
    }
    ctx.fillStyle = withAlpha(f.color === INK ? this.theme.ink : f.color, f.opacity ?? 1);
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
  drawDimensions(sketch, entMap, redundantIds) {
    if (!sketch) return;
    // remember the screen-space rect of every label we draw so the app can
    // hit-test them for click-to-edit / drag-to-move
    this.lastDimRects = [];
    for (const c of sketch.constraints) {
      const grey = c.driven || (redundantIds && redundantIds.has(c.id));
      switch (c.kind) {
        case 'distance':          this._drawDistance(c, entMap, grey); break;
        case 'curveDistance':     this._drawCurveDistance(c, entMap, grey); break;
        case 'pointLineDistance': this._drawPLDistance(c, entMap, grey); break;
        case 'offsetDistance':    this._drawOffsetDistance(c, entMap, grey); break;
        case 'radius':            this._drawRadius(c, entMap, grey); break;
        case 'angle':             this._drawAngle(c, entMap, grey); break;
      }
    }
  }

  /** Draw a SmartDim preview that follows the cursor — synthesises a
   *  fake constraint + entity map and reuses the committed-dimension
   *  drawing routines so the preview looks identical to what gets
   *  saved. */
  drawDimPreview(preview) {
    if (!preview) return;
    if (preview.kind === 'distance') {
      const fake = { p1:'_a', p2:'_b', value: preview.value,
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
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy);
    if (len < EPS) return;
    const v = this.view, ctx = this.ctx;

    const offsetWorld   = (c.labelOffset   != null) ? c.labelOffset   : (12 / v.zoom);
    const parallelWorld = (c.labelParallel != null) ? c.labelParallel : 0;
    const nx = -dy / len, ny = dx / len; // perpendicular unit
    const tx =  dx / len, ty =  dy / len; // tangent unit

    // Extension feet at the perpendicular projections of p1 and p2 onto
    // the dim line. The text rides at midpoint + tangent * parallel.
    const a = { x: p1.x + nx * offsetWorld, y: p1.y + ny * offsetWorld };
    const b = { x: p2.x + nx * offsetWorld, y: p2.y + ny * offsetWorld };
    const labelMid = {
      x: (p1.x + p2.x)/2 + nx * offsetWorld + tx * parallelWorld,
      y: (p1.y + p2.y)/2 + ny * offsetWorld + ty * parallelWorld
    };

    const pa = v.worldToScreen(a), pb = v.worldToScreen(b);
    const pp1 = v.worldToScreen(p1), pp2 = v.worldToScreen(p2);
    const plab = v.worldToScreen(labelMid);

    const target = recordAs || c;
    const cols = this._dimColors(grey, !!target.selected);
    ctx.save();
    ctx.strokeStyle = cols.stroke; ctx.fillStyle = cols.fill; ctx.lineWidth = 1;

    // Extension lines (small gap from anchor, extend slightly past dim line)
    const ux = pa.x - pp1.x, uy = pa.y - pp1.y;
    const ul = Math.hypot(ux, uy) || 1;
    const e1 = { x: ux/ul, y: uy/ul };
    ctx.beginPath();
    ctx.moveTo(pp1.x + e1.x*4, pp1.y + e1.y*4);
    ctx.lineTo(pa.x  + e1.x*4, pa.y  + e1.y*4);
    ctx.moveTo(pp2.x + e1.x*4, pp2.y + e1.y*4);
    ctx.lineTo(pb.x  + e1.x*4, pb.y  + e1.y*4);

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

    if (this.lastDimRects) {
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
    const cols = this._dimColors(grey, !!c.selected);

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

    if (this.lastDimRects) {
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
    const cols = this._dimColors(grey, !!c.selected);
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

    if (this.lastDimRects) {
      ctx.font = '11px ui-sans-serif, system-ui, -apple-system, "Segoe UI"';
      const w = ctx.measureText(txt).width;
      this.lastDimRects.push({ constraint: c, x: tx - w/2 - 4, y: ty - 9, w: w + 8, h: 18 });
    }
  }
}
