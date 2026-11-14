import { evaluate, isEquation } from '../core/expr.js';
import { Arc, Circle, Line, Point } from '../core/entities.js';
import { isDimension } from '../core/equations.js';
import {
  PATTERN_LABELS, PATTERN_MAX_COPIES, PatternConstraint, circularStep, cleanPatternParams, defaultPatternParams,
  directionVector, instanceIdMap, ownIds, patternCopyCount, patternKeys, patternTransform, placePatternCopies,
  refPoint, removePatternCopies, shapeReferencePoint, shapesBBox, syncPattern,
} from '../core/patterns.js';
import { uiIcon } from '../ui/icons.js';
import { ACTION_ICONS } from '../ui/tool-defs.js';
import { notice } from '../ui/dialogs.js';
import { trackOnce } from '../ui/analytics.js';

/* =============== PATTERNS (UI) ==================================
   Linear, circular and point patterns, from the Tools window (or the
   right-click menu of a pattern's shape to edit it). The operation runs
   with the Select tool, like Mirror and Offset, and its panel is in the
   Properties window:

     type        Linear · Circular · Points (while creating)
     pick        what canvas clicks do: seed shapes (click / box), the
                 centre (circular), the origin and the target points
                 (points), a line to follow (linear). Centre and targets
                 can be clicked on empty canvas: a point is made there.
     parameters  instances (the seed counts as one), spacing, direction,
                 angle… Fields take units and arithmetic (`1in`, `30/2`),
                 or an equation (`=D1/2`) that keeps following D1.
     keep linked on: copies follow the seed and the pattern stays
                 editable; off: plain copies with the seed's relations.

   Creating shows a dashed preview. Editing (Edit pattern) applies every
   change to the drawing at once; Done keeps it as one undo step, Cancel
   (or Esc, or Undo) puts everything back.
   ============================================================ */

const esc = (t) => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clone = (o) => JSON.parse(JSON.stringify(o));
const fmt = (v) => (Number.isFinite(v) ? String(Number(Number(v).toFixed(4))) : '');
/** A round number near v (1, 1.5, 2, 2.5 … steps of half a decade). */
const nice = (v) => {
  if (!(v > 0)) return 20;
  const m = 10 ** Math.floor(Math.log10(v)) / 2;
  return Math.max(m, Math.ceil(v / m - 1e-9) * m);
};
const ACTION_TYPE = { 'linear-pattern': 'linear', 'circular-pattern': 'circular', 'point-pattern': 'points' };
const TYPE_ICON = { linear: 'linear-pattern', circular: 'circular-pattern', points: 'point-pattern' };
const isShape = (e) => e instanceof Line || e instanceof Circle || e instanceof Arc || e instanceof Point;

/** Read / write a parameter by path ('d1.spacing', 'count'…). */
const getPath = (p, path) => path.split('.').reduce((o, k) => (o ? o[k] : undefined), p);
const setPath = (p, path, v) => {
  const ks = path.split('.');
  let o = p;
  for (const k of ks.slice(0, -1)) o = o[k];
  o[ks[ks.length - 1]] = v;
};
const COUNT_PATHS = new Set(['d1.count', 'd2.count', 'count']);
const ANGLE_PATHS = new Set(['d1.angle', 'd2.angle', 'angle']);

export class PatternsMixin {

  static actionType(a) { return ACTION_TYPE[a] || null; }

  /* ---- Starting / ending ---- */

  startPatternOperation(type = 'linear') {
    // Enter creates the pattern: it mustn't press the Tools button again.
    if (document.activeElement?.closest?.('.fwin, #menubar')) document.activeElement.blur();
    this._clearOperationState();
    this._switchToSelectToolForOperation();
    const sketch = this.activeSketch(); if (!sketch) return;
    const seeds = this._patternSeedsFromSelection();
    this.operationName = 'pattern';
    this.pattern = {
      mode: 'create', type, seeds: seeds.map(e => e.id),
      byType: {}, params: defaultPatternParams(type),
      linked: this._patternLinkPref !== false,
      pick: 'seeds', touched: new Set(), pendingSeq: 0,
    };
    this._patternDefaults();
    this._patternNextPick();
    this._showPatternPanel();
    this._syncPatternSelection();
    this.refreshToolOptions();
    this.requestRender();
  }

  /** The panel is in the Properties window: make sure it's open (on a
   *  phone it replaces the Tools sheet). */
  _showPatternPanel() {
    if (this.windows && !this.windows.isOpen('props')) this.windows.toggle('props', true);
  }

  /** Edit a linked pattern: its panel, applied to the drawing live. */
  editPattern(c) {
    const sketch = this.activeSketch();
    if (!sketch || !c || !sketch.constraints.includes(c)) return;
    if (document.activeElement?.closest?.('.fwin')) document.activeElement.blur();
    this._clearOperationState();
    this._switchToSelectToolForOperation();
    this.operationName = 'pattern';
    this.pattern = {
      mode: 'edit', editId: c.id, type: c.type, seeds: [...c.seeds],
      params: clone(c.params), linked: true, pick: 'seeds', touched: new Set(['all']),
      snapshot: JSON.stringify(this.project.toJSON({ images: false })), dirty: false, pendingSeq: 0,
    };
    this._showPatternPanel();
    this._syncPatternSelection();
    this.refreshToolOptions();
    this.requestRender();
    trackOnce('pattern-edit', { type: c.type });
  }

  _patternConstraint() {
    const st = this.pattern;
    if (!st || st.mode !== 'edit') return null;
    return this.activeSketch()?.constraints.find(c => c.id === st.editId) || null;
  }

