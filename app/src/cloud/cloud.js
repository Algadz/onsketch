// Accounts and cloud projects on Supabase (phase 1: data layer only).
//
// Nothing here touches the DOM. The editor gets a Cloud object from
// openCloud(); it is null when config.js is empty, so the app keeps
// working offline-only. supabase-js is loaded from the CDN on first use,
// so visitors who never sign in don't download it.
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

const SUPABASE_ESM = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
const LIST_COLUMNS = 'id,name,visibility,revision,updated_at';

export function isConfigured(url = SUPABASE_URL, key = SUPABASE_KEY) {
  return typeof url === 'string' && /^https:\/\/\S+$/.test(url) && typeof key === 'string' && key.length > 20;
}

/** A save was refused because the project changed elsewhere (another tab
 *  or device) since it was loaded. `latest` is the row as it is now. */
export class ConflictError extends Error {
  constructor(latest) { super('This project was changed somewhere else.'); this.name = 'ConflictError'; this.latest = latest; }
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
  /** Signs in with the 6-digit code from the sign-in email. */
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
  /** Stores a new project; returns its row (id, revision, …). */
  async create(json) {
    const { data, error } = await this.client.from('projects')
      .insert(rowFor(json)).select(LIST_COLUMNS).single();
    if (error) throw error;
    return data;
  }
  /** Overwrites project `id` if it is still at `revision`; returns the new
   *  row. Throws ConflictError when someone saved it in the meantime. */
  async save(id, json, revision) {
    const { data, error } = await this.client.from('projects')
      .update(rowFor(json)).eq('id', id).eq('revision', revision).select(LIST_COLUMNS);
    if (error) throw error;
    if (data && data.length) return data[0];
    let latest = null;
    try { latest = await this.load(id); } catch { /* deleted or no longer visible */ }
    throw new ConflictError(latest);
  }
  async rename(id, name) {
    const { error } = await this.client.from('projects').update({ name: cleanName(name) }).eq('id', id);
    if (error) throw error;
  }
  async setVisibility(id, visibility) {
    if (visibility !== 'private' && visibility !== 'public') throw new Error('bad visibility ' + visibility);
    const { error } = await this.client.from('projects').update({ visibility }).eq('id', id);
    if (error) throw error;
  }
  async remove(id) {
    const { error } = await this.client.from('projects').delete().eq('id', id);
    if (error) throw error;
  }
}

/** Columns written for a project file (Project.toJSON() output). */
export function rowFor(json) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.sketches)) throw new Error('not a project');
  return { name: cleanName(json.name), data: json };
}
export function cleanName(name) {
  const n = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return n || 'Untitled';
}
