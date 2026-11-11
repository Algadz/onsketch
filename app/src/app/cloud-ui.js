import { Project } from '../core/model.js';
import { isConfigured, openCloud, ConflictError, LimitError, TITLE_MIN } from '../cloud/cloud.js';
import { openDetailsDialog, openProfileDialog } from '../cloud/details-dialog.js';
import { renderThumbnail, thumbnailBlob } from '../render/thumbnail.js';
import { confirmDialog, notice } from '../ui/dialogs.js';

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
const THUMB_EVERY = 30000;        // at most one thumbnail upload per 30 s
const PAGE_PARAMS = ['project', 'view', 'new', 'signin', 'back'];
const BACK_KEY = 'onsketch:back-after-sign-in';   // sessionStorage: page to return to
const PROFILE_ASKED = 'onsketch:profile-asked';   // sessionStorage: "Later" was clicked this session
const PENDING_SAVE = 'onsketch:after-sign-in';   // sessionStorage: 'save' | 'open', survives the sign-in redirect
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
    const open = document.querySelector('#menubar [data-action="open"]');
    if (open) open.hidden = false;
    btn.addEventListener('click', (e) => { e.stopPropagation(); if (this.cloudUser) this.toggleAccountMenu(); else this.openAccount(); });
    this._renderAccountButton();
    window.addEventListener('online', () => { if (this.cloudLink?.dirty) this._cloudPushSoon(0); });

    const params = new URLSearchParams(location.search);
    const returning = AUTH_PARAMS.some(k => params.has(k));
    this._urlRequest = PAGE_PARAMS.find(k => params.has(k)) ? { what: PAGE_PARAMS.find(k => params.has(k)), id: params.get('project') || params.get('view') } : null;
    const back = params.get('back');
    if (back && /^\/(?!\/)[\w\-./?=&%]*$/.test(back)) { try { sessionStorage.setItem(BACK_KEY, back); } catch { /* storage unavailable */ } }
    if (this._urlRequest) {
      PAGE_PARAMS.forEach(k => params.delete(k));
      history.replaceState(null, '', location.pathname + (params.toString() ? '?' + params : '') + location.hash);
    }
    if (this._urlRequest?.what === 'new') { this._urlRequest = null; this._startNewFromPage(); }
    if (returning || this._hasStoredSession() || this.cloudLink || this._urlRequest) this._ensureCloud().then(() => this._handleURLRequest());
  }

  /** /app/?new from My sketches: a fresh drawing. A linked drawing is
   *  already in the account, so it is simply put away. */
  _startNewFromPage() {
    if (!this.cloudLink) { this.newProject(); return; }
    this._cloudUnlink();
    this._skipConfirm = true;
    try { this.newProject(); } finally { this._skipConfirm = false; }
  }
  /** /app/?project=<id> and /app/?signin, once the session is known. */
  async _handleURLRequest() {
    const req = this._urlRequest; this._urlRequest = null;
    if (!req) return;
    if (req.what === 'back') return;
    if (req.what === 'view') { if (this.cloud) await this.openPublicCopy(req.id); else this._hint("Couldn't reach the library. Check your connection."); return; }
    if (!this.cloud || !this.cloudUser) { this.openAccount(); return; }
    if (req.what === 'signin') { this.openAccount(); return; }
    if (req.what === 'project' && req.id && this.cloudLink?.id !== req.id) await this.openCloudProject(req.id);
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
      if (this._accountOpen && !this._conflictRow && !this._openList) this.closeAccount();   // signed in: the dialog's job is done
      else if (this._accountOpen) this._renderAccount();
      this._afterSignIn();
    }
    if (!user) { this.cloudPlan = null; this.cloudProfile = null; this.toggleAccountMenu(false); }
  }
  /** Plan, profile (asks for a username the first time), sync, then what
   *  the user was doing when asked to sign in (Save / Open). */
  async _afterSignIn() {
    this.cloud.plan().then(p => { this.cloudPlan = p; }).catch(() => {});
    this._cloudSync();
    this.cloudProfile = await this.cloud.profile().catch(() => null);
    this._renderAccountButton();
    const pending = this._pending();
    let asked = false;
    try { asked = sessionStorage.getItem(PROFILE_ASKED) === '1'; } catch { /* storage unavailable */ }
    if (!this.cloudProfile?.username && pending !== 'save' && !asked) {
      try { sessionStorage.setItem(PROFILE_ASKED, '1'); } catch { /* storage unavailable */ }
      await this.editProfile({ firstTime: true });
    }
    let back = null;
    try { back = sessionStorage.getItem(BACK_KEY); sessionStorage.removeItem(BACK_KEY); } catch { /* storage unavailable */ }
    if (back && !this._pending()) { location.href = back; return; }
    this._resumePendingSave();
  }

  /** Public username + picture. Resolves to the saved profile or null. */
  async editProfile({ firstTime = false, reason = '' } = {}) {
    this.toggleAccountMenu(false);
    const p = this.cloudProfile;
    const saved = await openProfileDialog({
      username: p?.username || '', picture: await this.cloud.accountPicture(), showPicture: !!p?.avatar_url,
      firstTime, reason, profile: p || {}, checkAvailable: (n) => this.cloud.usernameAvailable(n),
      onSubmit: (v) => this.cloud.saveProfile(v),
    });
    if (saved) {
      this.cloudProfile = saved;
      this._renderAccountButton();
      this._hint(`Your public username is @${saved.username}.`);
    }
    return saved;
  }
  /** Saving publishes (free plan), so a username is needed first. */
  async _ensureUsername() {
    if (!this.cloudProfile) this.cloudProfile = await this.cloud.profile().catch(() => null);
    if (this.cloudProfile?.username) return true;
    const saved = await this.editProfile({ firstTime: true,
      reason: 'Sketches you save on the free plan are public in the library, shown with this username. Choose it before saving. Your email address and your real name are never shown.' });
    return !!saved;
  }

  /* ---- Account menu (avatar, top right) ---- */
  toggleAccountMenu(open) {
    let menu = document.getElementById('account-menu');
    const show = open ?? !(menu && !menu.hidden);
    if (!show) { if (menu) menu.hidden = true; return; }
    if (!this.cloudUser) return;
    if (!menu) {
      menu = document.createElement('div');
      menu.id = 'account-menu'; menu.className = 'account-menu'; menu.setAttribute('role', 'menu');
      document.body.appendChild(menu);
      document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#account-menu, #account-btn')) this.toggleAccountMenu(false); });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) this.toggleAccountMenu(false); });
    }
    const u = this.cloudUser, p = this.cloudProfile;
    const plan = this.cloudPlan;
    menu.innerHTML = `
      <div class="am-head">
        ${this._avatarHTML()}
        <div class="am-who"><b>${p?.username ? '@' + esc(p.username) : 'No public username yet'}</b><span class="muted">${esc(u.email || '')}</span></div>
      </div>
      <div class="am-plan muted">${plan ? (plan.plan === 'premium' ? '<b>OnSketch Pro</b> · unlimited sketches' : `<b>Free plan</b> · up to ${plan.limit} sketches`) : ''}</div>
      <a role="menuitem" class="am-item" href="projects/">My sketches</a>
      <a role="menuitem" class="am-item" href="/library/">Library</a>
      <button type="button" role="menuitem" class="am-item" data-a="profile">${p?.username ? 'Edit public profile…' : 'Choose a username…'}</button>
      ${p?.username ? `<a role="menuitem" class="am-item" href="/library/?u=${encodeURIComponent(p.username)}">View my public profile</a>` : ''}
      ${this.cloudLink ? '<button type="button" role="menuitem" class="am-item" data-a="details">Sketch details…</button>' : ''}
      ${plan?.plan === 'premium'
        ? (plan.hasSubscription ? '<button type="button" role="menuitem" class="am-item" data-a="billing">Manage subscription</button>' : '')
        : '<a role="menuitem" class="am-item am-pro" href="/pricing/">Upgrade to Pro</a>'}
      <div class="am-sep"></div>
      <button type="button" role="menuitem" class="am-item" data-a="signout">Sign out</button>`;
    menu.querySelector('[data-a="profile"]').addEventListener('click', () => this.editProfile());
    menu.querySelector('[data-a="signout"]').addEventListener('click', () => { this.toggleAccountMenu(false); this.cloudSignOut(); });
    menu.querySelector('[data-a="billing"]')?.addEventListener('click', () => { this.toggleAccountMenu(false); this.manageSubscription(); });
    menu.querySelector('[data-a="details"]')?.addEventListener('click', async () => {
      this.toggleAccountMenu(false);
      try { this.editCloudDetails(await this.cloud.load(this.cloudLink.id)); } catch (e) { this._hint("Couldn't load the sketch details."); }
    });
    const r = document.getElementById('account-btn').getBoundingClientRect();
    menu.style.top = `${Math.round(r.bottom + 6)}px`;
    menu.style.right = `${Math.max(8, Math.round(innerWidth - r.right))}px`;
    menu.hidden = false;
    menu.querySelector('.am-item')?.focus();
    if (!plan) this.cloud.plan().then(pl => { this.cloudPlan = pl; if (!menu.hidden) this.toggleAccountMenu(true); }).catch(() => {});
  }
  async manageSubscription() {
    this._hint('Opening your subscription…');
    try { location.href = await this.cloud.billing('portal'); }
    catch (e) { notice(e.message || "Couldn't open the subscription page.", { kind: 'error' }); }
  }
  _avatarHTML() {
    const u = this.cloudUser, p = this.cloudProfile;
    const pic = p?.avatar_url || u?.user_metadata?.avatar_url;
    const initial = (p?.username || u?.email || '?').trim()[0].toUpperCase();
    return pic ? `<img class="avatar" src="${esc(pic)}" alt="" referrerpolicy="no-referrer">` : `<span class="avatar">${esc(initial)}</span>`;
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
    if (!this.cloudLink) { this._renderSaveState(); return; }
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
        this._cloudThumbSoon();
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
    if (this.cloudLink === link && !row.description) this._hint(`Add a description to "${row.name}": account menu → Edit details.`);
  }

  /* ---- Thumbnails ---- */
  _cloudThumbSoon(force = false) {
    if (!this.cloudLink || !this.cloud) return;
    clearTimeout(this._thumbTimer);
    const wait = force ? 0 : Math.max(0, (this._thumbAt || 0) + THUMB_EVERY - Date.now());
    this._thumbTimer = setTimeout(() => this._cloudThumbUpload(), wait);
  }
  async _cloudThumbUpload() {
    const link = this.cloudLink;
    if (!link || !this.cloud || !this.cloudUser) return;
    this._thumbAt = Date.now();
    try { await this.cloud.uploadThumbnail(link.id, await thumbnailBlob(this.project, this.fillDisplay())); }
    catch (e) { console.warn('thumbnail upload failed', e); }
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
    if (u) {
      btn.innerHTML = this._avatarHTML() + '<span class="am-caret" aria-hidden="true">▾</span>';
      btn.title = 'Account: my sketches, library, profile, sign out';
      btn.setAttribute('aria-haspopup', 'menu');
    } else {
      btn.innerHTML = '<span class="btn-label">Sign in</span>';
      btn.title = 'Sign in to save your sketches';
    }
    btn.setAttribute('aria-label', btn.title);
    this._renderSaveState();
  }
  /** The status next to Save: Saved / Saving… / Not synced / Conflict for
   *  a sketch in the account; "Not saved" for a drawing only in this browser. */
  _renderSaveState() {
    const el = document.getElementById('save-state');
    if (!el || !this.cloudEnabled) return;
    const STATUS = { saving: 'Saving…', saved: 'Saved', offline: 'Not synced', conflict: 'Conflict' };
    const s = this.activeSketch?.();
    const empty = !s || (!s.entities.length && !s.strokes.length && !s.fills.length);
    let text = '', state = '';
    if (this.cloudLink) { state = this._cloudStatus || 'saved'; text = STATUS[state] || ''; }
    else if (!empty) { state = 'unsaved'; text = 'Not saved'; }
    el.textContent = text;
    el.dataset.state = state;
    el.title = { saved: 'Saved in your account', saving: 'Saving to your account…', offline: "Couldn't reach the server; changes are kept in this browser and sent later",
      conflict: 'Changed somewhere else', unsaved: 'Only in this browser: Save keeps it in your account' }[state] || '';
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
    if (this.cloudUser) { this.toggleAccountMenu(true); return; }
    this._accountOpen = true;
    this._openList = false;
    this._signInStep = null;
    this._accountModal().classList.add('show');
    this._renderAccount('Loading…');
    const cloud = await this._ensureCloud();
    if (!this._accountOpen) return;
    if (this.cloudUser) { this.closeAccount(); this.toggleAccountMenu(true); return; }
    if (!cloud) { this._renderAccount("Couldn't reach the server. Check your connection and try again."); return; }
    this._renderAccount();
  }
  closeAccount() {
    if (this._accountOpen && !this.cloudUser) { try { sessionStorage.removeItem(PENDING_SAVE); sessionStorage.removeItem(BACK_KEY); } catch { /* storage unavailable */ } }
    this._accountOpen = false;
    this._openList = false;
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
    else if (this.cloudUser && this._openList) this._renderOpen(box);
    else if (!this.cloudUser) this._renderSignIn(box);
    else this.closeAccount();
  }

  _renderSignIn(box) {
    const step = this._signInStep;
    const pending = this._pending();
    const forSave = pending === 'save';
    box.innerHTML = `<h3>${forSave ? 'Sign in to save your sketch' : pending === 'open' ? 'Sign in to open your sketches' : 'Sign in to OnSketch'}</h3>
      <form class="body" novalidate>
        <p class="muted">${forSave || pending === 'open'
          ? 'Saving keeps your sketch in your account, so you can open it on any device. It\'s free.'
          : 'Keep your projects in your account and open them on any device.'}</p>
        ${step ? `
          <p>We sent a link to <b>${esc(step.email)}</b>. Open it on this device, or type the code from the email:</p>
          <input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="Code from the email" />
          <button type="submit" class="btn primary">Sign in</button>
          <button type="button" class="link" data-a="back">Use another email</button>`
        : `
          <button type="button" class="btn oauth" data-a="google">${GOOGLE_ICON}<span>Continue with Google</span></button>
          <div class="or"><span>or</span></div>
          <label for="account-email">Email</label>
          <input type="email" id="account-email" name="email" autocomplete="email" placeholder="you@example.com" />
          <button type="submit" class="btn primary">Email me a sign-in link</button>`}
        <p class="account-msg" role="status"></p>
        <p class="muted">See the <a href="/privacy/" target="_blank" rel="noopener">privacy policy</a>.</p>
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

  /* ---- Save (button, ⋯ menu, Ctrl+S) ---- */
  /** Signed in: saves now (first time: title + description). Signed out:
   *  asks to sign in, then continues with the save. */
  async cloudSave() {
    const cloud = await this._ensureCloud();
    if (!cloud) { this._hint("Couldn't reach the server to save. Check your connection and try again."); return; }
    if (!this.cloudUser) {
      this._setPending('save');
      this.openAccount();
      return;
    }
    if (this.cloudLink) {
      if (this.cloudLink.dirty) await this._cloudPush();
      if (this._cloudStatus === 'saved') this._flashStatus('Saved');
      return;
    }
    await this.saveToAccount();
  }
  _setPending(what) { try { sessionStorage.setItem(PENDING_SAVE, what); } catch { /* storage unavailable */ } }
  /** 'save' | 'open' | null: what to do once signed in. */
  _pending() { try { return sessionStorage.getItem(PENDING_SAVE); } catch { return null; } }
  /** After signing in from Save or Open (also after a Google / email-link redirect). */
  _resumePendingSave() {
    const what = this._pending();
    if (!what) return;
    try { sessionStorage.removeItem(PENDING_SAVE); } catch { /* storage unavailable */ }
    this.closeAccount();
    if (what === 'open') this.openSketch();
    else if (!this.cloudLink) this.saveToAccount();
  }

  /* ---- Open (button, ⋯ menu, Ctrl+O) ---- */
  async openSketch() {
    const cloud = await this._ensureCloud();
    if (!cloud) { this._hint("Couldn't reach the server. Check your connection and try again."); return; }
    if (!this.cloudUser) { this._setPending('open'); this.openAccount(); return; }
    this._accountOpen = true;
    this._openList = true;
    this._accountModal().classList.add('show');
    this._renderAccount();
  }
  async _renderOpen(box) {
    const linked = this.cloudLink;
    box.innerHTML = `<h3>Open a sketch</h3>
      <div class="body">
        <ul class="open-list"><li class="muted">Loading…</li></ul>
        <p class="account-msg" role="status"></p>
      </div>
      <div class="footer">
        <a class="link" href="projects/">Manage in My sketches</a>
        <a class="link" href="/library/">Browse the library</a>
        <span class="spacer"></span>
        <button type="button" class="btn" data-a="close">Cancel</button>
      </div>`;
    box.querySelector('[data-a="close"]').addEventListener('click', () => this.closeAccount());
    const list = box.querySelector('.open-list');
    let rows, thumbs;
    try {
      rows = await this.cloud.list();
      thumbs = await this.cloud.thumbnailURLs(rows).catch(() => new Map());
    } catch (e) { list.innerHTML = `<li class="error">${esc(e.message || "Couldn't load your sketches.")}</li>`; return; }
    if (!box.contains(list)) return;
    if (!rows.length) {
      list.innerHTML = '<li class="open-empty muted">No saved sketches yet. Draw something and click <b>Save</b>: it will be listed here.</li>';
      return;
    }
    list.innerHTML = rows.map(r => {
      const current = linked && linked.id === r.id;
      const t = thumbs.get(r.id);
      return `<li><button type="button" class="open-item${current ? ' current' : ''}" data-id="${esc(r.id)}"${current ? ' aria-current="true"' : ''}>
        <span class="open-thumb">${t ? `<img src="${esc(t)}" alt="" loading="lazy">` : ''}</span>
        <span class="open-text"><b>${esc(r.name)}</b><span class="muted">${esc(r.description || '')}</span></span>
        <span class="open-when muted">${current ? 'open now' : esc(when(r.updated_at))}</span>
      </button></li>`;
    }).join('');
    list.querySelectorAll('.open-item').forEach(b => b.addEventListener('click', () => {
      if (linked && linked.id === b.dataset.id) { this.closeAccount(); return; }
      this.openCloudProject(b.dataset.id);
    }));
    list.querySelector('.open-item')?.focus();
  }

  _flashStatus(text) {
    const pill = document.getElementById('status-solve');
    if (!pill) return;
    const old = pill.textContent;
    pill.textContent = text;
    setTimeout(() => { if (pill.textContent === text) pill.textContent = old; }, 1500);
  }

  /** First save of the open drawing: asks for title + description. */
  async saveToAccount() {
    this.closeAccount();
    const plan = this.cloudPlan || await this.cloud.plan().catch(() => ({ plan: 'free', limit: 3 }));
    if (plan.plan !== 'premium' && !(await this._ensureUsername())) { this._hint('Not saved: a public username is needed to save on the free plan.'); return; }
    const name = (this.project.name || '').trim();
    this.closeAccount();
    const row = await openDetailsDialog({
      heading: 'Save to my account', submitLabel: 'Save', plan: plan.plan,
      name: name.length >= TITLE_MIN && name !== 'Untitled' ? name : '',
      preview: renderThumbnail(this.project, this.fillDisplay(), { width: 320, height: 200, scale: 2 }),
      onSubmit: (details) => this.cloud.create(this.project.toJSON(), details),
    });
    if (!row) return;
    this._setProjectName(row.name);
    this._cloudLinkTo(row);
    this._writeLocal();
    this._cloudThumbSoon(true);
    this._hint(`"${row.name}" is saved in your account.`);
  }

  async editCloudDetails(row) {
    const plan = this.cloudPlan || { plan: 'free' };
    this.closeAccount();
    const updated = await openDetailsDialog({
      heading: 'Sketch details', submitLabel: 'Save', plan: plan.plan,
      name: row.name, description: row.description || '', visibility: row.visibility,
      onSubmit: (details) => this.cloud.updateDetails(row.id, details),
    });
    if (updated && this.cloudLink?.id === updated.id) { this._setProjectName(updated.name); this._writeLocal(); }
  }

  _setProjectName(name) {
    this.project.name = name;
    const field = document.getElementById('project-name');
    if (field) field.value = name;
  }

  async openCloudProject(id) {
    const s = this.activeSketch();
    const hasDrawing = s && (s.entities.length || s.strokes.length || s.fills.length);
    if (!this.cloudLink && hasDrawing && !(await confirmDialog({
      title: 'Replace the current drawing?',
      message: 'The drawing open now isn\'t saved in your account. Opening another sketch replaces it.',
      confirmLabel: 'Open anyway', danger: true }))) return;
    if (this.cloudLink?.dirty) await this._cloudPush();
    if (this._cloudStatus === 'conflict') return;
    try {
      const row = await this.cloud.load(id);
      this._openCloudRow(row);
      this.closeAccount();
    } catch (e) { notice("Couldn't open the sketch: " + (e.message || e), { kind: 'error' }); }
  }

  /** /app/?view=<id> from the library: a public sketch opens as a copy in
   *  this browser (not linked). The previous drawing stays one Undo away,
   *  as with the examples. */
  async openPublicCopy(id) {
    let row;
    try { row = await this.cloud.load(id); }
    catch { this._hint("This sketch isn't public any more, or the link is wrong."); return; }
    try {
      const p = Project.fromJSON(row.data);
      p.name = row.name || p.name;
      this._cloudUnlink();
      this.project = p;
      this.selectionOrder = [];
      if (this.tool && this.tool.activate) this.tool.activate();
      this.commit({ diagnostics: 'sync' });
      this.refreshUI();
      this.zoomFit();
      this._hint(`"${row.name}" from the library, as a copy in this browser. Save to my account to keep it; Ctrl+Z goes back to your previous drawing.`);
    } catch (e) { console.warn('library copy failed', e); this._hint("Couldn't open this sketch."); }
  }

  /** Makes `row` the open drawing, linked to it. */
  _openCloudRow(row, { keepUndo = false } = {}) {
    const p = Project.fromJSON(row.data);
    p.name = row.name || p.name;
    this.project = p;
    if (!keepUndo) { this.undoStack.length = 0; this.redoStack.length = 0; }
    this.undoStack.push(JSON.stringify(p.toJSON({ images: false })));
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
        const name = `${this.project.name} (copy)`.slice(0, 80);
        const created = await this.cloud.create({ ...this.project.toJSON(), name },
          { name, description: row.description || `Copy of ${row.name}.`, visibility: row.visibility });
        this._setProjectName(name);
        this._cloudLinkTo(created);
        this._writeLocal();
        this._cloudThumbSoon(true);
        done();
      } catch (e) {
        fail(e instanceof LimitError ? new Error(`No room for a copy: you've used your ${e.limit} free sketches.`) : e);
      }
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
