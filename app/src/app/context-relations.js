import { CONSTRAINT_GLYPHS, constraintLabel, Constraint } from '../core/constraints.js';
import { isDimension } from '../core/equations.js';
import { availableRelations, constraintAppliesToSelection } from '../editor/relations.js';

/* The context menu (right-click, long press) on something already selected:
   a shortcut to the relations Properties shows.

     one item selected    its relations (whatever they tie it to)
     two or more          only the relations between the selected items

   followed by the relations that can be added (as chips), then the usual
   actions. Tapping a relation selects it; × removes it and the menu stays
   open, rebuilt, so several can go in a row. Long lists stop at
   MAX_LISTED with a row that opens Properties. */

const MAX_LISTED = 6;

export class ContextRelationsMixin {
  /** Geometry of the current selection (no constraints), as Properties uses it. */
  _selectionGeometry() {
    return this.selectedEntitiesAndPoints().filter(e => !(e instanceof Constraint));
  }

  /** The relations the menu lists for the selection. */
  selectionMenuRelations(geom = this._selectionGeometry()) {
    const sketch = this.activeSketch();
    if (!sketch || !geom.length) return [];
    const mine = (c) => !isDimension(c) && c.kind !== 'paramFix' && c.kind !== 'pattern' && c.kind !== 'directedAngle';
    const touching = sketch.constraints.filter(c => mine(c) && constraintAppliesToSelection(c, geom));
    if (geom.length === 1) return touching;
    // Between the selected items: everything it ties is selected (a line's
    // end points count as the line), and no single one of them carries it
    // alone (a Horizontal on one of two selected lines isn't between them,
    // even when that line shares a corner with the other).
    const own = geom.map(g => new Set([g.id, ...(g.children ? g.children().map(p => p.id) : [])]));
    const byId = this._lookupMap([sketch]);
    return touching.filter(c => {
      const refs = [...this._relationRefIds(c, byId)];
      for (const id of c.refs()) if (byId.has(id) && !refs.includes(id)) refs.push(id);
      if (!refs.length || !refs.every(id => own.some(o => o.has(id)))) return false;
      return !own.some(o => refs.every(id => o.has(id)));
    });
  }

  /** Relations that can be added now (not already holding). */
  selectionMenuAddable(geom = this._selectionGeometry()) {
    return availableRelations(geom)
      .map(r => ({ ...r, state: this.relationState(r.kind, geom).state }))
      .filter(r => r.state === 'off' || r.state === 'partial');
  }

  /** Fills `menu` with the selection header and relations. */
  _appendSelectionRelations(menu, rebuild) {
    const geom = this._selectionGeometry();
    const sketch = this.activeSketch();
    const head = document.createElement('div');
    head.className = 'context-menu-head';
    head.textContent = geom.length === 1 ? this._entityLabel(geom[0]) : `${geom.length} items`;
    menu.appendChild(head);

    const related = this.selectionMenuRelations(geom);
    const byId = this._lookupMap([sketch]);
    const selIds = new Set(geom.map(g => g.id));
    for (const c of related.slice(0, MAX_LISTED)) {
      const row = document.createElement('div');
      row.className = 'context-menu-item cm-rel';
      row.dataset.cid = c.id;
      row.setAttribute('role', 'button');
      row.tabIndex = 0;
      // One item: say what else it ties it to.
      let with_ = '';
      if (geom.length === 1) {
        const owned = new Set(geom[0].children ? geom[0].children() : []);
        const others = this._relationParticipants(c, byId).filter(x => !selIds.has(x.id) && !owned.has(x));
        if (others.length) with_ = 'with ' + others.map(o => this._entityLabel(o)).join(', ');
      }
      row.innerHTML = `<span class="glyph">${CONSTRAINT_GLYPHS[c.kind] || '•'}</span><span class="cm-rel-name"></span><span class="meta"></span><button type="button" class="cm-del" aria-label="Remove">×</button>`;
      row.querySelector('.cm-rel-name').textContent = constraintLabel(c);
      row.querySelector('.meta').textContent = with_;
      row.addEventListener('click', (e) => {
        if (e.target.closest('.cm-del')) return;
        this.hideContextMenu();
        this.clearSelection();
        c.selected = true;
        this.refreshUI();
        this.requestRender();
      });
      row.querySelector('.cm-del').addEventListener('click', (e) => {
        e.stopPropagation();
        sketch.constraints = sketch.constraints.filter(k => k !== c);
        this._syncFixFlags([], [c]);
        this.commit();
        this.refreshUI();
        this.requestRender();
        rebuild();
      });
      menu.appendChild(row);
    }
    if (related.length > MAX_LISTED) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'context-menu-item action';
      more.innerHTML = `<span class="glyph">…</span><span>${related.length - MAX_LISTED} more in Properties</span>`;
      more.addEventListener('click', () => { this.hideContextMenu(); this.windows?.toggle('props', true); });
      menu.appendChild(more);
    }

    const addable = this.selectionMenuAddable(geom);
    if (addable.length) {
      const sub = document.createElement('div');
      sub.className = 'context-menu-head cm-sub';
      sub.textContent = related.length ? 'Add' : 'Add a relation';
      menu.appendChild(sub);
      const chips = document.createElement('div');
      chips.className = 'cm-chips';
      for (const r of addable) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'cm-chip' + (r.state === 'partial' ? ' partial' : '');
        b.dataset.rel = r.kind;
        b.title = r.state === 'partial' ? `${r.label}: holds for part of the selection; apply to all` : `Add ${r.label.toLowerCase()}`;
        b.innerHTML = `<span class="glyph">${r.glyph}</span><span></span>`;
        b.lastChild.textContent = r.label;
        b.addEventListener('click', () => {
          this.hideContextMenu();
          this.toggleRelation(r.kind);
          this.requestRender();
        });
        chips.appendChild(b);
      }
      menu.appendChild(chips);
    }
    if (!related.length && !addable.length) {
      const none = document.createElement('div');
      none.className = 'cm-none';
      none.textContent = 'No relation to add';
      menu.appendChild(none);
    }
  }
}
