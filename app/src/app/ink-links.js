import { Arc, Circle, Line, Point, newId } from '../core/entities.js';
import { anchorFrame, anchorLookup, canAnchor, groupItems, linkItems, rebaseLinks, syncLinks, ungroupItems, unlinkItems } from '../core/ink-links.js';
import { inkBounds, isText, unionBounds } from '../core/strokes.js';
import { isImage } from '../core/images.js';

const inkWord = (it) => (isText(it) ? 'text' : isImage(it) ? 'image' : it.kind === 'arrow' ? 'arrow' : 'stroke');
import { detachMovedEnds, syncArrowEnds } from '../core/arrows.js';

/* =============== GROUP AND LINK INK ============================
   Two right-click actions on ink (strokes and texts), also in
   Properties and on the keyboard:

   Group (Ctrl+G) / Ungroup (Ctrl+Shift+G)
     Grouped ink is picked, moved, recoloured and deleted as one piece.
     Geometry is never grouped: what moves it is the solver.

   Link to… / Unlink
     The ink follows a point, line, circle or arc (core/ink-links.js):
     change a dimension or drag the shape and the label goes with it.
     Two ways to link:
     - right-click the ink → "Link to a shape…", then click the target
       (any visible layer; Esc cancels);
     - with ink selected, right-click the target shape → "Link ink to
       this …".
     Dragging linked ink re-places it but keeps the link. Selected linked
     ink shows a dotted leader to the spot it follows. Deleting the shape
     drops the link and leaves the ink where it is.
   ============================================================ */
export class InkLinksMixin {
  _anchorLookup() { return anchorLookup(this.project.sketches); }

  /** Carries linked ink along with its geometry. Called before every
   *  render and before every undo snapshot.
   *  @returns {boolean} whether any ink moved or lost its link */
  syncInkLinks() {
    if (!this.project.sketches.some(s => s.strokes.some(x => x.link || x.at))) return false;
    const lookup = this._anchorLookup();
    const skip = this._inkDragItems || null;
    let changed = false;
    for (const s of this.project.sketches) {
      changed = syncLinks(s.strokes, lookup, skip) || changed;
      // then attached arrow ends sit back on their shapes
      changed = syncArrowEnds(s.strokes, lookup, skip) || changed;
    }
    return changed;
  }

  /** Ink moved by hand keeps its links, from where it now is. */
  rebaseInk(items) {
    if (!items.some(i => i.link || i.at)) return;
    const lookup = this._anchorLookup();
    detachMovedEnds(items, lookup);
    rebaseLinks(items, lookup);
  }

  /* ---- Group ---- */
  groupSelectedInk() {
    const items = this.selectedStrokes();
    if (items.length < 2) { this._inkHint('Select two or more strokes or texts to group them.'); return false; }
    groupItems(items, newId('g'), this._anchorLookup());
    this.commit(); this.refreshUI(); this.requestRender();
    this._inkHint(`Grouped ${items.length} items: they are selected and moved together.`);
    return true;
  }

  ungroupSelectedInk() {
    const n = ungroupItems(this.selectedStrokes());
    if (!n) return false;
    this.commit(); this.refreshUI(); this.requestRender();
    this._inkHint('Ungrouped.');
    return true;
  }

  /* ---- Link ---- */
  linkInkTo(items, anchor) {
    if (!items.length || !canAnchor(anchor)) return false;
    linkItems(items, anchor);
    this.commit(); this.refreshUI(); this.requestRender();
    const what = items.length === 1 ? `The ${inkWord(items[0])}` : `${items.length} items`;
    this._inkHint(`${what} now follow${items.length === 1 ? 's' : ''} ${this._entityLabel(anchor)}. Drag to re-place; right-click → Unlink to free.`);
    return true;
  }

  unlinkSelectedInk() {
    const n = unlinkItems(this.selectedStrokes());
    if (!n) return false;
    this.commit(); this.refreshUI(); this.requestRender();
    this._inkHint('Unlinked: the ink stays where it is and no longer follows the geometry.');
    return true;
  }

  /** "Link to…": the next click on a point or shape (any visible layer)
   *  becomes the anchor of the selected ink. */
  startLinkPick() {
    const items = this.selectedStrokes();
    if (!items.length) return false;
    if (this.toolName !== 'select') this.setTool('select');
    this.linkPick = { items };
    this.canvas.style.cursor = 'crosshair';
    this._inkHint('Click the point, line, circle or arc the ink should follow. Esc cancels.');
    this.requestRender();
    return true;
  }

  cancelLinkPick() {
    if (!this.linkPick) return false;
    this.linkPick = null;
    this._setHoverTarget(null);
    this._updateCanvasCursor();
    this._inkHint((this.tool?.hint && this.tool.hint()) || '');
    return true;
  }

