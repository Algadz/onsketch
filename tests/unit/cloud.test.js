// Cloud data layer against a fake supabase client (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openCloud, isConfigured, rowFor, cleanName, detailsProblems, ConflictError, LimitError } from '../../app/src/cloud/cloud.js';
import { Project } from '../../app/src/core/model.js';

const URL_ = 'https://abc.supabase.co';
const KEY = 'sb_publishable_xxxxxxxxxxxxxxxxxxxxxxxx';

/** Minimal in-memory stand-in for supabase-js: auth + one table with the
 *  revision trigger from supabase/migrations/0001_projects.sql. */
function fakeClient() {
  const rows = [];
  let session = { user: { id: 'u1', email: 'a@b.c' } };
  let nextId = 1;
  const table = () => {
    const q = { filters: [], op: 'select', payload: null, single: false };
    const match = r => q.filters.every(([k, v]) => r[k] === v);
    const pick = r => ({ ...r });
    const run = () => {
      let out;
      if (q.op === 'insert') {
        if (rows.filter(r => r.owner_id === session.user.id).length >= 3) return { data: null, error: new Error('OnSketch: free plan limit (3 projects).') };
        const r = { id: 'p' + nextId++, owner_id: session.user.id, visibility: 'private', revision: 1, updated_at: Date.now(), ...q.payload };
        rows.push(r); out = [r];
      } else if (q.op === 'update') {
        out = rows.filter(match);
        for (const r of out) Object.assign(r, q.payload, { revision: r.revision + ('data' in q.payload ? 1 : 0) });
      } else if (q.op === 'delete') {
        out = rows.filter(match);
        for (const r of out) rows.splice(rows.indexOf(r), 1);
      } else out = rows.filter(match);
      out = out.map(pick);
      if (q.maybe) return { data: out[0] || null, error: null };
      if (q.single) return out.length === 1 ? { data: out[0], error: null } : { data: null, error: new Error('not found') };
      return { data: out, error: null };
    };
    const b = {
      select() { return b; }, order() { return b; },
      insert(p) { q.op = 'insert'; q.payload = p; return b; },
      update(p) { q.op = 'update'; q.payload = p; return b; },
      delete() { q.op = 'delete'; return b; },
      eq(k, v) { q.filters.push([k, v]); return b; },
      single() { q.single = true; return b; },
      maybeSingle() { q.maybe = true; return b; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return b;
  };
  return {
    rows,
    signOut() { session = null; },
    auth: {
      getSession: async () => ({ data: { session }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signInWithOtp: async () => ({ error: null }),
      signInWithOAuth: async () => ({ error: null }),
      signOut: async () => { session = null; return { error: null }; },
    },
    from: () => table(),
    storage: { from: () => ({ upload: async () => ({ error: null }), remove: async () => ({ error: null }), copy: async () => ({ error: null }),
      createSignedUrls: async (paths) => ({ data: paths.map(p => ({ path: p, signedUrl: 'https://x/' + p })), error: null }) }) },
  };
}

const projectJSON = (name = 'Desk') => {
  const p = new Project(); p.name = name; p.addSketch('Sketch 1');
  return p.toJSON();
};

test('cloud is off until configured', async () => {
  assert.equal(isConfigured('', ''), false);
  assert.equal(isConfigured('http://abc.supabase.co', KEY), false);
  assert.equal(isConfigured(URL_, KEY), true);
  assert.equal(await openCloud({ url: '', key: '' }), null);
});

test('create, list, load, save, delete', async () => {
  const fake = fakeClient();
  const cloud = await openCloud({ url: URL_, key: KEY, createClient: () => fake });
  const row = await cloud.create(projectJSON('Desk'), { name: 'Desk', description: 'A standing desk' });
  assert.equal(row.name, 'Desk');
  assert.equal(row.revision, 1);
  assert.deepEqual((await cloud.list()).map(r => r.name), ['Desk']);

  const loaded = await cloud.load(row.id);
  const p = Project.fromJSON(loaded.data);
  assert.equal(p.name, 'Desk');

  p.name = 'Desk v2';
  const saved = await cloud.save(row.id, p.toJSON(), loaded.revision);
  assert.equal(saved.revision, 2);
  assert.equal(saved.name, 'Desk v2');

  await cloud.remove(row.id);
  assert.deepEqual(await cloud.list(), []);
});

test('a save from a stale revision is refused with the latest row', async () => {
  const fake = fakeClient();
  const cloud = await openCloud({ url: URL_, key: KEY, createClient: () => fake });
  const row = await cloud.create(projectJSON(), { name: 'Shelf', description: 'A wall shelf' });
  await cloud.save(row.id, projectJSON('From tab A'), 1);          // now at 2
  await assert.rejects(cloud.save(row.id, projectJSON('From tab B'), 1), (e) => {
    assert.ok(e instanceof ConflictError);
    assert.equal(e.latest.name, 'From tab A');
    return true;
  });
});

test('signed out: no projects listed', async () => {
  const fake = fakeClient();
  const cloud = await openCloud({ url: URL_, key: KEY, createClient: () => fake });
  await cloud.signOut();
  assert.equal(await cloud.user(), null);
  assert.deepEqual(await cloud.list(), []);
});

test('names are cleaned and non-projects rejected', () => {
  assert.equal(cleanName('  my   desk \n'), 'my desk');
  assert.equal(cleanName(''), 'Untitled');
  assert.equal(cleanName('x'.repeat(300)).length, 200);
  assert.throws(() => rowFor({ name: 'x' }));
  assert.equal(rowFor(projectJSON('A')).name, 'A');
});

test('details: title 3–80, description 10–500', async () => {
  assert.deepEqual(detailsProblems({ name: 'Desk', description: 'A standing desk' }), []);
  assert.match(detailsProblems({ name: 'ab', description: 'A standing desk' })[0], /title/);
  assert.match(detailsProblems({ name: 'Desk', description: '  too   short ' })[0], /description/);
  const cloud = await openCloud({ url: URL_, key: KEY, createClient: () => fakeClient() });
  await assert.rejects(cloud.create(projectJSON(), { name: 'Desk', description: 'short' }), /description/);
});

test('free plan: the fourth project is refused with LimitError', async () => {
  const cloud = await openCloud({ url: URL_, key: KEY, createClient: () => fakeClient() });
  const plan = await cloud.plan();
  assert.equal(plan.plan, 'free');
  assert.equal(plan.limit, 3);
  assert.equal(plan.hasSubscription, false);
  for (const n of ['One', 'Two', 'Three']) await cloud.create(projectJSON(n), { name: n, description: 'Some description' });
  await assert.rejects(cloud.create(projectJSON('Four'), { name: 'Four', description: 'Some description' }), (e) => e instanceof LimitError && e.limit === 3);
});

test('save keeps the cloud title when the project name is too short', async () => {
  const fake = fakeClient();
  const cloud = await openCloud({ url: URL_, key: KEY, createClient: () => fake });
  const row = await cloud.create(projectJSON('Desk'), { name: 'Desk', description: 'A standing desk' });
  const saved = await cloud.save(row.id, projectJSON('D'), row.revision);
  assert.equal(saved.name, 'Desk');
  const urls = await cloud.thumbnailURLs([row]);
  assert.match(urls.get(row.id), /u1\/.*\.webp$/);
});

test('usernames: 3–24 letters, digits, _ . -, not reserved', async () => {
  const { usernameProblem } = await import('../../app/src/cloud/cloud.js');
  for (const ok of ['alban', 'woodshop_tom', 'a.b-c', 'X12']) assert.equal(usernameProblem(ok), '', ok);
  assert.match(usernameProblem('ab'), /3 to 24/);
  assert.match(usernameProblem('x'.repeat(25)), /3 to 24/);
  assert.match(usernameProblem('_tom'), /starting with a letter/);
  assert.match(usernameProblem('tom smith'), /letters, digits/);
  assert.match(usernameProblem('Admin'), /reserved/);
});

test('profile fields: bio ≤ 280, country code, http(s) website only', async () => {
  const { profileProblem, normaliseWebsite } = await import('../../app/src/cloud/cloud.js');
  assert.equal(normaliseWebsite('example.com/me'), 'https://example.com/me');
  assert.equal(normaliseWebsite('  '), null);
  assert.equal(profileProblem({ bio: 'Maker', country: 'FR', website: 'https://example.com' }), '');
  assert.match(profileProblem({ bio: 'x'.repeat(281) }), /280/);
  assert.match(profileProblem({ country: 'France' }), /country/i);
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'ftp://x.y']) assert.match(profileProblem({ website: bad }), /website/i, bad);
});
