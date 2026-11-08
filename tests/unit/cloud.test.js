// Cloud data layer against a fake supabase client (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openCloud, isConfigured, rowFor, cleanName, ConflictError } from '../../app/src/cloud/cloud.js';
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
        const r = { id: 'p' + nextId++, owner_id: session.user.id, visibility: 'private', revision: 1, updated_at: Date.now(), ...q.payload };
        rows.push(r); out = [r];
      } else if (q.op === 'update') {
        out = rows.filter(match);
        for (const r of out) Object.assign(r, q.payload, { revision: r.revision + 1 });
      } else if (q.op === 'delete') {
        out = rows.filter(match);
        for (const r of out) rows.splice(rows.indexOf(r), 1);
      } else out = rows.filter(match);
      out = out.map(pick);
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
  const row = await cloud.create(projectJSON('Desk'));
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
  const row = await cloud.create(projectJSON());
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
