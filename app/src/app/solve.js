import { Arc } from '../core/entities.js';

export class SolveMixin {

  /* ---- Solving ---- */
  commit(options = {}) {
    // New constraints and dimensions are filed under the active layer
    // (layers are display only: this only decides where they're listed).
    const activeLayer = this.project.activeLayerId;
    for (const s of this.project.sketches) for (const c of s.constraints) if (!c.layerId) c.layerId = activeLayer;
    this._refLayers = null;
    // Equation changes (variables, formulas) are applied before the solve.
    if (this._applyEquations().changed) this._solveAllLayers();
    const diagnostics = options.diagnostics || 'defer';
    const sketch = this.activeSketch();
    const activeIds = options.activeIds
      ? new Set(options.activeIds)
      : (sketch && sketch.dirtyIds && sketch.dirtyIds.size ? new Set(sketch.dirtyIds) : null);
    if (sketch?.dirtyIds) sketch.dirtyIds.clear();
    if (diagnostics === 'sync') this.solveAndRender();
    else this.solveFastAndRender({ diagnostics, activeIds });
    // Carry fill colours over to the areas the settled shapes form (split /
    // merge / re-cut / opened). After the solve: a snap constraint added on
    // release only closes an area once solved.
    this._reconcileStoredFills();
    // Linked ink follows the settled geometry before the snapshot.
    this.syncInkLinks();
    // The undo step holds the settled, recoloured state.
    this.undoStack.push(JSON.stringify(this.project.toJSON({ images: false })));
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack.length = 0;
    if (this._refreshLayerPanel) this._refreshLayerPanel();   // entity counts
    this.scheduleAutosave();
  }


  solveSoft() {
    const sketch = this.activeSketch(); if (!sketch) return;
    const r = this.solver.solve(sketch, this.project.sketches, [], { diagnostics:true, revertOnFailure:true });
    for (const e of sketch.entities) if (e instanceof Arc) e.syncEnds();
    this._updateConstraintStatus(r);
    this._lastSolve = r;
  }

  solveFastAndRender(options = {}) {
    const scheduleDiagnostics = options.diagnostics === 'defer';
    if (!scheduleDiagnostics) this._cancelPendingDiagnostics();
    const sketch = this.activeSketch();
    if (!sketch) { this.requestRender(); return; }
    const t0 = performance.now();
    const r = this.solver.solve(sketch, this.project.sketches, [], {
      diagnostics:false,
      revertOnFailure:true,
      activeIds: options.activeIds || null
    });
    const t1 = performance.now();
    for (const e of sketch.entities) if (e instanceof Arc) e.syncEnds();

    const solvePill = document.getElementById('status-solve');
    solvePill.classList.remove('ok','warn','error');
    const totalConstraints = sketch.constraints.filter(c => !c.driven).length;
    if (totalConstraints === 0) { solvePill.textContent = 'no constraints'; solvePill.classList.add('warn'); }
    else if (r.ok)            { solvePill.textContent = `solved (${r.iters} it, ${(t1-t0).toFixed(1)} ms)`; solvePill.classList.add('ok'); }
    else                       { solvePill.textContent = `not solved (res ${r.residual.toExponential(2)})`; solvePill.classList.add('error'); }

    if (r.state === 'over') {
      const statePill = document.getElementById('status-state');
      statePill.classList.remove('ok','warn','error');
      statePill.textContent = 'Over-defined';
      statePill.classList.add('error');
    } else if (scheduleDiagnostics) {
      const statePill = document.getElementById('status-state');
      statePill.classList.remove('ok','warn','error');
      statePill.textContent = 'Checking...';
      statePill.classList.add('warn');
      document.getElementById('status-dof').textContent = 'DOF: ...';
    }

    this.updateAffectedConstraintStatus(options.activeIds || null);
    this.requestRender();
    if (scheduleDiagnostics) this.requestDiagnostics();
  }

