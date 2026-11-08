import { openCloud, isConfigured } from '../cloud/cloud.js';
import { SUPABASE_URL } from '../cloud/config.js';

/* =============== SITE ACCOUNT WIDGET ===========================
   For pages outside the editor (landing page, library): "Sign in"
   when signed out; the avatar with a menu (@username and email, My
   sketches, Library, Open the editor, Sign out) when signed in.

   Signed out visitors download nothing: the stored session is looked
   for in localStorage first. With one, the avatar shows at once from
   it, then supabase-js loads to confirm the session and fetch the
   username. Styles are injected here so any page can use it.

   mountAccount(element, { signInClass, editorHref })
   ============================================================ */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const LINK_KEY = 'onsketch:cloud';

/** The session supabase-js keeps in localStorage, or null. */
function storedSession() {
  try {
    const ref = new URL(SUPABASE_URL).hostname.split('.')[0];
    const raw = localStorage.getItem(`sb-${ref}-auth-token`);
    const s = raw && JSON.parse(raw);
    return s && s.user ? s : null;
  } catch { return null; }
}

export async function mountAccount(el, { signInClass = 'btn', editorHref = '/app/' } = {}) {
  if (!el || !isConfigured()) return;
  injectStyles();
  el.classList.add('site-acc');
  const signedOut = () => {
    const back = encodeURIComponent(location.pathname + location.search);
    el.innerHTML = `<a class="${esc(signInClass)} site-acc-signin" href="/app/?signin&back=${back}">Sign in</a>`;
  };
  const stored = storedSession();
  if (!stored) { signedOut(); return; }

  let user = stored.user, profile = null, cloud = null;
  const render = () => {
    const pic = profile?.avatar_url || user.user_metadata?.avatar_url;
    const initial = (profile?.username || user.email || '?').trim()[0].toUpperCase();
    const avatar = pic ? `<img class="site-acc-avatar" src="${esc(pic)}" alt="" referrerpolicy="no-referrer">` : `<span class="site-acc-avatar">${esc(initial)}</span>`;
    el.innerHTML = `
      <button type="button" class="site-acc-btn" aria-haspopup="menu" aria-expanded="false" title="Your account">${avatar}<span class="site-acc-caret" aria-hidden="true">▾</span></button>
      <div class="site-acc-menu" role="menu" hidden>
        <div class="site-acc-head">${avatar}<div><b>${profile?.username ? '@' + esc(profile.username) : 'Signed in'}</b><span>${esc(user.email || '')}</span></div></div>
        <a role="menuitem" href="/app/projects/">My sketches</a>
        <a role="menuitem" href="/library/">Library</a>
        <a role="menuitem" href="${esc(editorHref)}">Open the editor</a>
        <div class="site-acc-sep"></div>
        <button type="button" role="menuitem" data-a="signout">Sign out</button>
      </div>`;
    const btn = el.querySelector('.site-acc-btn'), menu = el.querySelector('.site-acc-menu');
    const toggle = (open) => { menu.hidden = !open; btn.setAttribute('aria-expanded', open); if (open) menu.querySelector('a')?.focus(); };
    btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(menu.hidden); });
    menu.querySelector('[data-a="signout"]').addEventListener('click', async () => {
      toggle(false);
      try { cloud = cloud || await openCloud(); await cloud.signOut(); } catch { /* signed out locally anyway */ }
      try { localStorage.removeItem(LINK_KEY); } catch { /* storage unavailable */ }
      signedOut();
    });
    el._close = () => toggle(false);
  };
  if (!el._listening) {
    el._listening = true;
    document.addEventListener('pointerdown', (e) => { if (!el.contains(e.target)) el._close?.(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') el._close?.(); });
  }
  render();

  // Confirm the session (it may have expired) and get the username.
  try {
    cloud = await openCloud({ createClient: window.__onsketchCreateClient || null });
    const fresh = await cloud.user();
    if (!fresh) { signedOut(); return; }
    user = fresh;
    profile = await cloud.profile().catch(() => null);
    render();
  } catch { /* offline: keep what the stored session says */ }
}

function injectStyles() {
  if (document.getElementById('site-acc-css')) return;
  const css = document.createElement('style');
  css.id = 'site-acc-css';
  css.textContent = `
  .site-acc { position: relative; display: inline-flex; align-items: center; }
  .site-acc-signin { white-space: nowrap; }
  .site-acc-btn { display: inline-flex; align-items: center; gap: 4px; padding: 3px 6px 3px 3px; border: 1px solid transparent; border-radius: 999px;
    background: none; cursor: pointer; color: inherit; font: inherit; }
  .site-acc-btn:hover, .site-acc-btn[aria-expanded="true"] { border-color: var(--border, #cfd5dd); background: var(--panel-2, #fff); }
  .site-acc-caret { font-size: 10px; color: var(--text-muted, #858f9b); }
  .site-acc-avatar { width: 30px; height: 30px; flex: 0 0 auto; border-radius: 50%; background: #2563a5; color: #fff;
    font-weight: 700; font-size: 13px; display: inline-flex; align-items: center; justify-content: center; object-fit: cover; }
  .site-acc-menu { position: absolute; right: 0; top: calc(100% + 6px); z-index: 50; width: 250px; padding: 6px; display: flex; flex-direction: column;
    background: var(--panel-2, #fff); border: 1px solid var(--border, #cfd5dd); border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,.18); text-align: left; }
  .site-acc-menu[hidden] { display: none; }
  .site-acc-head { display: flex; align-items: center; gap: 10px; padding: 8px 8px 10px; margin-bottom: 4px; border-bottom: 1px solid var(--border-soft, #e4e8ee); }
  .site-acc-head .site-acc-avatar { width: 34px; height: 34px; }
  .site-acc-head div { display: flex; flex-direction: column; min-width: 0; font-size: 14px; color: var(--text, #1b2028); }
  .site-acc-head div b, .site-acc-head div span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .site-acc-head div span { font-size: 12px; color: var(--text-muted, #858f9b); }
  .site-acc-menu a, .site-acc-menu button { display: block; width: 100%; padding: 8px 10px; border: 0; border-radius: 6px; background: none;
    color: var(--text, #1b2028); font: inherit; font-size: 14px; text-align: left; text-decoration: none; cursor: pointer; }
  .site-acc-menu a:hover, .site-acc-menu button:hover, .site-acc-menu a:focus-visible, .site-acc-menu button:focus-visible {
    background: var(--accent-soft, #dce9f7); outline: none; }
  .site-acc-sep { height: 1px; background: var(--border-soft, #e4e8ee); margin: 4px 2px; }`;
  document.head.appendChild(css);
}