  finishPatternEdit() {
    const st = this.pattern;
    if (!st) return;
    this.pattern = null;
    this.operationName = null;
    this._restoreStatusHint();
    if (st.dirty) this.commit();
    this.refreshUI();
    this.requestRender();
  }

  /** Cancel an edit: the drawing goes back to how it was before. */
  cancelPatternEdit() {
    const st = this.pattern;
    if (!st || st.mode !== 'edit') return false;
    this.pattern = null;
    this.operationName = null;
    this._restoreStatusHint();
    if (st.dirty) {
      this._swapSameDocument(st.snapshot);
      this._afterStateSwap();
    } else {
      this.refreshUI();
      this.requestRender();
    }
    return true;
  }

  _restoreStatusHint() {
    const el = document.getElementById('status-hint');
    if (el) el.textContent = (this.tool?.hint && this.tool.hint()) || '';
  }

  /* ---- Seeds and defaults ---- */

  _patternSeedsFromSelection() {
    const sketch = this.activeSketch(); if (!sketch) return [];
    return sketch.entities.filter(e => e.selected && isShape(e));
  }

  _patternSeeds() {
    const sketch = this.activeSketch(); if (!sketch || !this.pattern) return [];
    const ids = new Set(this.pattern.seeds);
    return sketch.entities.filter(e => ids.has(e.id));
  }

  /** Spacing from the seeds' size, the origin on the seed: unless the
   *  user set them already. */
  _patternDefaults() {
    const st = this.pattern;
    if (!st || st.mode === 'edit') return;
    const seeds = this._patternSeeds();
    const box = shapesBBox(seeds);
    const p = st.params;
    if (st.type === 'linear' && box) {
      // about one seed-width of gap between copies
      const w = box.maxX - box.minX, h = box.maxY - box.minY, big = Math.max(w, h);
      if (!st.touched.has('d1.spacing')) p.d1.spacing = big > 0 ? nice(Math.max(w, big * 0.3) * 1.5) : 20;
      if (!st.touched.has('d2.spacing')) p.d2.spacing = big > 0 ? nice(Math.max(h, big * 0.3) * 1.5) : 20;
    }
    if (st.type === 'points' && !st.touched.has('origin')) {
      const ref = seeds.length ? shapeReferencePoint(seeds[0]) : null;
      p.origin = ref ? { id: ref.id } : null;
    }
  }

  /** After the seeds, ask for what the type still needs. */
  _patternNextPick() {
    const st = this.pattern;
    if (!st || !st.seeds.length) return;
    if (st.type === 'circular' && !st.params.center) st.pick = 'center';
    else if (st.type === 'points' && !st.params.targets.length) st.pick = 'targets';
  }

  setPatternType(type) {
    const st = this.pattern;
    if (!st || st.mode !== 'create' || st.type === type) return;
    st.byType[st.type] = { params: st.params, touched: st.touched };
    const saved = st.byType[type];
    st.type = type;
    st.params = saved ? saved.params : defaultPatternParams(type);
    st.touched = saved ? saved.touched : new Set();
    st.pick = 'seeds';
    this._patternDefaults();
    this._patternNextPick();
    this._syncPatternSelection();
    this.refreshToolOptions();
    this.requestRender();
  }

  _syncPatternSelection() {
    const sketch = this.activeSketch(); if (!sketch || !this.pattern) return;
    for (const e of sketch.entities) {
      e.selected = false;
      for (const ch of e.children()) ch.selected = false;
    }
    for (const c of sketch.constraints) c.selected = false;
    this.clearStrokeSelection?.();
    this.selectionOrder = [];
    for (const e of this._patternSeeds()) this.setSelected(e, true);
    this.refreshUI();
    this.requestRender();
  }

  /* ---- Picking on the canvas ---- */

  /** Point reference for a click on a shape: a point, or a circle's centre. */
  _patternPointRef(hit) {
    if (hit instanceof Point && !hit.arcOwner) return { id: hit.id };
    if (hit instanceof Circle || hit instanceof Arc) return { id: hit.center.id };
    return null;
  }

  /** Ids that place the pattern (can't also be seeds). */
  _patternPlacingIds() {
    const st = this.pattern, p = st.params, out = new Set();
    if (st.type === 'circular' && p.center?.id) out.add(p.center.id);
    if (st.type === 'points') {
      if (p.origin?.id && !this._patternSeeds().some(s => ownIds(s).includes(p.origin.id))) out.add(p.origin.id);
      for (const t of p.targets) if (t.id) out.add(t.id);
    }
    return out;
  }

  /** Spot clicked on empty canvas: snapped like a drawing tool would. A
   *  snap onto an existing point picks that point. */
  _patternSpot(world) {
    const sn = this.snapActive() ? this.snap.find(world, this.view, this.visibleSketches()) : null;
    if (sn && sn.kind === 'endpoint' && sn.entity instanceof Point && !sn.entity.arcOwner) return { hit: sn.entity };
    if (sn && sn.kind === 'center' && sn.entity) return { hit: sn.entity };
    return { x: sn ? sn.x : world.x, y: sn ? sn.y : world.y };
  }

  /** A new spot for a centre / target: a pending position while creating
   *  (made into a point on Create when linked), a real point while editing. */
  _patternNewRef(x, y) {
    const st = this.pattern;
    if (st.mode === 'edit') {
      const sketch = this.activeSketch();
      const p = new Point(x, y);
      sketch.addEntity(p);
      return { id: p.id };
    }
    return { x, y, pending: true, key: 'n' + (++st.pendingSeq) };
  }

