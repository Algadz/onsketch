import { Project } from '../core/model.js';
import { isConfigured, openCloud, ConflictError } from '../cloud/cloud.js';

/* =============== ACCOUNT AND CLOUD PROJECTS ====================
   Optional. With app/src/cloud/config.js empty nothing here runs and
   the account button stays hidden.

   The browser copy (persistence.js) stays the working copy. When the
   drawing is linked to a cloud project (cloudLink = { id, revision,
   dirty }, kept in localStorage next to it), every change also marks it
   dirty and pushes it a moment later. Saves are conditional on the
   revision that was loaded, so a save from a stale tab or device is
   refused and the user chooses what to keep. Unsent changes survive a
   reload (dirty flag) and are pushed on the next start.

   supabase-js is only downloaded when someone clicks Sign in, or when
   this browser already holds a session or is coming back from a
   sign-in redirect.
   ============================================================ */
const LINK_KEY = 'onsketch:cloud';
const PUSH_DELAY = 2500;
const AUTH_PARAMS = ['code', 'error', 'error_code', 'error_description'];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function when(iso) {
  const t = new Date(iso);
  const s = (Date.now() - t.getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return t.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: t.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

export class CloudMixin {
  _setupCloud() {
    this.cloud = null;
    this.cloudUser = null;
    this.cloudLink = null;
    this._cloudStatus = '';
    if (!isConfigured()) return;
    this.cloudEnabled = true;
    try { this.cloudLink = JSON.parse(localStorage.getItem(LINK_KEY) || 'null'); } catch { this.cloudLink = null; }

    const btn = document.getElementById('account-btn');
    btn.hidden = false;
    btn.addEventListener('click', () => this.openAccount());
    this._renderAccountButton();
    window.addEventListener('online', () => { if (this.cloudLink?.dirty) this._cloudPushSoon(0); });

    const params = new URLSearchParams(location.search);
    const returning = AUTH_PARAMS.some(k => params.has(k));
    if (returning || this._hasStoredSession() || this.cloudLink) this._ensureCloud();
  }

  _hasStoredSession() {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('sb-') && k.endsWith('-auth-token')) return true;
      }
    } catch { /* storage unavailable */ }
    return false;
  }

  /** Loads supabase-js and the session once; resolves to the Cloud or null (offline). */
  _ensureCloud() {
    if (this._cloudReady) return this._cloudReady;
    this._cloudReady = (async () => {
      try {
        this.cloud = await openCloud({ createClient: window.__onsketchCreateClient || null });
        const user = await this.cloud.user();
        this._cleanAuthParams();
        this.cloud.onUserChange((u) => { if ((u && u.id) !== (this.cloudUser && this.cloudUser.id)) this._setCloudUser(u); });
        this._setCloudUser(user);
        return this.cloud;
      } catch (e) {
        console.warn('cloud unavailable', e);
        this._cloudReady = null;
        this._setCloudStatus(this.cloudLink ? 'offline' : '');
        return null;
      }
    })();
    return this._cloudReady;
  }

  /** Removes ?code=… / ?error=… left by a sign-in redirect; reports errors. */
  _cleanAuthParams() {
    const params = new URLSearchParams(location.search);
    if (!AUTH_PARAMS.some(k => params.has(k))) return;
    const err = params.get('error_description');
    AUTH_PARAMS.forEach(k => params.delete(k));
    history.replaceState(null, '', location.pathname + (params.toString() ? '?' + params : '') + location.hash);
    if (err) this._hint(`Sign-in failed: ${err}`);
  }

  _setCloudUser(user) {
    const was = this.cloudUser;
    this.cloudUser = user;
    this._renderAccountButton();
    if (this.compact) this._refreshMoreMenu?.();
    if (user && !was) {
      if (this._accountOpen) this._renderAccount();
      this._cloudSync();
    }
  }

  /* ---- Link between the drawing and a cloud project ---- */
  _storeLink() {
    try {
      if (this.cloudLink) localStorage.setItem(LINK_KEY, JSON.stringify(this.cloudLink));
      else localStorage.removeItem(LINK_KEY);
    } catch { /* storage unavailable */ }
  }
  _cloudLinkTo(row) {
    this.cloudLink = { id: row.id, revision: row.revision, dirty: false };
    this._storeLink();
    this._setCloudStatus('saved');
  }
  /** The drawing becomes a browser-only one (new, import, example, sign out). */
  _cloudUnlink() {
    if (!this.cloudLink) return;
    clearTimeout(this._cloudTimer);
    this.cloudLink = null;
    this._storeLink();
    this._setCloudStatus('');
  }

  /** Called on every change (from scheduleAutosave). */
  _cloudChanged() {
    if (!this.cloudLink) return;
    if (!this.cloudLink.dirty) { this.cloudLink.dirty = true; this._storeLink(); }
    this._cloudPushSoon(PUSH_DELAY);
  }
  _cloudPushSoon(ms) {
    clearTimeout(this._cloudTimer);
    this._cloudTimer = setTimeout(() => this._cloudPush(), ms);
  }

  async _cloudPush() {
    clearTimeout(this._cloudTimer);
    const link = this.cloudLink;
    if (!link || !link.dirty) return;
    if (this._cloudPushing) { this._cloudPushAgain = true; return; }
    if (!this.cloud || !this.cloudUser) { this._setCloudStatus('offline'); return; }
    this._cloudPushing = true;
    this._setCloudStatus('saving');
    try {
      const row = await this.cloud.save(link.id, this.project.toJSON(), link.revision);
      if (this.cloudLink === link) {
        link.revision = row.revision;
        link.dirty = !!this._cloudPushAgain;
        this._storeLink();
        this._setCloudStatus(link.dirty ? 'saving' : 'saved');
      }
    } catch (e) {
      if (e instanceof ConflictError) { this._setCloudStatus('conflict'); this._showConflict(e.latest); }
      else { console.warn('cloud save failed', e); this._setCloudStatus('offline'); }
    } finally {
      this._cloudPushing = false;
      if (this._cloudPushAgain) { this._cloudPushAgain = false; if (this.cloudLink?.dirty) this._cloudPushSoon(0); }
    }
  }

  /** After sign-in or start: pick up a newer version saved on another
   *  device, or send what this browser hasn't sent yet. */
  async _cloudSync() {
    const link = this.cloudLink;
    if (!link || !this.cloud || !this.cloudUser) return;
    let row;
    try { row = await this.cloud.load(link.id); }
    catch (e) {
      if (e && e.code === 'PGRST116') {          // no such row (deleted, or another account)
        this._cloudUnlink();
        this._hint('This drawing is no longer in your account; it is kept in this browser.');
      } else this._setCloudStatus('offline');
      return;
    }
    if (this.cloudLink !== link) return;
    if (row.revision > link.revision) {
      if (link.dirty) { this._setCloudStatus('conflict'); this._showConflict(row); }
      else { this._openCloudRow(row, { keepUndo: true }); this._hint(`Updated "${row.name}" with the version saved on another device.`); }
    } else if (link.dirty) this._cloudPush();
    else this._setCloudStatus('saved');
  }

  /* ---- Status ---- */
  _setCloudStatus(s) {
    this._cloudStatus = s;
    this._renderAccountButton();
  }
  _renderAccountButton() {
    const btn = document.getElementById('account-btn');
    if (!btn || !this.cloudEnabled) return;
    const u = this.cloudUser;
    const STATUS = { saving: 'Saving…', saved: 'Saved', offline: 'Not synced', conflict: 'Conflict' };
    const status = this.cloudLink ? (STATUS[this._cloudStatus] || '') : '';
    btn.dataset.status = this.cloudLink ? this._cloudStatus : '';
    if (u) {
      const initial = (u.user_metadata?.full_name || u.email || '?').trim()[0].toUpperCase();
      const pic = u.user_metadata?.avatar_url;
      btn.innerHTML = (status ? `<span class="cloud-status">${status}</span>` : '')
        + (pic ? `<img class="avatar" src="${esc(pic)}" alt="" referrerpolicy="no-referrer">` : `<span class="avatar">${esc(initial)}</span>`);
      btn.title = `${u.email || 'Account'}: my projects`;
    } else {
      btn.innerHTML = (status ? `<span class="cloud-status">${status}</span>` : '') + '<span class="btn-label">Sign in</span>';
      btn.title = 'Sign in to keep your projects in the cloud';
    }
    btn.setAttribute('aria-label', btn.title);
  }

  /* ---- Account / projects dialog ---- */
  _accountModal() {
    let back = document.getElementById('account-modal');
    if (back) return back;
    back = document.createElement('div');
    back.className = 'modal-backdrop';
    back.id = 'account-modal';
    back.innerHTML = '<div class="modal account" role="dialog" aria-modal="true"></div>';
    back.addEventListener('pointerdown', (e) => { if (e.target === back && !this._conflictRow) this.closeAccount(); });
    back.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !this._conflictRow) { e.stopPropagation(); this.closeAccount(); } });
    document.body.appendChild(back);
    return back;
  }
  async openAccount() {
    this._accountOpen = true;
    this._signInStep = null;
    this._accountModal().classList.add('show');
    this._renderAccount('Loading…');
    const cloud = await this._ensureCloud();
    if (!this._accountOpen) return;
    if (!cloud) { this._renderAccount("Couldn't reach the server. Check your connection and try again."); return; }
    this._renderAccount();
  }
  closeAccount() {
    this._accountOpen = false;
    this._conflictRow = null;
    document.getElementById('account-modal')?.classList.remove('show');
  }

  _renderAccount(message) {
    const box = this._accountModal().querySelector('.modal');
    if (message) {
      box.innerHTML = `<h3>Account</h3><div class="body"><p class="muted">${esc(message)}</p></div>
        <div class="footer"><button type="button" class="btn" data-a="close">Close</button></div>`;
      box.querySelector('[data-a="close"]').addEventListener('click', () => this.closeAccount());
      return;
    }
    if (this._conflictRow) this._renderConflict(box);
    else if (this.cloudUser) this._renderProjects(box);
    else this._renderSignIn(box);
  }

  _renderSignIn(box) {
    const step = this._signInStep;
    box.innerHTML = `<h3>Sign in to OnSketch</h3>
      <form class="body" novalidate>
        <p class="muted">Keep your projects in your account and open them on any device. Without an account, OnSketch keeps working in this browser.</p>
        ${step ? `
          <p>We sent a link to <b>${esc(step.email)}</b>. Open it on this device, or type the code from the email:</p>
          <input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="123456" />
          <button type="submit" class="btn primary">Sign in</button>
          <button type="button" class="link" data-a="back">Use another email</button>`
        : `
          <button type="button" class="btn oauth" data-a="google">${GOOGLE_ICON}<span>Continue with Google</span></button>
          <div class="or"><span>or</span></div>
          <label for="account-email">Email</label>
          <input type="email" id="account-email" name="email" autocomplete="email" placeholder="you@example.com" />
          <button type="submit" class="btn primary">Email me a sign-in link</button>`}
        <p class="account-msg" role="status"></p>
      </form>
      <div class="footer"><button type="button" class="btn" data-a="close">Cancel</button></div>`;
    const form = box.querySelector('form');
    const msg = box.querySelector('.account-msg');
    const say = (t, err) => { msg.textContent = t; msg.classList.toggle('error', !!err); };
    const busy = (on) => form.querySelectorAll('button, input').forEach(el => el.disabled = on);
    box.querySelector('[data-a="close"]').addEventListener('click', () => this.closeAccount());
    box.querySelector('[data-a="google"]')?.addEventListener('click', async () => {
      busy(true); say('Opening Google…');
      try { await this.cloud.signInWithProvider('google', this._returnURL()); }
      catch (e) { busy(false); say(e.message || "Couldn't start Google sign-in.", true); }
    });
    box.querySelector('[data-a="back"]')?.addEventListener('click', () => { this._signInStep = null; this._renderAccount(); });
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (!step) {
        const email = form.elements.email.value.trim();
        if (!/^\S+@\S+\.\S+$/.test(email)) { say('Enter your email address.', true); form.elements.email.focus(); return; }
        busy(true); say('Sending…');
        try { await this.cloud.signInWithEmail(email, this._returnURL()); this._signInStep = { email }; this._renderAccount(); box.querySelector('input[name="code"]')?.focus(); }
        catch (e) { busy(false); say(e.message || "Couldn't send the email.", true); }
      } else {
        const code = form.elements.code.value.trim();
        if (!/^\d{6,10}$/.test(code)) { say('Enter the code from the email.', true); return; }
        busy(true); say('Signing in…');
        try { const user = await this.cloud.verifyEmailCode(step.email, code); this._signInStep = null; this._setCloudUser(user); this._renderAccount(); }
        catch (e) { busy(false); say(e.message || 'That code didn’t work.', true); }
      }
    });
    (box.querySelector('input[name="code"]') || box.querySelector('input[type="email"]'))?.focus();
  }
  /** Where sign-in redirects come back to: the editor, without parameters. */
  _returnURL() { return location.origin + location.pathname; }

  async _renderProjects(box) {
    const u = this.cloudUser;
    const linked = this.cloudLink;
    box.innerHTML = `<h3>My projects</h3>
      <div class="body">
        <div class="account-who"><span>${esc(u.email || '')}</span><button type="button" class="link" data-a="signout">Sign out</button></div>
        <div class="account-current">${linked
          ? '<span class="muted">This drawing is saved in your account; changes are saved as you work.</span>'
          : '<span class="muted">This drawing is only in this browser.</span><button type="button" class="btn primary" data-a="upload">Save it to my account</button>'}</div>
        <ul class="project-list"><li class="muted">Loading…</li></ul>
        <p class="account-msg" role="status"></p>
      </div>
      <div class="footer"><button type="button" class="btn" data-a="close">Close</button></div>`;
    const msg = box.querySelector('.account-msg');
    const say = (t, err) => { msg.textContent = t; msg.classList.toggle('error', !!err); };
    box.querySelector('[data-a="close"]').addEventListener('click', () => this.closeAccount());
    box.querySelector('[data-a="signout"]').addEventListener('click', () => this.cloudSignOut());
    box.querySelector('[data-a="upload"]')?.addEventListener('click', async (e) => {
      e.target.disabled = true; say('Saving…');
      try { this._cloudLinkTo(await this.cloud.create(this.project.toJSON())); this._renderAccount(); }
      catch (err) { e.target.disabled = false; say(err.message || "Couldn't save.", true); }
    });

    const list = box.querySelector('.project-list');
    let rows;
    try { rows = await this.cloud.list(); }
    catch (e) { list.innerHTML = `<li class="error">${esc(e.message || "Couldn't load your projects.")}</li>`; return; }
    if (!this._accountOpen || !box.contains(list)) return;
    if (!rows.length) { list.innerHTML = '<li class="muted">No projects yet.</li>'; return; }
    list.innerHTML = rows.map(r => `
      <li data-id="${esc(r.id)}"${linked && linked.id === r.id ? ' class="current"' : ''}>
        <span class="name">${esc(r.name)}</span>
        <span class="when">${linked && linked.id === r.id ? 'open now' : esc(when(r.updated_at))}</span>
        <button type="button" class="btn" data-a="open"${linked && linked.id === r.id ? ' disabled' : ''}>Open</button>
        <button type="button" class="btn icon" data-a="delete" title="Delete" aria-label="Delete ${esc(r.name)}">✕</button>
      </li>`).join('');
    list.querySelectorAll('li[data-id]').forEach(li => {
      const row = rows.find(r => r.id === li.dataset.id);
      li.querySelector('[data-a="open"]').addEventListener('click', () => this.openCloudProject(row.id));
      li.querySelector('[data-a="delete"]').addEventListener('click', async () => {
        if (!confirm(`Delete "${row.name}" from your account? This can't be undone.`)) return;
        try {
          await this.cloud.remove(row.id);
          if (this.cloudLink?.id === row.id) this._cloudUnlink();
          this._renderAccount();
        } catch (e) { say(e.message || "Couldn't delete.", true); }
      });
    });
  }

  async openCloudProject(id) {
    const s = this.activeSketch();
    const hasDrawing = s && (s.entities.length || s.strokes.length || s.fills.length);
    if (!this.cloudLink && hasDrawing &&
        !confirm('The drawing open now is only in this browser and will be replaced. Open the project anyway?')) return;
    if (this.cloudLink?.dirty) await this._cloudPush();
    if (this._cloudStatus === 'conflict') return;
    try {
      const row = await this.cloud.load(id);
      this._openCloudRow(row);
      this.closeAccount();
    } catch (e) { alert("Couldn't open the project: " + (e.message || e)); }
  }

  /** Makes `row` the open drawing, linked to it. */
  _openCloudRow(row, { keepUndo = false } = {}) {
    const p = Project.fromJSON(row.data);
    p.name = row.name || p.name;
    this.project = p;
    if (!keepUndo) { this.undoStack.length = 0; this.redoStack.length = 0; }
    this.undoStack.push(JSON.stringify(p.toJSON()));
    this.redoStack.length = 0;
    this.selectionOrder = [];
    if (this.tool && this.tool.activate) this.tool.activate();
    this._cloudLinkTo(row);
    this.refreshUI();
    this.solveAndRender();
    this._primeFillRegions();
    if (!keepUndo) this.zoomFit();
    this._writeLocal();
  }

  async cloudSignOut() {
    this._cloudUnlink();
    try { await this.cloud.signOut(); } catch (e) { console.warn('sign out', e); }
    this._setCloudUser(null);
    this.closeAccount();
    this._hint('Signed out. The drawing stays in this browser.');
  }

  /* ---- Conflicts ---- */
  _showConflict(latest) {
    if (!latest) {          // gone (deleted elsewhere): keep it local
      this._cloudUnlink();
      this._hint('This project was deleted from your account; the drawing is kept in this browser.');
      return;
    }
    this._conflictRow = latest;
    this._accountOpen = true;
    this._accountModal().classList.add('show');
    this._renderAccount();
  }
  _renderConflict(box) {
    const row = this._conflictRow;
    box.innerHTML = `<h3>Changed somewhere else</h3>
      <div class="body">
        <p>"${esc(row.name)}" was saved from another tab or device (${esc(when(row.updated_at))}) after you opened it here. Which version do you want?</p>
        <p class="account-msg" role="status"></p>
      </div>
      <div class="footer">
        <button type="button" class="btn" data-a="theirs">Load the other version</button>
        <button type="button" class="btn" data-a="copy">Keep mine as a copy</button>
        <button type="button" class="btn primary" data-a="mine">Keep mine</button>
      </div>`;
    const msg = box.querySelector('.account-msg');
    const done = () => { this._conflictRow = null; this.closeAccount(); };
    const fail = (e) => { msg.textContent = e.message || 'Something went wrong.'; msg.classList.add('error'); };
    box.querySelector('[data-a="theirs"]').addEventListener('click', async () => {
      try { this._openCloudRow(await this.cloud.load(row.id)); done(); } catch (e) { fail(e); }
    });
    box.querySelector('[data-a="copy"]').addEventListener('click', async () => {
      try {
        const json = this.project.toJSON();
        json.name = `${this.project.name} (copy)`;
        this.project.name = json.name;
        document.getElementById('project-name').value = json.name;
        this._cloudLinkTo(await this.cloud.create(json));
        this._writeLocal();
        done();
      } catch (e) { fail(e); }
    });
    box.querySelector('[data-a="mine"]').addEventListener('click', async () => {
      this.cloudLink.revision = row.revision;       // overwrite the version we just saw
      this.cloudLink.dirty = true;
      this._storeLink();
      done();
      await this._cloudPush();
    });
  }

  _hint(text) {
    const hint = document.getElementById('status-hint');
    if (hint) hint.textContent = text;
  }
}

const GOOGLE_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="#4285F4" d="M22.6 12.2c0-.8-.1-1.5-.2-2.2H12v4.2h5.9a5 5 0 0 1-2.2 3.3v2.7h3.6c2.1-1.9 3.3-4.8 3.3-8z"/><path fill="#34A853" d="M12 23c3 0 5.5-1 7.3-2.7l-3.6-2.7c-1 .7-2.2 1.1-3.7 1.1-2.9 0-5.3-1.9-6.2-4.5H2.1v2.8A11 11 0 0 0 12 23z"/><path fill="#FBBC05" d="M5.8 14.2a6.6 6.6 0 0 1 0-4.3V7.1H2.1a11 11 0 0 0 0 9.9z"/><path fill="#EA4335" d="M12 5.4c1.6 0 3.1.6 4.2 1.7l3.2-3.2A11 11 0 0 0 2.1 7.1l3.7 2.8C6.7 7.3 9.1 5.4 12 5.4z"/></svg>';
