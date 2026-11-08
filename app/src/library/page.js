import { openCloud, isConfigured } from '../cloud/cloud.js';

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
  constructor() { this.rows = []; this.thumbs = new Map(); this.offset = 0; this.query = { search: '', sort: 'new' }; this.seq = 0; }

  async start() {
    if (!isConfigured()) return this.message('The library is not available on this site.');
    try { this.cloud = await openCloud({ createClient: window.__onsketchCreateClient || null }); }
    catch { return this.message("Couldn't reach the server. Check your connection and reload."); }
    this.cloud.user().then(u => {
      if (!u) return;
      const a = $('lib-account');
      a.textContent = 'My sketches'; a.href = '/app/projects/';
    }).catch(() => {});

    const form = $('lib-search');
    let timer;
    const apply = () => { this.query = { search: form.elements.q.value, sort: form.elements.sort.value }; this.reload(); };
    form.addEventListener('submit', (e) => { e.preventDefault(); clearTimeout(timer); apply(); });
    form.elements.q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(apply, 300); });
    form.elements.sort.addEventListener('change', apply);
    $('lib-more').addEventListener('click', () => this.more());
    window.addEventListener('popstate', () => this.showFromURL());

    await this.reload();
    this.showFromURL();
  }

  message(html) { const m = $('page-msg'); m.hidden = !html; m.innerHTML = html || ''; }

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
    const thumbs = await this.cloud.thumbnailURLs(res.rows).catch(() => new Map());
    if (seq !== this.seq) return;
    for (const [k, v] of thumbs) this.thumbs.set(k, v);
    this.rows.push(...res.rows);
    this.offset += res.rows.length;
    btn.hidden = !res.more; btn.disabled = false;
    this.message(this.rows.length ? '' : (this.query.search
      ? `No sketch matches "${esc(this.query.search.trim())}".`
      : 'No public sketches yet. Draw something, sign in and <b>Save to my account</b>: free sketches appear here. <a href="/app/">Open the editor</a>'));
    $('grid').insertAdjacentHTML('beforeend', res.rows.map(r => this.card(r)).join(''));
    $('grid').querySelectorAll('.sketch-card:not([data-ready])').forEach(li => {
      li.dataset.ready = '1';
      li.addEventListener('click', (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;   // new tab: follow the link
        e.preventDefault();
        this.show(li.dataset.id, true);
      });
    });
  }

  card(r) {
    const thumb = this.thumbs.get(r.id);
    return `<li class="sketch-card lib-card" data-id="${esc(r.id)}">
      <a class="thumb" href="?s=${encodeURIComponent(r.id)}" aria-label="${esc(r.name)}">
        ${thumb ? `<img src="${esc(thumb)}" alt="" loading="lazy">` : `<span class="thumb-empty">${PLACEHOLDER}</span>`}
      </a>
      <div class="card-body">
        <h2 class="card-title"><a href="?s=${encodeURIComponent(r.id)}">${esc(r.name)}</a></h2>
        <p class="card-desc">${esc(r.description)}</p>
        <div class="card-meta"><span>${esc(day(r.created_at || r.updated_at))}</span></div>
      </div>
    </li>`;
  }

  /* ---- Detail view (/library/?s=<id>) ---- */
  showFromURL() {
    const id = new URLSearchParams(location.search).get('s');
    if (id) this.show(id, false); else this.closeDetail(false);
  }
  async show(id, push) {
    if (push) history.pushState({ s: id }, '', `?s=${encodeURIComponent(id)}`);
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
    document.title = `${row.name} - OnSketch library`;
    const thumb = this.thumbs.get(row.id);
    const link = `${location.origin}/library/?s=${encodeURIComponent(row.id)}`;
    back.querySelector('.modal').innerHTML = `
      <div class="lib-detail-thumb">${thumb ? `<img src="${esc(thumb)}" alt="Preview of ${esc(row.name)}">` : `<span class="thumb-empty">${PLACEHOLDER}<span>No preview yet</span></span>`}</div>
      <div class="body">
        <h3 id="lib-detail-title">${esc(row.name)}</h3>
        <p class="lib-detail-desc">${esc(row.description)}</p>
        <p class="muted">Shared ${esc(day(row.created_at || row.updated_at))}${row.updated_at && row.created_at && day(row.updated_at) !== day(row.created_at) ? ` · updated ${esc(day(row.updated_at))}` : ''}</p>
        <p class="account-msg" role="status"></p>
      </div>
      <div class="footer">
        <button type="button" class="link lib-report" data-a="report">Report</button>
        <button type="button" class="btn" data-a="copy">Copy link</button>
        <a class="btn primary" href="/app/?view=${encodeURIComponent(row.id)}">Open a copy in the editor</a>
      </div>`;
    const msg = back.querySelector('.account-msg');
    back.querySelector('[data-a="copy"]').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(link); msg.textContent = 'Link copied.'; }
      catch { msg.textContent = link; }
    });
    back.querySelector('[data-a="report"]').addEventListener('click', () => this.report(row, msg));
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
    document.title = 'Sketch library - OnSketch';
    if (push && new URLSearchParams(location.search).has('s')) history.pushState({}, '', location.pathname);
  }
  async report(row, msg) {
    const why = prompt(`Report "${row.name}": what's wrong with it? (spam, offensive, someone else's work…)`);
    if (!why || !why.trim()) return;
    const data = new FormData();
    data.append('_subject', 'OnSketch library report');
    data.append('message', why.trim());
    data.append('context', `sketch: ${row.id}\ntitle: ${row.name}\npage: ${location.href}`);
    try {
      const res = await fetch(REPORT_ENDPOINT, { method: 'POST', body: data, headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      msg.textContent = 'Thanks, we will look at it.';
    } catch { msg.textContent = "Couldn't send the report. Try again later."; }
  }
}

const lib = new Library();
window._library = lib;
lib.start();