  handlePatternPick(hit, world) {
    const st = this.pattern;
    if (this.operationName !== 'pattern' || !st) return false;
    const sketch = this.activeSketch(); if (!sketch) return true;
    if (hit && this.project.sketchOf(hit) !== sketch) return true;
    const owner = (e) => (e instanceof Point && !e.arcOwner && !sketch.entities.includes(e) ? this.project.ownerOf(e) : e.arcOwner || e);
    if (st.pick === 'seeds') {
      if (!hit) return true;
      const e = owner(hit);
      if (!isShape(e) || this._patternPlacingIds().has(e.id)) return true;
      if (this._patternConstraint()?.copyIds().has(e.id)) { notice('That\'s one of the copies: pick seed shapes.'); return true; }
      const i = st.seeds.indexOf(e.id);
      if (i >= 0) st.seeds.splice(i, 1); else st.seeds.push(e.id);
      this._patternSeedsChanged();
      return true;
    }
    if (st.pick === 'dir1' || st.pick === 'dir2') {
      const e = hit ? owner(hit) : null;
      if (!(e instanceof Line)) { notice('Click a line: the pattern follows its direction.'); return true; }
      const d = st.params[st.pick === 'dir1' ? 'd1' : 'd2'];
      d.line = { a: e.p1.id, b: e.p2.id, id: e.id };
      d.angle = Math.atan2(e.p2.y - e.p1.y, e.p2.x - e.p1.x) * 180 / Math.PI;
      st.pick = 'seeds';
      this._patternChanged();
      return true;
    }
    // centre, origin, targets: a point, a circle's centre, or a new spot
    let ref = hit ? this._patternPointRef(hit) : null;
    if (!hit && world) {
      const spot = this._patternSpot(world);
      ref = spot.hit ? this._patternPointRef(spot.hit) : (st.pick === 'origin' ? null : this._patternNewRef(spot.x, spot.y));
    }
    if (!ref) {
      if (hit instanceof Line) notice('Click a point or a circle (its centre), or empty space for a new point.');
      return true;
    }
    const seedOwn = new Set(this._patternSeeds().flatMap(ownIds));
    if (st.pick === 'center') {
      if (ref.id && seedOwn.has(ref.id)) { notice('The centre can\'t be part of the seed.'); return true; }
      st.params.center = ref;
      st.pick = 'seeds';
    } else if (st.pick === 'origin') {
      st.params.origin = ref;
      st.touched.add('origin');
      st.pick = 'targets';
    } else if (st.pick === 'targets') {
      if (ref.id && seedOwn.has(ref.id)) { notice('That point is on the seed: pick it as the origin instead.'); return true; }
      const t = st.params.targets;
      const i = ref.id ? t.findIndex(x => x.id === ref.id) : -1;
      if (i >= 0) t.splice(i, 1);
      else t.push({ key: ref.key || ref.id, ...ref });
    }
    this._patternChanged();
    return true;
  }

  /** Box-select: seeds (shapes inside) or targets (points inside). */
  handlePatternBoxPick(hits, opts = {}) {
    const st = this.pattern;
    if (this.operationName !== 'pattern' || !st) return false;
    if (st.pick === 'seeds') {
      if (opts.replace) st.seeds = [];
      const placing = this._patternPlacingIds();
      const copies = this._patternConstraint()?.copyIds() || new Set();
      for (const e of hits) {
        if (!isShape(e) || placing.has(e.id) || copies.has(e.id)) continue;
        const i = st.seeds.indexOf(e.id);
        if (opts.toggle && i >= 0) st.seeds.splice(i, 1);
        else if (i < 0) st.seeds.push(e.id);
      }
      this._patternSeedsChanged();
    } else if (st.pick === 'targets') {
      const seedOwn = new Set(this._patternSeeds().flatMap(ownIds));
      for (const e of hits) {
        if (!(e instanceof Point) || seedOwn.has(e.id) || st.params.targets.some(t => t.id === e.id)) continue;
        st.params.targets.push({ key: e.id, id: e.id });
      }
      this._patternChanged();
    }
    return true;
  }

  _patternSeedsChanged() {
    const st = this.pattern;
    this._patternDefaults();
    if (st.mode === 'create' && st.pick === 'seeds') {
      // A first seed picked: go on to what the type needs next.
      const need = (st.type === 'circular' && !st.params.center) || (st.type === 'points' && !st.params.targets.length);
      if (need && st.seeds.length === 1) this._patternNextPick();
    }
    this._syncPatternSelection();
    this._patternChanged();
  }

  setPatternPick(pick) {
    if (!this.pattern) return;
    this.pattern.pick = pick;
    this.refreshToolOptions();
    this.requestRender();
  }

  /* ---- Parameters ---- */

  /** What's missing or wrong, as a sentence; null when ready. */
  _patternIssue() {
    const st = this.pattern; if (!st) return null;
    const p = st.params;
    if (!st.seeds.length) return 'Pick the shapes to repeat (the seed).';
    if (st.type === 'circular' && !p.center) return 'Pick the centre: a point, a circle, or empty space.';
    if (st.type === 'points' && !p.origin) return 'Pick the origin: the point of the seed that lands on each target.';
    if (st.type === 'points' && !p.targets.length) return 'Pick target points, or click empty space to place them.';
    const n = patternCopyCount(st.type, p);
    if (n > PATTERN_MAX_COPIES) return `That makes ${n} copies: ${PATTERN_MAX_COPIES} at most.`;
    if (n < 1) return 'Set at least 2 instances.';
    if (st.type === 'linear' && (!(p.d1.spacing > 0) || (p.d2.count > 1 && !(p.d2.spacing > 0)))) return 'Spacing must be greater than 0.';
    return null;
  }

  /** Something changed: refresh the panel and the preview; while editing,
   *  apply it to the drawing. */
  _patternChanged({ panel = true } = {}) {
    const st = this.pattern; if (!st) return;
    if (st.mode === 'edit') this._applyPatternEdit();
    if (panel) this.refreshToolOptions();
    else this._refreshPatternMetrics();
    this.requestRender();
  }

