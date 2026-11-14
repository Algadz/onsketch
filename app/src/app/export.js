import { toDXF } from '../core/dxf.js';
import { PAPERS, exportPNG, exportPrintSVG, exportSVG, printLayout, scaleChoices, scaleLabel } from '../render/export.js';
import { UNIT_NAMES } from '../core/expr.js';
import { choose } from '../ui/dialogs.js';
import { track } from '../ui/analytics.js';

/* =============== EXPORT ========================================
   Export… (menu bar, ⋯ menu): the drawing out of the editor.

   Every format is free, on every plan.
   Images, for slides, documents and messages:
     Copy image   PNG to the clipboard, ready to paste
     PNG          2× for sharp slides, white or transparent background
     SVG          vector, for documents and vector editors
   To scale, at real size for making things:
     DXF          shapes in millimetres, for CAD, CAM and laser cutters
     Print / PDF  one sheet at a true scale (1:1, 1:2, 1:5…) through the
                  browser's print dialog, where "Save as PDF" gives a PDF

   Options: dimensions (starts as shown on screen), construction lines,
   transparent background (PNG and Copy).
   ============================================================ */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export class ExportMixin {
  _exportSource() {
    return {
      project: this.project,
      fillDisplay: this.fillDisplay(),
      labelFor: (c, text) => this.dimensionLabel(c, text),
      layerState: (c) => this.constraintLayerState(c),
      redundantIds: this._lastSolve?.redundantIds,
    };
  }
  _exportName() {
    return (this.project.name || 'sketch').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'sketch';
  }
  _download(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  }

  openExport() {
    if (document.getElementById('export-modal')) return;
    this.cancelTextEdit?.();
    this.refreshDrivenDimensions?.();
    const opts = this._exportOpts ||= { dimensions: null, construction: false, transparent: false, paper: 'A4', scale: 'auto' };
    if (opts.dimensions == null) opts.dimensions = this.showDimensions !== false && this._hasDimensions();
    const back = document.createElement('div');
    back.className = 'modal-backdrop show';
    back.id = 'export-modal';
    back.innerHTML = `
      <div class="modal export" role="dialog" aria-modal="true" aria-labelledby="export-heading">
        <h3 id="export-heading">Export</h3>
        <div class="body">
          <div class="export-preview"><span class="muted">Nothing drawn yet.</span></div>
          <div class="export-opts">
            <label class="check"><input type="checkbox" data-opt="dimensions" ${opts.dimensions ? 'checked' : ''}/> Dimensions</label>
            <label class="check"><input type="checkbox" data-opt="construction" ${opts.construction ? 'checked' : ''}/> Construction lines</label>
            <label class="check"><input type="checkbox" data-opt="transparent" ${opts.transparent ? 'checked' : ''}/> Transparent background</label>
          </div>
          <h4>Image <span class="muted">for slides, documents, messages</span></h4>
          <div class="export-row">
            <button type="button" class="btn primary" data-format="copy">Copy image</button>
            <button type="button" class="btn" data-format="png">PNG</button>
            <button type="button" class="btn" data-format="svg">SVG</button>
          </div>
          <h4>To scale <span class="muted">real size, for making things</span></h4>
          <div class="export-row">
            <button type="button" class="btn" data-format="dxf">DXF</button>
            <button type="button" class="btn" data-format="print">Print / PDF</button>
          </div>
          <div class="export-row">
            <label class="opt">Paper <select data-opt="paper">${Object.keys(PAPERS).map(p => `<option${p === opts.paper ? ' selected' : ''}>${p}</option>`).join('')}</select></label>
            <label class="opt">Scale <select data-opt="scale"></select></label>
          </div>
          <p class="muted export-note" data-note="scale"></p>
          <p class="account-msg" role="status"></p>
        </div>
        <div class="footer"><button type="button" class="btn" data-a="close">Close</button></div>
      </div>`;
    document.body.appendChild(back);
    const previous = document.activeElement;
    const close = () => { back.remove(); if (previous?.focus && document.contains(previous)) previous.focus(); };
    const msg = back.querySelector('.account-msg');
    const say = (text, bad = false) => { msg.textContent = text; msg.classList.toggle('bad', bad); };
    const scaleSel = back.querySelector('[data-opt="scale"]');

    const refresh = () => {
      // Preview: the exported picture itself, small.
      const slot = back.querySelector('.export-preview');
      const canvas = exportPNG(this._exportSource(), opts, { scale: 1 });
      slot.classList.toggle('checker', !!opts.transparent);
      if (canvas) { slot.replaceChildren(canvas); } else slot.innerHTML = '<span class="muted">Nothing drawn yet.</span>';
      back.querySelectorAll('[data-format]').forEach(b => { b.disabled = !canvas; });
      // Scales that fit the chosen paper.
      const auto = printLayout(this._exportSource(), opts, { paper: opts.paper });
      const { w = 0, h = 0, area = { w: 1, h: 1 }, n: best = 1 } = auto || {};
      const choices = scaleChoices(best);
      if (opts.scale !== 'auto' && !choices.includes(+opts.scale)) opts.scale = 'auto';
      scaleSel.innerHTML = `<option value="auto"${opts.scale === 'auto' ? ' selected' : ''}>Auto (${scaleLabel(best)})</option>`
        + choices.map(n => `<option value="${n}"${String(opts.scale) === String(n) ? ' selected' : ''}>${scaleLabel(n)}${w / n > area.w || h / n > area.h ? ' (too big)' : ''}</option>`).join('');
      const n = opts.scale === 'auto' ? best : +opts.scale;
      back.querySelector('[data-note="scale"]').textContent = auto
        ? `DXF is in ${UNIT_NAMES[this.project.units] || 'millimetres'} at real size (shapes only). Printing: ${Math.round(w / n)} × ${Math.round(h / n)} mm on ${opts.paper} at ${scaleLabel(n)}; choose "Save as PDF" in the print dialog for a PDF.`
        : '';
    };
    back.querySelectorAll('input[data-opt]').forEach(i => i.addEventListener('change', () => { opts[i.dataset.opt] = i.checked; refresh(); }));
    back.querySelectorAll('select[data-opt]').forEach(s => s.addEventListener('change', () => { opts[s.dataset.opt] = s.value; refresh(); }));
    back.querySelectorAll('[data-format]').forEach(b => b.addEventListener('click', async () => {
      const format = b.dataset.format;
      say('');
      try {
        const done = await this.exportAs(format, opts);
        if (done) say(done);
      } catch (e) {
        console.warn('export failed', e);
        say(`Couldn't export: ${e?.message || e}`, true);
      }
    }));
    back.querySelector('[data-a="close"]').addEventListener('click', close);
    back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
    back.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); close(); } });
    refresh();
    back.querySelector('[data-format="copy"]').focus();
    track('export-open');
  }

  _hasDimensions() {
    const kinds = new Set(['distance', 'curveDistance', 'pointLineDistance', 'offsetDistance', 'radius', 'angle']);
    return !!this.activeSketch()?.constraints.some(c => kinds.has(c.kind));
  }

  /** One export. @returns {Promise<string>} a short confirmation ('' when
   *  nothing happened). */
  async exportAs(format, opts = this._exportOpts || {}) {
    const src = this._exportSource();
    const name = this._exportName();
    const info = { format, dimensions: !!opts.dimensions, construction: !!opts.construction };
    if (format === 'dxf') {
      const { text, count } = toDXF(this.project, opts);
      if (!count) return 'No shapes to export: a DXF holds lines, circles and arcs.';
      this._download(new Blob([text], { type: 'application/dxf' }), name + '.dxf');
      track('export', info);
      return `DXF downloaded: ${count} shape${count === 1 ? '' : 's'}, in millimetres.`;
    }
    if (format === 'svg') {
      const svg = exportSVG(src, opts);
      if (!svg) return '';
      this._download(new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n', svg], { type: 'image/svg+xml' }), name + '.svg');
      track('export', info);
      return 'SVG downloaded.';
    }
    if (format === 'print') {
      const res = exportPrintSVG(src, opts, { paper: opts.paper, scale: opts.scale === 'auto' || !opts.scale ? null : +opts.scale });
      if (!res) return '';
      if (!res.fits) {
        const ok = await choose({
          title: 'The drawing is larger than the sheet',
          message: `At ${scaleLabel(res.scale)} it doesn't fit on ${opts.paper}: the edges will be cut off. Choose Auto for the largest scale that fits.`,
          cancelValue: false,
          choices: [{ label: 'Cancel', value: false }, { label: 'Print anyway', value: true }],
        });
        if (!ok) return '';
      }
      this._print(res);
      track('export', { ...info, scale: res.scale, paper: opts.paper });
      return `Print dialog opened at ${scaleLabel(res.scale)}. Keep the print scale at 100 %.`;
    }
    // png, copy
    const canvas = exportPNG(src, opts);
    if (!canvas) return '';
    const blob = () => new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('could not encode the image')), 'image/png'));
    if (format === 'copy') {
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') return 'This browser can\'t copy images. Use PNG instead.';
      try {
        // Safari needs the pending image inside the ClipboardItem; others take either.
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob() })]);
      } catch {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': await blob() })]);
      }
      track('export', info);
      return 'Image copied. Paste it into a slide, document or message.';
    }
    this._download(await blob(), name + '.png');
    track('export', { ...info, transparent: !!opts.transparent });
    return 'PNG downloaded.';
  }

  /** Prints one sheet through a hidden frame, so the editor page itself
   *  is never what gets printed. */
  _print(res) {
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(this.project.name || 'OnSketch')}</title>`
      + `<style>@page{size:${res.pw}mm ${res.ph}mm;margin:0}html,body{margin:0;padding:0;background:#fff}`
      + `svg{display:block;width:${res.pw}mm;height:${res.ph}mm}</style></head><body>${res.svg}</body></html>`;
    if (this._printHook) { this._printHook(html, res); return; }
    document.getElementById('print-frame')?.remove();
    const frame = document.createElement('iframe');
    frame.id = 'print-frame';
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
    frame.srcdoc = html;
    frame.addEventListener('load', () => {
      const w = frame.contentWindow;
      w.addEventListener('afterprint', () => setTimeout(() => frame.remove(), 500));
      w.focus();
      w.print();
    });
    document.body.appendChild(frame);
  }
}
