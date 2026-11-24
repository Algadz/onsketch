import { dxfToSketchData } from '../core/dxf-import.js';
import { alertDialog, choose } from '../ui/dialogs.js';
import { track } from '../ui/analytics.js';

/* =============== DXF IMPORT (OnSketch Pro) ======================
   Import (menu bar, ⋯ menu on a phone) or a .dxf dropped on the canvas:
   the file's lines, circles, arcs, polylines and points come in as a
   part at real size, on their own layers, selected, free to move or to
   dimension against the drawing (core/dxf-import.js reads the file,
   core/insert.js places it). One undo step.

   DXF import and DXF export are OnSketch Pro. Free accounts (and
   visitors) get a short "part of OnSketch Pro" prompt that leads to the
   pricing page. Where accounts aren't configured (self-hosted), Pro
   features are open to everyone.
   ============================================================ */
const MAX_BYTES = 15 * 1024 * 1024;
const LABELS = { 'dxf-import': 'DXF import', 'dxf-export': 'DXF export' };

export class DxfImportMixin {
  /** Pro features, as far as known now (no network): open without
   *  accounts, else for a Pro plan. */
  hasProNow() { return !this.cloudEnabled || this.cloudPlan?.plan === 'premium'; }

  /** Pro features: asks the plan when it isn't known yet. */
  async hasPro() {
    if (this.hasProNow()) return true;
    if (!this.cloudUser || !this.cloud) return false;
    try { this.cloudPlan = await this.cloud.plan(); } catch { /* offline: as known */ }
    this._refreshProBadges();
    return this.cloudPlan?.plan === 'premium';
  }

  /** "Part of OnSketch Pro": Not now, or the pricing page. */
  async proPrompt(feature) {
    track('pro-prompt', { feature });
    const go = await choose({
      title: `${LABELS[feature] || 'This'} is part of OnSketch Pro`,
      message: 'Pro adds DXF import and export at real size, for CAD, CAM and laser cutters, with unlimited and private sketches. Images (PNG, SVG, copy) and printing or PDF to scale stay free.',
      cancelValue: false,
      choices: [{ label: 'Not now', value: false }, { label: 'See OnSketch Pro', value: true, kind: 'primary' }],
    });
    if (go) { track('upgrade-click', { from: feature }); this._writeLocal?.(); location.href = '/pricing/'; }
  }

  /** The "Pro" badges on Pro-only buttons follow the plan. */
  _refreshProBadges() {
    const pro = this.hasProNow();
    document.querySelectorAll('[data-pro]').forEach(el => el.classList.toggle('pro-locked', !pro));
  }

  /** Import (menu): a .dxf from a file picker. */
  async openDXFPicker() {
    if (!(await this.hasPro())) { await this.proPrompt('dxf-import'); return; }
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.dxf,application/dxf,image/vnd.dxf';
    inp.style.display = 'none';
    inp.addEventListener('change', () => {
      const file = inp.files && inp.files[0];
      inp.remove();
      if (file) this.importDXFFile(file, 'picker');
    });
    document.body.appendChild(inp);
    inp.click();
  }

  /** Reads a .dxf and inserts it as a part. @returns {Promise<boolean>} */
  async importDXFFile(file, via = 'drop') {
    if (!(await this.hasPro())) { await this.proPrompt('dxf-import'); return false; }
    if (file.size > MAX_BYTES) {
      await alertDialog({ title: 'This DXF is too large', message: `It is ${(file.size / 1048576).toFixed(1)} MB; OnSketch opens DXF files up to 15 MB.` });
      return false;
    }
    const name = String(file.name || 'DXF').replace(/\.dxf$/i, '').slice(0, 60) || 'DXF';
    let res;
    try { res = dxfToSketchData(await file.text(), this.project.units, name); }
    catch (e) {
      await alertDialog({ title: 'Can\'t import this DXF', message: `${e.message || e} Save it from your CAD program as an ASCII DXF (any version), with lines, arcs, circles or polylines.` });
      track('dxf-import', { result: 'error', via });
      return false;
    }
    if (!res.count) {
      await alertDialog({ title: 'Nothing to import', message: 'This DXF has no lines, arcs, circles, polylines or points.' + skippedText(res.skipped) });
      track('dxf-import', { result: 'empty', via });
      return false;
    }
    const units = res.unit ? (res.unit === this.project.units ? '' : ` Converted from ${res.unit} to ${this.project.units}.`) : ' The file says no unit: read as millimetres.';
    const ok = this.insertSketchData(res.data, name, 'dxf',
      `"${name}" imported: ${res.count} shape${res.count === 1 ? '' : 's'} at real size, on ${res.data.layers.length === 1 ? 'its own layer' : 'their own layers'}.${units}${skippedText(res.skipped)}`);
    track('dxf-import', { result: ok ? 'ok' : 'failed', via, shapes: res.count });
    return ok;
  }
}

function skippedText(skipped) {
  const list = Object.entries(skipped || {});
  if (!list.length) return '';
  const n = list.reduce((s, [, k]) => s + k, 0);
  return ` Not imported: ${list.map(([t, k]) => `${k} ${t.toLowerCase()}`).join(', ')} (${n === 1 ? 'it isn\'t' : 'they aren\'t'} lines, arcs or circles).`;
}