  _applyPatternEdit() {
    const st = this.pattern;
    const c = this._patternConstraint();
    const sketch = this.activeSketch();
    if (!c || !sketch) return;
    if (this._patternIssue() && !st.seeds.length) return;
    if (patternCopyCount(st.type, st.params) > PATTERN_MAX_COPIES) return;
    c.params = cleanPatternParams(c.type, clone(st.params));
    c.seeds = [...st.seeds];
    syncPattern(sketch, c);
    placePatternCopies(sketch, c);
    st.seeds = [...c.seeds];
    st.dirty = true;
    this.solveFastAndRender({ diagnostics: 'defer', activeIds: new Set(c.refs()) });
  }

  /** Text typed in a parameter field: a value with units, arithmetic, or
   *  an equation (kept, like a dimension's). */
  _patternParse(path, text) {
    const src = String(text).trim();
    if (!src) throw new Error('Type a value');
    let v = evaluate(src.replace(/^=\s*/, ''), (n) => this._namedValue(n));
    if (COUNT_PATHS.has(path)) {
      v = Math.round(v);
      if (v < 1) throw new Error('At least 1');
    } else if (!ANGLE_PATHS.has(path) && !(v > 0)) throw new Error('Must be greater than 0');
    return { value: v, expr: isEquation(src) ? src.replace(/^=\s*/, '') : null };
  }

  _patternSet(path, text, final) {
    const st = this.pattern; if (!st) return false;
    let r;
    try { r = this._patternParse(path, text); } catch { return false; }
    const p = st.params;
    setPath(p, path, r.value);
    if (final) {
      p.exprs = p.exprs || {};
      if (r.expr) p.exprs[path] = r.expr; else delete p.exprs[path];
      if (!Object.keys(p.exprs).length) delete p.exprs;
    }
    st.touched.add(path);
    if (COUNT_PATHS.has(path) || final) this._patternChanged({ panel: final });
    else this._patternChanged({ panel: false });
    return true;
  }

  _patternFieldText(path) {
    const p = this.pattern.params;
    const e = p.exprs?.[path];
    return e ? '=' + e : fmt(getPath(p, path));
  }

  /* ---- Create ---- */

  createPattern() {
    const st = this.pattern;
    const sketch = this.activeSketch();
    if (!st || !sketch || st.mode !== 'create') return;
    const issue = this._patternIssue();
    if (issue) { notice(issue, { kind: 'error' }); return; }
    const params = clone(st.params);
    const made = [];
    // Spots clicked on empty canvas become points when the pattern is
    // linked (they drive it); unlinked copies only need where they were.
    const realize = (r) => {
      if (!r || !r.pending) return r;
      if (!st.linked) return { x: r.x, y: r.y };
      const pt = new Point(r.x, r.y);
      sketch.addEntity(pt);
      made.push(pt);
      return { id: pt.id };
    };
    if (st.type === 'circular') params.center = realize(params.center);
    if (st.type === 'points') {
      params.origin = realize(params.origin);
      params.targets = params.targets.map(t => {
        const r = realize(t);
        return { key: r.id || t.key, ...(r.id ? { id: r.id } : { x: r.x, y: r.y }) };
      });
    }
    const c = new PatternConstraint(st.type, params, st.seeds);
    const { added } = syncPattern(sketch, c);
    if (st.linked) sketch.constraints.push(c);
    else this._copySeedRelations(sketch, c);
    this._patternLinkPref = st.linked;
    trackOnce('pattern', { type: st.type, linked: st.linked });
    this.pattern = null;
    this.operationName = null;
    this.clearSelection();
    for (const e of added) this.setSelected(e, true);
    this._restoreStatusHint();
    this.commit({ activeIds: [...c.refs(), ...made.map(p => p.id)] });
    this.refreshUI();
    this.requestRender();
  }

  /** Copies get the seed's own relations (between seed shapes; not
   *  dimensions or Fix): an unlinked copy keeps its shape on its own. */
  _copySeedRelations(sketch, c) {
    const seedOwn = new Set();
    for (const id of c.seeds) {
      const e = sketch.entities.find(x => x.id === id);
      if (e) for (const x of ownIds(e)) seedOwn.add(x);
    }
    const rels = sketch.constraints.filter(k => k !== c && k.kind !== 'pattern' && k.kind !== 'fix'
      && k.kind !== 'arcEndpointFix' && k.kind !== 'paramFix' && !isDimension(k)
      && k.refs().length && k.refs().every(id => seedOwn.has(id)));
    for (const inst of c.instances) {
      const map = instanceIdMap(inst);
      for (const k of rels) {
        const copy = this._cloneOffsetGroupConstraint(k, map);
        if (copy && !this._isInvalidConstraint(sketch, copy)) sketch.constraints.push(copy);
      }
    }
  }

  /* ---- Linked pattern actions ---- */

  /** The copies stay, as plain geometry with the seed's relations. */
  unlinkPattern(c, { commit = true } = {}) {
    const sketch = this.activeSketch(); if (!sketch || !c) return;
    if (this.pattern?.editId === c.id) { this.pattern = null; this.operationName = null; this._restoreStatusHint(); }
    this._copySeedRelations(sketch, c);
    sketch.constraints = sketch.constraints.filter(k => k !== c);
    if (commit) {
      this.commit();
      this.refreshUI();
      notice('Pattern unlinked: the copies are separate shapes now.');
    }
  }

