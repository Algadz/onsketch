import { track } from '../ui/analytics.js';

/* =============== WELCOME TOUR: THREE SLIDES =====================
   onsketch.io opens the editor directly (no landing page), so a first
   visit gets three short slides with animated drawings, before anything
   else, saying what makes OnSketch different from Paint:

     1. Lock the sizes that matter   (Smart Dimension, the rest stays free)
     2. Colour it, label it          (fill, arrows and text follow the shape)
     3. Take it anywhere             (copy for slides, DXF, print to scale)

   Start drawing  → the tour closes and the first-run steps (guide.js)
                    take over: draw a rectangle, give it a size, colour it.
   Skip / Esc     → closes, and the first-run steps aren't shown either.
   An example is offered on the last slide, never opened by itself.

   Shown once per browser, on the same visits as the first-run steps
   (empty canvas, no saved drawing, example or shared sketch). The "?"
   button (menu bar, or ⋯ on a phone) opens it again at any time.
   Automated browsers don't get it unless window.__onsketchTour is set,
   so the other end-to-end tests aren't blocked by a dialog.

   Umami:  tour { step: 'shown' | 'lock' | 'colour' | 'export' | 'done'
                        | 'skipped' | 'example', source: 'first' | 'help',
                  at (with skipped) }
   ============================================================ */
const TOUR_KEY = 'onsketch:tour';              // 'done' | 'skipped'
const get = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const set = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } };

const GRID = (id) => `<defs><pattern id="${id}" width="16" height="16" patternUnits="userSpaceOnUse">
  <path d="M16 0H0V16" class="tg"/></pattern></defs><rect width="320" height="190" fill="url(#${id})"/>`;
const EASE = 'calcMode="spline" keySplines=".45 0 .55 1;.45 0 .55 1"';

/* 1. The width is locked at 120 mm, the cursor drags the top corner:
      the height follows, the width doesn't move. */
const ILLU_LOCK = `<svg viewBox="0 0 320 190" aria-hidden="true">${GRID('tour-g1')}
  <polygon class="acc accf" stroke-width="3" stroke-linejoin="round" points="80,140 200,140 200,92 80,92">
    <animate attributeName="points" dur="3.2s" repeatCount="indefinite" keyTimes="0;.5;1" ${EASE}
      values="80,140 200,140 200,92 80,92;80,140 200,140 200,40 80,40;80,140 200,140 200,92 80,92"/>
  </polygon>
  <g class="ln" stroke-width="1.4"><path d="M80 146v20M200 146v20M80 160h120"/></g>
  <path class="lnf" d="M80 160l7-4v8zM200 160l-7-4v8z"/>
  <rect class="chip" x="113" y="150" width="54" height="20" rx="4"/>
  <text x="140" y="164" text-anchor="middle" class="t b">120 mm</text>
  <g>
    <animateTransform attributeName="transform" type="translate" dur="3.2s" repeatCount="indefinite"
      values="0 0;0 -52;0 0" keyTimes="0;.5;1" ${EASE}/>
    <circle cx="200" cy="92" r="5" class="chip acc" stroke-width="2"/>
    <path d="M204 96l0 18 5-5 4 9 4-2-4-9h7z" class="cursor"/>
    <text x="232" y="96" class="t b acct">free ↕</text>
  </g>
</svg>`;

/* 2. The size changes from 120 to 170: the fill and the pinned arrow
      follow the edge, the note stays where it was put. */
const T2 = 'dur="4s" repeatCount="indefinite"';
const KT2 = 'keyTimes="0;.3;.45;.8;.95;1"';
const pts = (x) => `70,135 ${x},135 ${x},70 70,70`;
const ILLU_COLOUR = `<svg viewBox="0 0 320 190" aria-hidden="true">${GRID('tour-g2')}
  <defs><marker id="tour-ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
    <path d="M0 0L10 5L0 10z" fill="#e5484d"/></marker></defs>
  <polygon class="acc" stroke-width="3" stroke-linejoin="round" fill="#f5a524" fill-opacity=".45" points="${pts(180)}">
    <animate attributeName="points" ${T2} ${KT2} values="${pts(180)};${pts(180)};${pts(230)};${pts(230)};${pts(180)};${pts(180)}"/>
  </polygon>
  <g class="ln" stroke-width="1.4"><path d="M70 141v20"/>
    <path d="M180 141v20"><animateTransform attributeName="transform" type="translate" ${T2} ${KT2} values="0 0;0 0;50 0;50 0;0 0;0 0"/></path>
    <line x1="70" y1="155" x2="180" y2="155"><animate attributeName="x2" ${T2} ${KT2} values="180;180;230;230;180;180"/></line>
  </g>
  <rect class="chip" x="105" y="145" width="40" height="20" rx="4">
    <animate attributeName="x" ${T2} ${KT2} values="105;105;130;130;105;105"/></rect>
  <text x="125" y="159" text-anchor="middle" class="t b">
    <animate attributeName="x" ${T2} ${KT2} values="125;125;150;150;125;125"/>
    <tspan>120<animate attributeName="opacity" ${T2} calcMode="discrete" keyTimes="0;.38;.88" values="1;0;1"/></tspan></text>
  <text x="150" y="159" text-anchor="middle" class="t b" opacity="0">170
    <animate attributeName="opacity" ${T2} calcMode="discrete" keyTimes="0;.38;.88" values="0;1;0"/></text>
  <line x1="262" y1="58" x2="184" y2="92" stroke="#e5484d" stroke-width="2.5" stroke-linecap="round" marker-end="url(#tour-ah)">
    <animate attributeName="x2" ${T2} ${KT2} values="184;184;234;234;184;184"/></line>
  <rect x="232" y="34" width="64" height="24" rx="5" fill="#fff4d6" stroke="#f5a524" stroke-width="1.5"/>
  <text x="264" y="50" text-anchor="middle" class="t b" fill="#8a5a00">Heat sink</text>
</svg>`;

