// Accounts and cloud projects on Supabase: the data layer.
//
// Nothing here touches the DOM. Pages get a Cloud object from
// openCloud(); it is null when config.js is empty, so the app keeps
// working offline-only. supabase-js is loaded from the CDN on first use,
// so visitors who never sign in don't download it.
//
// The rules (title 3–80, description 10–500, 3 projects on the free plan,
// and whether free sketches may be private: rules()) live in the database
// (supabase/migrations/0002_* and 0007_*);
// the checks here only give quicker, friendlier messages.
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

const SUPABASE_ESM = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
const LIST_COLUMNS = 'id,name,description,visibility,revision,updated_at,created_at';
const THUMBS = 'thumbnails';

export const TITLE_MIN = 3, TITLE_MAX = 80, DESC_MIN = 10, DESC_MAX = 500;
const PROFILE_COLUMNS = 'user_id,username,avatar_url,bio,country,website';
export const BIO_MAX = 280, WEBSITE_MAX = 200;
const LIBRARY_COLUMNS = 'id,owner_id,name,description,created_at,updated_at,author_name,author_avatar,likes';
/** Projects allowed per plan (null = no limit); mirrors plan_project_limit() in SQL. */
export const PLAN_LIMITS = { free: 3, premium: null };

export function isConfigured(url = SUPABASE_URL, key = SUPABASE_KEY) {
  return typeof url === 'string' && /^https:\/\/\S+$/.test(url) && typeof key === 'string' && key.length > 20;
}

/** A save was refused because the project changed elsewhere (another tab
 *  or device) since it was loaded. `latest` is the row as it is now. */
export class ConflictError extends Error {
  constructor(latest) { super('This project was changed somewhere else.'); this.name = 'ConflictError'; this.latest = latest; }
}
/** The plan doesn't allow another project. */
export class LimitError extends Error {
  constructor(limit) { super(`The free plan holds ${limit} sketches. OnSketch Pro has no limit.`); this.name = 'LimitError'; this.limit = limit; }
}

/** Opens the cloud, or returns null when it isn't configured.
 *  `createClient` can be passed in (tests); by default it comes from the CDN. */
export async function openCloud({ url = SUPABASE_URL, key = SUPABASE_KEY, createClient = null } = {}) {
  if (!isConfigured(url, key)) return null;
  if (!createClient) ({ createClient } = await import(/* @vite-ignore */ SUPABASE_ESM));
  const client = createClient(url, key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
  });
  return new Cloud(client);
}

/** Problems with a title / description, as a list of messages (empty = fine). */
export function detailsProblems({ name, description }) {
  const out = [];
  const t = cleanText(name), d = cleanText(description);
  if (t.length < TITLE_MIN) out.push(`The title needs at least ${TITLE_MIN} characters.`);
  if (t.length > TITLE_MAX) out.push(`The title can have at most ${TITLE_MAX} characters.`);
  if (d.length < DESC_MIN) out.push(`The description needs at least ${DESC_MIN} characters.`);
  if (d.length > DESC_MAX) out.push(`The description can have at most ${DESC_MAX} characters.`);
  return out;
}