  /** Removes the copies and the pattern; the seed stays. */
  deletePatternCopies(c) {
    const sketch = this.activeSketch(); if (!sketch || !c) return;
    if (this.pattern?.editId === c.id) { this.pattern = null; this.operationName = null; this._restoreStatusHint(); }
    const seeds = c.seeds.map(id => sketch.entities.find(e => e.id === id)).filter(Boolean);
    removePatternCopies(sketch, c);
    sketch.constraints = sketch.constraints.filter(k => k !== c);
    this.clearSelection();
    for (const e of seeds) this.setSelected(e, true);
    this.commit();
    this.refreshUI();
  }

  /** Linked patterns a shape (or one of its points) belongs to. */
  patternsOf(entities) {
    const sketch = this.activeSketch(); if (!sketch) return [];
    const ids = new Set();
    for (const e of entities) {
      ids.add(e.id);
      const owner = e instanceof Point ? this.project.ownerOf(e) : null;
      if (owner) ids.add(owner.id);
    }
    return sketch.constraints.filter(c => c.kind === 'pattern' && [...c.memberIds()].some(id => ids.has(id)));
  }

  /** Equations in pattern fields (`=D1/2`), re-evaluated with the others.
   *  @returns {number} how many patterns changed */
  _applyPatternEquations() {
    const sketch = this.activeSketch(); if (!sketch) return 0;
    let changed = 0;
    for (const c of sketch.constraints) {
      if (c.kind !== 'pattern' || !c.params.exprs) continue;
      if (this.pattern?.editId === c.id) continue;
      let structural = false, moved = false;
      for (const [path, expr] of Object.entries(c.params.exprs)) {
        let v;
        try { v = this._patternParse(path, '=' + expr).value; } catch { continue; }
        if (Math.abs(v - getPath(c.params, path)) < 1e-12) continue;
        setPath(c.params, path, v);
        if (COUNT_PATHS.has(path)) structural = true; else moved = true;
      }
      if (structural && patternCopyCount(c.type, c.params) <= PATTERN_MAX_COPIES) syncPattern(sketch, c);
      if (structural || moved) { placePatternCopies(sketch, c); changed++; }
    }
    return changed;
  }

  /* ---- Canvas preview ---- */

  /** Dashed copies while creating, plus the centre, origin, targets and
   *  directions, in both modes. */
  getPatternPreview() {
    const st = this.pattern;
    if (this.operationName !== 'pattern' || !st) return null;
    const sketch = this.activeSketch(); if (!sketch) return null;
    const P = (id) => this._lookupAny(id);
    const p = st.params;
    const out = { paths: [], circles: [], arcs: [], points: [], marks: [] };
    const seeds = this._patternSeeds();
    const box = shapesBBox(seeds);
    if (st.mode === 'create' && !this._patternIssue()) {
      for (const key of patternKeys(st.type, p)) {
        const T = patternTransform(st.type, p, key, P);
        if (!T) continue;
        for (const s of seeds) {
          if (s instanceof Line) out.paths.push([T.map(s.p1), T.map(s.p2)]);
          else if (s instanceof Arc) out.arcs.push({ center: T.map(s.center), r: s.r, a0: s.a0 + T.rot, a1: s.a1 + T.rot, clockwise: s.clockwise });
          else if (s instanceof Circle) out.circles.push({ center: T.map(s.center), r: s.r });
          else if (s instanceof Point) out.points.push(T.map(s));
        }
      }
    }
    if (st.type === 'circular') {
      const c = refPoint(p.center, P);
      if (c) out.marks.push({ kind: 'center', x: c.x, y: c.y });
      if (c && box) {
        const mid = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
        out.marks.push({ kind: 'sweep', center: c, from: mid, angle: (p.equal ? p.angle : circularStep(p) * Math.max(0, p.count - 1)) * (p.reverse ? -1 : 1) });
      }
    } else if (st.type === 'points') {
      const o = refPoint(p.origin, P);
      if (o) out.marks.push({ kind: 'origin', x: o.x, y: o.y });
      for (const t of p.targets) {
        const tp = refPoint(t, P);
        if (!tp) continue;
        out.marks.push({ kind: 'target', x: tp.x, y: tp.y });
        if (o) out.marks.push({ kind: 'leader', a: o, b: tp });
      }
    } else if (st.type === 'linear' && box) {
      const start = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
      const dirs = [p.d1];
      if (p.d2.count > 1) dirs.push(p.d2);
      for (const d of dirs) {
        const u = directionVector(d, P);
        const len = Math.max(1, d.count - 1) * d.spacing;
        out.marks.push({ kind: 'arrow', a: start, b: { x: start.x + u.x * len, y: start.y + u.y * len } });
      }
    }
    return out;
  }

  /* ---- Panel ---- */

  _patternCountHTML(seeds, n) {
    return `<b>${seeds}</b> seed shape${seeds === 1 ? '' : 's'} <span aria-hidden="true">→</span> <b>${n}</b> cop${n === 1 ? 'y' : 'ies'}`;
  }

  _refreshPatternMetrics() {
    const st = this.pattern; if (!st) return;
    const n = patternCopyCount(st.type, st.params);
    const el = document.querySelector('#tool-options-body .pat-count');
    if (el) el.innerHTML = this._patternCountHTML(this._patternSeeds().length, n);
    const btn = document.getElementById('pattern-create');
    const issue = this._patternIssue();
    if (btn && st.mode === 'create') {
      btn.disabled = !!issue;
      btn.lastChild.textContent = n === 1 ? 'Create 1 copy' : `Create ${n} copies`;
    }
    const note = document.getElementById('pattern-issue');
    if (note) { note.hidden = !issue; note.textContent = issue || ''; }
  }

