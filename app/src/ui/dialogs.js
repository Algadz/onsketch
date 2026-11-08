/* =============== DIALOGS AND NOTICES ===========================
   In-page replacements for the browser's confirm(), alert() and
   prompt(), styled like the rest of the app (.modal in styles.css).

   choose({ title, message, choices: [{ label, value, kind }], cancelValue })
     → Promise<value>. kind: 'primary' | 'danger' | '' (plain).
     Escape or a click outside resolves to cancelValue. The last choice is
     the default (Enter), except that a dangerous one is never focused
     first: the focus starts on Cancel then.
   confirmDialog({ title, message, confirmLabel, danger }) → Promise<boolean>
   alertDialog({ title, message }) → Promise<void>
   promptDialog({ title, message, label, placeholder, multiline, maxLength,
     confirmLabel, required }) → Promise<string | null>
   notice(text, { kind: 'info' | 'error', ms }) → a short message at the
     bottom of the window that fades away (for "select something first"
     style hints that shouldn't block).
   ============================================================ */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function open(html, { onKey, initialFocus } = {}) {
  const back = document.createElement('div');
  back.className = 'modal-backdrop show app-dialog';
  back.innerHTML = html;
  document.body.appendChild(back);
  const previous = document.activeElement;
  const close = () => { back.remove(); if (previous && previous.focus && document.contains(previous)) previous.focus(); };
  back.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {                                     // keep focus inside the dialog
      const f = [...back.querySelectorAll('button, input, textarea, select, a[href]')].filter(x => !x.disabled);
      if (!f.length) return;
      const i = f.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
    }
    e.stopPropagation();                                       // editor shortcuts don't fire behind a dialog
    onKey?.(e);
  });
  (initialFocus ? back.querySelector(initialFocus) : null)?.focus();
  return { back, close };
}

export function choose({ title, message = '', choices, cancelValue = null }) {
  return new Promise((resolve) => {
    const buttons = choices.map((c, i) =>
      `<button type="button" class="btn${c.kind === 'primary' ? ' primary' : c.kind === 'danger' ? ' danger' : ''}" data-i="${i}">${esc(c.label)}</button>`).join('');
    const last = choices[choices.length - 1];
    const cancelIndex = choices.findIndex(c => c.value === cancelValue);
    const focusIndex = last.kind === 'danger' && cancelIndex >= 0 ? cancelIndex : choices.length - 1;
    let done = false;
    const finish = (v) => { if (done) return; done = true; d.close(); resolve(v); };
    const d = open(`
      <div class="modal app-dialog-box" role="alertdialog" aria-modal="true" aria-labelledby="app-dialog-title" aria-describedby="app-dialog-msg">
        <h3 id="app-dialog-title">${esc(title)}</h3>
        ${message ? `<div class="body"><p id="app-dialog-msg">${esc(message)}</p></div>` : ''}
        <div class="footer">${buttons}</div>
      </div>`, {
      initialFocus: `[data-i="${focusIndex}"]`,
      onKey: (e) => { if (e.key === 'Escape') { e.preventDefault(); finish(cancelValue); } },
    });
    d.back.querySelectorAll('[data-i]').forEach(b => b.addEventListener('click', () => finish(choices[+b.dataset.i].value)));
    d.back.addEventListener('pointerdown', (e) => { if (e.target === d.back) finish(cancelValue); });
  });
}

export function confirmDialog({ title, message = '', confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false }) {
  return choose({ title, message, cancelValue: false, choices: [
    { label: cancelLabel, value: false },
    { label: confirmLabel, value: true, kind: danger ? 'danger' : 'primary' },
  ] });
}

export async function alertDialog({ title, message = '', okLabel = 'OK' }) {
  await choose({ title, message, cancelValue: undefined, choices: [{ label: okLabel, value: undefined, kind: 'primary' }] });
}

export function promptDialog({ title, message = '', label = '', placeholder = '', multiline = false, maxLength = 500,
  confirmLabel = 'OK', required = true, value = '' }) {
  return new Promise((resolve) => {
    const field = multiline
      ? `<textarea id="app-dialog-input" rows="4" maxlength="${maxLength}" placeholder="${esc(placeholder)}">${esc(value)}</textarea>`
      : `<input type="text" id="app-dialog-input" maxlength="${maxLength}" placeholder="${esc(placeholder)}" value="${esc(value)}" />`;
    let done = false;
    const finish = (v) => { if (done) return; done = true; d.close(); resolve(v); };
    const d = open(`
      <form class="modal account app-dialog-box" role="dialog" aria-modal="true" aria-labelledby="app-dialog-title" novalidate>
        <h3 id="app-dialog-title">${esc(title)}</h3>
        <div class="body">
          ${message ? `<p class="muted">${esc(message)}</p>` : ''}
          ${label ? `<label for="app-dialog-input">${esc(label)}</label>` : ''}
          ${field}
        </div>
        <div class="footer">
          <button type="button" class="btn" data-a="cancel">Cancel</button>
          <button type="submit" class="btn primary" data-a="ok">${esc(confirmLabel)}</button>
        </div>
      </form>`, {
      initialFocus: '#app-dialog-input',
      onKey: (e) => { if (e.key === 'Escape') { e.preventDefault(); finish(null); } },
    });
    const input = d.back.querySelector('#app-dialog-input');
    const ok = d.back.querySelector('[data-a="ok"]');
    const sync = () => { ok.disabled = required && !input.value.trim(); };
    input.addEventListener('input', sync); sync();
    d.back.querySelector('[data-a="cancel"]').addEventListener('click', () => finish(null));
    d.back.addEventListener('pointerdown', (e) => { if (e.target === d.back) finish(null); });
    d.back.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      if (ok.disabled) return;
      finish(input.value.trim());
    });
  });
}

let noticeTimer = null;
export function notice(text, { kind = 'info', ms = 3500 } = {}) {
  let el = document.getElementById('app-notice');
  if (!el) {
    el = document.createElement('div');
    el.id = 'app-notice';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.dataset.kind = kind;
  el.classList.remove('show'); void el.offsetWidth;            // restart the animation
  el.classList.add('show');
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => el.classList.remove('show'), ms);
}
