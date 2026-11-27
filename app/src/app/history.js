import { Project } from '../core/model.js';
import { compareProjects, countText } from '../core/compare.js';
import { inkBounds } from '../core/strokes.js';
import { FREE_VERSIONS, LimitError, NotAvailableError } from '../cloud/cloud.js';
import { renderThumbnail } from '../render/thumbnail.js';
import { confirmDialog, notice } from '../ui/dialogs.js';
import { track } from '../ui/analytics.js';

/* =============== VERSION HISTORY (History window) ===============
   Earlier versions of a sketch saved in the account, kept by the server
   (supabase/migrations/0009_*): when a save changes the drawing and the
   newest version is more than 10 minutes old, the drawing as it was
   before is kept. Free accounts see the last 3; OnSketch Pro keeps the
   whole history (thinned out with age) and adds named versions ("Save
   version…", like a commit with a message), kept for good.

   Click a version to Compare: on the canvas, what it had that the
   drawing no longer has is drawn dashed in red, what is new or changed
   since is drawn in green, and the window lists changed dimensions
   (D3: 120 → 140 mm) and variables. From there: Restore (the current
   drawing is kept as a version first, and Ctrl+Z also goes back), Copy
   as a new sketch, or Name it (Pro).
   ============================================================ */
const RED = '#d4372c', GREEN = '#1f9d55';
const REFRESH_EVERY = 60000;          // re-list after saves, at most once a minute

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** "14:32", "Yesterday, 14:32", "12 Nov, 14:32", "12 Nov 2025". */
export function versionTime(iso, now = new Date()) {
  const t = new Date(iso);
  const hm = t.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const dayOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((dayOf(now) - dayOf(t)) / 86400000);
  if (days === 0) return `Today, ${hm}`;
  if (days === 1) return `Yesterday, ${hm}`;
  if (t.getFullYear() === now.getFullYear()) return `${t.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${hm}`;
  return t.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** A dimension value as shown: "120 mm", "35°". */
function dimText(v, angular, units) {
  if (v == null || !Number.isFinite(v)) return '—';
  return angular ? `${Number(v.toFixed(2))}°` : `${Number(v.toFixed(4))} ${units}`;
}

export class HistoryMixin {
  _setupHistory() {
    this._hist = { rows: null, error: '', selected: null, data: new Map(), listedAt: 0, projectId: null, form: null };
    const btn = document.querySelector('#menubar [data-window="history"]');
    if (!this.cloudEnabled) { if (btn) btn.hidden = true; return; }
    this.windows.onToggle = (id, open) => { if (id === 'history') { if (open) this._historyOpened(); else this.stopCompare(); } };
    document.getElementById('save-state')?.addEventListener('click', () => this.openHistory());
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !this._compare || e.defaultPrevented) return;
      if (document.querySelector('.modal-backdrop.show, .app-dialog') || e.target.closest?.('input, textarea')) return;
      this.stopCompare();
    });
    if (this.windows.isOpen('history')) this._historyOpened();
  }

  /** Opens the History window (menu, ⋯ menu, the "Saved" status). */
  openHistory() {
    if (!this.cloudEnabled) return;
    track('history-open');
    this.windows.toggle('history', true);
    this._historyOpened();
  }
  _historyOpened() { this._historyLoad(true); }

  /** The linked sketch changed (opened, saved, unlinked) or a save went out. */
  _historyChanged({ saved = false } = {}) {
    if (!this._hist || !this.windows?.isOpen('history')) return;
    const id = this.cloudLink?.id || null;
    if (id !== this._hist.projectId) { this.stopCompare(); this._historyLoad(true); return; }
    if (saved && Date.now() - this._hist.listedAt > REFRESH_EVERY) this._historyLoad(false);
  }

  async _historyLoad(reset) {
    const h = this._hist;
    if (!h) return;
    const id = this.cloudLink?.id || null;
    if (reset || id !== h.projectId) { h.rows = null; h.error = ''; h.selected = null; h.form = null; h.projectId = id; }
    this._renderHistory();
    if (!id) return;
    const cloud = await this._ensureCloud();
    if (!cloud || !this.cloudUser) { this._renderHistory(); return; }
    if (!this.cloudPlan) this.cloudPlan = await cloud.plan().catch(() => null);
    try {
      const rows = await cloud.versions(id);
      if (h.projectId !== id) return;
      h.rows = rows; h.error = ''; h.listedAt = Date.now();
    } catch (e) {
      if (h.projectId !== id) return;
      h.rows = []; h.error = e instanceof NotAvailableError ? e.message : "Couldn't load the history. Check your connection.";
    }
    if (h.selected != null && !h.rows.some(r => r.id === h.selected)) { h.selected = null; this.stopCompare(); }
    this._renderHistory();
  }

  _historyPro() { return this.hasProNow?.() ?? false; }

  _renderHistory() {
    const body = document.getElementById('history-body');
    const h = this._hist;
    if (!body || !h) return;
    const pro = this._historyPro();
    if (!this.cloudUser || !this.cloudLink) {
      body.innerHTML = `<div class="hist-empty">
        <p>History keeps earlier versions of the sketches saved in your account: compare them with the drawing, and bring one back.</p>
        <p class="muted">${this.cloudUser ? 'This drawing is only in this browser.' : 'Sign in and save this drawing to start its history.'}</p>
        <button type="button" class="btn primary" data-h="save">${this.cloudUser ? 'Save to my account' : 'Sign in to save'}</button></div>`;
      body.querySelector('[data-h="save"]').addEventListener('click', () => this.cloudSave());
      return;
    }
    const rows = h.rows;
    const named = h.form && h.form.what === 'new';
    const versionRows = (rows || []).map(r => this._historyItem(r, pro)).join('');
    body.innerHTML = `
      <div class="hist-top">
        <button type="button" class="btn hist-save${pro ? '' : ' pro-locked'}" data-h="save-version" data-pro title="Keep the drawing as it is now under a name, for good (OnSketch Pro)">Save version…</button>
        ${this._compare ? '<button type="button" class="link" data-h="stop">Stop comparing</button>' : ''}
      </div>
      ${named ? this._historyForm('', '') : ''}
      <ol class="hist-list">
        <li class="hist-item hist-now${h.selected == null ? ' sel' : ''}" data-v="now">
          <span class="hist-dot" aria-hidden="true"></span>
          <span class="hist-text"><b>Now</b><span class="muted">${this._cloudStatus === 'saving' ? 'Saving…' : 'The drawing as it is'}</span></span>
        </li>
        ${rows == null ? '<li class="hist-msg muted">Loading…</li>' : ''}
        ${h.error ? `<li class="hist-msg error">${esc(h.error)}</li>` : ''}
        ${rows && !rows.length && !h.error ? '<li class="hist-msg muted">No earlier versions yet. One is kept when you change the drawing after a pause, and every 10 minutes while you work.</li>' : ''}
        ${versionRows}
      </ol>
      ${pro ? '<p class="hist-foot muted">OnSketch Pro: your whole history, thinned out with age; named versions are kept for good.</p>'
        : `<p class="hist-foot muted">The free plan keeps the last ${FREE_VERSIONS} versions. <a href="/pricing/" data-h="pro">OnSketch Pro</a> keeps the whole history and named versions.</p>`}`;
    this._wireHistory(body);
  }

  _historyItem(r, pro) {
    const h = this._hist;
    const sel = h.selected === r.id;
    const time = versionTime(r.saved_at);
    const title = r.kind === 'named' && r.name ? esc(r.name) : esc(time);
    const sub = [r.kind === 'named' && r.name ? esc(time) : '', r.kind === 'restore' ? 'Before a restore' : '', r.note ? esc(r.note) : ''].filter(Boolean).join(' · ');
    let detail = '';
    if (sel) {
      const naming = h.form && h.form.what === r.id;
      detail = `<div class="hist-detail">
        <div class="hist-diff">${this._compare?.versionId === r.id ? this._diffHTML() : '<span class="muted">Comparing…</span>'}</div>
        ${naming ? this._historyForm(r.name || '', r.note || '') : ''}
        <div class="hist-actions">
          <button type="button" class="btn primary" data-h="restore">Restore</button>
          <button type="button" class="btn" data-h="copy" title="A new sketch in your account, from this version; this one stays as it is">Copy as new sketch</button>
          ${naming ? '' : `<button type="button" class="btn${pro ? '' : ' pro-locked'}" data-h="name" data-pro title="${r.kind === 'named' ? 'Rename this version' : 'Name this version, to keep it for good'} (OnSketch Pro)">${r.kind === 'named' ? 'Rename…' : 'Name…'}</button>`}
        </div></div>`;
    }
    return `<li class="hist-item${sel ? ' sel' : ''}${r.kind === 'named' ? ' named' : ''}" data-v="${r.id}">
      <canvas class="hist-thumb" width="192" height="120" data-thumb="${r.id}" aria-hidden="true"></canvas>
      <span class="hist-text"><b>${r.kind === 'named' ? '★ ' : ''}${title}</b>${sub ? `<span class="muted">${sub}</span>` : ''}</span>
      ${detail}</li>`;
  }

  _historyForm(name, note) {
    return `<form class="hist-form" novalidate>
      <input type="text" name="name" maxlength="80" placeholder="Name, e.g. First prototype" value="${esc(name)}" aria-label="Version name" required>
      <textarea name="note" maxlength="500" rows="2" placeholder="Note (optional): what changed" aria-label="Note">${esc(note)}</textarea>
      <p class="hist-form-msg error" role="status"></p>
      <div class="hist-form-btns"><button type="button" class="btn" data-h="cancel">Cancel</button><button type="submit" class="btn primary">Save</button></div>
    </form>`;
  }

  _diffHTML() {
    const c = this._compare;
    if (!c) return '';
    const d = c.diff;
    if (d.same) return '<span class="muted">Same drawing as now.</span>';
    const units = this.project.units;
    const parts = [countText(d.shapes, 'Shapes'), countText(d.ink, 'Ink')].filter(Boolean).map(t => `<li>${esc(t)}</li>`);
    const dims = d.dims.slice(0, 12).map(x => {
      const label = x.name ? `<b>${esc(x.name)}</b> ` : '';
      if (x.from == null) return `<li>${label}added: ${esc(dimText(x.to, x.angular, units))}</li>`;
      if (x.to == null) return `<li>${label}removed (was ${esc(dimText(x.from, x.angular, units))})</li>`;
      const val = Math.abs(x.from - x.to) > 1e-9 ? `${esc(dimText(x.from, x.angular, units))} → ${esc(dimText(x.to, x.angular, units))}` : '';
      const f = x.fromExpr !== x.toExpr ? `${val ? ' · ' : ''}<code>${esc(x.fromExpr ? '=' + x.fromExpr : 'no formula')}</code> → <code>${esc(x.toExpr ? '=' + x.toExpr : 'no formula')}</code>` : '';
      return `<li>${label}${val}${f}</li>`;
    });
    if (d.dims.length > 12) dims.push(`<li class="muted">and ${d.dims.length - 12} more dimensions</li>`);
    const vars = d.vars.map(v => `<li>Variable <b>${esc(v.name)}</b>: ${v.from == null ? 'added' : v.to == null ? 'removed' : `<code>${esc(v.from)}</code> → <code>${esc(v.to)}</code>`}</li>`);
    return `<p class="hist-legend"><span class="hist-key red"></span>only in this version <span class="hist-key green"></span>new or changed since</p>
      <ul class="hist-changes">${[...parts, ...dims, ...vars].join('')}</ul>`;
  }

  _wireHistory(body) {
    const h = this._hist;
    const on = (sel, fn) => body.querySelectorAll(sel).forEach(el => el.addEventListener('click', fn));
    on('[data-h="stop"]', () => { h.selected = null; this.stopCompare(); this._renderHistory(); });
    on('[data-h="pro"]', () => track('upgrade-click', { from: 'history' }));
    on('[data-h="save-version"]', async () => {
      if (!(await this.hasPro())) { await this.proPrompt('history'); return; }
      h.form = { what: 'new' }; this._renderHistory();
      body.querySelector('.hist-form input')?.focus();
    });
    on('[data-h="name"]', async (e) => {
      e.stopPropagation();
      if (!(await this.hasPro())) { await this.proPrompt('history'); return; }
      h.form = { what: h.selected }; this._renderHistory();
      body.querySelector('.hist-form input')?.focus();
    });
    on('[data-h="restore"]', (e) => { e.stopPropagation(); this.restoreVersion(h.selected); });
    on('[data-h="copy"]', (e) => { e.stopPropagation(); this.copyVersion(h.selected); });
    body.querySelectorAll('.hist-item').forEach(li => li.addEventListener('click', (e) => {
      if (e.target.closest('.hist-detail')) return;
      const v = li.dataset.v;
      if (v === 'now' || h.selected === +v) { h.selected = null; h.form = null; this.stopCompare(); this._renderHistory(); return; }
      this.compareWith(+v);
    }));
    const form = body.querySelector('.hist-form');
    if (form) {
      form.addEventListener('click', (e) => e.stopPropagation());
      form.querySelector('[data-h="cancel"]').addEventListener('click', () => { h.form = null; this._renderHistory(); });
      form.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); h.form = null; this._renderHistory(); } });
      form.addEventListener('submit', (e) => { e.preventDefault(); this._submitVersionForm(form); });
    }
    this._historyThumbs(body);
  }

  async _submitVersionForm(form) {
    const h = this._hist;
    const name = form.elements.name.value.trim(), note = form.elements.note.value.trim();
    const msg = form.querySelector('.hist-form-msg');
    const what = h.form?.what;
    if (!name && what === 'new') { msg.textContent = 'Give the version a name.'; form.elements.name.focus(); return; }
    form.querySelectorAll('button, input, textarea').forEach(el => { el.disabled = true; });
    try {
      if (what === 'new') {
        if (this.cloudLink?.dirty) await this._cloudPush();
        if (this._cloudStatus === 'conflict') throw new Error('Resolve the conflict first.');
        await this.cloud.saveVersion(this.cloudLink.id, name, note);
        track('version-saved', { note: !!note });
        this._hint(`Version "${name}" saved. It is kept for good.`);
      } else {
        await this.cloud.nameVersion(what, name, note);
        track('version-named');
      }
      h.form = null;
      await this._historyLoad(false);
    } catch (e) {
      form.querySelectorAll('button, input, textarea').forEach(el => { el.disabled = false; });
      msg.textContent = e.message || "Couldn't save the version.";
    }
  }

  /** Thumbnails, drawn when they scroll into view. */
  _historyThumbs(body) {
    const draw = async (cv) => {
      try {
        const json = await this._versionJSON(+cv.dataset.thumb);
        const pic = renderThumbnail(Project.fromJSON(json), new Map(), { width: 96, height: 60, scale: 2 });
        cv.getContext('2d').drawImage(pic, 0, 0, cv.width, cv.height);
        cv.classList.add('ready');
      } catch { /* no preview */ }
    };
    const cvs = body.querySelectorAll('canvas[data-thumb]');
    if (typeof IntersectionObserver !== 'function') { cvs.forEach(draw); return; }
    this._histObserver?.disconnect();
    this._histObserver = new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) { this._histObserver.unobserve(en.target); draw(en.target); }
    }, { root: body.closest('.fwin-body') || null });
    cvs.forEach(cv => this._histObserver.observe(cv));
  }

  async _versionJSON(id) {
    const h = this._hist;
    if (!h.data.has(id)) h.data.set(id, this.cloud.versionData(id).catch((e) => { h.data.delete(id); throw e; }));
    return h.data.get(id);
  }

  /* ---- Compare ---- */
  async compareWith(versionId) {
    const h = this._hist;
    h.selected = versionId; h.form = null;
    this._renderHistory();
    try {
      const json = await this._versionJSON(versionId);
      if (h.selected !== versionId) return;
      this._compare = { versionId, before: Project.fromJSON(json), diff: null, key: null };
      this._refreshCompare(true);
      track('history-compare');
    } catch (e) {
      if (h.selected !== versionId) return;
      notice("Couldn't load this version: " + (e.message || e), { kind: 'error' });
      h.selected = null;
    }
    this._renderHistory();
    this.requestRender();
  }
  stopCompare() {
    if (!this._compare) return;
    this._compare = null;
    if (this._hist) { this._hist.selected = null; this._hist.form = null; }
    if (this.windows?.isOpen('history')) this._renderHistory();
    this.requestRender();
  }
  /** Recomputes the comparison when the drawing changed (an edit while comparing). */
  _refreshCompare(force = false) {
    const c = this._compare;
    if (!c) return;
    const key = `${this.undoStack.length}:${this.redoStack.length}:${this._cloudStatus}`;
    if (!force && c.key === key && c.project === this.project) return;
    const changed = c.diff != null;
    c.key = key; c.project = this.project;
    c.diff = compareProjects(c.before, this.project);
    if (changed && this.windows.isOpen('history')) {
      const box = document.querySelector(`#history-body .hist-item[data-v="${c.versionId}"] .hist-diff`);
      if (box) box.innerHTML = this._diffHTML();
    }
  }

  /** Canvas overlay (render loop): the old version's shapes in red, the
   *  new or changed ones in green. */
  _drawCompare() {
    const c = this._compare;
    if (!c) return;
    this._refreshCompare();
    const r = this.renderer, ctx = r.ctx, v = this.view;
    const style = (e, color, dashed) => {
      const st = r.styleFor(e, true);
      return { color, width: st.width + (dashed ? 0.4 : 1.2), dashed, dash: dashed ? [6, 4] : [] };
    };
    const { shapes, ink } = c.diff;
    ctx.save();
    ctx.globalAlpha = 0.9;
    for (const e of [...shapes.removed, ...shapes.changed.map(p => p[0])]) e.draw(ctx, v, style(e, RED, true));
    for (const st of [...ink.removed, ...ink.changed.map(p => p[0])]) {
      ctx.globalAlpha = 0.45;
      r.drawStroke({ ...st, color: RED, selected: false });
    }
    ctx.globalAlpha = 0.85;
    for (const e of [...shapes.added, ...shapes.changed.map(p => p[1])]) e.draw(ctx, v, style(e, GREEN, false));
    ctx.globalAlpha = 1;
    for (const st of [...ink.added, ...ink.changed.map(p => p[1])]) {
      const b = inkBounds(st);
      const a = v.worldToScreen({ x: b.minX, y: b.maxY }), z = v.worldToScreen({ x: b.maxX, y: b.minY });
      ctx.strokeStyle = GREEN; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
      ctx.strokeRect(Math.min(a.x, z.x) - 3, Math.min(a.y, z.y) - 3, Math.abs(z.x - a.x) + 6, Math.abs(z.y - a.y) + 6);
    }
    ctx.restore();
  }

  /* ---- Restore / copy ---- */
  async restoreVersion(versionId) {
    const link = this.cloudLink;
    const row = this._hist.rows?.find(r => r.id === versionId);
    if (!link || !row) return;
    const label = row.kind === 'named' && row.name ? `"${row.name}"` : `the version from ${versionTime(row.saved_at)}`;
    if (!(await confirmDialog({ title: 'Restore this version?', confirmLabel: 'Restore',
      message: `The drawing goes back to ${label}. The drawing as it is now is kept in History, and Ctrl+Z also brings it back.` }))) return;
    if (link.dirty) await this._cloudPush();
    if (this._cloudStatus === 'conflict' || this.cloudLink !== link) return;
    try {
      await this.cloud.restoreVersion(versionId);
      const fresh = await this.cloud.load(link.id);
      this.stopCompare();
      this._openCloudRow(fresh, { keepUndo: true });
      track('version-restored', { kind: row.kind });
      this._hint(`Restored ${label}. The drawing before is kept in History; Ctrl+Z also brings it back.`);
      await this._historyLoad(true);
    } catch (e) { notice("Couldn't restore this version: " + (e.message || e), { kind: 'error' }); }
  }

  async copyVersion(versionId) {
    const link = this.cloudLink;
    const v = this._hist.rows?.find(r => r.id === versionId);
    if (!link || !v) return;
    try {
      if (link.dirty) await this._cloudPush();
      const [json, cur] = await Promise.all([this._versionJSON(versionId), this.cloud.load(link.id)]);
      const plan = this.cloudPlan || await this.cloud.plan().catch(() => ({ canPrivate: false }));
      const stamp = new Date(v.saved_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
      const name = `${cur.name} (${v.kind === 'named' && v.name ? v.name : stamp})`.slice(0, 80);
      const details = { name, description: cur.description || `Earlier version of ${cur.name}.`,
        visibility: plan.canPrivate && cur.visibility === 'private' ? 'private' : 'public' };
      await this._beforePublish(details);
      const data = { ...json, name };
      const row = await this.cloud.create(data, details);
      this.stopCompare();
      this._openCloudRow({ ...row, data });
      this._cloudThumbSoon(true);
      track('version-copied');
      this._hint(`"${row.name}" is a new sketch in your account; "${cur.name}" is unchanged.`);
    } catch (e) {
      notice(e instanceof LimitError ? `No room for a copy: the free plan holds ${e.limit} sketches. OnSketch Pro has no limit.` : "Couldn't copy this version: " + (e.message || e), { kind: 'error' });
    }
  }
}