  _refreshPatternOptions(section, body) {
    const st = this.pattern;
    section.hidden = false;
    const label = PATTERN_LABELS[st.type];
    document.getElementById('tool-options-title').textContent = st.mode === 'edit' ? `Edit ${label.toLowerCase()}` : 'Pattern';
    const p = st.params;
    const seeds = this._patternSeeds();
    const n = patternCopyCount(st.type, p);
    const issue = this._patternIssue();
    const hints = {
      seeds: 'Pattern: click or box-select the shapes to repeat.',
      center: 'Pattern: click the centre point, a circle (its centre), or empty space.',
      origin: 'Pattern: click the point of the seed that lands on each target.',
      targets: 'Pattern: click points (or empty space) to place copies; box-select many; click a target again to remove it.',
      dir1: 'Pattern: click a line to follow its direction.',
      dir2: 'Pattern: click a line for direction 2.',
    };
    document.getElementById('status-hint').textContent = hints[st.pick] || '';

    const choice = (pick, title, text) => `
      <button class="choice-row ${st.pick === pick ? 'active' : ''}" data-pick="${pick}">
        <span class="glyph">${st.pick === pick ? '›' : '+'}</span>
        <span><strong>${title}</strong><span>${text}</span></span>
      </button>`;
    const refText = (r, none) => {
      if (!r) return none;
      if (r.pending) return `New point at ${fmt(r.x)}, ${fmt(r.y)}`;
      if (r.id) { const e = this._lookupAny(r.id); return `Point ${esc(r.id)}${e ? ` (${fmt(e.x)}, ${fmt(e.y)})` : ''}`; }
      return `Fixed spot ${fmt(r.x)}, ${fmt(r.y)}`;
    };
    const field = (path, lab, unit, extra = '') => {
      const bad = this._patternFieldBad?.[path];
      return `<div class="prop-row"><label for="pf-${path}">${lab}</label>
        <span class="pat-field"><input id="pf-${path}" type="text" inputmode="decimal" data-pfield="${path}" value="${esc(this._patternFieldText(path))}"${bad ? ' class="bad"' : ''} autocomplete="off" spellcheck="false">${unit ? `<span class="pat-unit">${unit}</span>` : ''}${extra}</span></div>`;
    };
    const stepper = (path, lab) => `<div class="prop-row"><label for="pf-${path}">${lab}</label>
        <span class="pat-stepper"><button class="pat-step" data-step="${path}" data-d="-1" aria-label="Fewer" title="Fewer">−</button>
        <input id="pf-${path}" type="text" inputmode="numeric" data-pfield="${path}" value="${esc(this._patternFieldText(path))}" autocomplete="off">
        <button class="pat-step" data-step="${path}" data-d="1" aria-label="More" title="More">+</button></span></div>`;
    const flip = (key, on) => `<button class="pat-flip${on ? ' on' : ''}" data-flip="${key}" title="Reverse the direction" aria-label="Reverse">${uiIcon('flip')}</button>`;

    let html = '';
    if (st.mode === 'create') {
      html += `<div class="seg pat-types" role="tablist">${['linear', 'circular', 'points'].map(t =>
        `<button class="${st.type === t ? 'on' : ''}" data-ptype="${t}" role="tab" aria-selected="${st.type === t}">${ACTION_ICONS[TYPE_ICON[t]]}<span>${t === 'points' ? 'Points' : t[0].toUpperCase() + t.slice(1)}</span></button>`).join('')}</div>`;
    }
    html += `<div class="pat-count">${this._patternCountHTML(seeds.length, n)}</div>`;
    html += choice('seeds', 'Seed', seeds.length ? `${seeds.length} shape${seeds.length > 1 ? 's' : ''}: click to add or remove` : 'Click or box-select the shapes to repeat');
    if (st.type === 'circular') html += choice('center', 'Centre', refText(p.center, 'A point, a circle, or empty space'));
    if (st.type === 'points') {
      html += choice('origin', 'Origin', refText(p.origin, 'The seed point placed on each target'));
      html += choice('targets', 'Targets', p.targets.length ? `${p.targets.length} point${p.targets.length > 1 ? 's' : ''}: click to add, again to remove` : 'Click points, or empty space for new ones');
      if (p.targets.length) {
        html += '<div class="stack-list pat-targets">' + p.targets.map((t, i) =>
          `<div class="sel-item"><span class="glyph">${i + 1}</span><span>${refText(t, '')}</span><button class="pat-x" data-untarget="${esc(t.key)}" title="Remove this target" aria-label="Remove">${uiIcon('x')}</button></div>`).join('') + '</div>';
      }
    }

    if (st.type === 'linear') {
      const dirRow = (k) => {
        const d = p[k];
        const lineTxt = d.line ? `<span class="pat-chip" title="Follows this line">Along line ${esc(d.line.id || '')}<button class="pat-x" data-unline="${k}" title="Use an angle instead" aria-label="Use an angle">${uiIcon('x')}</button></span>` : '';
        return d.line
          ? `<div class="prop-row"><label>Direction</label><span class="pat-field">${lineTxt}${flip(k, d.reverse)}</span></div>`
          : field(`${k}.angle`, 'Angle', '°', `<button class="pat-pickline${st.pick === (k === 'd1' ? 'dir1' : 'dir2') ? ' on' : ''}" data-pick="${k === 'd1' ? 'dir1' : 'dir2'}" title="Follow a line: click it on the canvas">Line…</button>${flip(k, d.reverse)}`);
      };
      html += '<div class="sb-subhead">Direction 1</div>';
      html += stepper('d1.count', 'Instances');
      html += field('d1.spacing', 'Spacing', 'mm');
      html += dirRow('d1');
      const two = p.d2.count > 1;
      html += `<div class="sb-subhead pat-head">Direction 2<label class="switch" title="Repeat in a second direction too (a grid)"><input type="checkbox" data-dir2${two ? ' checked' : ''}><span></span></label></div>`;
      if (two) {
        html += stepper('d2.count', 'Instances');
        html += field('d2.spacing', 'Spacing', 'mm');
        html += dirRow('d2');
      }
    } else if (st.type === 'circular') {
      html += '<div class="sb-subhead">Parameters</div>';
      html += stepper('count', 'Instances');
      html += field('angle', p.equal ? 'Total angle' : 'Step angle', '°');
      html += `<div class="prop-row"><label>Equal spacing</label><label class="switch" title="On: spread the instances over the total angle. Off: the angle is the step between two instances"><input type="checkbox" data-equal${p.equal ? ' checked' : ''}><span></span></label></div>`;
      html += `<div class="prop-row"><label>Direction</label><span class="seg"><button class="${p.reverse ? '' : 'on'}" data-rev="0" title="Counter-clockwise">↺ CCW</button><button class="${p.reverse ? 'on' : ''}" data-rev="1" title="Clockwise">↻ CW</button></span></div>`;
    }

    if (st.mode === 'create') {
      html += `<div class="sb-subhead">Link</div>
        <div class="prop-row"><label for="pattern-linked">Keep linked</label><label class="switch"><input type="checkbox" id="pattern-linked"${st.linked ? ' checked' : ''}><span></span></label></div>
        <div class="hint">${st.linked
          ? 'Copies follow the seed; edit the pattern later from Properties.'
          : 'Plain copies with the seed\'s relations, each edited on its own.'}</div>`;
    }
    html += `<div class="tool-note warn" id="pattern-issue"${issue ? '' : ' hidden'}>${esc(issue || '')}</div>`;
    if (st.mode === 'create') {
      html += `<div class="rel-grid op-actions">
        <button class="rel-btn primary" id="pattern-create"${issue ? ' disabled' : ''}>${uiIcon('check')}<span>${n === 1 ? 'Create 1 copy' : `Create ${n} copies`}</span></button>
        <button class="rel-btn danger" id="pattern-cancel">${uiIcon('x')}Cancel</button>
      </div>`;
    } else {
      html += `<div class="rel-grid op-actions">
        <button class="rel-btn primary" id="pattern-done">${uiIcon('check')}<span>Done</span></button>
        <button class="rel-btn" id="pattern-cancel">${uiIcon('x')}Cancel</button>
        <button class="rel-btn" id="pattern-unlink" title="Keep the copies as separate shapes">${uiIcon('unlock')}Unlink</button>
        <button class="rel-btn danger" id="pattern-delete" title="Remove the copies; the seed stays">${uiIcon('trash')}Delete copies</button>
      </div>`;
    }
    body.innerHTML = html;
    this._bindPatternOptions(body);
  }

