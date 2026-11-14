import { Arc, Bezier, Circle, Line, Point } from '../core/entities.js';
import { bezierNearest } from '../core/bezier.js';
import { constraintLabel } from '../core/constraints.js';
import { pieceAt, pieceShape, splitAt, splitSpot, splittable, strokeCrossings, trimPiece } from '../core/trim.js';
import { notice } from '../ui/dialogs.js';
import { trackOnce } from '../ui/analytics.js';
import { Tool } from './tool.js';

/* =============== SCISSORS TOOL (X) ==============================
   Trim (default): hover shows, in red, the piece a click removes: the
   part of the line / circle / arc between the two nearest crossings with
   other visible shapes (or the whole shape when nothing crosses it).
   Click removes it; dragging across shapes ("power trim") removes every
   piece the stroke crosses. One undo step per click or stroke.
   Split: click a line or an arc to cut it in two there; the spot snaps to
   crossings, points on the shape and its middle (Alt: no snapping). A
   circle needs two spots: the first click marks it.
   X again (or the options bar) switches Trim ↔ Split.
   What happens to relations: see core/trim.js. Shapes of a linked
   pattern are left alone (unlink the pattern first).
   ============================================================ */

const SNAP_PX = 9;
const isCurve = (e) => e instanceof Line || e instanceof Circle || e instanceof Arc || e instanceof Bezier;

export class ScissorsTool extends Tool {
  constructor(app) {
    super(app);
    this.hover = null;        // { piece } (trim) or { e, spot } (split)
    this.stroke = null;       // power trim in progress: { last, pts, results }
    this.pending = null;      // split a circle: { e, spot } after the first click
  }

  get mode() { return this.app.scissorsMode === 'split' ? 'split' : 'trim'; }

  hint() {
    if (this.mode === 'split') {
      return this.pending
        ? 'Split: click a second spot on the circle (Esc: cancel).'
        : 'Split: click a line, an arc or a curve to cut it in two there (snaps to crossings and the middle). A circle: click two spots.';
    }
    return 'Trim: click the piece to remove (it\'s shown in red), or drag across several. With nothing crossing it, the whole shape goes. X: split instead.';
  }
  deactivate() { this.hover = null; this.stroke = null; this.pending = null; }

  _sketch() { return this.app.activeSketch(); }
  /** Visible shapes cut; hidden layers don't. */
  _opts() { return { cutter: (o) => this.app.isEntityVisible(o) }; }

  /** The line / circle / arc under the cursor (nearest), visible, on the active sketch. */
  _curveAt(world) {
    const s = this._sketch(); if (!s) return null;
    const v = this.app._hitView();
    let best = null, bd = Infinity;
    for (const e of s.entities) {
      if (!isCurve(e) || !this.app.isEntityVisible(e) || !e.hit(world, v)) continue;
      const d = e instanceof Line ? distToSeg(world, e) : e instanceof Bezier ? bezierNearest(e.ctrl(), world, 24).d : Math.abs(Math.hypot(world.x - e.center.x, world.y - e.center.y) - e.r);
      const bonus = this.app._onActiveLayer?.(e) ? 0 : 1e6;      // the active layer wins overlaps
      if (d + bonus < bd) { bd = d + bonus; best = e; }
    }
    return best;
  }

  /** Why this shape can't be cut, or null. */
  _blocked(e) {
    const pats = this.app.patternsOf?.([e]) || [];
    if (pats.length) return `That shape belongs to a ${constraintLabel(pats[0]).toLowerCase()}: unlink the pattern first (select it, Properties ▸ Unlink).`;
    return null;
  }

  onPointerDown(world, snap, ev) {
    this.hover = null;
    const e = this._curveAt(world);
    if (this.mode === 'split') { this._splitClick(e, world, ev); return; }
    this.stroke = { last: world, pts: [world], results: [], blocked: null };
    if (e) this._trimHere(e, world);
    this.app.requestRender();
  }

  onPointerMove(world, snap, ev) {
    if (this.stroke) {
      // Power trim: every piece the stroke crosses since the last move.
      const s = this._sketch();
      const a = this.stroke.last;
      if (Math.hypot(world.x - a.x, world.y - a.y) * this.app.view.zoom < 2) return;
      const hits = strokeCrossings(s, a, world, (o) => this.app.isEntityVisible(o));
      const done = new Set();
      for (const h of hits) {
        if (done.has(h.e) || !s.entities.includes(h.e)) continue;
        done.add(h.e);
        this._trimHere(h.e, { x: h.x, y: h.y });
      }
      this.stroke.last = world;
      this.stroke.pts.push(world);
      this.hover = null;
      this.app.requestRender();
      return;
    }
    this._updateHover(world, ev);
  }

