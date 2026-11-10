import { PAPER, cleanBox, inkHit, inkInBox, isText, placeTextCenter, textCenter } from '../core/strokes.js';
import { isArrow, setArrowEnd } from '../core/arrows.js';
import { arrowStyleHTML, bindArrowStyle, bindBoxSwatches, boxModeHTML, boxSwatchesHTML } from './sketch-window.js';
import { groupOf, withGroups } from '../core/ink-links.js';
import { INK } from '../render/theme.js';

const esc = (t) => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* =============== SELECTING AND MOVING INK ======================
   Strokes and texts from the Sketch window work with the Select tool
   like shapes do, on the active layer only:
   - click selects (Ctrl toggles, Shift adds); geometry under the cursor
     wins, so CAD editing is unchanged; a grouped item brings its whole
     group;
   - a box selects ink that lies entirely inside it (and its groups);
   - drag moves the selected ink (and selected shapes move with it when
     the drag starts on a shape); linked ink stays linked, from where it
     was dropped;
   - double-click a text to edit it;
   - Delete removes; Properties shows colour, opacity, width or text
     size, layer, group and link.
   `selected` on an item is transient: strokeToJSON doesn't save it.
   ============================================================ */
export class InkSelectMixin {
  /** Topmost visible ink item of the active layer under the point. */
  hitStrokeAt(world, { textOnly = false } = {}) {
    const sketch = this.activeSketch(); if (!sketch) return null;
    const layer = this.project.activeLayer();
    if (!layer || !layer.visible) return null;
    const tol = 5 * (this._inputScale || 1) / this.view.zoom;
    for (let i = sketch.strokes.length - 1; i >= 0; i--) {
      const s = sketch.strokes[i];
      if (s.layerId !== layer.id || (textOnly && !isText(s))) continue;
      if (inkHit(s, world, isText(s) ? tol / 2 : tol)) return s;
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

  /** Select (or toggle) an item together with its group. */
  selectInk(item, on = true) {
    const sketch = this.activeSketch(); if (!sketch) return;
    for (const x of groupOf(sketch.strokes, item)) x.selected = !!on;
  }

  clearStrokeSelection() {
    for (const s of this.project.sketches) for (const st of s.strokes) st.selected = false;
  }

  /** Ink of the active layer lying entirely inside the world box, with
   *  the rest of the groups it belongs to. */
  strokesInBox(x0, y0, x1, y1) {
    const sketch = this.activeSketch(); if (!sketch) return [];
    const layerId = this.project.activeLayerId;
    const inside = sketch.strokes.filter(s => s.layerId === layerId && inkInBox(s, x0, y0, x1, y1));
    return withGroups(sketch.strokes, inside);
  }

  /** Start moving the selected ink; returns the drag record. While it
   *  lasts, the links of the dragged items don't pull them. */
  beginInkDrag(startWorld) {
    const items = this.selectedStrokes().map(s => ({ s, pts: s.points.map(p => ({ x: p.x, y: p.y })) }));
    if (!items.length) return null;
    this._inkDragItems = new Set(items.map(i => i.s));
    return { startWorld, items, moved: false };
  }

  dragInk(drag, world) {
    const dx = world.x - drag.startWorld.x, dy = world.y - drag.startWorld.y;
    if (!drag.moved && Math.hypot(dx, dy) * this.view.zoom < 2) return;
    drag.moved = true;
    for (const { s, pts } of drag.items) s.points = pts.map(p => ({ x: p.x + dx, y: p.y + dy }));
    this.requestRender();
  }

  /** End of an ink drag: moved linked ink keeps its link, from where it
   *  was dropped. */
  endInkDrag(drag) {
    this._inkDragItems = null;
    if (drag && drag.moved) this.rebaseInk(drag.items.map(i => i.s));
  }

  deleteSelectedStrokes() {
    const sketch = this.activeSketch(); if (!sketch) return false;
    const n = sketch.strokes.length;
    sketch.strokes = sketch.strokes.filter(s => !s.selected);
    return sketch.strokes.length !== n;
  }

  /* ---- Properties: the selected ink ---- */
  _inkSectionHTML(items) {
    if (!items.length) return '';
    const first = items[0];
    const texts = items.filter(isText), strokes = items.filter(s => !isText(s));
    const same = (list, k) => list.every(s => s[k] === list[0][k]);
    const color = same(items, 'color') ? first.color : null;
    const shown = (c) => c === INK ? '#111418' : c;
    const opacity = same(items, 'opacity') ? first.opacity : null;
    const units = esc(this.project.units);
    const arrows = items.filter(isArrow);
    const lines = strokes.length - arrows.length;
    const what = [
      lines ? `${lines} stroke${lines === 1 ? '' : 's'}` : '',
      arrows.length ? `${arrows.length} arrow${arrows.length === 1 ? '' : 's'}` : '',
      texts.length ? `${texts.length} text${texts.length === 1 ? '' : 's'}` : '',
    ].filter(Boolean).join(', ');
    let html = `<div class="sb-subhead">Ink (${what})</div>`;
    if (texts.length === 1 && items.length === 1) {
      html += `<div class="prop-row prop-text"><label>text</label><textarea rows="2" data-ink-k="text" spellcheck="false">${esc(first.text)}</textarea></div>`;
    }
    html += `<div class="prop-row"><label>colour</label><input type="color" data-ink-k="color" value="${shown(color || first.color)}"${color ? '' : ' title="Mixed colours"'}></div>`;
    html += `<div class="prop-row"><label>opacity</label><div class="range-row"><input type="range" min="0.05" max="1" step="0.05" data-ink-k="opacity" value="${opacity ?? first.opacity}"><span>${opacity == null ? 'mixed' : Math.round(opacity * 100) + '%'}</span></div></div>`;
    if (strokes.length) {
      const width = same(strokes, 'width') ? strokes[0].width : null;
      html += `<div class="prop-row"><label>width</label><div class="unit-row"><input type="number" min="0.01" step="any" data-ink-k="width" value="${width == null ? '' : Number(width.toPrecision(4))}" placeholder="mixed"><span>${units}</span></div></div>`;
    }
    if (arrows.length) {
      const pick = (k, d) => (arrows.every(a => (a[k] ?? d) === (arrows[0][k] ?? d)) ? (arrows[0][k] ?? d) : null);
      html += arrowStyleHTML({ tips: pick('tips', 'end'), head: pick('head', 'filled'), dash: pick('dash', false) && true }, 'data-ink-arrow', true)
        .replace(/<label>Ends<\/label>/, '<label>ends</label>').replace(/<label>Head<\/label>/, '<label>head</label>').replace(/<label>Line<\/label>/, '<label>line</label>');
      const attached = arrows.filter(a => a.at && (a.at[0] || a.at[1]));
      if (attached.length) {
        const lookup = this._anchorLookup();
        const names = [...new Set(attached.flatMap(a => a.at.filter(Boolean).map(x => lookup.get(x.to)).filter(Boolean).map(e => esc(this._entityLabel(e)))))];
        html += `<div class="prop-row"><label>attached</label><span class="prop-val">${names.join(', ') || 'a shape'} <button class="mini-btn" data-ink-act="detach" title="Free the arrow ends from the shapes">Detach</button></span></div>`;
      }
    }
    if (texts.length) {
      const size = same(texts, 'size') ? texts[0].size : null;
      const bold = texts.every(t => t.bold);
      html += `<div class="prop-row"><label>text size</label><div class="unit-row"><input type="number" min="0.01" step="any" data-ink-k="size" value="${size == null ? '' : Number(size.toPrecision(4))}" placeholder="mixed"><span>${units}</span></div></div>`;
      html += `<div class="prop-row"><label>bold</label><input type="checkbox" data-ink-k="bold"${bold ? ' checked' : ''}></div>`;
      const ang = same(texts, 'angle') ? (texts[0].angle || 0) : null;
      html += `<div class="prop-row"><label>angle</label><div class="unit-row"><input type="number" step="any" data-ink-k="angle" value="${ang == null ? '' : Number((ang * 180 / Math.PI).toFixed(2))}" placeholder="mixed"><span>°</span></div></div>`;
      const modes = texts.map(t => !t.box ? 'none' : t.box.border ? 'outline' : 'box');
      html += `<div class="prop-row"><label>box</label>${boxModeHTML(modes.every(m => m === modes[0]) ? modes[0] : null, 'data-ink-boxmode')}</div>`;
      const boxed = texts.filter(t => t.box);
      if (boxed.length) {
        const c = boxed.every(t => t.box.color === boxed[0].box.color) ? boxed[0].box.color : null;
        html += `<div class="prop-row"><label>box colour</label>${boxSwatchesHTML(c, 'data-ink-boxcolor')}</div>`;
      }
    }
    if (this.project.layers.length > 1) {
      html += `<div class="prop-row"><label>layer</label><select data-ink-k="layer">
        ${[...this.project.layers].reverse().map(l => `<option value="${l.id}"${l.id === first.layerId ? ' selected' : ''}>${esc(l.name)}</option>`).join('')}
      </select></div>`;
    }
    html += this._inkGroupLinkHTML(items);
    html += `<div class="hint">Drag to move${texts.length ? ', double-click a text to edit it' : ''}. Delete removes. Ink is not solved or dimensioned.</div>`;
    return html;
  }

  /** Group and link rows of the ink properties. */
  _inkGroupLinkHTML(items) {
    let html = '';
    const groups = new Set(items.map(i => i.group || null));
    const oneGroup = groups.size === 1 && !groups.has(null);
    const grouped = items.some(i => i.group);
    const btn = (act, label, title) => `<button class="mini-btn" data-ink-act="${act}" title="${title}">${label}</button>`;
    if (oneGroup) html += `<div class="prop-row"><label>group</label><span class="prop-val">${items.length} items ${btn('ungroup', 'Ungroup', 'Ungroup (Ctrl+Shift+G)')}</span></div>`;
    else if (items.length > 1) html += `<div class="prop-row"><label>group</label><span class="prop-val">${btn('group', 'Group', 'Select and move them as one (Ctrl+G)')}${grouped ? btn('ungroup', 'Ungroup', 'Ungroup (Ctrl+Shift+G)') : ''}</span></div>`;

    const targets = new Set(items.map(i => i.link?.to || null));
    const lookup = targets.size ? this._anchorLookup() : null;
    let linkText;
    if (targets.size === 1 && !targets.has(null)) {
      const a = lookup.get([...targets][0]);
      linkText = `follows ${a ? esc(this._entityLabel(a)) : 'a shape'}`;
    } else if ([...targets].some(Boolean)) linkText = 'some items are linked';
    else linkText = 'free';
    const linked = [...targets].some(Boolean);
    html += `<div class="prop-row"><label>link</label><span class="prop-val">${linkText} ${btn('link', linked ? 'Change…' : 'Link to…', 'Click a point, line, circle or arc for the ink to follow')}${linked ? btn('unlink', 'Unlink', 'Stop following the geometry') : ''}</span></div>`;
    return html;
  }

  _bindInkSection(body) {
    const items = this.selectedStrokes();
    if (!items.length) return;
    const texts = items.filter(isText), strokes = items.filter(s => !isText(s));
    body.querySelectorAll('[data-ink-k]').forEach(inp => {
      const k = inp.dataset.inkK;
      const live = () => {
        if (k === 'color') for (const s of items) s.color = inp.value;
        else if (k === 'opacity') { const v = parseFloat(inp.value); for (const s of items) s.opacity = v; inp.nextElementSibling.textContent = Math.round(v * 100) + '%'; }
        this.requestRender();
      };
      if (k === 'color' || k === 'opacity') inp.addEventListener('input', live);
      if (k === 'text') {
        inp.addEventListener('input', () => { if (inp.value.trim()) { texts[0].text = inp.value; this.requestRender(); } });
        inp.addEventListener('keydown', (e) => e.stopPropagation());
      }
      inp.addEventListener('change', () => {
        if (k === 'width' || k === 'size') {
          const v = parseFloat(inp.value);
          if (!(v > 0)) { inp.classList.add('bad'); return; }
          for (const s of (k === 'width' ? strokes : texts)) s[k] = v;
        } else if (k === 'bold') {
          for (const t of texts) t.bold = inp.checked;
        } else if (k === 'angle') {
          const deg = parseFloat(inp.value);
          if (!Number.isFinite(deg)) { inp.classList.add('bad'); return; }
          for (const t of texts) { const c = textCenter(t); if (deg) t.angle = deg * Math.PI / 180; else delete t.angle; placeTextCenter(t, c); }
        } else if (k === 'text') {
          if (!inp.value.trim()) { inp.value = texts[0].text; return; }
          texts[0].text = inp.value.replace(/\s+$/, '');
        } else if (k === 'layer') {
          for (const s of items) { s.layerId = inp.value; s.selected = false; }
        } else live();
        this.commit();
        this.refreshUI();
        this.requestRender();
      });
    });
    const done = () => { this.commit(); this.refreshUI(); this.requestRender(); };
    bindArrowStyle(body, 'data-ink-arrow', (k, v) => {
      for (const a of items.filter(isArrow)) {
        if (k === 'tips') { if (v === 'end') delete a.tips; else a.tips = v; }
        else if (k === 'head') { if (v === 'filled') delete a.head; else a.head = v; }
        else if (v) a.dash = true; else delete a.dash;
      }
      done();
    });
    body.querySelectorAll('[data-ink-boxmode]').forEach(b => b.addEventListener('click', () => {
      const mode = b.dataset.inkBoxmode;
      for (const t of texts) {
        if (mode === 'none') delete t.box;
        else t.box = cleanBox({ color: t.box?.color || this.pen.textBoxColor || PAPER, border: mode === 'outline' });
      }
      done();
    }));
    bindBoxSwatches(body, 'data-ink-boxcolor', (c) => {
      for (const t of texts) t.box = cleanBox({ color: c, border: !!t.box?.border });
      done();
    });
    body.querySelectorAll('[data-ink-act]').forEach(b => b.addEventListener('click', () => {
      const act = b.dataset.inkAct;
      if (act === 'group') this.groupSelectedInk();
      else if (act === 'ungroup') this.ungroupSelectedInk();
      else if (act === 'link') this.startLinkPick();
      else if (act === 'unlink') this.unlinkSelectedInk();
      else if (act === 'detach') { for (const a of items.filter(isArrow)) { setArrowEnd(a, 0, null); setArrowEnd(a, 1, null); } done(); }
    }));
  }
}
