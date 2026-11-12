import { IMAGES_TOTAL_MAX, imageElement, imageSource, isImage, usedImageIds } from '../core/images.js';
import { decodeClipHTML, encodeClipHTML, inkPayload, inkPlainText, pasteItems, textFromPlain } from '../core/ink-clipboard.js';
import { placeTextCenter } from '../core/strokes.js';
import { alertDialog } from '../ui/dialogs.js';
import { trackOnce } from '../ui/analytics.js';

/* =============== CLIPBOARD: COPY, CUT, PASTE ===================
   Ctrl+C / Ctrl+X / Ctrl+V (and Copy / Cut / Paste in the right-click
   and long-press menus) for ink: strokes, arrows, texts and images.
   Format and rules: core/ink-clipboard.js. From other apps, Ctrl+V takes
   an image (core/images.js limits apply) or plain text, which becomes a
   text label in the current text style.

   Placement: a copy pasted while the original spot is in view lands a
   little down and to the right (further on each paste); otherwise in the
   middle of the view. Pasted text goes under the cursor when it is on the
   canvas. A paste is one undo step and leaves the pasted ink selected.
   Fields (Properties, the text editor, dialogs) keep their usual copy and
   paste, and so does text selected in a window.
   ============================================================ */
const STEP = 24;   // screen px between successive pastes

const inField = (t) => !!t?.closest?.('input,textarea,[contenteditable="true"],[contenteditable=""],.modal-backdrop');
const domSelection = () => { const s = window.getSelection?.(); return !!s && !s.isCollapsed && String(s).trim() !== ''; };

export class ClipboardMixin {
  _setupClipboard() {
    this.canvas.addEventListener('pointerenter', () => { this._pointerOnCanvas = true; });
    this.canvas.addEventListener('pointerleave', () => { this._pointerOnCanvas = false; });
    window.addEventListener('copy', (ev) => this._onCopy(ev, false));
    window.addEventListener('cut', (ev) => this._onCopy(ev, true));
    window.addEventListener('paste', (ev) => {
      if (inField(ev.target) || this._textEdit) return;
      const dt = ev.clipboardData;
      if (!dt) return;
      if (this.pasteData({
        html: dt.getData('text/html'),
        file: [...dt.items].filter(i => i.kind === 'file' && i.type.startsWith('image/')).map(i => i.getAsFile()).find(Boolean),
        text: dt.getData('text/plain'),
      })) ev.preventDefault();
    });
  }

  /** Ink the clipboard commands act on (the active layer's selection). */
  _clipItems() {
    if (this._textEdit) return [];
    return this.selectedStrokes();
  }

  _onCopy(ev, cut) {
    if (inField(ev.target) || domSelection()) return;
    const items = this._clipItems();
    if (!items.length || !ev.clipboardData) return;
    ev.preventDefault();
    this.copyInk(items, cut, ev.clipboardData);
  }

  /** Puts ink on the clipboard (`dt`: the copy event's data, else the
   *  async clipboard API). With `cut`, removes it (one undo step). */
  copyInk(items = this._clipItems(), cut = false, dt = null) {
    if (!items.length) return false;
    trackOnce(cut ? 'cut' : 'copy');
    const payload = inkPayload(items);
    const plain = inkPlainText(items);
    const html = encodeClipHTML(payload, plain);
    this._inkClip = { html, plain, payload };
    if (dt) {
      dt.setData('text/html', html);
      dt.setData('text/plain', plain);
    }
    // A single picture also goes as PNG, for other apps (async, where the
    // browser allows it; the data above stays if it doesn't).
    const pictures = items.filter(isImage);
    if (pictures.length === 1 || !dt) this._writeAsync(html, plain, pictures.length === 1 ? pictures[0] : null);
    if (cut) {
      const set = new Set(items), sketch = this.activeSketch();
      sketch.strokes = sketch.strokes.filter(s => !set.has(s));
      this.commit(); this.refreshUI(); this.requestRender();
    }
    const n = items.length;
    this._inkHint(`${cut ? 'Cut' : 'Copied'} ${n === 1 ? (isImage(items[0]) ? 'the image' : items[0].kind === 'text' ? 'the text' : 'the ink') : n + ' items'}. Ctrl+V pastes.`);
    return true;
  }

