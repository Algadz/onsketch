import { strokeHit } from '../core/strokes.js';
import { INK } from '../render/theme.js';

const esc = (t) => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* =============== SELECTING AND MOVING INK ======================
   Strokes from the Sketch window work with the Select tool like shapes
   do, on the active layer only:
   - click selects (Ctrl toggles, Shift adds); geometry under the cursor
     wins, so CAD editing is unchanged;
   - a box selects strokes that lie entirely inside it;
   - drag moves the selected strokes (and selected shapes move with
     them when the drag starts on a shape);
   - Delete removes them; Properties shows colour, opacity, width, layer.
   `selected` on a stroke is transient: strokeToJSON doesn't save it.
   ============================================================ */
export class InkSelectMixin {
  /** Topmost visible stroke of the active layer under the point. */
  hitStrokeAt(world) {
    const sketch = this.activeSketch(); if (!sketch) return null;
    const layer = this.project.activeLayer();
    if (!layer || !layer.visible) return null;
    const tol = 5 / this.view.zoom;
    for (let i = sketch.strokes.length - 1; i >= 0; i--) {
      const s = sketch.strokes[i];
      if (s.layerId === layer.id && strokeHit(s, world, tol)) return s;
    }
    return null;
  }

  selectedStrokes() {
    const sketch = this.activeSketch();
    return sketch ? sketch.strokes.filter(s => s.selected) : [];
  }

  setStrokeSelected(stroke, on) {
    stroke.selected = !!on;
  }

  clearStrokeSelection() {
    for (const s of this.project.sketches) for (const st of s.strokes) st.selected = false;
  }

  /** Strokes of the active layer lying entirely inside the world box. */
  strokesInBox(x0, y0, x1, y1) {
    const sketch = this.activeSketch(); if (!sketch) return [];
    const layerId = this.project.activeLayerId;
    return sketch.strokes.filter(s => s.layerId === layerId
      && s.points.every(p => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1));
  }

  /** Start moving the selected strokes; returns the drag record. */
  beginInkDrag(startWorld) {
    const items = this.selectedStrokes().map(s => ({ s, pts: s.points.map(p => ({ x: p.x, y: p.y })) }));
    return items.length ? { startWorld, items, moved: false } : null;
  }

  dragInk(drag, world) {
    const dx = world.x - drag.startWorld.x, dy = world.y - drag.startWorld.y;
    if (!drag.moved && Math.hypot(dx, dy) * this.view.zoom < 2) return;
    drag.moved = true;
    for (const { s, pts } of drag.items) s.points = pts.map(p => ({ x: p.x + dx, y: p.y + dy }));
    this.requestRender();
  }

  deleteSelectedStrokes() {
    const sketch = this.activeSketch(); if (!sketch) return false;
    const n = sketch.strokes.length;
    sketch.strokes = sketch.strokes.filter(s => !s.selected);
    return sketch.strokes.length !== n;
  }

  /* ---- Properties: the selected ink ---- */
  _inkSectionHTML(strokes) {
    if (!strokes.length) return '';
    const first = strokes[0];
    const same = (k) => strokes.every(s => s[k] === first[k]);
    const color = same('color') ? first.color : null;
    const shown = (c) => c === INK ? '#111418' : c;
    const opacity = same('opacity') ? first.opacity : null;
    const width = same('width') ? first.width : null;
    const n = strokes.length;
    let html = `<div class="sb-subhead">Ink (${n} stroke${n === 1 ? '' : 's'})</div>`;
    html += `<div class="prop-row"><label>colour</label><input type="color" data-ink-k="color" value="${shown(color || first.color)}"${color ? '' : ' title="Mixed colours"'}></div>`;
    html += `<div class="prop-row"><label>opacity</label><div class="range-row"><input type="range" min="0.05" max="1" step="0.05" data-ink-k="opacity" value="${opacity ?? first.opacity}"><span>${opacity == null ? 'mixed' : Math.round(opacity * 100) + '%'}</span></div></div>`;
    html += `<div class="prop-row"><label>width</label><div class="unit-row"><input type="number" min="0.01" step="any" data-ink-k="width" value="${width == null ? '' : Number(width.toPrecision(4))}" placeholder="mixed"><span>${esc(this.project.units)}</span></div></div>`;
    if (this.project.layers.length > 1) {
      html += `<div class="prop-row"><label>layer</label><select data-ink-k="layer">
        ${[...this.project.layers].reverse().map(l => `<option value="${l.id}"${l.id === first.layerId ? ' selected' : ''}>${esc(l.name)}</option>`).join('')}
      </select></div>`;
    }
    html += '<div class="hint">Drag to move. Delete removes. Ink is not solved or dimensioned.</div>';
    return html;
  }

  _bindInkSection(body) {
    const strokes = this.selectedStrokes();
    if (!strokes.length) return;
    body.querySelectorAll('[data-ink-k]').forEach(inp => {
      const k = inp.dataset.inkK;
      const live = () => {
        if (k === 'color') for (const s of strokes) s.color = inp.value;
        else if (k === 'opacity') { const v = parseFloat(inp.value); for (const s of strokes) s.opacity = v; inp.nextElementSibling.textContent = Math.round(v * 100) + '%'; }
        this.requestRender();
      };
      if (k === 'color' || k === 'opacity') inp.addEventListener('input', live);
      inp.addEventListener('change', () => {
        if (k === 'width') {
          const v = parseFloat(inp.value);
          if (!(v > 0)) { inp.classList.add('bad'); return; }
          for (const s of strokes) s.width = v;
        } else if (k === 'layer') {
          for (const s of strokes) { s.layerId = inp.value; s.selected = false; }
        } else live();
        this.commit();
        this.refreshUI();
        this.requestRender();
      });
    });
  }
}
