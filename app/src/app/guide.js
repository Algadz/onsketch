import { track } from '../ui/analytics.js';

/* =============== FIRST RUN: THREE STEPS ========================
   A first visit starts on an empty canvas; the point of OnSketch (type
   a size, the drawing follows, colour included) only shows once a shape
   has a dimension and a fill. A small card walks through exactly that:

     1. Draw a rectangle      2. Give it a size      3. Colour it

   Each step has a button that picks the tool, and ticks itself when the
   drawing shows it was done (a closed shape, a dimension with a value,
   a fill), whatever way the user got there. It never blocks: the canvas
   and every tool stay usable (clicks and drags go through the card,
   only its buttons take them), and × dismisses it for good.

   Shown once per browser, only on an empty first visit (not with a
   saved drawing, an example or a shared sketch), and never again once
   finished or dismissed.

   Activation is counted for everyone, guided or not, once per browser:
     activation { step: 'shape' | 'dimension' | 'fill', guided }
     activated  { guided }      all three reached
   ============================================================ */
const GUIDE_KEY = 'onsketch:guide';            // 'done' | 'skipped'
const ACT_KEY = 'onsketch:activation';         // comma list of steps reached
const DIM_KINDS = new Set(['distance', 'curveDistance', 'pointLineDistance', 'offsetDistance', 'radius', 'angle']);
const STEPS = ['shape', 'dimension', 'fill'];
const get = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const set = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } };

export class GuideMixin {
  /** What the drawing shows of the three steps. */
  _guideState() {
    const s = this.activeSketch();
    if (!s) return { shape: false, dimension: false, fill: false };
    let lines = 0, round = false;
    for (const e of s.entities) {
      if (e.construction) continue;
      const k = e.constructor.kind;
      if (k === 'line') lines++;
      else if (k === 'circle') round = true;
    }
    return {
      shape: round || lines >= 3,
      dimension: s.constraints.some(c => DIM_KINDS.has(c.kind) && !c.driven),
      fill: s.fills.length > 0,
    };
  }

  /** Called after every change (commit, undo, load). */
  _guideCheck() {
    const st = this._guideState();
    // Activation, once per browser per step.
    const reached = new Set((get(ACT_KEY) || '').split(',').filter(Boolean));
    let grew = false;
    // What was already there when the drawing was opened (an example, a
    // saved sketch) isn't something this visitor just did.
    if (!this._actBaseline) this._actBaseline = st;
    for (const step of STEPS) {
      if (st[step] && !this._actBaseline[step] && !reached.has(step)) {
        reached.add(step); grew = true;
        track('activation', { step, guided: !!this._guide });
      }
    }
    if (grew) {
      set(ACT_KEY, [...reached].join(','));
      if (STEPS.every(s => reached.has(s))) track('activated', { guided: !!this._guide });
    }
    if (this._guide) this._guideRender(st);
  }

  /** Another drawing was opened (example, account, library): what it
   *  holds isn't this visitor's doing, and the first-run card goes. */
  _guideOpened() {
    this._actBaseline = null;
    this._guideClose('skipped');
  }

  /** Starts the guide on an empty first visit. */
  _setupGuide(restored) {
    const params = new URLSearchParams(location.search);
    const busy = ['example', 'view', 'project', 'insert', 'signin', 'new'].some(k => params.has(k));
    const s = this.activeSketch();
    const empty = !!s && !s.entities.length && !s.strokes.length && !s.fills.length;
    this._actBaseline = this._guideState();
    if (restored || busy || !empty || get(GUIDE_KEY)) return;
    const el = document.createElement('aside');
    el.id = 'guide';
    el.setAttribute('aria-label', 'Getting started');
    document.getElementById('workspace').appendChild(el);
    this._guide = { el, step: 0, shownAt: Date.now() };
    track('guide', { step: 'shown' });
    this._guideRender(this._guideState());
  }

  _guideClose(how) {
    const g = this._guide; if (!g) return;
    this._guide = null;
    g.el.remove();
    set(GUIDE_KEY, how);
    if (how === 'skipped') track('guide', { step: 'skipped', at: STEPS[g.step] || 'end' });
  }

  _guideRender(st) {
    const g = this._guide; if (!g) return;
    const touch = !!(this.touchUI || this.compact);
    const done = STEPS.map(k => !!st[k]);
    // The step to show: the first one not done, in order (a fill needs a shape).
    let step = done.indexOf(false); if (step < 0) step = STEPS.length;
    if (step > g.step) {
      for (let i = g.step; i < step; i++) track('guide', { step: STEPS[i] });
      if (step === STEPS.length) track('guide', { step: 'done', seconds: Math.round((Date.now() - g.shownAt) / 1000) });
    }
    g.step = step;
    const items = [
      { title: 'Draw a rectangle', tool: 'rectangle', label: 'Rectangle',
        how: touch ? 'Then drag across the canvas.' : 'Then click two corners on the canvas.' },
      { title: 'Give it a size', tool: 'smartdim', label: 'Dimension',
        how: touch ? 'Tap a side, tap again to place the dimension, then type a size like 120.' : 'Click a side, click again to place the dimension, then type a size like 120 and press Enter.' },
      { title: 'Colour it', tool: 'fill', label: 'Fill',
        how: (touch ? 'Then tap' : 'Then click') + ' inside the rectangle.' },
    ];
    const dots = STEPS.map((_, i) => `<span class="guide-dot${done[i] ? ' done' : i === step ? ' now' : ''}">${done[i] ? '✓' : i + 1}</span>`).join('');
    if (step < STEPS.length) {
      const it = items[step];
      const active = this.toolName === it.tool;
      g.el.innerHTML = `
        <div class="guide-steps">${dots}</div>
        <div class="guide-text"><b>${it.title}</b><span>${active ? it.how.replace(/^Then /, '').replace(/^./, c => c.toUpperCase()) : `Pick <b>${it.label}</b>. ${it.how}`}</span></div>
        ${active ? '' : `<button type="button" class="btn primary" data-a="tool">${it.label}</button>`}
        <button type="button" class="guide-x" data-a="skip" title="Hide these steps" aria-label="Hide these steps">×</button>`;
      g.el.querySelector('[data-a="tool"]')?.addEventListener('click', () => { this.setTool(it.tool); this._guideRender(this._guideState()); });
    } else {
      g.el.innerHTML = `
        <div class="guide-steps">${dots}</div>
        <div class="guide-text"><b>That's the idea.</b><span>Now change the size: ${touch ? 'tap the dimension twice' : 'double-click the dimension'} and type another number. The shape and its colour follow.</span></div>
        <a class="btn" data-a="example" href="?example=desk">See an example</a>
        <button type="button" class="btn primary" data-a="ok">Got it</button>`;
      g.el.querySelector('[data-a="ok"]').addEventListener('click', () => this._guideClose('done'));
      g.el.querySelector('[data-a="example"]').addEventListener('click', () => { set(GUIDE_KEY, 'done'); track('guide', { step: 'example' }); });
      set(GUIDE_KEY, 'done');
    }
    g.el.querySelector('[data-a="skip"]')?.addEventListener('click', () => this._guideClose('skipped'));
  }
}
