/* =============== LIGHT / DARK ON THE SITE PAGES ================
   Every page (library, My sketches, pricing, about, privacy) uses the
   theme chosen in the editor (☾ / ☀ in its menu bar), saved in this
   browser as onsketch:prefs.theme, else the system's. Each page sets it
   before it paints (a short inline script in its <head>, the same as
   readTheme() here), and mountThemeToggle() puts a ☾ / ☀ button in its
   header: the choice is saved for the editor and the other pages, and
   pages open in other tabs follow it.
   ============================================================ */
const KEY = 'onsketch:prefs';

/** The saved theme, else the system's. */
export function readTheme() {
  try {
    const t = JSON.parse(localStorage.getItem(KEY) || '{}').theme;
    if (t === 'dark' || t === 'light') return t;
  } catch { /* storage unavailable */ }
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  document.querySelectorAll('[data-site-theme]').forEach(paint);
}

/** Saves the theme (keeping the editor's other preferences) and applies it. */
export function setTheme(t) {
  try {
    const prefs = JSON.parse(localStorage.getItem(KEY) || '{}');
    prefs.theme = t;
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch { /* storage unavailable: this page only */ }
  applyTheme(t);
}

const MOON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></svg>';
const SUN = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/></svg>';

function paint(btn) {
  const dark = (document.documentElement.dataset.theme || readTheme()) === 'dark';
  btn.innerHTML = dark ? SUN : MOON;
  btn.title = dark ? 'Light theme' : 'Dark theme';
  btn.setAttribute('aria-label', btn.title);
  btn.setAttribute('aria-pressed', String(dark));
}

/**
 * A ☾ / ☀ button switching the theme, put in `parent` (before `before`).
 * @returns {HTMLButtonElement}
 */
export function mountThemeToggle(parent, before = null) {
  if (!parent) return null;
  applyTheme(readTheme());
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'site-theme';
  b.dataset.siteTheme = '';
  paint(b);
  b.addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
  parent.insertBefore(b, before && before.parentNode === parent ? before : null);
  // Another tab (or the editor) changed it: follow.
  window.addEventListener('storage', (e) => { if (e.key === KEY) applyTheme(readTheme()); });
  return b;
}
