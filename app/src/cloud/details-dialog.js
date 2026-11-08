import { TITLE_MIN, TITLE_MAX, DESC_MIN, DESC_MAX, LimitError, cleanText } from './cloud.js';

/* =============== SKETCH DETAILS DIALOG ==========================
   Title + description (+ visibility for Premium) for a cloud project.
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
          : `<p class="muted details-note">Free sketches are <b>public</b>: they will appear in the OnSketch library when it opens. Private sketches come with Premium.</p>`}
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
          ? `You've used your ${e.limit} free sketches. Delete one on My sketches, or go Premium for unlimited sketches.`
          : (e.message || "Couldn't save.");
      }
    });
    validate();
    (name.length >= TITLE_MIN ? form.elements.description : form.elements.name).focus();
  });
}