  updateAffectedConstraintStatus(activeIds) {
    const sketch = this.activeSketch();
    if (!sketch || !activeIds || !activeIds.size) return;
    const r = this.solver.solve(sketch, this.project.sketches, [], {
      diagnostics:true,
      revertOnFailure:true,
      activeIds
    });
    const overOverall = r.state === 'over';
    for (const e of sketch.entities) {
      const status = r.entityStatus?.get(e.id);
      if (status) e.status = overOverall ? 'over' : status;
      for (const child of e.children()) {
        const childStatus = r.entityStatus?.get(child.id);
        if (childStatus) child.status = overOverall ? 'over' : childStatus;
      }
    }
    this._lastSolve = {
      ...(this._lastSolve || {}),
      state: r.state,
      redundantIds: this._lastSolve?.redundantIds || new Set()
    };
  }

  solveAndRender() {
    this._cancelPendingDiagnostics();
    const sketch = this.activeSketch();
    if (!sketch) { this.requestRender(); return; }
    const t0 = performance.now();
    const r = this.solver.solve(sketch, this.project.sketches, [], { diagnostics:true, revertOnFailure:true });
    const t1 = performance.now();
    for (const e of sketch.entities) if (e instanceof Arc) e.syncEnds();
    this._updateConstraintStatus(r);
    this._lastSolve = r;

    const solvePill = document.getElementById('status-solve');
    solvePill.classList.remove('ok','warn','error');
    if (r.m === 0)            { solvePill.textContent = 'no constraints'; solvePill.classList.add('warn'); }
    else if (r.ok)            { solvePill.textContent = `solved (${r.iters} it, ${(t1-t0).toFixed(1)} ms)`; solvePill.classList.add('ok'); }
    else                       { solvePill.textContent = `not solved (res ${r.residual.toExponential(2)})`; solvePill.classList.add('error'); }

    const statePill = document.getElementById('status-state');
    statePill.classList.remove('ok','warn','error');
    if (r.state === 'fully')   { statePill.textContent = 'Fully defined'; statePill.classList.add('ok'); }
    else if (r.state === 'over'){ statePill.textContent = `Over-defined (${r.redundant} redundant)`; statePill.classList.add('error'); }
    else                        { statePill.textContent = 'Under-defined'; statePill.classList.add('warn'); }

    document.getElementById('status-dof').textContent = 'DOF: ' + r.dof;
    this.requestRender();
  }

  _cancelPendingDiagnostics() {
    this._diagnosticsToken++;
    if (this._diagnosticsTimer != null) {
      clearTimeout(this._diagnosticsTimer);
      this._diagnosticsTimer = null;
    }
    if (this._diagnosticsFrame != null) {
      cancelAnimationFrame(this._diagnosticsFrame);
      this._diagnosticsFrame = null;
    }
    if (this._diagnosticsIdleId != null && typeof cancelIdleCallback !== 'undefined') {
      cancelIdleCallback(this._diagnosticsIdleId);
      this._diagnosticsIdleId = null;
    }
  }

  requestDiagnostics() {
    this._cancelPendingDiagnostics();
    const token = this._diagnosticsToken;
    const run = () => {
      this._diagnosticsTimer = null;
      this._diagnosticsIdleId = null;
      this._diagnosticsFrame = null;
      if (token !== this._diagnosticsToken) return;
      this.solveAndRender();
    };
    this._diagnosticsFrame = requestAnimationFrame(() => {
      if (token !== this._diagnosticsToken) return;
      if (typeof requestIdleCallback !== 'undefined') {
        this._diagnosticsIdleId = requestIdleCallback(run, { timeout: 1000 });
      } else {
        this._diagnosticsTimer = setTimeout(run, 120);
      }
    });
  }

  /** Colour every entity by how defined it is. Layers don't matter: the
   *  whole drawing is solved as one. */
  _updateConstraintStatus(result) {
    const sketch = this.activeSketch(); if (!sketch) return;
    const over = result.state === 'over';
    for (const e of sketch.entities) {
      const s = result.entityStatus?.get(e.id) || 'under';
      e.status = over ? 'over' : s;
      for (const c of e.children()) {
        const cs = result.entityStatus?.get(c.id) || s;
        c.status = over ? 'over' : cs;
      }
    }
  }

}