/* 3. One drawing, three ways out. */
const chip = (y, cls, a, b, d) => `<g class="tour-pop" style="animation-delay:${d}s">
  <rect class="chip ${cls}" x="200" y="${y}" width="96" height="38" rx="7" stroke-width="1.5"/>
  <text x="248" y="${y + 17}" text-anchor="middle" class="t big">${a}</text>
  <text x="248" y="${y + 31}" text-anchor="middle" class="t soft">${b}</text></g>`;
const ILLU_EXPORT = `<svg viewBox="0 0 320 190" aria-hidden="true">${GRID('tour-g3')}
  <rect class="chip" x="22" y="46" width="118" height="114" rx="8" stroke-width="1.5"/>
  <rect class="acc" x="40" y="66" width="60" height="36" rx="2" stroke-width="2" fill="#f5a524" fill-opacity=".45"/>
  <circle cx="114" cy="124" r="12" class="acc" fill="none" stroke-width="2"/>
  <g class="ln" stroke-width="1.2"><path d="M40 140h60M40 135v10M100 135v10"/></g>
  <path class="ln tour-draw" pathLength="1" d="M150 103H184" stroke-width="2.5"/>
  <path class="lnf tour-pop" style="animation-delay:.6s" d="M184 97l9 6-9 6z"/>
  ${chip(36, '', 'PNG · SVG', 'into your slides', .8)}
  ${chip(84, '', 'DXF', 'for CAD', 1.1)}
  ${chip(132, 'acc', 'Print 1:1', 'true scale', 1.4)}
</svg>`;

const SLIDES = [
  { id: 'lock', title: 'Lock the sizes that matter', illu: ILLU_LOCK,
    text: (t) => `Draw like in Paint. Pick <b>Smart Dimension</b>${t ? '' : ' (D)'}, ${t ? 'tap' : 'click'} a side and type a size. What you don't lock stays free to drag.` },
  { id: 'colour', title: 'Colour it, label it', illu: ILLU_COLOUR,
    text: () => '<b>Fill</b> closed shapes, pin <b>arrows</b> and <b>text</b> to them. Change a size and everything follows.' },
  { id: 'export', title: 'Take it anywhere', illu: ILLU_EXPORT,
    text: () => 'Paste it into your slides, export a <b>DXF</b> for CAD, or print at true scale. Every export is free.' },
];

export class TourMixin {
  /** First visit: the tour should come before the first-run steps. */
  _tourWanted() {
    if (get(TOUR_KEY)) return false;
    if (typeof navigator !== 'undefined' && navigator.webdriver && !window.__onsketchTour) return false;
    return true;
  }