  async _writeAsync(html, plain, picture) {
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
        if (!picture && navigator.clipboard?.writeText && plain) await navigator.clipboard.writeText(plain);
        return;
      }
      const parts = { 'text/html': new Blob([html], { type: 'text/html' }) };
      if (plain) parts['text/plain'] = new Blob([plain], { type: 'text/plain' });
      if (picture) {
        const png = await pngOf(picture);
        if (png) parts['image/png'] = png;
      }
      await navigator.clipboard.write([new ClipboardItem(parts)]);
    } catch { /* not allowed here: the copy event's data stays */ }
  }

  /** Paste from the right-click menu (no paste event): the system
   *  clipboard where readable, else the last ink copied here. */
  async pasteFromMenu() {
    try {
      if (navigator.clipboard?.read) {
        const [item] = await navigator.clipboard.read();
        if (item) {
          const get = async (type) => (item.types.includes(type) ? (await item.getType(type)) : null);
          const html = await get('text/html'), text = await get('text/plain');
          const imgType = item.types.find(t => t.startsWith('image/'));
          const blob = imgType ? await item.getType(imgType) : null;
          const file = blob ? new File([blob], 'pasted', { type: blob.type }) : null;
          if (this.pasteData({ html: html ? await html.text() : '', file, text: text ? await text.text() : '' })) return true;
        }
      }
    } catch { /* not readable: use our own copy */ }
    if (this._inkClip) return this.pasteData({ html: this._inkClip.html });
    return false;
  }

  /** Pastes whatever fits: OnSketch ink, an image file, or plain text.
   *  @returns {boolean} whether something was taken */
  pasteData({ html = '', file = null, text = '' }) {
    const payload = decodeClipHTML(html);
    if (payload) { trackOnce('paste', { what: 'ink' }); this.pasteInk(payload); return true; }
    if (file) { trackOnce('paste', { what: 'image' }); this.importImageFile(file); return true; }
    if (text && text.trim()) { trackOnce('paste', { what: 'text' }); return this.pasteText(text); }
    return false;
  }

  /** Adds copied ink to the active layer, selected. */
  async pasteInk(payload) {
    const sketch = this.activeSketch(); if (!sketch) return [];
    const fresh = Object.entries(payload.images || {}).filter(([id]) => !usedImageIds(this.project).has(id)).map(([, src]) => src);
    if (fresh.length && !(await this._imagesFit(fresh))) return [];
    const items = pasteItems(payload, {
      layerId: this.project.activeLayerId,
      lookup: this._anchorLookup(),
      place: (b) => this._pasteOffset(b, payload.stamp),
    });
    if (!items.length) return [];
    this._addPasted(items);
    this._inkHint(`Pasted ${items.length === 1 ? (isImage(items[0]) ? 'an image' : items[0].kind === 'text' ? 'a text' : 'the ink') : items.length + ' items'}.`);
    return items;
  }

  /** Plain text from another app becomes a text label. */
  pasteText(text) {
    const s = this.inkSettings('text');
    const item = textFromPlain(text, {
      layerId: this.project.activeLayerId, color: this.pen.fillColor,
      size: s.size / this.view.zoom, bold: s.bold, box: s.box,
    });
    if (!item) return false;
    placeTextCenter(item, this._pasteTarget());
    this._addPasted([item]);
    this._inkHint('Pasted the text as a label. Double-click it to edit.');
    return true;
  }

  _addPasted(items) {
    const sketch = this.activeSketch();
    if (this.toolName !== 'select') this.setTool('select');
    this.clearSelection();
    this.clearStrokeSelection();
    sketch.strokes.push(...items);
    this.rebaseInk(items);
    for (const it of items) it.selected = true;
    this.commit();
    this.refreshUI();
    this.requestRender();
  }

  /** Under the cursor when it is on the canvas, else the middle of the view. */
  _pasteTarget() {
    const v = this.view;
    if (this._pointerOnCanvas && this.lastWorldCursor) return { ...this.lastWorldCursor };
    return v.screenToWorld({ x: v.cssW / 2, y: v.cssH / 2 });
  }

  /** Offset for pasted ink with bounds `b` (see the header). */
  _pasteOffset(b, stamp) {
    const v = this.view, step = STEP / v.zoom;
    if (this._pasteStamp !== stamp) { this._pasteStamp = stamp; this._pasteN = 0; }
    const n = ++this._pasteN;
    const c = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
    const s = v.worldToScreen(c);
    if (s.x >= 0 && s.y >= 0 && s.x <= v.cssW && s.y <= v.cssH) return { x: step * n, y: -step * n };
    const m = v.screenToWorld({ x: v.cssW / 2, y: v.cssH / 2 });
    return { x: m.x - c.x + step * (n - 1), y: m.y - c.y - step * (n - 1) };
  }

  /** Whether pictures with these data URLs still fit in the sketch. */
  async _imagesFit(srcs) {
    let total = srcs.reduce((k, s) => k + s.length, 0);
    for (const used of usedImageIds(this.project)) total += (imageSource(used) || '').length;
    if (total <= IMAGES_TOTAL_MAX) return true;
    const mb = (n) => (n * 0.75 / 1024 / 1024).toFixed(1);
    await alertDialog({ title: 'Too many images', message: `A sketch can hold about ${mb(IMAGES_TOTAL_MAX)} MB of images in total, and this would bring it to ${mb(total)} MB. Use a smaller image, or remove one first.` });
    return false;
  }

  /** Copy / Cut entries for the ink menus. */
  clipboardActions() {
    if (!this._clipItems().length) return [];
    const mod = /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘' : 'Ctrl+';
    return [
      { id: 'copy', glyph: '⧉', label: 'Copy', hint: mod + 'C', run: () => this.copyInk() },
      { id: 'cut', glyph: '✂', label: 'Cut', hint: mod + 'X', run: () => this.copyInk(undefined, true) },
    ];
  }
}

/** A picture as a PNG blob (the original when it is a PNG). */
async function pngOf(item) {
  const src = imageSource(item.image);
  if (!src) return null;
  if (src.startsWith('data:image/png')) return (await fetch(src)).blob();
  const img = imageElement(item.image);
  if (!img) return null;
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  c.getContext('2d').drawImage(img, 0, 0);
  return new Promise(r => c.toBlob(r, 'image/png'));
}
