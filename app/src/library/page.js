import { openCloud, isConfigured } from '../cloud/cloud.js';
import { mountAccount } from '../site/account.js';
import { countryFlag, countryName } from '../ui/countries.js';
import { promptDialog } from '../ui/dialogs.js';
import { track, trackOnce, trackErrors } from '../ui/analytics.js';

/* =============== PUBLIC LIBRARY (/library/) =====================
   Every public sketch that has a description, newest first, with
   search and "Show more". A card opens a detail view (big preview,
   title, description, dates) whose URL /library/?s=<id> can be shared.
   "Open a copy in the editor" goes to /app/?view=<id>: the sketch opens
   as a browser-only copy the visitor can change and save as their own.
   Works signed out (public rows and their thumbnails are readable by
   anyone; see supabase/migrations/0002_*).
   ============================================================ */
const PAGE = 24;
const REPORT_ENDPOINT = 'https://formspree.io/f/mrppvjjp';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const day = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const PLACEHOLDER = `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M7 23 C 11 9, 15 9, 16 16 S 21 24, 25 9" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><circle cx="7" cy="23" r="2.2" fill="currentColor"/><circle cx="25" cy="9" r="2.2" fill="currentColor"/></svg>`;

class Library {
  constructor() {
    this.rows = []; this.thumbs = new Map(); this.liked = new Set(); this.user = null; this.offset = 0;
    this.query = { search: '', sort: 'new' }; this.seq = 0;
    this.username = new URLSearchParams(location.search).get('u');     // /library/?u=<username>: one person's profile
    this.profile = null;
  }
  /** This page's URL with a detail id (or none), keeping ?u=. */
  urlFor(id) {
    const q = new URLSearchParams();
    if (this.username) q.set('u', this.username);
    if (id) q.set('s', id);
    return location.pathname + (q.toString() ? '?' + q : '');
  }

