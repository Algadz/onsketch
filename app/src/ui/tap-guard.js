/* =============== TAP-THROUGH GUARD =============================
   On a touch screen the browser sends the click of a tap after the
   finger lifts, to whatever is under it *then*. A control that appears
   because of that same tap (the Delete button after selecting, the
   dimension keypad after tapping a dimension, a long-press menu) would
   take that click: the selection got deleted at once, or the keypad
   opened with a digit already typed.
   armOnPress(el): a click inside `el` only counts when the last press
   (pointerdown, anywhere) started inside `el`. Keyboard activation
   (Enter / Space: click.detail === 0) always counts.
   ============================================================ */
let lastDown = null;
let tracking = false;

export function armOnPress(el) {
  if (!tracking) {
    tracking = true;
    document.addEventListener('pointerdown', (e) => { lastDown = e.target; }, true);
  }
  el.addEventListener('click', (e) => {
    if (e.detail === 0) return;
    if (!(lastDown instanceof Node) || !el.contains(lastDown)) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
  return el;
}
