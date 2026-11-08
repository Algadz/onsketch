import { Project } from '../core/model.js';

export class PersistenceMixin {

  /* ---- Storage ---- */
  saveLocal() {
    localStorage.setItem('sketchcad:last', JSON.stringify(this.project.toJSON()));
    const pill = document.getElementById('status-solve');
    const old = pill.textContent;
    pill.textContent = 'saved to browser';
    setTimeout(() => pill.textContent = old, 1500);
  }
  loadLocalIfAny() {
    const raw = localStorage.getItem('sketchcad:last');
    if (!raw) return false;
    try { this.project = Project.fromJSON(JSON.parse(raw)); return true; }
    catch (e) { console.warn('load failed', e); return false; }
  }
  newProject() {
    if (!confirm('Discard current project and start a new one?')) return;
    this.project = new Project(); this.project.addSketch('Sketch 1');
    this.undoStack.length = 0; this.redoStack.length = 0;
    this.selectionOrder = [];
    this.refreshUI(); this.solveAndRender();
  }
  exportJSON() { this._modal('Export JSON', JSON.stringify(this.project.toJSON(), null, 2), false); }
  importJSON() {
    this._modal('Import JSON', '', true).then(text => {
      if (!text) return;
      try {
        this.project = Project.fromJSON(JSON.parse(text));
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
   *  exist (e.g. LineTool.startPt, DimensionTool.picks). Re-activating the
   *  tool resets that state without changing tool selection. */
  _afterStateSwap() {
    if (this.tool && this.tool.activate) this.tool.activate();
    this.lastSnap = null;
    this.lastDragSnaps = [];
    this.selectionOrder = [];
    this.refreshUI();
    this.solveAndRender();
    this._primeFillRegions();
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