  async start() {
    if (!isConfigured()) return this.message('The library is not available on this site.');
    try { this.cloud = await openCloud({ createClient: window.__onsketchCreateClient || null }); }
    catch { return this.message("Couldn't reach the server. Check your connection and reload."); }
    this.user = await this.cloud.user().catch(() => null);
    mountAccount($('lib-account'));

    const form = $('lib-search');
    let timer;
    const apply = () => {
      if (form.elements.q.value.trim()) trackOnce('library-search');
      if (form.elements.sort.value !== (this.query.sort || form.elements.sort.options[0]?.value)) track('library-sort', { sort: form.elements.sort.value });
      this.query = { ...this.query, search: form.elements.q.value, sort: form.elements.sort.value }; this.reload();
    };
    form.addEventListener('submit', (e) => { e.preventDefault(); clearTimeout(timer); apply(); });
    form.elements.q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(apply, 300); });
    form.elements.sort.addEventListener('change', apply);
    $('lib-more').addEventListener('click', () => { trackOnce('library-more'); this.more(); });
    window.addEventListener('popstate', () => this.showFromURL());

    if (this.username && !(await this.loadProfile())) return;
    await this.reload();
    this.showFromURL();
  }

  message(html) { const m = $('page-msg'); m.hidden = !html; m.innerHTML = html || ''; }

  /* ---- Profile mode (/library/?u=<username>) ---- */
  async loadProfile() {
    track('library-profile');
    let p = null;
    try { p = await this.cloud.publicProfile(this.username); } catch { p = null; }
    const box = $('lib-profile');
    box.hidden = false;
    document.querySelector('.lib-intro h2').textContent = 'Public sketches';
    document.querySelector('.lib-intro p').hidden = true;
    if (!p) {
      box.innerHTML = `<div class="lp-empty"><h2>No one here</h2><p>There is no OnSketch user called @${esc(this.username)}. <a href="/library/">Browse the whole library</a></p></div>`;
      document.querySelector('.lib-intro').hidden = true;
      this.message('');
      return false;
    }
    this.profile = p;
    this.query.owner = p.user_id;
    document.title = `@${p.username} - OnSketch`;
    const mine = this.user && this.user.id === p.user_id;
    const site = p.website ? p.website.replace(/^https?:\/\//, '').replace(/\/$/, '') : '';
    box.innerHTML = `
      <a class="lp-back" href="/library/">← All sketches</a>
      <div class="lp-card">
        ${p.avatar_url ? `<img class="lp-avatar" src="${esc(p.avatar_url)}" alt="" referrerpolicy="no-referrer">` : `<span class="lp-avatar">${esc(p.username[0].toUpperCase())}</span>`}
        <div class="lp-main">
          <h2>@${esc(p.username)}</h2>
          ${p.bio ? `<p class="lp-bio">${esc(p.bio)}</p>` : ''}
          <p class="lp-facts">
            ${p.country ? `<span>${countryFlag(p.country)} ${esc(countryName(p.country))}</span>` : ''}
            ${site ? `<a href="${esc(p.website)}" rel="nofollow ugc noopener" target="_blank">${esc(site)}</a>` : ''}
            <span>Joined ${esc(new Date(p.joined_at).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }))}</span>
          </p>
        </div>
        <div class="lp-stats">
          <div><b>${p.sketches}</b><span>sketch${p.sketches === 1 ? '' : 'es'}</span></div>
          <div><b>${p.likes}</b><span>thumbs-up</span></div>
        </div>
      </div>
      ${mine ? '<p class="lp-mine muted">This is your public profile. Change it from the account menu → Edit public profile, or on <a href="/app/projects/">My sketches</a>.</p>' : ''}`;
    return true;
  }

  async reload() {
    this.rows = []; this.thumbs = new Map(); this.offset = 0;
    $('grid').innerHTML = '';
    this.message('Loading…');
    await this.more();
  }

  async more() {
    const seq = ++this.seq;
    const btn = $('lib-more');
    btn.disabled = true;
    let res;
    try { res = await this.cloud.library({ ...this.query, offset: this.offset, limit: PAGE }); }
    catch (e) { if (seq === this.seq) this.message(esc(e.message || "Couldn't load the library.")); btn.disabled = false; return; }
    if (seq !== this.seq) return;                 // a newer search started meanwhile
    const [thumbs, liked] = await Promise.all([
      this.cloud.thumbnailURLs(res.rows).catch(() => new Map()),
      this.user ? this.cloud.likedIds(res.rows.map(r => r.id)).catch(() => new Set()) : new Set()]);
    if (seq !== this.seq) return;
    for (const [k, v] of thumbs) this.thumbs.set(k, v);
    for (const id of liked) this.liked.add(id);
    this.rows.push(...res.rows);
    this.offset += res.rows.length;
    btn.hidden = !res.more; btn.disabled = false;
    this.message(this.rows.length ? '' : (this.query.search
      ? `No sketch matches "${esc(this.query.search.trim())}".`
      : this.profile ? `@${esc(this.profile.username)} has no public sketches yet.`
      : 'No public sketches yet. Draw something, sign in and <b>Save to my account</b>: free sketches appear here. <a href="/app/">Open the editor</a>'));
    $('grid').insertAdjacentHTML('beforeend', res.rows.map(r => this.card(r)).join(''));
    $('grid').querySelectorAll('.sketch-card:not([data-ready])').forEach(li => {
      li.dataset.ready = '1';
      li.querySelector('.like-btn').addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); this.toggleLike(li.dataset.id); });
      li.addEventListener('click', (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;   // new tab: follow the link
        if (e.target.closest('a.author-name')) return;                        // to the author's profile
        e.preventDefault();
        this.show(li.dataset.id, true);
      });
    });
  }

  card(r) {
    const thumb = this.thumbs.get(r.id);
    return `<li class="sketch-card lib-card" data-id="${esc(r.id)}">
      <a class="thumb" href="${esc(this.urlFor(r.id))}" aria-label="${esc(r.name)}">
        ${thumb ? `<img src="${esc(thumb)}" alt="" loading="lazy">` : `<span class="thumb-empty">${PLACEHOLDER}</span>`}
      </a>
      <div class="card-body">
        <h2 class="card-title"><a href="${esc(this.urlFor(r.id))}">${esc(r.name)}</a></h2>
        <p class="card-desc">${esc(r.description)}</p>
        <div class="card-meta">${this.author(r)}${this.likeButton(r)}</div>
      </div>
    </li>`;
  }

  author(r, big = false) {
    const pic = r.author_avatar
      ? `<img class="avatar" src="${esc(r.author_avatar)}" alt="" referrerpolicy="no-referrer" loading="lazy">`
      : `<span class="avatar">${esc((r.author_name || '?').trim()[0].toUpperCase())}</span>`;
    const named = r.author_name && r.author_name !== 'OnSketch user';
    const name = named && !this.profile
      ? `<a class="author-name" href="/library/?u=${encodeURIComponent(r.author_name)}" title="@${esc(r.author_name)}: profile and sketches">${esc(r.author_name)}</a>`
      : `<span class="author-name">${esc(r.author_name || 'OnSketch user')}</span>`;
    return `<span class="author${big ? ' big' : ''}">${pic}${name}${big ? '' : ` · ${esc(day(r.created_at || r.updated_at))}`}</span>`;
  }

  likeButton(r) {
    const mine = this.user && r.owner_id === this.user.id;
    const on = this.liked.has(r.id);
    const title = mine ? 'Your sketch' : (this.user ? (on ? 'Remove your thumbs-up' : 'Thumbs up: this is a good sketch') : 'Sign in to give a thumbs-up');
    return `<button type="button" class="like-btn${on ? ' on' : ''}" data-like="${esc(r.id)}" aria-pressed="${on}" title="${title}" aria-label="${title} (${r.likes || 0})"${mine ? ' disabled' : ''}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10v11H3V10zM7 10l4-8c1.7 0 3 1.3 3 3v4h5.5a2 2 0 0 1 2 2.4l-1.4 7A2 2 0 0 1 18.1 21H7"/></svg>
      <span class="like-count">${r.likes || 0}</span></button>`;
  }
  async toggleLike(id) {
    if (!this.user) { track('signin-prompt', { reason: 'like' }); location.href = `/app/?signin&back=${encodeURIComponent(location.pathname + location.search)}`; return; }
    const row = this.rows.find(r => r.id === id) || this._detailRow;
    if (!row || row.owner_id === this.user.id || this._liking) return;
    const was = this.liked.has(id);
    this._liking = true;
    const copies = [...new Set([row, this.rows.find(x => x.id === id)].filter(Boolean))];   // card and detail may be two objects
    const apply = (on) => {
      if (on) this.liked.add(id); else this.liked.delete(id);
      for (const r of copies) r.likes = Math.max(0, (r.likes || 0) + (on ? 1 : -1));
      document.querySelectorAll(`.like-btn[data-like="${CSS.escape(id)}"]`).forEach(b => {
        b.classList.toggle('on', on); b.setAttribute('aria-pressed', on);
        b.querySelector('.like-count').textContent = copies[0].likes;
      });
    };
    apply(!was);
    track('library-like', { on: !was });
    try { if (was) await this.cloud.unlike(id); else await this.cloud.like(id); }
    catch { apply(was); }
    finally { this._liking = false; }
  }

  /* ---- Detail view (/library/?s=<id>) ---- */
  showFromURL() {
    const id = new URLSearchParams(location.search).get('s');
    if (id) this.show(id, false); else this.closeDetail(false);
  }
  async show(id, push) {
    if (push) history.pushState({ s: id }, '', this.urlFor(id));
    let row = this.rows.find(r => r.id === id);
    const back = this.detailBox();
    back.querySelector('.modal').innerHTML = '<div class="body"><p class="muted">Loading…</p></div>';
    if (!row) {
      try { row = await this.cloud.libraryItem(id); } catch { row = null; }
      if (row && !this.thumbs.has(id)) for (const [k, v] of await this.cloud.thumbnailURLs([row]).catch(() => new Map())) this.thumbs.set(k, v);
    }
    if (!row) {
      back.querySelector('.modal').innerHTML = `<h3>Sketch not found</h3><div class="body"><p>This sketch is no longer public, or the link is wrong.</p></div>
        <div class="footer"><button type="button" class="btn" data-a="close">Close</button></div>`;
      back.querySelector('[data-a="close"]').addEventListener('click', () => this.closeDetail(true));
      return;
    }
    this._detailRow = row;
    track('library-view', { id: row.id });
    if (this.user && !this.liked.has(row.id) && !this.rows.includes(row)) {
      for (const lid of await this.cloud.likedIds([row.id]).catch(() => new Set())) this.liked.add(lid);
    }
    document.title = `${row.name} - OnSketch library`;
    const thumb = this.thumbs.get(row.id);
    const link = `${location.origin}/library/?s=${encodeURIComponent(row.id)}`;
    back.querySelector('.modal').innerHTML = `
      <div class="lib-detail-thumb">${thumb ? `<img src="${esc(thumb)}" alt="Preview of ${esc(row.name)}">` : `<span class="thumb-empty">${PLACEHOLDER}<span>No preview yet</span></span>`}</div>
      <div class="body">
        <h3 id="lib-detail-title">${esc(row.name)}</h3>
        <div class="lib-detail-by">${this.author(row, true)}${this.likeButton(row)}</div>
        <p class="lib-detail-desc">${esc(row.description)}</p>
        <p class="muted">Shared ${esc(day(row.created_at || row.updated_at))}${row.updated_at && row.created_at && day(row.updated_at) !== day(row.created_at) ? ` · updated ${esc(day(row.updated_at))}` : ''}</p>
        <p class="account-msg" role="status"></p>
      </div>
      <div class="footer">
        <button type="button" class="link lib-report" data-a="report">Report</button>
        <button type="button" class="btn" data-a="copy">Copy link</button>
        <a class="btn" data-a="insert" href="/app/?insert=${encodeURIComponent(row.id)}" title="Place it inside the sketch you are drawing, at real size, as a part">Insert into my sketch</a>
        <a class="btn primary" href="/app/?view=${encodeURIComponent(row.id)}">Open a copy in the editor</a>
      </div>`;
    const msg = back.querySelector('.account-msg');
    back.querySelector('a.btn.primary').addEventListener('click', () => track('library-open-copy', { id: row.id }));
    back.querySelector('[data-a="insert"]').addEventListener('click', () => track('library-insert', { id: row.id }));
    back.querySelector('[data-a="copy"]').addEventListener('click', async () => {
      track('library-copy-link');
      try { await navigator.clipboard.writeText(link); msg.textContent = 'Link copied.'; }
      catch { msg.textContent = link; }
    });
    back.querySelector('[data-a="report"]').addEventListener('click', () => this.report(row, msg));
    back.querySelector('.like-btn').addEventListener('click', () => this.toggleLike(row.id));
    back.querySelector('a.btn.primary').focus();
  }
  detailBox() {
    let back = $('lib-detail');
    if (back) return back;
    back = document.createElement('div');
    back.className = 'modal-backdrop show';
    back.id = 'lib-detail';
    back.innerHTML = '<div class="modal lib-detail" role="dialog" aria-modal="true" aria-labelledby="lib-detail-title"></div>';
    back.addEventListener('pointerdown', (e) => { if (e.target === back) this.closeDetail(true); });
    document.addEventListener('keydown', this._esc = (e) => { if (e.key === 'Escape') this.closeDetail(true); });
    document.body.appendChild(back);
    return back;
  }
  closeDetail(push) {
    const back = $('lib-detail');
    if (!back) return;
    back.remove();
    document.removeEventListener('keydown', this._esc);
    document.title = this.profile ? `@${this.profile.username} - OnSketch` : 'Sketch library - OnSketch';
    if (push && new URLSearchParams(location.search).has('s')) history.pushState({}, '', this.urlFor(null));
  }
  async report(row, msg) {
    const why = await promptDialog({ title: `Report "${row.name}"`, multiline: true, maxLength: 1000,
      message: 'Tell us what is wrong with this sketch: spam, offensive content, someone else\'s work… We read every report.',
      label: 'Reason', confirmLabel: 'Send report' });
    if (!why) return;
    const data = new FormData();
    data.append('_subject', 'OnSketch library report');
    data.append('message', why.trim());
    data.append('context', `sketch: ${row.id}\ntitle: ${row.name}\npage: ${location.href}`);
    try {
      const res = await fetch(REPORT_ENDPOINT, { method: 'POST', body: data, headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      track('library-report');
      msg.textContent = 'Thanks, we will look at it.';
    } catch { msg.textContent = "Couldn't send the report. Try again later."; }
  }
}

trackErrors('library');
const lib = new Library();
window._library = lib;
lib.start();