  /** Point or shape under the cursor on any visible layer (points first). */
  hitAnchorAt(world) {
    const v = this._hitView();
    const sketches = this.project.visibleSketches();
    for (const s of sketches) for (const e of s.entities) {
      if (!this.isEntityVisible(e)) continue;
      for (const c of e.children()) if (c.hit(world, v)) return c;
      if (e instanceof Point && e.hit(world, v)) return e;
    }
    for (const s of sketches) for (const e of s.entities) {
      if (!(e instanceof Point) && this.isEntityVisible(e) && e.hit(world, v)) return e;
    }
    return null;
  }

  /** A click while picking a link target. Always consumed. */
  handleLinkPick(world) {
    const pick = this.linkPick;
    const target = this.hitAnchorAt(world);
    if (!target) { this._inkHint('Click a point, line, circle or arc (Esc cancels).'); return true; }
    this.linkPick = null;
    this._setHoverTarget(null);
    this._updateCanvasCursor();
    const sketch = this.activeSketch();
    const items = pick.items.filter(i => sketch?.strokes.includes(i));
    this.linkInkTo(items, target);
    return true;
  }

  /* ---- Right-click on ink ---- */

  /** Actions for the selected ink (the right-clicked item was selected
   *  first, with its group). */
  inkContextActions() {
    const items = this.selectedStrokes();
    if (!items.length) return [];
    const out = [];
    if (items.length === 1 && isText(items[0])) {
      out.push({ id: 'edit-text', glyph: 'T', label: 'Edit text', run: () => this.editText(items[0]) });
    }
    out.push(...this.clipboardActions());
    const groups = new Set(items.map(i => i.group || null));
    const oneGroup = groups.size === 1 && !groups.has(null);
    if (items.length > 1 && !oneGroup) out.push({ id: 'group', glyph: '▣', label: `Group (${items.length})`, hint: 'Ctrl+G', run: () => this.groupSelectedInk() });
    if (items.some(i => i.group)) out.push({ id: 'ungroup', glyph: '▢', label: 'Ungroup', hint: 'Ctrl+Shift+G', run: () => this.ungroupSelectedInk() });
    const linked = items.some(i => i.link);
    out.push({ id: 'link', glyph: '⇢', label: linked ? 'Link to another shape…' : 'Link to a shape…', run: () => this.startLinkPick() });
    if (linked) out.push({ id: 'unlink', glyph: '⇥', label: 'Unlink', run: () => this.unlinkSelectedInk() });
    out.push({ id: 'rotate90', glyph: '↻', label: 'Rotate 90°', run: () => this.transformSelectedInk('rotate') });
    out.push({ id: 'flipH', glyph: '⇋', label: 'Flip horizontal', run: () => this.transformSelectedInk('flipH') });
    out.push({ id: 'flipV', glyph: '⇵', label: 'Flip vertical', run: () => this.transformSelectedInk('flipV') });
    if (this.touchUI) out.push({ id: 'delete', glyph: '✕', label: items.length > 1 ? `Delete (${items.length})` : 'Delete', run: () => this.deleteSelection() });
    return out;
  }

  /** With ink selected, right-clicking a shape offers to link the ink to it. */
  linkHereActions(target) {
    const items = this.selectedStrokes();
    if (!items.length || !canAnchor(target)) return [];
    const what = items.length === 1 ? inkWord(items[0]) : `ink (${items.length})`;
    return [{ id: 'link-here', glyph: '⇢', label: `Link selected ${what} to this ${this._entityLabel(target).split(' ')[0].toLowerCase()}`, run: () => this.linkInkTo(items, target) }];
  }

  /* ---- Drawing ---- */

  /** Dotted leaders from selected linked ink to the spot it follows. */
  _drawInkLinks() {
    const sketch = this.activeSketch(); if (!sketch) return;
    const sel = sketch.strokes.filter(s => s.selected && s.link && !s._editing);
    if (!sel.length) return;
    const lookup = this._anchorLookup();
    const byTarget = new Map();
    for (const it of sel) {
      const key = it.link.to + '|' + (it.link.t ?? '');
      if (!byTarget.has(key)) byTarget.set(key, []);
      byTarget.get(key).push(it);
    }
    for (const list of byTarget.values()) {
      const a = lookup.get(list[0].link.to);
      const f = a && anchorFrame(a, list[0].link.t);
      if (!f) continue;
      const b = list.length === 1 ? inkBounds(list[0]) : unionBounds(list);
      const from = nearestOnBox(b, { x: f[0], y: f[1] });
      this.renderer.drawInkLink(from, { x: f[0], y: f[1] });
    }
  }

  _inkHint(text) {
    const el = document.getElementById('status-hint');
    if (el) el.textContent = text;
  }

  /** Short glyph for an anchor in menus. */
  _anchorGlyph(e) {
    return e instanceof Point ? 'P' : e instanceof Line ? 'L' : e instanceof Circle ? 'C' : e instanceof Arc ? 'A' : '?';
  }
}

/** Point of the box closest to p (p itself when inside). */
function nearestOnBox(b, p) {
  return { x: Math.min(b.maxX, Math.max(b.minX, p.x)), y: Math.min(b.maxY, Math.max(b.minY, p.y)) };
}
