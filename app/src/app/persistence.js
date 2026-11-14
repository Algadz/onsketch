import { Project } from '../core/model.js';
import { choose, notice } from '../ui/dialogs.js';
import { track, trackOnce } from '../ui/analytics.js';

const STORE_KEY = 'sketchcad:last';

export class PersistenceMixin {

  /* ---- Storage ----
     The project is kept in the browser under STORE_KEY: written shortly
     after every change (autosave), when the page is hidden or closed,
     and by the Save button; read back when the editor opens. */
  /** Save (button, ⋯ menu, Ctrl+S). With accounts enabled it saves to the
   *  account (signing in first if needed); the browser copy is kept
   *  silently either way. Without accounts it is the browser save. */
  save() {
    this._writeLocal();
    track('sketch-save', { to: this.cloudEnabled ? 'account' : 'browser', signed_in: !!this.cloudUser, linked: !!this.cloudLink });
    if (this.cloudEnabled) { this.cloudSave(); return; }
    this.saveLocal();
  }
  saveLocal() {
    if (!this._writeLocal()) return;
    const pill = document.getElementById('status-solve');
    const old = pill.textContent;
    pill.textContent = 'saved to browser';
    setTimeout(() => pill.textContent = old, 1500);
  }
  _writeLocal() {
    clearTimeout(this._autosaveTimer);
    try { localStorage.setItem(STORE_KEY, JSON.stringify(this.project.toJSON())); return true; }
    catch (e) {
      // Usually the browser's storage is full (imported pictures are big):
      // keep the drawing without the pictures' data rather than nothing.
      const hasImages = this.project.sketches.some(s => s.strokes.some(st => st.kind === 'image'));
      if (hasImages) {
        try {
          localStorage.setItem(STORE_KEY, JSON.stringify(this.project.toJSON({ images: false })));
          if (!this._imageQuotaNoted) {
            this._imageQuotaNoted = true;
            notice('The pictures are too large for the browser copy. Save the sketch to keep them.', { ms: 6000 });
          }
          return true;
        } catch { /* fall through */ }
      }
      console.warn('save failed', e); return false;
    }
  }
  /** Saves a moment after the last change, so a burst of edits is one write. */
  scheduleAutosave() {
    clearTimeout(this._autosaveTimer);
    this._autosaveTimer = setTimeout(() => this._writeLocal(), 400);
    if (this._cloudChanged) this._cloudChanged();
  }
  /** Restores the last saved project. Bad or missing data leaves the new
   *  empty project in place. */
  loadLocalIfAny() {
    let raw = null;
    try { raw = localStorage.getItem(STORE_KEY); } catch { return false; }
    if (!raw) return false;
    try {
      const p = Project.fromJSON(JSON.parse(raw));
      if (!p.active()) return false;
      this.project = p;
      return true;
    } catch (e) { console.warn('load failed', e); return false; }
  }
  /** /app/?example=<slug> opens app/examples/<slug>.json. The drawing that
   *  was open stays one Undo away; the parameter is dropped from the URL
   *  so a reload keeps whatever the user did with the example. */
  async openExampleFromURL() {
    const params = new URLSearchParams(location.search);
    const slug = params.get('example');
    if (!slug) return false;
    params.delete('example');
    const clean = location.pathname + (params.toString() ? '?' + params : '') + location.hash;
    history.replaceState(null, '', clean);
    if (!/^[a-z0-9-]{1,40}$/.test(slug)) return false;
    const hint = document.getElementById('status-hint');
    try {
      const res = await fetch(`examples/${slug}.json`, { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const project = Project.fromJSON(await res.json());
      if (this._cloudUnlink) this._cloudUnlink();
      this.project = project;
      this.selectionOrder = [];
      if (this.tool && this.tool.activate) this.tool.activate();
      this.commit({ diagnostics: 'sync' });
      this.refreshUI();
      this.zoomFit();
      if (hint) hint.textContent = `Example "${project.name}" opened. Ctrl+Z goes back to your previous drawing.`;
      track('sketch-open', { from: 'example', example: slug });
      return true;
    } catch (e) {
      console.warn('example failed', e);
      if (hint) hint.textContent = `Couldn't open the example "${slug}".`;
      return false;
    }
  }

  _setupAutosave() {
    const flush = () => { this._writeLocal(); if (this.cloudLink?.dirty) this._cloudPush(); };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
  }
  async newProject() {
    // A drawing saved in the account is safe: no question. Otherwise ask.
    const s = this.activeSketch();
    const empty = !s || (!s.entities.length && !s.strokes.length && !s.fills.length);
    const saved = this.cloudLink && !this.cloudLink.dirty;
    if (!empty && !saved && !this._skipConfirm) {
      const linked = !!this.cloudLink;
      const answer = await choose({
        title: 'Start a new sketch?',
        message: linked
          ? 'Some changes to this sketch haven\'t reached your account yet (no connection). If you start a new sketch now, they will be lost.'
          : 'The current drawing isn\'t saved. If you start a new sketch, it will be lost.',
        cancelValue: 'cancel',
        choices: [
          { label: 'Cancel', value: 'cancel' },
          ...(this.cloudEnabled && !linked ? [{ label: 'Save it first', value: 'save' }] : []),
          { label: 'Discard and start new', value: 'new', kind: 'danger' },
        ],
      });
      if (answer === 'save') { this.save(); return; }
      if (answer !== 'new') return;
    }
    if (this._cloudUnlink) this._cloudUnlink();
    this.project = new Project(); this.project.addSketch('Sketch 1');
    this.undoStack.length = 0; this.redoStack.length = 0;
    this.selectionOrder = [];
    this.refreshUI(); this.solveAndRender();
    this._writeLocal();
    this._renderSaveState?.();
    track('sketch-new');
  }
  /* ---- Undo / redo ---- */
  undo() {
    if (this.operationName === 'pattern' && this.pattern?.mode === 'edit') { this.cancelPatternEdit(); return; }
    if (this.operationName === 'pattern') this.cancelOperation();
    if (this.undoStack.length < 2) return;
    trackOnce('undo');
    const cur = this.undoStack.pop();
    this.redoStack.push(cur);
    const prev = this.undoStack[this.undoStack.length - 1];
    this._swapSameDocument(prev);
    this._afterStateSwap();
  }
  redo() {
    if (this.operationName === 'pattern') return;      // finish or cancel the pattern first
    if (!this.redoStack.length) return;
    const next = this.redoStack.pop();
    this.undoStack.push(next);
    this._swapSameDocument(next);
    this._afterStateSwap();
  }
  /** Undo / redo / abort: an earlier state of the same drawing. The
   *  display (grid, snap…) stays as it is now: toggling isn't undone. */
  _swapSameDocument(json) {
    this._keepDisplay = true;
    try { this.project = Project.fromJSON(JSON.parse(json)); }
    finally { this._keepDisplay = false; }
  }
  /** After replacing this.project with a freshly revived version, the
   *  current tool may be holding references to entities that no longer
   *  exist (e.g. LineTool.startPt, SmartDim.picks). Re-activating the
   *  tool resets that state without changing tool selection. */
  _afterStateSwap() {
    this.cancelTextEdit();
    this._inkDragItems = null;
    this.linkPick = null;
    if (this.tool && this.tool.activate) this.tool.activate();
    this.lastSnap = null;
    this.lastDragSnaps = [];
    this.selectionOrder = [];
    this.refreshUI();
    this.solveAndRender();
    this._primeFillRegions();
    this.scheduleAutosave();
  }

  _setupResize() {
    const onResize = () => {
      this.renderer.dpr = window.devicePixelRatio || 1;
      this.renderer.resize();
      this.requestRender();
    };
    window.addEventListener('resize', onResize);
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(onResize).observe(this.canvas);
    }
    onResize();
    requestAnimationFrame(onResize);
  }
}
