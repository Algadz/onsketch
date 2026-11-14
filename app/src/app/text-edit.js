import { newId } from '../core/entities.js';
import { BOX_PAD, TEXT_LINE, TEXT_MAX, textBox, textFont } from '../core/strokes.js';
import { INK } from '../render/theme.js';

/* =============== EDITING TEXT IN PLACE =========================
   One text is edited at a time, in a transparent textarea laid exactly
   over where the text is drawn (same font, size and colour), so typing
   looks like writing on the canvas. The canvas skips that text while
   the box is open; the box follows zoom and pan.
   - Enter or Esc finishes; Shift+Enter starts a new line;
   - clicking anywhere else finishes;
   - finishing with no text removes the text (a new one is just dropped).
   A new text is added to the sketch only when it is finished, so
   starting one and clicking away leaves no trace and no undo step.
   Restyling while typing: pressing a style button (Sketch window,
   options bar, Colors palette) doesn't take the focus from the box, so
   Bold / Box / a colour apply to the text being typed and typing goes
   on. A finished text stays selected and keeps following the settings
   until the next one starts (sketch-window.js, "Draw first, refine").
   ============================================================ */
const STYLE_BUTTONS = '#sketch-body button, #optbar button, #colors-body .palette button';
export class TextEditMixin {
  /** Starts a new text with the middle of its first line at `world`. */
  startNewText(world) {
    const sketch = this.activeSketch(); if (!sketch) return;
    const layer = this.project.activeLayer();
    if (!layer?.visible) {
      document.getElementById('status-hint').textContent = 'The active layer is hidden: show it to add text.';
      return;
    }
    const s = this.inkSettings('text');
    const size = s.size / this.view.zoom;
    const item = {
      id: newId('k'), layerId: layer.id, kind: 'text',
      color: this.pen.fillColor, opacity: 1, size, bold: !!s.bold, text: '',
      points: [{ x: world.x, y: world.y + size * TEXT_LINE / 2 }],
    };
    if (s.box) item.box = { ...s.box };
    this.editText(item, { isNew: true });
  }

  /** Opens the inline editor on a text (new or existing). */
  editText(item, { isNew = false } = {}) {
    this.finishTextEdit();
    const ws = document.getElementById('workspace');
    const ta = document.createElement('textarea');
    ta.className = 'text-edit';
    ta.value = item.text;
    ta.maxLength = TEXT_MAX;
    ta.wrap = 'off';
    ta.spellcheck = false;
    ta.setAttribute('autocapitalize', 'sentences');
    ta.setAttribute('aria-label', 'Text');
    item._editing = true;
    this._keepTextFocusOnStyleButtons();
    const te = { item, isNew, ta };
    te.place = () => {
      const v = this.view;
      const p = v.worldToScreen(item.points[0]);
      const px = Math.max(4, item.size * v.zoom);
      const b = textBox({ ...item, text: ta.value || ' ', _raw: true });   // formulas as typed
      // With a box, the textarea is the box: padded, filled and outlined
      // like the canvas draws it.
      const pad = item.box ? BOX_PAD * item.size * v.zoom : 0;
      const ink = item.color === INK ? this.renderer.theme.ink : item.color;
      ta.style.left = (p.x - pad) + 'px';
      ta.style.top = (p.y - pad) + 'px';
      ta.style.padding = pad + 'px';
      ta.style.font = textFont(px, item.bold);
      ta.style.lineHeight = String(TEXT_LINE);
      ta.style.color = ink;
      ta.style.opacity = String(item.opacity ?? 1);
      ta.style.background = item.box ? this.renderer.boxColor(item.box.color) : 'transparent';
      ta.style.borderRadius = item.box ? Math.min(6, px * 0.25) + 'px' : '1px';
      ta.style.boxShadow = item.box?.border ? `inset 0 0 0 ${Math.max(1, px * 0.06)}px ${ink}` : 'none';
      ta.style.width = Math.ceil(b.w * v.zoom + px * 0.8 + 2 + 2 * pad) + 'px';
      ta.style.height = Math.ceil(b.h * v.zoom + 2 * pad) + 'px';
      // a turned text is edited turned, about its top-left corner
      ta.style.transformOrigin = `${pad}px ${pad}px`;
      ta.style.transform = item.angle ? `rotate(${-item.angle}rad)` : '';
    };
    te.place();
    ta.addEventListener('input', () => te.place());
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Escape') { e.preventDefault(); this.finishTextEdit(); }
    });
    const focus = () => { if (this._textEdit === te) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } };
    // The click that opened the box may still move the focus away: a blur
    // right after opening refocuses instead of finishing.
    te.opened = performance.now();
    ta.addEventListener('blur', () => {
      if (this._textEdit !== te) return;
      if (performance.now() - te.opened < 250) { setTimeout(focus, 0); return; }
      this.finishTextEdit();
    });
    ws.appendChild(ta);
    this._textEdit = te;
    focus();                     // at once, so typing right away goes in the box
    setTimeout(focus, 0);
    document.getElementById('status-hint').textContent = 'Type the text. {D1} or {orbit*2} shows a value (click a dimension to insert it). Enter or Esc finishes, Shift+Enter adds a line.';
    this.requestRender();
  }

  /** While a text is being typed, a press on a style button must not move
   *  the focus away (that would finish the text): the click still runs. */
  _keepTextFocusOnStyleButtons() {
    if (this._textFocusGuard) return;
    this._textFocusGuard = (e) => {
      if (this._textEdit && e.target.closest?.(STYLE_BUTTONS)) e.preventDefault();
    };
    document.addEventListener('mousedown', this._textFocusGuard, true);
  }

  /** Closes the editor and keeps what was typed (one undo step).
   *  @returns {boolean} whether an editor was open */
  finishTextEdit() {
    const te = this._textEdit;
    if (!te) return false;
    this._textEdit = null;
    const { item, isNew, ta } = te;
    ta.remove();
    delete item._editing;
    const text = ta.value.replace(/\s+$/, '');
    const sketch = this.activeSketch();
    let changed = false;
    if (sketch) {
      if (!text.trim()) {
        if (!isNew && sketch.strokes.includes(item)) { sketch.strokes = sketch.strokes.filter(x => x !== item); changed = true; }
      } else if (isNew) {
        item.text = text;
        sketch.strokes.push(item);
        changed = true;
      } else if (text !== item.text) {
        item.text = text;
        changed = true;
      }
    }
    if (changed) { this.commit(); this.refreshUI(); }
    document.getElementById('status-hint').textContent = (this.tool?.hint && this.tool.hint()) || '';
    // The text just written stays selected and keeps following the settings.
    if (this.toolName === 'text' && sketch?.strokes.includes(item)) {
      this.setInkCurrent(item);
      document.getElementById('status-hint').textContent =
        `Text ${isNew ? 'added' : 'updated'}. Change its size, Bold, box or colour now to restyle it, or click to write the next one. Delete removes it, Esc deselects.`;
    }
    this.requestRender();
    return true;
  }

  /** Drops the editor without applying it (the project was replaced). */
  cancelTextEdit() {
    const te = this._textEdit;
    if (!te) return;
    this._textEdit = null;
    te.ta.remove();
    delete te.item._editing;
  }
}
