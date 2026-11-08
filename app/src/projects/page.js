import { openCloud, isConfigured, LimitError } from '../cloud/cloud.js';
import { openDetailsDialog, openProfileDialog } from '../cloud/details-dialog.js';
import { confirmDialog, notice } from '../ui/dialogs.js';

/* =============== MY SKETCHES (/app/projects/) ==================
   The signed-in user's cloud projects as cards: preview, title,
   description, last change, visibility. Open goes to the editor
   (/app/?project=<id>); New to /app/?new. Free plan: a usage meter and,
   at the limit, an upgrade card instead of New.
   ============================================================ */
const LINK_KEY = 'onsketch:cloud';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function when(iso) {
  const t = new Date(iso);
  const s = (Date.now() - t.getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} day${s < 86400 * 1.5 ? '' : 's'} ago`;
  return t.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: t.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}
const linkedId = () => { try { return JSON.parse(localStorage.getItem(LINK_KEY) || 'null')?.id || null; } catch { return null; } };

const PLACEHOLDER = `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M7 23 C 11 9, 15 9, 16 16 S 21 24, 25 9" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><circle cx="7" cy="23" r="2.2" fill="currentColor"/><circle cx="25" cy="9" r="2.2" fill="currentColor"/></svg>`;

class Page {
  async start() {
    if (!isConfigured()) return this.message('Accounts are not enabled on this site.');
    try { this.cloud = await openCloud({ createClient: window.__onsketchCreateClient || null }); }
    catch { return this.message("Couldn't reach the server. Check your connection and reload."); }
    this.user = await this.cloud.user().catch(() => null);
    if (!this.user) return this.signedOut();
    this.renderAccount();
    document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.card-menu, .menu-btn')) this.closeMenus(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.closeMenus(); });
    await this.load();
  }

  message(html) { const m = $('page-msg'); m.hidden = !html; m.innerHTML = html || ''; }

  signedOut() {
    this.message('');
    $('grid').innerHTML = `
      <li class="empty-state">
        <div class="empty-mark">${PLACEHOLDER}</div>
        <h2>Sign in to see your sketches</h2>
        <p>Keep your sketches in your account and open them on any device.</p>
        <a class="btn primary" href="../?signin">Sign in</a>
      </li>`;
  }

  renderAccount() {
    const u = this.user;
    const box = $('page-account');
    const pic = u.user_metadata?.avatar_url;
    const initial = (u.user_metadata?.full_name || u.email || '?').trim()[0].toUpperCase();
    box.hidden = false;
    box.innerHTML = `${pic ? `<img class="avatar" src="${esc(pic)}" alt="" referrerpolicy="no-referrer">` : `<span class="avatar">${esc(initial)}</span>`}
      <span class="who">${esc(u.email || '')}</span>
      <button type="button" class="link" data-a="signout">Sign out</button>`;
    box.querySelector('[data-a="signout"]').addEventListener('click', async () => {
      try { await this.cloud.signOut(); } catch { /* signed out anyway */ }
      try { localStorage.removeItem(LINK_KEY); } catch { /* storage unavailable */ }
      location.href = '../';
    });
  }

  async load() {
    try {
      [this.rows, this.plan, this.profile] = await Promise.all([this.cloud.list(), this.cloud.plan(), this.cloud.profile().catch(() => null)]);
    } catch (e) { return this.message(esc(e.message || "Couldn't load your sketches.")); }
    this.message('');
    [this.thumbs, this.likes] = await Promise.all([
      this.cloud.thumbnailURLs(this.rows).catch(() => new Map()),
      this.cloud.likeCounts(this.rows.filter(r => r.visibility === 'public').map(r => r.id)).catch(() => new Map())]);
    this.render();
  }

  full() { return this.plan.limit != null && this.rows.length >= this.plan.limit; }

  render() {
    const { plan, limit } = this.plan, used = this.rows.length;
    const usage = $('usage');
    usage.hidden = false;
    if (plan === 'premium') {
      usage.innerHTML = `<span><b>OnSketch Pro</b> · ${used} sketch${used === 1 ? '' : 'es'} · unlimited, private allowed</span>
        ${this.plan.hasSubscription ? '<button type="button" class="link" data-a="billing">Manage subscription</button>' : ''}`;
      usage.querySelector('[data-a="billing"]')?.addEventListener('click', (e) => this.manageSubscription(e.currentTarget));
    }
    else {
      const pct = Math.min(100, Math.round(used / limit * 100));
      usage.innerHTML = `<span><b>Free plan</b> · ${used} of ${limit} sketches used</span>
        <span class="meter${used >= limit ? ' full' : ''}" role="meter" aria-valuemin="0" aria-valuemax="${limit}" aria-valuenow="${used}" aria-label="Sketches used"><span style="width:${pct}%"></span></span>
        <a class="link" href="/pricing/">Upgrade to Pro →</a>`;
    }
    usage.insertAdjacentHTML('beforeend', this.profile?.username
      ? `<span class="usage-name">Shown in the <a href="/library/">library</a> as <a href="/library/?u=${encodeURIComponent(this.profile.username)}"><b>@${esc(this.profile.username)}</b></a> <button type="button" class="link" data-a="name">Edit profile</button></span>`
      : `<span class="usage-name">No public username yet <button type="button" class="link" data-a="name">Choose one</button></span>`);
    usage.querySelector('[data-a="name"]').addEventListener('click', () => this.editName());

    const open = linkedId();
    const cards = this.rows.map(r => {
      const thumb = this.thumbs.get(r.id);
      return `<li class="sketch-card" data-id="${esc(r.id)}">
        <a class="thumb" href="../?project=${encodeURIComponent(r.id)}" aria-label="Open ${esc(r.name)}">
          ${thumb ? `<img src="${esc(thumb)}" alt="" loading="lazy">` : `<span class="thumb-empty">${PLACEHOLDER}<span>Preview after the next save</span></span>`}
          ${r.id === open ? '<span class="tag open">Open in editor</span>' : ''}
        </a>
        <div class="card-body">
          <div class="card-title-row">
            <h2 class="card-title"><a href="../?project=${encodeURIComponent(r.id)}">${esc(r.name)}</a></h2>
            <button type="button" class="menu-btn" aria-label="More actions for ${esc(r.name)}" aria-haspopup="menu">⋯</button>
          </div>
          <p class="card-desc">${r.description ? esc(r.description) : '<span class="missing">No description yet. <button type="button" class="link" data-a="details">Add one</button></span>'}</p>
          <div class="card-meta">
            <span>${esc(when(r.updated_at))}</span>
            <span class="card-tags">${r.visibility === 'public' && this.likes?.has(r.id) ? `<span class="likes-pill" title="Thumbs-up in the library">👍 ${this.likes.get(r.id)}</span>` : ''}<span class="tag ${r.visibility === 'private' ? 'private' : 'public'}">${r.visibility === 'private' ? '🔒 Private' : 'Public'}</span></span>
          </div>
        </div>
      </li>`;
    });
    const remaining = this.plan.limit == null ? null : this.plan.limit - used;
    cards.push(this.full()
      ? `<li class="sketch-card upsell">
          <h2>You've used your ${limit} free sketches</h2>
          <p>Delete one to make room, or go Pro for unlimited and private sketches.</p>
          <a class="btn primary" href="/pricing/">See OnSketch Pro</a>
        </li>`
      : `<li class="sketch-card new">
          <a href="../?new"><span class="plus">+</span><b>New sketch</b>${remaining != null ? `<span class="muted">${remaining} left on the free plan</span>` : ''}</a>
        </li>`);
    if (!this.rows.length) cards.unshift(`<li class="empty-state wide"><h2>No sketches yet</h2><p>Draw something in the editor, then <b>Save to my account</b> from the account button. Or start from an example.</p><a class="btn" href="../?example=desk">Open the desk example</a></li>`);
    $('grid').innerHTML = cards.join('');

    $('grid').querySelectorAll('[data-a="upgrade"]').forEach(b => b.addEventListener('click', () => this.upgrade()));
    $('grid').querySelectorAll('.sketch-card[data-id]').forEach(li => {
      const row = this.rows.find(r => r.id === li.dataset.id);
      li.querySelector('.menu-btn').addEventListener('click', (e) => { e.stopPropagation(); this.openMenu(li, row); });
      li.querySelector('[data-a="details"]')?.addEventListener('click', () => this.editDetails(row));
    });
  }

  closeMenus() { document.querySelectorAll('.card-menu').forEach(m => m.remove()); }
  openMenu(li, row) {
    const wasOpen = li.querySelector('.card-menu');
    this.closeMenus();
    if (wasOpen) return;
    const m = document.createElement('div');
    m.className = 'card-menu'; m.setAttribute('role', 'menu');
    const pro = this.plan.plan === 'premium';
    const items = [['open', 'Open'], ['details', 'Edit details'],
      row.visibility === 'private' ? ['public', 'Make public'] : (pro ? ['private', 'Make private'] : ['private-pro', 'Make private (Pro)']),
      ['duplicate', 'Duplicate'], ['download', 'Download JSON'], ['delete', 'Delete']];
    m.innerHTML = items.map(([a, t]) => `<button type="button" role="menuitem" data-a="${a}"${a === 'delete' ? ' class="danger"' : ''}>${t}</button>`).join('');
    li.querySelector('.card-title-row').appendChild(m);
    m.querySelector('button').focus();
    m.addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return;
      this.closeMenus();
      if (a === 'open') location.href = `../?project=${encodeURIComponent(row.id)}`;
      else if (a === 'details') this.editDetails(row);
      else if (a === 'duplicate') this.duplicate(row);
      else if (a === 'download') this.download(row);
      else if (a === 'delete') this.remove(row);
      else if (a === 'public') this.setVisibility(row, 'public');
      else if (a === 'private') this.setVisibility(row, 'private');
      else if (a === 'private-pro') this.upgrade();
    });
  }

  async editName() {
    const saved = await openProfileDialog({
      username: this.profile?.username || '', picture: await this.cloud.accountPicture(), showPicture: !!this.profile?.avatar_url,
      firstTime: !this.profile?.username, profile: this.profile || {}, checkAvailable: (n) => this.cloud.usernameAvailable(n),
      onSubmit: (v) => this.cloud.saveProfile(v),
    });
    if (saved) { this.profile = saved; this.render(); }
  }
  async editDetails(row) {
    const thumb = this.thumbs.get(row.id);
    const updated = await openDetailsDialog({
      heading: 'Sketch details', submitLabel: 'Save', plan: this.plan.plan,
      name: row.name, description: row.description || '', visibility: row.visibility, preview: thumb || null,
      onSubmit: (d) => this.cloud.updateDetails(row.id, d),
    });
    if (updated) { Object.assign(row, updated); this.render(); }
  }
  async duplicate(row) {
    if (this.full()) return this.upgrade();
    try { await this.cloud.duplicate(row.id); await this.load(); }
    catch (e) { if (e instanceof LimitError) this.upgrade(); else notice("Couldn't duplicate: " + (e.message || e), { kind: 'error' }); }
  }
  async download(row) {
    try {
      const full = await this.cloud.load(row.id);
      const blob = new Blob([JSON.stringify(full.data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${row.name.replace(/[^\w\- ]+/g, '').trim() || 'sketch'}.onsketch.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (e) { notice("Couldn't download: " + (e.message || e), { kind: 'error' }); }
  }
  async remove(row) {
    if (!(await confirmDialog({ title: `Delete "${row.name}"?`,
      message: 'It will be removed from your account and from the library. This can\'t be undone.',
      confirmLabel: 'Delete', danger: true }))) return;
    try {
      await this.cloud.remove(row.id);
      if (linkedId() === row.id) { try { localStorage.removeItem(LINK_KEY); } catch { /* storage unavailable */ } }
      await this.load();
    } catch (e) { notice("Couldn't delete: " + (e.message || e), { kind: 'error' }); }
  }
  /** Free plan full (or a Pro feature): to the pricing page. */
  upgrade() { location.href = '/pricing/'; }
  async manageSubscription(btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Opening…'; }
    try { location.href = await this.cloud.billing('portal'); }
    catch (e) { notice(e.message || "Couldn't open the subscription page.", { kind: 'error' }); if (btn) { btn.disabled = false; btn.textContent = 'Manage subscription'; } }
  }
  async setVisibility(row, visibility) {
    try { await this.cloud.setVisibility(row.id, visibility); row.visibility = visibility; this.render();
      notice(visibility === 'private' ? `"${row.name}" is private: only you can see it.` : `"${row.name}" is public: it appears in the library.`); }
    catch (e) { notice(e.message || "Couldn't change it.", { kind: 'error' }); }
  }

}

const page = new Page();
window._page = page;
page.start();
