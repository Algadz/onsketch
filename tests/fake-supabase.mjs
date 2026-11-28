// In-page fake of supabase-js for the end-to-end tests (no network):
// pass installFake to context.addInitScript. Rows live in localStorage,
// so a second tab (or a reload) sees the same "server". It mirrors the
// rules of supabase/migrations (free limit, likes, library view, version
// history and remixes of 0009) closely enough for the editor's flows.
export function installFake() {
  const DB = 'fake-sb:rows', SES = 'fake-sb:session';
  const listeners = new Set();
  const session = () => JSON.parse(localStorage.getItem(SES) || 'null');
  const SB_KEY = 'sb-rwmzpzaqijgdfsjmpqbd-auth-token';   // where the real supabase-js keeps the session
  const setSession = (s) => { if (s) { localStorage.setItem(SES, JSON.stringify(s)); localStorage.setItem(SB_KEY, JSON.stringify(s)); } else { localStorage.removeItem(SES); localStorage.removeItem(SB_KEY); } listeners.forEach(cb => cb(s ? 'SIGNED_IN' : 'SIGNED_OUT', s)); };
  window.__fakeSent = [];
  // Version history (migration 0009): a version is kept when a save changes
  // the drawing and the newest one is older than the gap (10 min; tests
  // set fake-sb:version-gap to 0 to get one per save).
  const LS = (k) => JSON.parse(localStorage.getItem(k) || '[]');
  const SS = (k, v) => localStorage.setItem(k, JSON.stringify(v));
  const VKEY = 'fake-sb:t:project_versions';
  const isPro = (uid) => LS('fake-sb:t:account_plans').some(r => r.user_id === uid && r.plan === 'premium');
  const prune = (pid) => {
    const p = LS('fake-sb:rows').find(r => r.id === pid);
    if (!p || isPro(p.owner_id)) return;
    const all = LS(VKEY);
    const auto = all.filter(v => v.project_id === pid && v.kind !== 'named').sort((a, b) => b.saved_at.localeCompare(a.saved_at) || b.id - a.id);
    const drop = new Set(auto.slice(3).map(v => v.id));
    SS(VKEY, all.filter(v => !drop.has(v.id)));
  };
  const addVersion = (p, kind, extra = {}) => {
    const all = LS(VKEY);
    const id = (all.reduce((m, v) => Math.max(m, v.id), 0) || 0) + 1;
    const v = { id, project_id: p.id, owner_id: p.owner_id, saved_at: p.updated_at, created_at: new Date().toISOString(), kind, name: null, note: null, data: p.data, ...extra };
    all.push(v); SS(VKEY, all);
    return v;
  };
  const keepVersion = (old) => {
    const gap = +(localStorage.getItem('fake-sb:version-gap') ?? 600000);
    const recent = LS(VKEY).some(v => v.project_id === old.id && Date.now() - Date.parse(v.created_at) < gap);
    if (!recent) { addVersion(old, 'auto'); prune(old.id); }
  };
  window.__onsketchCreateClient = () => ({
    auth: {
      getSession: async () => ({ data: { session: session() }, error: null }),
      onAuthStateChange: (cb) => { listeners.add(cb); return { data: { subscription: { unsubscribe: () => listeners.delete(cb) } } }; },
      signInWithOtp: async ({ email }) => { window.__fakeSent.push(email); return { error: null }; },
      verifyOtp: async ({ email, token }) => {
        if (token !== '123456') return { data: {}, error: new Error('Token has expired or is invalid') };
        const s = { user: { id: email === 'me@example.com' ? 'u1' : 'u-' + email.split('@')[0], email } }; setSession(s); return { data: { user: s.user, session: s }, error: null };
      },
      signInWithOAuth: async () => ({ error: null }),
      // OAuth 2.1 server (the consent page, /oauth/consent/). Authorization
      // "seen" was approved before; anything else asks Claude-like consent.
      oauth: {
        getAuthorizationDetails: async (id) => {
          window.__oauthCalls = [...(window.__oauthCalls || []), ['details', id]];
          if (!session()) return { data: null, error: new Error('Unauthorized') };
          if (id === 'seen') return { data: { redirect_url: 'https://assistant.test/cb?code=again' }, error: null };
          if (id === 'gone') return { data: null, error: new Error('Authorization not found') };
          return { data: { authorization_id: id, redirect_uri: 'https://assistant.test/cb', scope: 'openid email profile',
            client: { id: 'c1', name: 'Claude <b>', uri: 'https://assistant.test', logo_uri: '' }, user: { id: session().user.id, email: session().user.email } }, error: null };
        },
        approveAuthorization: async (id, opts) => { window.__oauthCalls.push(['approve', id, opts]); return { data: { redirect_url: 'https://assistant.test/cb?code=xyz' }, error: null }; },
        denyAuthorization: async (id, opts) => { window.__oauthCalls.push(['deny', id, opts]); return { data: { redirect_url: 'https://assistant.test/cb?error=access_denied' }, error: null }; },
      },
      signOut: async () => { setSession(null); return { error: null }; },
    },
    functions: { invoke: async (name, { body }) => {
      window.__billingCalls = [...(window.__billingCalls || []), { name, body }];
      if (name !== 'billing' || !session()) return { data: null, error: new Error('Unauthorized') };
      if (body.action === 'checkout') return { data: { url: `https://checkout.stripe.test/c/${body.interval}?user=${session().user.id}` }, error: null };
      if (body.action === 'portal') return { data: { url: 'https://billing.stripe.test/p' }, error: null };
      return { data: null, error: new Error('Unknown action') };
    } },
    rpc: async (fn, args) => {
      const uid = session()?.user?.id;
      const err = (message, code = 'P0001') => ({ data: null, error: Object.assign(new Error(message), { code }) });
      if (localStorage.getItem('fake-sb:no-history') === '1' && /_version$/.test(fn)) return err('Could not find the function', 'PGRST202');
      if (fn === 'save_version') {
        const p = LS('fake-sb:rows').find(r => r.id === args.pid && r.owner_id === uid);
        if (!p) return err('OnSketch: this sketch is not in your account.');
        if (!isPro(uid)) return err('OnSketch: named versions are an OnSketch Pro feature.');
        if (!args.vname) return err('OnSketch: a version name has 1 to 80 characters.');
        return { data: [addVersion(p, 'named', { name: args.vname, note: args.vnote || null })], error: null };
      }
      if (fn === 'name_version') {
        const all = LS(VKEY); const v = all.find(x => x.id === args.vid && x.owner_id === uid);
        if (!v) return err('OnSketch: no such version.');
        if (!isPro(uid)) return err('OnSketch: named versions are an OnSketch Pro feature.');
        Object.assign(v, args.vname ? { name: args.vname, note: args.vnote || null, kind: 'named' } : { name: null, note: null, kind: 'auto' });
        SS(VKEY, all); return { data: [v], error: null };
      }
      if (fn === 'restore_version') {
        const v = LS(VKEY).find(x => x.id === args.vid && x.owner_id === uid);
        if (!v) return err('OnSketch: no such version.');
        const rows = LS('fake-sb:rows'); const p = rows.find(r => r.id === v.project_id);
        addVersion(p, 'restore');
        Object.assign(p, { data: { ...v.data, name: p.name }, revision: p.revision + 1, updated_at: new Date().toISOString() });
        SS('fake-sb:rows', rows); prune(p.id);
        return { data: p.revision, error: null };
      }
      if (fn === 'public_profile') {
        const L = (k) => JSON.parse(localStorage.getItem(k) || '[]');
        const p = L('fake-sb:t:public_profiles').find(x => x.username && x.username.toLowerCase() === args.name.toLowerCase());
        if (!p) return { data: [], error: null };
        const mine = L('fake-sb:rows').filter(r => r.owner_id === p.user_id && r.visibility === 'public' && r.description != null);
        const likes = L('fake-sb:t:project_likes').filter(l => mine.some(r => r.id === l.project_id)).length;
        return { data: [{ user_id: p.user_id, username: p.username, avatar_url: p.avatar_url || null, bio: p.bio || null, country: p.country || null,
          website: p.website || null, joined_at: '2026-11-01T00:00:00Z', sketches: mine.length, likes }], error: null };
      }
      // The database after migration 0007 (free sketches may be private): opt-in per test.
      if (fn === 'plan_rules' && localStorage.getItem('fake-sb:free-private') === '1') return { data: { free_private: true, free_limit: 3 }, error: null };
      if (fn !== 'username_available') return { data: null, error: new Error('no such function') };
      const me = session()?.user?.id;
      const taken = JSON.parse(localStorage.getItem('fake-sb:t:public_profiles') || '[]')
        .some(p => p.username && p.username.toLowerCase() === args.name.toLowerCase() && p.user_id !== me);
      return { data: !taken, error: null };
    },
    storage: { from: () => ({
      upload: async (path, blob) => {
        const url = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
        const files = JSON.parse(localStorage.getItem('fake-sb:files') || '{}'); files[path] = url;
        localStorage.setItem('fake-sb:files', JSON.stringify(files)); window.__fakeUploads = (window.__fakeUploads || 0) + 1;
        return { data: { path }, error: null };
      },
      remove: async (paths) => { const files = JSON.parse(localStorage.getItem('fake-sb:files') || '{}'); paths.forEach(p => delete files[p]); localStorage.setItem('fake-sb:files', JSON.stringify(files)); return { error: null }; },
      copy: async (a, b) => { const files = JSON.parse(localStorage.getItem('fake-sb:files') || '{}'); if (files[a]) files[b] = files[a]; localStorage.setItem('fake-sb:files', JSON.stringify(files)); return { error: null }; },
      createSignedUrls: async (paths) => { const files = JSON.parse(localStorage.getItem('fake-sb:files') || '{}'); return { data: paths.map(p => files[p] ? { path: p, signedUrl: files[p] } : { path: p, error: 'not found', signedUrl: null }), error: null }; },
    }) },
    from: (table) => {
      const q = { f: [], op: 'select', p: null, single: false, table };
      const KEY = table === 'projects' ? DB : 'fake-sb:t:' + table;
      const load = (k) => JSON.parse(localStorage.getItem(k) || '[]');
      const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));
      const me = () => session()?.user?.id || null;
      const m = r => q.f.every(([k, v]) => r[k] === v) && (q.ins || []).every(([k, vs]) => vs.includes(r[k]))
        && (q.notNull || []).every(k => r[k] != null)
        && (!q.text || [r.name, r.description].some(t => (t || '').toLowerCase().includes(q.text)));
      const fail = (message, code) => ({ data: null, error: Object.assign(new Error(message), { code }) });
      const finish = (out) => {
        out = JSON.parse(JSON.stringify(out));
        if (q.maybe) return { data: out[0] || null, error: null };
        if (q.single) return out.length === 1 ? { data: out[0], error: null } : fail('not found', 'PGRST116');
        return { data: out, error: null };
      };
      const run = () => {
        if (table === 'account_plans') return finish(load('fake-sb:t:account_plans').filter(m));
        if (table === 'project_versions') {
          if (localStorage.getItem('fake-sb:no-history') === '1') return fail('relation "public.project_versions" does not exist', '42P01');
          if (q.op === 'delete') { const all = load(VKEY); save(VKEY, all.filter(r => !(m(r) && r.owner_id === me()))); return { data: [], error: null }; }
          const out = load(VKEY).filter(r => r.owner_id === me() && m(r)).sort((a, b) => b.saved_at.localeCompare(a.saved_at) || b.id - a.id);
          return finish(out);
        }
        const remixInfo = (r) => {
          const rows = load(DB), profiles = load('fake-sb:t:public_profiles');
          const o = rows.find(x => x.id === r.remixed_from && x.visibility === 'public' && x.description != null);
          const oa = o && profiles.find(x => x.user_id === o.owner_id);
          return { remixes: rows.filter(x => x.remixed_from === r.id).length, remixed_from: o ? o.id : null,
            remixed_from_name: o ? o.name : null, remixed_from_author: o ? (oa && oa.username ? oa.username : 'OnSketch user') : null };
        };
        if (table === 'library_sketches') {
          const profiles = load('fake-sb:t:public_profiles'), likes = load('fake-sb:t:project_likes');
          let out = load(DB).filter(r => r.visibility === 'public' && r.description != null).map(r => {
            const a = profiles.find(x => x.user_id === r.owner_id);
            return { id: r.id, owner_id: r.owner_id, name: r.name, description: r.description, created_at: r.created_at || r.updated_at, updated_at: r.updated_at,
              author_name: a && a.username ? a.username : 'OnSketch user', author_avatar: a && a.username ? a.avatar_url : null, likes: likes.filter(l => l.project_id === r.id).length,
              ...remixInfo(r) };
          }).filter(m);
          const [k, asc] = q.order || ['created_at', false];
          out.sort((a, b) => (asc ? 1 : -1) * (typeof a[k] === 'number' ? a[k] - b[k] : String(a[k]).localeCompare(String(b[k]))));
          if (q.range) out = out.slice(q.range[0], q.range[1] + 1);
          return finish(out);
        }
        const all = load(KEY);
        let out;
        if (q.op === 'insert' || q.op === 'upsert') {
          if (table === 'projects') {
            const pro = load('fake-sb:t:account_plans').some(r => r.user_id === me() && r.plan === 'premium');
            if (!pro && all.filter(r => r.owner_id === me()).length >= (window.__fakeLimit ?? 3)) return fail('OnSketch: free plan limit (3 projects).');
            const now = new Date().toISOString();
            const r = { id: 'p' + (all.length + 1) + '-' + Date.now(), owner_id: me(), visibility: 'private', revision: 1, created_at: now, updated_at: now, ...q.p };
            if (r.remixed_from && !all.some(x => x.id === r.remixed_from && (x.visibility === 'public' || x.owner_id === me()))) r.remixed_from = null;
            all.push(r); out = [r];
          } else if (table === 'project_likes') {
            const p = load(DB).find(x => x.id === q.p.project_id);
            if (!p || p.visibility !== 'public' || p.owner_id === me()) return fail('new row violates row-level security policy', '42501');
            if (all.some(l => l.project_id === q.p.project_id && l.user_id === me())) return fail('duplicate key', '23505');
            out = [{ project_id: q.p.project_id, user_id: me() }]; all.push(out[0]);
          } else if (table === 'public_profiles') {
            const r = { user_id: me(), ...q.p };
            if (r.username && all.some(x => x.user_id !== r.user_id && (x.username || '').toLowerCase() === r.username.toLowerCase())) return fail('duplicate key', '23505');
            const i = all.findIndex(x => x.user_id === r.user_id);
            if (i >= 0 && q.op === 'insert') return fail('duplicate key', '23505');
            if (i >= 0) all[i] = { ...all[i], ...r }; else all.push(r);
            out = [all.find(x => x.user_id === r.user_id)];
          }
        } else if (q.op === 'update') {
          out = all.filter(m);
          if (table === 'projects' && 'data' in q.p) {
            save(KEY, all);                                    // versions are written beside the rows
            out.forEach(r => { if (JSON.stringify(r.data) !== JSON.stringify(q.p.data)) keepVersion(JSON.parse(JSON.stringify(r))); });
          }
          out.forEach(r => Object.assign(r, q.p, table === 'projects' ? { revision: r.revision + ('data' in q.p ? 1 : 0), updated_at: new Date().toISOString() } : {}));
        } else if (q.op === 'delete') {
          out = all.filter(m); save(KEY, all.filter(r => !m(r))); return { data: out, error: null };
        } else {
          out = all.filter(m);
          if (table === 'project_likes' || table === 'public_profiles') out = table === 'project_likes' ? out.filter(l => l.user_id === me()) : out;
          if (table === 'projects') out.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
          if (q.range) out = out.slice(q.range[0], q.range[1] + 1);
        }
        if (q.op !== 'select') save(KEY, all);
        return finish(out);
      };
      const b = {
        select() { return b; }, single() { q.single = true; return b; }, maybeSingle() { q.maybe = true; return b; },
        order(k, o) { if (!q.order) q.order = [k, !!(o && o.ascending)]; return b; },
        insert(p) { q.op = 'insert'; q.p = p; return b; }, upsert(p) { q.op = 'upsert'; q.p = p; return b; },
        update(p) { q.op = 'update'; q.p = p; return b; },
        delete() { q.op = 'delete'; return b; }, eq(k, v) { q.f.push([k, v]); return b; },
        in(k, vs) { (q.ins = q.ins || []).push([k, vs]); return b; },
        not(k) { (q.notNull = q.notNull || []).push(k); return b; },
        or(expr) { q.text = /ilike\.%([^%]*)%/.exec(expr)[1].toLowerCase(); return b; },
        range(a, z) { q.range = [a, z]; return b; },
        then(res, rej) { return Promise.resolve(run()).then(res, rej); },
      };
      return b;
    },
  });
}