  onPointerUp() {
    const st = this.stroke;
    this.stroke = null;
    if (!st) return;
    if (st.results.length) this._finish(st.results, 'trim');
    else if (st.blocked) notice(st.blocked);
    this.app.requestRender();
  }

  onKey(ev) {
    if (ev.key === 'Escape') {
      if (this.pending) { this.pending = null; this._hint(); this.app.requestRender(); return; }
      this.app.setTool('select');
    }
  }

  _hint() {
    const el = document.getElementById('status-hint');
    if (el) el.textContent = this.hint();
  }

  _updateHover(world, ev) {
    const e = this._curveAt(world);
    const s = this._sketch();
    this.hover = null;
    if (e && !this._blocked(e)) {
      if (this.mode === 'trim') this.hover = { piece: pieceAt(s, e, world, this._opts()) };
      else this.hover = { e, spot: this._spot(e, world, ev) };
    }
    this.app.canvas.style.cursor = e ? (this._blocked(e) ? 'not-allowed' : 'crosshair') : 'crosshair';
    this.app.requestRender();
  }

  _spot(e, world, ev) {
    const snap = ev?.altKey ? 0 : SNAP_PX / this.app.view.zoom;
    return splitSpot(this._sketch(), e, world, snap, this._opts());
  }

  _trimHere(e, at) {
    const why = this._blocked(e);
    if (why) { if (this.stroke) this.stroke.blocked = why; else notice(why); return; }
    const s = this._sketch();
    const piece = pieceAt(s, e, at, this._opts());
    const r = trimPiece(s, piece);
    (this.stroke ? this.stroke.results : []).push(r);
  }

  _splitClick(e, world, ev) {
    if (!e) { if (this.pending) { this.pending = null; this._hint(); } return; }
    const why = this._blocked(e);
    if (why) { notice(why); return; }
    const s = this._sketch();
    const spot = this._spot(e, world, ev);
    if (e instanceof Circle) {
      if (!this.pending || this.pending.e !== e) {
        this.pending = { e, spot };
        this._hint();
        this.app.requestRender();
        return;
      }
      const r = splitAt(s, e, this.pending.spot, spot);
      this.pending = null;
      this._hint();
      if (!r) { notice('Pick two different spots on the circle.'); return; }
      this._finish([r], 'split');
      return;
    }
    this.pending = null;
    if (!splittable(e, spot)) { notice('That\'s the end of the shape: split it somewhere along it.'); return; }
    const r = splitAt(s, e, spot);
    if (r) this._finish([r], 'split');
  }

  /** One undo step, and a word on relations that had to go. */
  _finish(results, kind) {
    const app = this.app;
    const added = results.flatMap(r => r.added);
    const dropped = results.flatMap(r => r.dropped);
    const ids = new Set();
    for (const r of results) for (const e of [...r.added]) { ids.add(e.id); for (const ch of e.children()) ids.add(ch.id); }
    for (const r of results) for (const c of r.addedRelations) for (const id of c.refs()) ids.add(id);
    app.clearSelection();
    app.commit({ activeIds: ids.size ? [...ids] : undefined });
    app.refreshUI();
    trackOnce('scissors', { mode: kind });
    if (dropped.length) {
      const names = [...new Set(dropped.map(c => (c.name ? `${c.name} (${constraintLabel(c).toLowerCase()})` : constraintLabel(c))))];
      const list = names.length > 4 ? names.slice(0, 4).join(', ') + ` and ${names.length - 4} more` : names.join(', ');
      notice(`${kind === 'split' ? 'Split' : 'Trimmed'}: removed ${list}, which no longer applied.`);
    }
    void added; void Point;
  }

  getPreview() {
    const out = { cut: null };
    if (this.stroke && this.stroke.pts.length > 1) out.cut = { trail: this.stroke.pts };
    if (this.hover?.piece) {
      const p = this.hover.piece;
      out.cut = { ...(out.cut || {}), remove: pieceShape(p), ends: [p.lo, p.hi].filter(Boolean).map(c => ({ x: c.x, y: c.y })) };
    } else if (this.hover?.spot) {
      const sp = this.hover.spot;
      out.cut = { ...(out.cut || {}), split: { x: sp.x, y: sp.y, snapped: sp.snapped || null } };
    }
    if (this.pending) out.cut = { ...(out.cut || {}), marks: [{ x: this.pending.spot.x, y: this.pending.spot.y }] };
    return out.cut ? out : null;
  }
}

function distToSeg(p, l) {
  const dx = l.p2.x - l.p1.x, dy = l.p2.y - l.p1.y, L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((p.x - l.p1.x) * dx + (p.y - l.p1.y) * dy) / L2)) : 0;
  return Math.hypot(p.x - (l.p1.x + t * dx), p.y - (l.p1.y + t * dy));
}
