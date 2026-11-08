import { Project } from '../core/model.js';

const STORE_KEY = 'sketchcad:last';

export class PersistenceMixin {

  /* ---- Storage ----
     The project is kept in the browser under STORE_KEY: written shortly
     after every change (autosave), when the page is hidden or closed,
     and by the Save button; read back when the editor opens. */
  saveLocal() {
    if (!this._writeLocal()) return;
    if (this.cloudLink) this._cloudPush();
    const pill = document.getElementById('status-solve');
    const old = pill.textContent;
    pill.textContent = 'saved to browser';
    setTimeout(() => pill.textContent = old, 1500);
  }
  _writeLocal() {
    clearTimeout(this._autosaveTimer);
    try { localStorage.setItem(STORE_KEY, JSON.stringify(this.project.toJSON())); return true; }
    catch (e) { console.warn('save failed', e); return false; }
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
  newProject() {
    if (!confirm('Discard current project and start a new one?')) return;
    if (this._cloudUnlink) this._cloudUnlink();
    this.project = new Project(); this.project.addSketch('Sketch 1');
    this.undoStack.length = 0; this.redoStack.length = 0;
    this.selectionOrder = [];
    this.refreshUI(); this.solveAndRender();
    this._writeLocal();
  }
  exportJSON() { this._modal('Export JSON', JSON.stringify(this.project.toJSON(), null, 2), false); }
  importJSON() {
    this._modal('Import JSON', '', true).then(text => {
      if (!text) return;
      try {
        const project = Project.fromJSON(JSON.parse(text));
        if (this._cloudUnlink) this._cloudUnlink();
        this.project = project;
        this.selectionOrder = [];
        this.commit({ diagnostics:'sync' });
        this.refreshUI();
      } catch (e) { alert('Failed to parse: ' + e.message); }
    });
  }

  _setupModal() {
    const m = document.getElementById('json-modal');
    document.getElementById('json-modal-cancel').addEventListener('click', () => {
      m.classList.remove('show');
      this._modalResolve && this._modalResolve(null);
    });
    document.getElementById('json-modal-ok').addEventListener('click', () => {
      m.classList.remove('show');
      this._modalResolve && this._modalResolve(document.getElementById('json-modal-text').value);
    });
  }
  _modal(title, text, editable) {
    const m = document.getElementById('json-modal');
    document.getElementById('json-modal-title').textContent = title;
    const ta = document.getElementById('json-modal-text');
    ta.value = text; ta.readOnly = !editable;
    m.classList.add('show');
    return new Promise((res) => { this._modalResolve = res; });
  }

  /* ---- Undo / redo ---- */
  undo() {
    if (this.undoStack.length < 2) return;
    const cur = this.undoStack.pop();
    this.redoStack.push(cur);
    const prev = this.undoStack[this.undoStack.length - 1];
    this.project = Project.fromJSON(JSON.parse(prev));
    this._afterStateSwap();
  }
  redo() {
    if (!this.redoStack.length) return;
    const next = this.redoStack.pop();
    this.undoStack.push(next);
    this.project = Project.fromJSON(JSON.parse(next));
    this._afterStateSwap();
  }
  /** After replacing this.project with a freshly revived version, the
   *  current tool may be holding references to entities that no longer
   *  exist (e.g. LineTool.startPt, SmartDim.picks). Re-activating the
   *  tool resets that state without changing tool selection. */
  _afterStateSwap() {
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
