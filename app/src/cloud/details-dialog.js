import { TITLE_MIN, TITLE_MAX, DESC_MIN, DESC_MAX, BIO_MAX, LimitError, cleanText, usernameProblem, profileProblem, normaliseWebsite } from './cloud.js';
import { countries, countryFlag } from '../ui/countries.js';

/* =============== SKETCH DETAILS DIALOG ==========================
   Title + description (+ visibility for Pro) for a cloud project.
   Shared by the editor (first save, Edit details) and My sketches.
   Uses the .modal styles of app/styles.css.

   openDetailsDialog({ heading, submitLabel, name, description,
     visibility, plan, preview, onSubmit }) resolves to whatever
   onSubmit(details) returns, or null if cancelled. When onSubmit
   throws, the message is shown and the dialog stays open.
   ============================================================ */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function openDetailsDialog({ heading = 'Sketch details', submitLabel = 'Save', name = '', description = '', visibility = 'public',
  plan = 'free', preview = null, onSubmit }) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-backdrop show';
    back.id = 'details-modal';
    const premium = plan === 'premium';
    back.innerHTML = `
      <form class="modal account details" role="dialog" aria-modal="true" aria-labelledby="details-heading" novalidate>
        <h3 id="details-heading">${esc(heading)}</h3>
        <div class="body">
          <div class="details-preview" ${preview ? '' : 'hidden'}></div>
          <label for="details-name">Title</label>
          <input type="text" id="details-name" name="name" maxlength="${TITLE_MAX}" autocomplete="off" value="${esc(name)}" placeholder="Standing desk" />
          <label for="details-desc">Description <span class="counter" data-for="description"></span></label>
          <textarea id="details-desc" name="description" maxlength="${DESC_MAX}" rows="3" placeholder="What it is, sizes, materials…">${esc(description)}</textarea>
          ${premium ? `
            <label class="check"><input type="checkbox" name="private" ${visibility === 'private' ? 'checked' : ''} /> Private <span class="muted">(only you can see it)</span></label>`
          : `<p class="muted details-note">Free sketches are <b>public</b>: they appear in the <a href="/library/" target="_blank" rel="noopener">library</a>. <a href="/pricing/" target="_blank" rel="noopener">OnSketch Pro</a> keeps sketches private.</p>`}
          <p class="account-msg" role="status"></p>
        </div>
        <div class="footer">
          <button type="button" class="btn" data-a="cancel">Cancel</button>
          <button type="submit" class="btn primary" data-a="ok">${esc(submitLabel)}</button>
        </div>
      </form>`;
    document.body.appendChild(back);
    const form = back.querySelector('form');
    const msg = back.querySelector('.account-msg');
    const ok = back.querySelector('[data-a="ok"]');
    const counter = back.querySelector('.counter');
    if (preview) {
      const slot = back.querySelector('.details-preview');
      if (typeof preview === 'string') slot.innerHTML = `<img src="${esc(preview)}" alt="">`;
      else slot.appendChild(preview);
    }
    const values = () => ({
      name: cleanText(form.elements.name.value),
      description: cleanText(form.elements.description.value),
      visibility: premium && form.elements.private?.checked ? 'private' : 'public',
    });
    const validate = () => {
      const v = values();
      const n = v.description.length;
      counter.textContent = n < DESC_MIN ? `${n} / ${DESC_MIN} minimum` : `${n} / ${DESC_MAX}`;
      counter.classList.toggle('short', n < DESC_MIN);
      const good = v.name.length >= TITLE_MIN && v.name.length <= TITLE_MAX && n >= DESC_MIN && n <= DESC_MAX;
      ok.disabled = !good;
      return good;
    };
    const close = (value) => { back.remove(); resolve(value); };
    form.addEventListener('input', () => { validate(); msg.textContent = ''; msg.classList.remove('error'); });
    back.querySelector('[data-a="cancel"]').addEventListener('click', () => close(null));
    back.addEventListener('pointerdown', (e) => { if (e.target === back) close(null); });
    back.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } });
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (!validate()) {
        const v = values();
        msg.textContent = v.name.length < TITLE_MIN ? `The title needs at least ${TITLE_MIN} characters.` : `The description needs at least ${DESC_MIN} characters.`;
        msg.classList.add('error');
        return;
      }
      ok.disabled = true;
      msg.classList.remove('error'); msg.textContent = 'Saving…';
      try { close(await onSubmit(values())); }
      catch (e) {
        ok.disabled = false;
        msg.classList.add('error');
        msg.textContent = e instanceof LimitError
          ? `You've used your ${e.limit} free sketches. Delete one on My sketches, or go Pro (onsketch.io/pricing) for unlimited sketches.`
          : (e.message || "Couldn't save.");
      }
    });
    validate();
    (name.length >= TITLE_MIN ? form.elements.description : form.elements.name).focus();
  });
}

/** Public profile: username (unique, checked as you type) and whether the
 *  account picture is shown. `firstTime` words it as the sign-up step.
 *  Resolves to onSubmit's result, or null when cancelled / "Later". */