  _bindPatternOptions(body) {
    const st = this.pattern;
    body.querySelectorAll('[data-ptype]').forEach(b => b.addEventListener('click', () => this.setPatternType(b.dataset.ptype)));
    body.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => {
      const pick = b.dataset.pick;
      this.setPatternPick(st.pick === pick && pick.startsWith('dir') ? 'seeds' : pick);
    }));
    body.querySelectorAll('[data-pfield]').forEach(inp => {
      const path = inp.dataset.pfield;
      const original = inp.value;
      this._patternFieldBad = this._patternFieldBad || {};
      inp.addEventListener('input', () => {
        const ok = this._patternSet(path, inp.value, false);
        inp.classList.toggle('bad', !ok);
      });
      const commitField = () => {
        if (inp.value === original) return;
        const ok = this._patternSet(path, inp.value, true);
        this._patternFieldBad[path] = !ok;
        if (!ok) { inp.classList.add('bad'); notice('Type a number, a value with units, or an equation like =D1/2.', { kind: 'error' }); }
      };
      inp.addEventListener('change', commitField);
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
        else if (e.key === 'Escape') { e.preventDefault(); inp.value = original; inp.blur(); this._patternSet(path, original, true); }
        else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          const v = parseFloat(inp.value);
          if (!Number.isFinite(v) || this.pattern.params.exprs?.[path]) return;
          const step = COUNT_PATHS.has(path) ? 1 : ANGLE_PATHS.has(path) ? (e.shiftKey ? 1 : 15) : (e.shiftKey ? 0.1 : 1);
          inp.value = fmt(v + (e.key === 'ArrowUp' ? step : -step));
          this._patternSet(path, inp.value, false);
        }
      });
    });
    body.querySelectorAll('[data-step]').forEach(b => b.addEventListener('click', () => {
      const path = b.dataset.step;
      const p = this.pattern.params;
      const v = Math.max(1, Math.round(getPath(p, path)) + Number(b.dataset.d));
      if (p.exprs?.[path]) delete p.exprs[path];
      this._patternSet(path, String(v), true);
    }));
    body.querySelectorAll('[data-flip]').forEach(b => b.addEventListener('click', () => {
      const d = this.pattern.params[b.dataset.flip];
      d.reverse = !d.reverse;
      this._patternChanged();
    }));
    body.querySelectorAll('[data-unline]').forEach(b => b.addEventListener('click', () => {
      this.pattern.params[b.dataset.unline].line = null;
      this._patternChanged();
    }));
    body.querySelectorAll('[data-untarget]').forEach(b => b.addEventListener('click', () => {
      const p = this.pattern.params;
      p.targets = p.targets.filter(t => t.key !== b.dataset.untarget);
      this._patternChanged();
    }));
    body.querySelector('[data-dir2]')?.addEventListener('change', (e) => {
      const p = this.pattern.params;
      p.d2.count = e.target.checked ? Math.max(2, this.pattern.d2Last || 2) : 1;
      if (!e.target.checked) this.pattern.d2Last = getPath(p, 'd2.count');
      if (p.exprs) delete p.exprs['d2.count'];
      this._patternChanged();
    });
    body.querySelector('[data-equal]')?.addEventListener('change', (e) => {
      const p = this.pattern.params;
      const step = circularStep(p);
      p.equal = e.target.checked;
      // keep the copies where they are: total ↔ step
      if (p.exprs) delete p.exprs.angle;
      p.angle = p.equal ? (Math.abs(step * p.count) >= 360 - 1e-9 ? 360 * Math.sign(step || 1) : step * Math.max(1, p.count - 1)) : step;
      this._patternChanged();
    });
    body.querySelectorAll('[data-rev]').forEach(b => b.addEventListener('click', () => {
      this.pattern.params.reverse = b.dataset.rev === '1';
      this._patternChanged();
    }));
    body.querySelector('#pattern-linked')?.addEventListener('change', (e) => {
      this.pattern.linked = e.target.checked;
      this.refreshToolOptions();
    });
    body.querySelector('#pattern-create')?.addEventListener('click', () => this.createPattern());
    body.querySelector('#pattern-cancel')?.addEventListener('click', () => this.cancelOperation());
    body.querySelector('#pattern-done')?.addEventListener('click', () => this.finishPatternEdit());
    body.querySelector('#pattern-unlink')?.addEventListener('click', () => {
      const c = this._patternConstraint();
      this.pattern = null; this.operationName = null;
      if (c) this.unlinkPattern(c);
    });
    body.querySelector('#pattern-delete')?.addEventListener('click', () => {
      const c = this._patternConstraint();
      this.pattern = null; this.operationName = null;
      if (c) this.deletePatternCopies(c);
    });
  }

  /* ---- Properties window: shapes in a pattern, the pattern relation ---- */

  _patternSummary(c) {
    const p = c.params;
    const sketch = this.activeSketch();
    const live = new Set(sketch ? sketch.entities.map(e => e.id) : []);
    const copies = c.instances.filter(i => i.pairs.some(pr => live.has(pr[1]))).length;
    let what = '';
    if (c.type === 'linear') what = p.d2.count > 1 ? `${p.d1.count} × ${p.d2.count}, ${fmt(p.d1.spacing)} × ${fmt(p.d2.spacing)} mm` : `${p.d1.count} × ${fmt(p.d1.spacing)} mm`;
    else if (c.type === 'circular') what = `${p.count} × ${fmt(circularStep(p))}°`;
    else what = `${p.targets.length} target${p.targets.length === 1 ? '' : 's'}`;
    const skipped = c.skipped.length ? `, ${c.skipped.length} skipped` : '';
    return { what, copies, skipped };
  }

  /** Card in Properties for selected shapes that belong to a pattern. */
  _patternBlockHTML(geom) {
    if (this.operationName === 'pattern') return '';
    const pats = this.patternsOf(geom).slice(0, 3);
    if (!pats.length) return '';
    let html = '<div class="sb-subhead">Pattern</div>';
    for (const c of pats) {
      const s = this._patternSummary(c);
      html += `<div class="pat-card" data-cid="${c.id}" ${this._hoverAttr ? `data-hover="${esc([...c.memberIds()].join(' '))}"` : ''}>
        <span class="pat-card-icon">${ACTION_ICONS[TYPE_ICON[c.type]]}</span>
        <span class="pat-card-text"><strong>${PATTERN_LABELS[c.type]}</strong><span>${esc(s.what)}${s.skipped}</span></span>
        <button class="rel-btn" data-pattern-edit="${c.id}" title="Change the pattern">Edit</button>
      </div>`;
    }
    return html;
  }

  /** Properties for a selected pattern relation. */
  _patternConstraintHTML(c) {
    const s = this._patternSummary(c);
    return `<div class="ps-head">
        <span class="ps-glyph">▦</span>
        <span class="ps-title"><strong>${PATTERN_LABELS[c.type]}</strong><span class="ps-id">${esc(c.id)}</span></span>
        <span class="ps-tag">linked</span>
      </div>
      <div class="tool-summary">
        <div class="tool-metric"><strong>${c.seeds.length}</strong><span>Seed shapes</span></div>
        <div class="tool-metric"><strong>${s.copies}</strong><span>Copies</span></div>
      </div>
      <div class="tool-note">${esc(s.what)}${s.skipped}. Copies follow the seed.</div>
      <div class="rel-grid">
        <button class="rel-btn primary full" data-pattern-edit="${c.id}">${ACTION_ICONS[TYPE_ICON[c.type]]}Edit pattern</button>
        <button class="rel-btn" data-pattern-unlink="${c.id}" title="Keep the copies as separate shapes">${uiIcon('unlock')}Unlink</button>
        <button class="rel-btn danger" data-pattern-delete="${c.id}" title="Remove the copies; the seed stays">${uiIcon('trash')}Delete copies</button>
      </div>`;
  }

  _bindPatternBlock(body) {
    const sketch = this.activeSketch(); if (!sketch) return;
    const find = (id) => sketch.constraints.find(c => c.id === id);
    body.querySelectorAll('[data-pattern-edit]').forEach(b => b.addEventListener('click', (e) => {
      e.stopPropagation();
      this.editPattern(find(b.dataset.patternEdit));
    }));
    body.querySelectorAll('[data-pattern-unlink]').forEach(b => b.addEventListener('click', () => this.unlinkPattern(find(b.dataset.patternUnlink))));
    body.querySelectorAll('[data-pattern-delete]').forEach(b => b.addEventListener('click', () => this.deletePatternCopies(find(b.dataset.patternDelete))));
  }
}