/** Turns a database error into a friendlier one. */
function fromDb(error) {
  const m = /OnSketch: free plan limit \((\d+)/.exec(error?.message || '');
  if (m) return new LimitError(+m[1]);
  if (/^OnSketch: /.test(error?.message || '')) return new Error(error.message.replace(/^OnSketch: /, '').replace('a Premium feature', 'an OnSketch Pro feature'));
  return error;
}

export class Cloud {
  constructor(client) { this.client = client; }

  /* ---- Account ---- */
  async user() {
    const { data, error } = await this.client.auth.getSession();
    if (error) throw error;
    return data.session ? data.session.user : null;
  }
  /** cb(user | null) on sign-in, sign-out and token refresh. Returns an unsubscribe function. */
  onUserChange(cb) {
    const { data } = this.client.auth.onAuthStateChange((_event, session) => cb(session ? session.user : null));
    return () => data.subscription.unsubscribe();
  }
  /** Emails a sign-in link (and code). Creates the account on first use. */
  async signInWithEmail(email, redirectTo = location.href) {
    const { error } = await this.client.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo } });
    if (error) throw error;
  }
  /** Signs in with the code from the sign-in email (6 to 10 digits, set in Supabase). */
  async verifyEmailCode(email, code) {
    const { data, error } = await this.client.auth.verifyOtp({ email, token: String(code).trim(), type: 'email' });
    if (error) throw error;
    return data.user;
  }
  /** Redirects to Google / GitHub / … and back to `redirectTo`. */
  async signInWithProvider(provider, redirectTo = location.href) {
    const { error } = await this.client.auth.signInWithOAuth({ provider, options: { redirectTo } });
    if (error) throw error;
  }
  async signOut() {
    const { error } = await this.client.auth.signOut();
    if (error) throw error;
  }
  /** What the plans allow, as the database says (plan_rules() in SQL):
   *  { freePrivate }: whether free sketches may be private. A database
   *  that doesn't have the function yet keeps the earlier rule (free =
   *  public only), so the app never offers what the server would refuse. */
  async rules() {
    if (!this._rules) {
      this._rules = (async () => {
        try {
          const { data, error } = await this.client.rpc('plan_rules');
          const r = Array.isArray(data) ? data[0] : data;
          return { freePrivate: !error && !!r?.free_private };
        } catch { return { freePrivate: false }; }
      })();
    }
    return this._rules;
  }
  /** The signed-in user's plan: { plan: 'free' | 'premium' (= Pro), limit,
   *  canPrivate, status, interval, renewsAt, endsAt, hasSubscription }. */
  async plan() {
    const user = await this.user();
    const rules = await this.rules();
    let row = null;
    if (user) {
      const { data, error } = await this.client.from('account_plans')
        .select('plan,status,interval,renews_at,ends_at,subscription_id').eq('user_id', user.id).maybeSingle();
      if (!error && data) row = data;
    }
    let plan = row && row.plan in PLAN_LIMITS ? row.plan : 'free';
    // Same rule as plan_of() in SQL: a cancelled subscription ends at ends_at.
    if (plan === 'premium' && row.status === 'cancelled' && row.ends_at && new Date(row.ends_at) < new Date()) plan = 'free';
    return { plan, limit: PLAN_LIMITS[plan], canPrivate: plan === 'premium' || rules.freePrivate, status: row?.status || null, interval: row?.interval || null,
      renewsAt: row?.renews_at || null, endsAt: row?.ends_at || null, hasSubscription: !!row?.subscription_id };
  }
  /** Lemon Squeezy through the "billing" Edge Function: 'checkout'
   *  ({ interval: 'month' | 'year' }) or 'portal'. Resolves to a URL. */
  async billing(action, options = {}) {
    const { data, error } = await this.client.functions.invoke('billing', { body: { action, ...options } });
    if (error) {
      let detail = '';
      try { detail = (await error.context?.json?.())?.error || ''; } catch { /* no JSON body */ }
      throw new Error(detail || error.message || "Couldn't reach the billing service.");
    }
    if (!data?.url) throw new Error(data?.error || "Couldn't reach the billing service.");
    return data.url;
  }

  /* ---- Projects ---- */
  /** The signed-in user's projects, most recently changed first (no data). */
  async list() {
    const user = await this.user();
    if (!user) return [];
    const { data, error } = await this.client.from('projects')
      .select(LIST_COLUMNS).eq('owner_id', user.id).order('updated_at', { ascending: false });
    if (error) throw error;
    return data;
  }
  /** One project row including `data` (the project JSON). */
  async load(id) {
    const { data, error } = await this.client.from('projects')
      .select(LIST_COLUMNS + ',data').eq('id', id).single();
    if (error) throw error;
    return data;
  }
  /** Stores a new project with its details { name, description, visibility };
   *  returns its row. Throws LimitError at the plan's limit. */
  async create(json, details) {
    const problems = detailsProblems(details);
    if (problems.length) throw new Error(problems[0]);
    const name = cleanText(details.name);
    const row = { ...rowFor({ ...json, name }), name, description: cleanText(details.description),
      visibility: details.visibility === 'private' ? 'private' : 'public' };
    const { data, error } = await this.client.from('projects').insert(row).select(LIST_COLUMNS).single();
    if (error) throw fromDb(error);
    return data;
  }
  /** Overwrites project `id`'s drawing if it is still at `revision`;
   *  returns the new row. Throws ConflictError when someone saved it in
   *  the meantime. The title follows the project name when it is valid. */
  async save(id, json, revision) {
    const row = rowFor(json);
    if (row.name.length < TITLE_MIN) delete row.name;
    else row.name = row.name.slice(0, TITLE_MAX);
    const { data, error } = await this.client.from('projects')
      .update(row).eq('id', id).eq('revision', revision).select(LIST_COLUMNS);
    if (error) throw fromDb(error);
    if (data && data.length) return data[0];
    let latest = null;
    try { latest = await this.load(id); } catch { /* deleted or no longer visible */ }
    throw new ConflictError(latest);
  }
  /** Changes title / description / visibility (not the drawing: no conflict). */
  async updateDetails(id, details) {
    const problems = detailsProblems(details);
    if (problems.length) throw new Error(problems[0]);
    const patch = { name: cleanText(details.name), description: cleanText(details.description) };
    if (details.visibility) patch.visibility = details.visibility === 'private' ? 'private' : 'public';
    const { data, error } = await this.client.from('projects').update(patch).eq('id', id).select(LIST_COLUMNS).single();
    if (error) throw fromDb(error);
    return data;
  }
  async rename(id, name) {
    const { error } = await this.client.from('projects').update({ name: cleanName(name) }).eq('id', id);
    if (error) throw fromDb(error);
  }
  async setVisibility(id, visibility) {
    if (visibility !== 'private' && visibility !== 'public') throw new Error('bad visibility ' + visibility);
    const { error } = await this.client.from('projects').update({ visibility }).eq('id', id);
    if (error) throw fromDb(error);
  }
  /** A copy of project `id` (drawing, description), titled "<title> (copy)". */
  async duplicate(id) {
    const row = await this.load(id);
    const name = `${row.name} (copy)`.slice(0, TITLE_MAX);
    const copy = await this.create({ ...row.data, name }, {
      name, description: row.description || `Copy of ${row.name}.`, visibility: row.visibility });
    const thumb = await this._thumbPath(id);
    if (thumb) {
      try { await this.client.storage.from(THUMBS).copy(thumb, await this._thumbPath(copy.id)); } catch { /* no thumbnail yet */ }
    }
    return copy;
  }
  async remove(id) {
    const thumb = await this._thumbPath(id);
    const { error } = await this.client.from('projects').delete().eq('id', id);
    if (error) throw fromDb(error);
    if (thumb) {
      try { await this.client.storage.from(THUMBS).remove([thumb]); } catch { /* already gone */ }
    }
  }

  /* ---- Public library (view library_sketches, migration 0003) ---- */
  /** Public sketches with author and likes. sort: 'new' | 'updated' |
   *  'popular'. `search` matches title or description. Returns { rows, more }. */
  async library({ search = '', offset = 0, limit = 24, sort = 'new', owner = null } = {}) {
    let q = this.client.from('library_sketches').select(LIBRARY_COLUMNS);
    if (owner) q = q.eq('owner_id', owner);
    const words = librarySearch(search);
    if (words) q = q.or(`name.ilike.%${words}%,description.ilike.%${words}%`);
    if (sort === 'popular') q = q.order('likes', { ascending: false }).order('created_at', { ascending: false });
    else q = q.order(sort === 'updated' ? 'updated_at' : 'created_at', { ascending: false });
    const { data, error } = await q.range(offset, offset + limit);
    if (error) throw error;
    return { rows: data.slice(0, limit), more: data.length > limit };
  }
  /** One public sketch (no drawing data), or null. */
  async libraryItem(id) {
    const { data, error } = await this.client.from('library_sketches').select(LIBRARY_COLUMNS).eq('id', id).maybeSingle();
    if (error) throw error;
    return data;
  }
  /** Like counts of some of the user's public sketches: Map id → count. */
  async likeCounts(ids) {
    if (!ids.length) return new Map();
    const { data, error } = await this.client.from('library_sketches').select('id,likes').in('id', ids);
    if (error) return new Map();
    return new Map(data.map(r => [r.id, r.likes]));
  }
  /** Which of `ids` the signed-in user has liked (a Set). */
  async likedIds(ids) {
    const user = await this.user();
    if (!user || !ids.length) return new Set();
    const { data, error } = await this.client.from('project_likes').select('project_id').eq('user_id', user.id).in('project_id', ids);
    if (error) return new Set();
    return new Set(data.map(r => r.project_id));
  }
  async like(id) {
    const { error } = await this.client.from('project_likes').insert({ project_id: id });
    if (error && error.code !== '23505') throw error;          // already liked: fine
  }
  async unlike(id) {
    const user = await this.user();
    if (!user) return;
    const { error } = await this.client.from('project_likes').delete().eq('project_id', id).eq('user_id', user.id);
    if (error) throw error;
  }

  /* ---- Public profile: the username shown with public sketches ---- */
  /** The signed-in user's profile { user_id, username, avatar_url } or null.
   *  `username` is null until the user has chosen one (migration 0004). */
  async profile() {
    const user = await this.user();
    if (!user) return null;
    const { data, error } = await this.client.from('public_profiles').select(PROFILE_COLUMNS).eq('user_id', user.id).maybeSingle();
    if (error) throw error;
    return data;
  }
  /** Someone's public profile by username (ignoring case), with their
   *  number of public sketches and thumbs-up received; null if unknown. */
  async publicProfile(name) {
    const { data, error } = await this.client.rpc('public_profile', { name: cleanText(name) });
    if (error) throw error;
    const p = Array.isArray(data) ? data[0] : data;
    return p || null;
  }
  /** Exact, case-insensitive: is `name` free (or already mine)? */
  async usernameAvailable(name) {
    const { data, error } = await this.client.rpc('username_available', { name: cleanText(name) });
    if (error) throw error;
    return !!data;
  }
  /** The Google (or other provider) picture, if the account has one. */
  async accountPicture() {
    const meta = (await this.user())?.user_metadata || {};
    return typeof meta.avatar_url === 'string' && /^https:\/\//.test(meta.avatar_url) && meta.avatar_url.length <= 500 ? meta.avatar_url : null;
  }
  /** Saves the public profile: username, whether the account picture is
   *  shown, and the optional bio, country (ISO code) and website. */
  async saveProfile({ username, showPicture = false, bio, country, website }) {
    const user = await this.user();
    if (!user) throw new Error('Not signed in.');
    const problem = usernameProblem(username) || profileProblem({ bio, country, website });
    if (problem) throw new Error(problem);
    const avatar = showPicture ? await this.accountPicture() : null;
    const row = { user_id: user.id, username: cleanText(username), avatar_url: avatar };
    if (bio !== undefined) row.bio = String(bio || '').trim() || null;
    if (country !== undefined) row.country = country || null;
    if (website !== undefined) row.website = normaliseWebsite(website);
    const { data, error } = await this.client.from('public_profiles').upsert(row).select(PROFILE_COLUMNS).single();
    if (error) {
      if (error.code === '23505') throw new Error('This username is taken. Try another one.');
      throw fromDb(error);
    }
    return data;
  }

  /* ---- Thumbnails (Storage: thumbnails/<owner>/<project>.webp) ---- */
  async _thumbPath(id) {
    const user = await this.user();
    return user ? `${user.id}/${id}.webp` : null;
  }
  async uploadThumbnail(id, blob) {
    const path = await this._thumbPath(id);
    if (!path) return;
    const { error } = await this.client.storage.from(THUMBS)
      .upload(path, blob, { upsert: true, contentType: blob.type || 'image/webp', cacheControl: '60' });
    if (error) throw error;
  }
  /** Map project id → temporary URL of its thumbnail (missing ones left out). */
  async thumbnailURLs(rows, owner = null) {
    if (!rows.length) return new Map();
    const user = owner ? { id: owner } : (rows.every(r => r.owner_id) ? null : await this.user());
    if (!user && !rows.every(r => r.owner_id)) return new Map();
    const paths = rows.map(r => `${r.owner_id || user.id}/${r.id}.webp`);
    const { data, error } = await this.client.storage.from(THUMBS).createSignedUrls(paths, 3600);
    if (error || !data) return new Map();
    const out = new Map();
    data.forEach((d, i) => { if (d && d.signedUrl && !d.error) out.set(rows[i].id, d.signedUrl); });
    return out;
  }
}