export function openProfileDialog({ username = '', picture = null, showPicture = false, firstTime = false,
  reason = '', profile = {}, checkAvailable, onSubmit }) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-backdrop show';
    back.id = 'profile-modal';
    back.innerHTML = `
      <form class="modal account profile" role="dialog" aria-modal="true" aria-labelledby="profile-heading" novalidate>
        <h3 id="profile-heading">${firstTime ? 'Choose your public username' : 'Your public profile'}</h3>
        <div class="body">
          <p class="muted">${esc(reason || 'Sketches on the free plan are public: the library shows them with this username. Your email address and your real name are never shown.')}</p>
          <label for="profile-username">Username</label>
          <div class="username-row"><span class="at">@</span><input type="text" id="profile-username" name="username" maxlength="24" autocomplete="username"
            autocapitalize="none" spellcheck="false" value="${esc(username)}" placeholder="e.g. woodshop_tom" /></div>
          <p class="username-hint muted" aria-live="polite">3 to 24 letters, digits, _ . or -</p>
          ${picture ? `<label class="check picture-opt"><input type="checkbox" name="pic" ${showPicture ? 'checked' : ''} />
            <img src="${esc(picture)}" alt="" referrerpolicy="no-referrer"> Show my account picture next to my sketches</label>` : ''}
          ${firstTime ? '' : `
          <label for="profile-bio">About you <span class="muted">(optional)</span> <span class="counter" data-for="bio"></span></label>
          <textarea id="profile-bio" name="bio" rows="3" maxlength="${BIO_MAX}" placeholder="What you sketch, your trade, your projects…">${esc(profile.bio || '')}</textarea>
          <div class="profile-row">
            <div><label for="profile-country">Country <span class="muted">(optional)</span></label>
              <select id="profile-country" name="country"><option value="">Not shown</option>
                ${countries().map(c => `<option value="${c.code}"${c.code === profile.country ? ' selected' : ''}>${countryFlag(c.code)} ${esc(c.name)}</option>`).join('')}
              </select></div>
            <div><label for="profile-website">Website <span class="muted">(optional)</span></label>
              <input type="url" id="profile-website" name="website" maxlength="200" inputmode="url" autocomplete="url" placeholder="example.com" value="${esc(profile.website || '')}" /></div>
          </div>
          <p class="muted profile-public-note">Everything on this form is public, on your profile page and next to your sketches.</p>`}
          <p class="account-msg" role="status"></p>
        </div>
        <div class="footer">
          ${!firstTime && username ? `<a class="link profile-view" href="/library/?u=${encodeURIComponent(username)}" target="_blank" rel="noopener">View my public profile</a><span class="spacer"></span>` : ''}
          <button type="button" class="btn" data-a="cancel">${firstTime ? 'Later' : 'Cancel'}</button>
          <button type="submit" class="btn primary" data-a="ok">${firstTime ? 'Continue' : 'Save'}</button>
        </div>
      </form>`;
    document.body.appendChild(back);
    const form = back.querySelector('form');
    const input = form.elements.username;
    const hint = back.querySelector('.username-hint');
    const msg = back.querySelector('.account-msg');
    const ok = back.querySelector('[data-a="ok"]');
    let seq = 0, timer, available = null;
    const setHint = (text, state) => { hint.textContent = text; hint.dataset.state = state || ''; };
    const check = () => {
      const name = cleanText(input.value);
      const problem = usernameProblem(name);
      available = null;
      if (problem) { setHint(name ? problem : '3 to 24 letters, digits, _ . or -', name ? 'bad' : ''); ok.disabled = true; return; }
      if (name.toLowerCase() === username.toLowerCase() && username) { available = true; setHint('This is your username.', 'good'); ok.disabled = false; return; }
      setHint('Checking…'); ok.disabled = true;
      const mine = ++seq;
      clearTimeout(timer);
      timer = setTimeout(async () => {
        let free;
        try { free = await checkAvailable(name); } catch { free = null; }
        if (mine !== seq) return;
        available = free;
        if (free === false) setHint(`@${name} is taken. Try another one.`, 'bad');
        else setHint(free ? `@${name} is available.` : "Couldn't check right now; it will be checked when you save.", free ? 'good' : '');
        ok.disabled = free === false;
      }, 300);
    };
    const close = (v) => { clearTimeout(timer); back.remove(); resolve(v); };
    input.addEventListener('input', () => { msg.textContent = ''; msg.classList.remove('error'); check(); });
    const bio = form.elements.bio, bioCount = back.querySelector('.counter[data-for="bio"]');
    const countBio = () => { if (bio) bioCount.textContent = `${bio.value.trim().length} / ${BIO_MAX}`; };
    bio?.addEventListener('input', countBio); countBio();
    back.querySelector('[data-a="cancel"]').addEventListener('click', () => close(null));
    back.addEventListener('pointerdown', (e) => { if (e.target === back && !firstTime) close(null); });
    back.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } });
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const name = cleanText(input.value);
      const extra = firstTime ? {} : { bio: bio.value, country: form.elements.country.value, website: form.elements.website.value };
      const problem = usernameProblem(name) || (firstTime ? '' : profileProblem({ ...extra, website: normaliseWebsite(extra.website) }));
      if (problem || available === false) { msg.textContent = problem || 'This username is taken.'; msg.classList.add('error'); return; }
      ok.disabled = true;
      msg.classList.remove('error'); msg.textContent = 'Saving…';
      try { close(await onSubmit({ username: name, showPicture: !!form.elements.pic?.checked, ...extra })); }
      catch (e) { ok.disabled = false; msg.classList.add('error'); msg.textContent = e.message || "Couldn't save."; }
    });
    check();
    input.focus();
    input.select();
  });
}
