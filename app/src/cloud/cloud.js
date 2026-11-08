// Accounts and cloud projects on Supabase: the data layer.
//
// Nothing here touches the DOM. Pages get a Cloud object from
// openCloud(); it is null when config.js is empty, so the app keeps
// working offline-only. supabase-js is loaded from the CDN on first use,
// so visitors who never sign in don't download it.
//
// The rules (title 3–80, description 10–500, 3 projects and public only
// on the free plan) live in the database (supabase/migrations/0002_*);
// the checks here only give quicker, friendlier messages.
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

const SUPABASE_ESM = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
const LIST_COLUMNS = 'id,name,description,visibility,revision,updated_at,created_at';
const THUMBS = 'thumbnails';

export const TITLE_MIN = 3, TITLE_MAX = 80, DESC_MIN = 10, DESC_MAX = 500, NAME_MIN = 2, NAME_MAX = 40;
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
  constructor(limit) { super(`The free plan holds ${limit} sketches.`); this.name = 'LimitError'; this.limit = limit; }
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
  if (/^OnSketch: /.test(error?.message || '')) return new Error(error.message.replace(/^OnSketch: /, ''));
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
  /** { plan: 'free' | 'premium', limit: number | null } for the signed-in user. */
  async plan() {
    const user = await this.user();
    let plan = 'free';
    if (user) {
      const { data, error } = await this.client.from('account_plans').select('plan').eq('user_id', user.id).maybeSingle();
      if (!error && data && data.plan in PLAN_LIMITS) plan = data.plan;
    }
    return { plan, limit: PLAN_LIMITS[plan] };
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
  async library({ search = '', offset = 0, limit = 24, sort = 'new' } = {}) {
    let q = this.client.from('library_sketches').select(LIBRARY_COLUMNS);
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

  /* ---- Public profile: the name shown with public sketches ---- */
  async profile() {
    const user = await this.user();
    if (!user) return null;
    const { data, error } = await this.client.from('public_profiles').select('user_id,display_name,avatar_url').eq('user_id', user.id).maybeSingle();
    if (error) throw error;
    return data;
  }
  /** Creates the profile on first sign-in, from the account's name
   *  (Google) or "OnSketch user"; never from the email address. */
  async ensureProfile() {
    const user = await this.user();
    if (!user) return null;
    const existing = await this.profile().catch(() => null);
    if (existing) return existing;
    const meta = user.user_metadata || {};
    let name = cleanText(meta.full_name || meta.name || '').slice(0, NAME_MAX);
    if (name.length < NAME_MIN) name = 'OnSketch user';
    const avatar = typeof meta.avatar_url === 'string' && /^https:\/\//.test(meta.avatar_url) && meta.avatar_url.length <= 500 ? meta.avatar_url : null;
    const { data, error } = await this.client.from('public_profiles')
      .insert({ display_name: name, avatar_url: avatar }).select('user_id,display_name,avatar_url').single();
    if (error) { if (error.code === '23505') return this.profile(); throw error; }
    return data;
  }
  /** Changes the display name (2–40 characters); `showPicture` false removes the picture. */
  async saveProfile({ displayName, showPicture = true }) {
    const user = await this.user();
    if (!user) throw new Error('Not signed in.');
    const name = cleanText(displayName);
    if (name.length < NAME_MIN || name.length > NAME_MAX) throw new Error(`Your name needs ${NAME_MIN} to ${NAME_MAX} characters.`);
    const meta = user.user_metadata || {};
    const avatar = showPicture && typeof meta.avatar_url === 'string' && /^https:\/\//.test(meta.avatar_url) ? meta.avatar_url.slice(0, 500) : null;
    const { data, error } = await this.client.from('public_profiles')
      .upsert({ user_id: user.id, display_name: name, avatar_url: avatar }).select('user_id,display_name,avatar_url').single();
    if (error) throw error;
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
/** A search string made safe for a PostgREST or=() filter. */
export function librarySearch(s) {
  return cleanText(String(s ?? '').replace(/[,()%*\\:."]/g, ' ')).slice(0, 60);
}
export function cleanText(s) { return String(s ?? '').replace(/\s+/g, ' ').trim(); }
export function cleanName(name) {
  const n = cleanText(name).slice(0, 200);
  return n || 'Untitled';
}