  /** Opens the tour. source 'first' (first visit) or 'help' (the ? button).
   *  onStart runs when the visitor presses Start drawing. */
  openTour({ source = 'help', onStart } = {}) {
    if (this._tour) return;
    const touch = !!(this.touchUI || this.compact);
    const back = document.createElement('div');
    back.className = 'modal-backdrop show app-dialog tour-backdrop';
    back.innerHTML = `
      <div class="modal tour" role="dialog" aria-modal="true" aria-labelledby="tour-t0">
        <button type="button" class="tour-skip" data-a="skip">${source === 'help' ? 'Close' : 'Skip'}</button>
        <div class="tour-view"><div class="tour-track">
          ${SLIDES.map((s, i) => `
            <section class="tour-slide" aria-hidden="${i !== 0}">
              <div class="tour-ill">${s.illu}</div>
              <h2 id="tour-t${i}">${s.title}</h2>
              <p>${s.text(touch)}</p>
            </section>`).join('')}
        </div></div>
        <div class="tour-foot">
          <div class="tour-dots">${SLIDES.map((s, i) => `<button type="button" class="tour-dot" data-i="${i}" aria-label="Slide ${i + 1} of ${SLIDES.length}"></button>`).join('')}</div>
          <button type="button" class="btn tour-back" data-a="back">Back</button>
          <button type="button" class="btn primary tour-next" data-a="next">Next</button>
        </div>
        <a class="tour-example" data-a="example" href="?example=linkage" hidden>or open an example</a>
      </div>`;
    document.body.appendChild(back);
    const box = back.querySelector('.tour');
    const trackEl = back.querySelector('.tour-track');
    const slides = [...back.querySelectorAll('.tour-slide')];
    const dots = [...back.querySelectorAll('.tour-dot')];
    const prevBtn = back.querySelector('[data-a="back"]');
    const nextBtn = back.querySelector('[data-a="next"]');
    const example = back.querySelector('[data-a="example"]');
    const previous = document.activeElement;
    const last = SLIDES.length - 1;
    const seen = new Set();
    const t = this._tour = { back, index: 0 };

    const go = (i) => {
      t.index = Math.max(0, Math.min(last, i));
      trackEl.style.transform = `translateX(${-100 * t.index}%)`;
      slides.forEach((s, k) => {
        s.setAttribute('aria-hidden', String(k !== t.index));
        s.classList.toggle('on', k === t.index);
        if (k === t.index) {                                   // replay the drawing from its start
          s.classList.remove('play'); void s.offsetWidth; s.classList.add('play');
          s.querySelector('svg')?.setCurrentTime?.(0);
        }
      });
      dots.forEach((d, k) => d.setAttribute('aria-current', String(k === t.index)));
      box.setAttribute('aria-labelledby', `tour-t${t.index}`);
      prevBtn.style.visibility = t.index ? 'visible' : 'hidden';
      nextBtn.textContent = t.index < last ? 'Next' : source === 'help' ? 'Got it' : 'Start drawing';
      example.hidden = t.index < last;
      const id = SLIDES[t.index].id;
      if (!seen.has(id)) { seen.add(id); track('tour', { step: id, source }); }
    };
    const close = (how) => {
      if (this._tour !== t) return;
      this._tour = null;
      back.remove();
      if (source === 'first' || !get(TOUR_KEY)) set(TOUR_KEY, how === 'skipped' ? 'skipped' : 'done');
      track('tour', how === 'skipped' ? { step: 'skipped', source, at: SLIDES[t.index].id } : { step: how, source });
      if (previous?.focus && document.contains(previous)) previous.focus();
      if (how === 'done') onStart?.();
    };
    t.close = close;

    nextBtn.addEventListener('click', () => (t.index < last ? go(t.index + 1) : close('done')));
    prevBtn.addEventListener('click', () => go(t.index - 1));
    back.querySelector('[data-a="skip"]').addEventListener('click', () => close('skipped'));
    dots.forEach(d => d.addEventListener('click', () => go(+d.dataset.i)));
    example.addEventListener('click', () => { close('example'); });   // the link then opens ?example=linkage
    back.addEventListener('click', (e) => { if (e.target === back) close('skipped'); });
    back.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close('skipped'); }
      else if (e.key === 'ArrowRight' && t.index < last) go(t.index + 1);
      else if (e.key === 'ArrowLeft') go(t.index - 1);
      else if (e.key === 'Tab') {                              // keep focus inside
        const f = [...box.querySelectorAll('button, a[href]')].filter(x => !x.hidden && x.style.visibility !== 'hidden');
        const i = f.indexOf(document.activeElement);
        if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
      }
      e.stopPropagation();                                     // editor shortcuts don't fire behind it
    });
    // Swipe between slides (finger, pen or mouse).
    const view = back.querySelector('.tour-view');
    let x0 = null;
    view.addEventListener('pointerdown', (e) => { x0 = e.clientX; });
    view.addEventListener('pointerup', (e) => {
      if (x0 === null) return;
      const dx = e.clientX - x0; x0 = null;
      if (Math.abs(dx) > 40) go(t.index + (dx < 0 ? 1 : -1));
    });

    track('tour', { step: 'shown', source });
    go(0);
    nextBtn.focus();
  }

  /** On a first visit, once the editor has faded in. */
  _startTourThen(onStart) {
    const root = document.documentElement;
    const open = () => this.openTour({ source: 'first', onStart });
    if (!root.classList.contains('booting')) { open(); return; }
    const mo = new MutationObserver(() => {
      if (root.classList.contains('booting')) return;
      mo.disconnect(); setTimeout(open, 150);
    });
    mo.observe(root, { attributes: true, attributeFilter: ['class'] });
  }
}