/** Columns written for a project file (Project.toJSON() output). */
export function rowFor(json) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.sketches)) throw new Error('not a project');
  return { name: cleanName(json.name), data: json };
}
/** Why `name` can't be a username, or '' if its form is fine (mirrors
 *  public_profiles_touch() in SQL; uniqueness is checked by the server). */
export function usernameProblem(name) {
  const n = cleanText(name);
  if (n.length < 3 || n.length > 24) return 'A username has 3 to 24 characters.';
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(n)) return 'Use letters, digits, _ . or -, starting with a letter or digit.';
  if (RESERVED.has(n.toLowerCase())) return 'This username is reserved.';
  return '';
}
/** Problems with the optional profile fields (mirrors the SQL trigger). */
export function profileProblem({ bio, country, website } = {}) {
  if (bio && String(bio).trim().length > BIO_MAX) return `The description can have at most ${BIO_MAX} characters.`;
  if (country && !/^[A-Z]{2}$/.test(country)) return 'Unknown country.';
  const w = normaliseWebsite(website);
  if (w && (!/^https?:\/\/[^\s/$.?#][^\s]*$/.test(w) || w.length > WEBSITE_MAX)) return 'The website must be a link like https://example.com.';
  return '';
}
/** "example.com" → "https://example.com"; empty → null. */
export function normaliseWebsite(w) {
  const t = String(w ?? '').trim();
  if (!t) return null;
  if (/^https?:\/\//i.test(t) || /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(t)) return t;   // another scheme stays, to be refused
  return `https://${t}`;
}
const RESERVED = new Set(['admin', 'administrator', 'onsketch', 'support', 'help', 'moderator', 'mod', 'staff', 'team',
  'root', 'system', 'official', 'library', 'anonymous', 'null', 'undefined', 'onsketch_user']);

/** A search string made safe for a PostgREST or=() filter. */
export function librarySearch(s) {
  return cleanText(String(s ?? '').replace(/[,()%*\\:."]/g, ' ')).slice(0, 60);
}
export function cleanText(s) { return String(s ?? '').replace(/\s+/g, ' ').trim(); }
export function cleanName(name) {
  const n = cleanText(name).slice(0, 200);
  return n || 'Untitled';
}
