export class SelectionMixin {

  selectedEntitiesAndPoints() {
    // Dedup — a Point shared between two or more entities (e.g. a corner
    // joining several lines) would otherwise appear once per parent.
    const out = [];
    const seen = new Set();
    const add = (x) => { if (!seen.has(x)) { seen.add(x); out.push(x); } };
    const sketch = this.activeSketch();
    if (!sketch) return out;
    const activeItems = new Set();
    for (const e of sketch.entities) {
      activeItems.add(e);
      for (const c of e.children()) activeItems.add(c);
    }
    for (const c of sketch.constraints) activeItems.add(c);
    this.selectionOrder = this.selectionOrder.filter(x => x && x.selected && activeItems.has(x));
    for (const x of this.selectionOrder) add(x);
    for (const e of sketch.entities) {
      if (e.selected) add(e);
      for (const c of e.children()) if (c.selected) add(c);
    }
    for (const c of sketch.constraints) if (c.selected) add(c);
    return out;
  }

  setSelected(entity, selected) {
    if (!entity) return;
    entity.selected = !!selected;
    const i = this.selectionOrder.indexOf(entity);
    if (selected) {
      if (i < 0) this.selectionOrder.push(entity);
    } else if (i >= 0) {
      this.selectionOrder.splice(i, 1);
    }
  }

  clearSelection() {
    for (const s of this.project.sketches) {
      for (const e of s.entities) {
        e.selected = false;
        for (const c of e.children()) c.selected = false;
      }
      for (const c of s.constraints) c.selected = false;
    }
    this.clearStrokeSelection();
    this.selectionOrder = [];
    this.refreshUI();
    this.requestRender();
  }

  deleteSelection() {
    const sketch = this.activeSketch(); if (!sketch) return;
    // Selected shapes, whatever their layer.
    const toDelete = sketch.entities.filter(e => e.selected || e.children().some(c => c.selected));
    const hasSelectedConstraints = sketch.constraints.some(c => c.selected);
    const inkDeleted = this.deleteSelectedStrokes();
    if (!toDelete.length && !hasSelectedConstraints) {
      if (inkDeleted) { this.commit(); this.refreshUI(); this.requestRender(); }
      return;
    }
    const gone = sketch.constraints.filter(c => c.selected);
    sketch.constraints = sketch.constraints.filter(c => !c.selected);
    this._syncFixFlags([], gone);
    for (const e of toDelete) sketch.removeEntity(e);
    this.commit();
    this.refreshUI();
  }
}
