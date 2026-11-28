/* =============== "ALLOW <ASSISTANT> TO USE ONSKETCH" ================
   The consent page of OnSketch's OAuth server (/oauth/consent/). When an
   AI assistant (Claude, ChatGPT…) connects to the OnSketch MCP server, it
   sends the user to Supabase Auth, which sends them here with an
   authorization_id. Signed out: sign in first (the editor's sign-in,
   which comes back here). Signed in: show who is asking, and approve or
   deny; Supabase then sends the user back to the assistant.

   Assistants register themselves (dynamic client registration), so the
   name they give is not checked by anyone: the page also shows where the
   user will be sent back to, which is what really identifies them.
   ============================================================ */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hostOf = (u) => { try { return new URL(u).host; } catch { return ''; } };

/** What the page shows for one state. Pure, for tests. */
export function consentView(state) {
  switch (state.kind) {
    case 'missing':
      return { title: 'Nothing to approve', body: '<p>This page is opened by an AI assistant when it asks to use your OnSketch account. Start again from the assistant.</p>' };
    case 'signin':
      return { title: 'Sign in to connect your assistant', body: `<p>An AI assistant is asking to draw sketches in your OnSketch account. Sign in first; you will come back here to allow or refuse it.</p>
        <p class="actions"><a class="btn primary" href="${esc(state.signInUrl)}">Sign in to OnSketch</a></p>` };
    case 'ask': {
      const { client, user, redirect_uri: back } = state.details;
      const name = client?.name || 'An application';
      const host = hostOf(back);
      return { title: `Allow ${esc(name)} to use OnSketch?`, body: `
        <p><strong>${esc(name)}</strong>${client?.uri ? ` (<a href="${esc(client.uri)}" rel="noopener nofollow">${esc(hostOf(client.uri) || client.uri)}</a>)` : ''} wants to use your OnSketch account${user?.email ? `, <strong>${esc(user.email)}</strong>` : ''}.</p>
        <p>It will be able to:</p>
        <ul>
          <li>create sketches in your account,</li>
          <li>read your sketches and change them (earlier versions stay in each sketch's history),</li>
          <li>see the list of your sketches.</li>
        </ul>
        <p>It can't delete sketches, change your profile or plan, or see your payment details.</p>
        ${host ? `<p class="back">After you choose, you go back to <strong>${esc(host)}</strong>. Only allow it if that is the assistant you are using.</p>` : ''}
        <p class="actions"><button class="btn primary" data-act="allow">Allow</button> <button class="btn" data-act="deny">Don't allow</button></p>
        <p class="small">You can disconnect it at any time in the assistant's settings.</p>` };
    }
    case 'error':
      return { title: 'Something went wrong', body: `<p>${esc(state.message)}</p><p>Go back to your assistant and connect OnSketch again.</p>` };
    case 'busy':
      return { title: 'Connecting…', body: '<p>One moment.</p>' };
  }
  return { title: '', body: '' };
}

/** Runs the page. `cloud` is openCloud()'s result (null: not configured). */
export async function startConsent(root, { cloud, location: loc = window.location, go = (u) => { window.location.href = u; } } = {}) {
  const show = (state) => {
    const v = consentView(state);
    root.innerHTML = `<h1>${v.title}</h1>${v.body}`;
  };
  const id = new URLSearchParams(loc.search).get('authorization_id');
  if (!id || !/^[\w-]{1,128}$/.test(id)) return show({ kind: 'missing' });
  if (!cloud) return show({ kind: 'error', message: 'Accounts are not available on this copy of OnSketch.' });
  show({ kind: 'busy' });
  let user = null;
  try { user = await cloud.user(); } catch { /* treated as signed out */ }
  if (!user) {
    const back = `${loc.pathname}?authorization_id=${encodeURIComponent(id)}`;
    return show({ kind: 'signin', signInUrl: `/app/?signin&back=${encodeURIComponent(back)}` });
  }
  const oauth = cloud.client.auth.oauth;
  const { data, error } = await oauth.getAuthorizationDetails(id);
  if (error || !data) return show({ kind: 'error', message: error?.message || 'This request has expired or was already answered.' });
  if (data.redirect_url) return go(data.redirect_url);           // allowed before: straight back
  show({ kind: 'ask', details: data });
  root.addEventListener('click', async (e) => {
    const act = e.target.closest?.('[data-act]')?.dataset.act;
    if (!act) return;
    root.querySelectorAll('button').forEach(b => { b.disabled = true; });
    const r = act === 'allow'
      ? await oauth.approveAuthorization(id, { skipBrowserRedirect: true })
      : await oauth.denyAuthorization(id, { skipBrowserRedirect: true });
    if (r.error || !r.data?.redirect_url) return show({ kind: 'error', message: r.error?.message || 'The answer could not be sent.' });
    go(r.data.redirect_url);
  });
}
