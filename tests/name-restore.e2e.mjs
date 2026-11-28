// Opening a sketch from a link (/app/?project=…, e.g. from an AI
// assistant) while another sketch was open, then going Back: the browser
// puts the old sketch's name back in the name field, which then renamed
// the sketch open now on its next save. The field must follow the sketch.
// Usage: node tests/name-restore.e2e.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { createRequire } from 'node:module';
import { installFake } from './fake-supabase.mjs';
import { buildFromSpec } from '../app/src/core/spec.js';
const { chromium, devices } = createRequire(import.meta.url)('playwright');
const root = new URL('..', import.meta.url).pathname;
const s = createServer(async (q, r) => { let p = new URL(q.url, 'http://x').pathname; if (p.endsWith('/')) p += 'index.html';
  try { r.writeHead(200, { 'content-type': { '.js': 'text/javascript', '.css': 'text/css' }[extname(p)] || 'text/html' }); r.end(await readFile(join(root, p))); } catch { r.writeHead(404); r.end(); } });
await new Promise(ok => s.listen(0, ok));
const base = `http://localhost:${s.address().port}`;
const orbital = buildFromSpec({ shapes: [{ type: 'circle', center: [0, 0], r: 30 }] }, { title: 'orbital sketch' }).project.toJSON();
const bike = buildFromSpec({ shapes: [{ type: 'circle', center: [0, 0], r: 340 }, { type: 'circle', center: [1000, 0], r: 340 }] }, { title: 'Simple road bicycle' }).project.toJSON();
const now = new Date().toISOString();
const rows = [
  { id: 'aaaaaaaa-0000-4000-8000-000000000001', owner_id: 'u1', name: 'orbital sketch', description: 'old one here', visibility: 'private', revision: 3, data: orbital, created_at: now, updated_at: now },
  { id: 'bbbbbbbb-0000-4000-8000-000000000002', owner_id: 'u1', name: 'Simple road bicycle', description: 'made by claude', visibility: 'private', revision: 1, data: bike, created_at: now, updated_at: now },
];
let failed = 0;
const check = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) failed++; };
for (const mobile of [false, true]) {
  const b = await chromium.launch();
  const ctx = await b.newContext(mobile ? devices['Pixel 7'] : { viewport: { width: 1300, height: 850 } });
  await ctx.route(/umami|jsdelivr|supabase\.co/, r => r.abort());
  await ctx.addInitScript(installFake);
  await ctx.addInitScript(([rows, orbital]) => {
    if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1');
    const ses = { user: { id: 'u1', email: 'me@example.com' } };
    localStorage.setItem('fake-sb:session', JSON.stringify(ses)); localStorage.setItem('sb-rwmzpzaqijgdfsjmpqbd-auth-token', JSON.stringify(ses));
    localStorage.setItem('fake-sb:rows', JSON.stringify(rows));
    localStorage.setItem('fake-sb:t:public_profiles', JSON.stringify([{ user_id: 'u1', username: 'tester' }]));
    localStorage.setItem('sketchcad:last', JSON.stringify(orbital));
    localStorage.setItem('onsketch:cloud', JSON.stringify({ id: rows[0].id, revision: 3, dirty: false }));
    localStorage.setItem('onsketch:tour-done', '1');
  }, [rows, orbital]);
  const pg = await ctx.newPage();
  const errs = []; pg.on('pageerror', e => errs.push(String(e)));
  await pg.goto(`${base}/app/`);
  await pg.waitForFunction(() => window._app?.cloudUser, null, { timeout: 15000 });
  await pg.waitForTimeout(1500);
  await pg.goto(`${base}/app/?project=${rows[1].id}`);
  await pg.waitForFunction(() => window._app?.cloudLink?.id?.startsWith('bbbb'), null, { timeout: 15000 });
  await pg.waitForTimeout(2000);
  await pg.goBack();
  await pg.waitForTimeout(3000);
  const back = await pg.evaluate(() => [window._app?.project.name, document.getElementById('project-name').value]);
  check(back[0] === 'Simple road bicycle' && back[1] === back[0], `${mobile ? 'phone' : 'desktop'}: after Back, the name field shows the open sketch's name (${back[1]})`);
  // a small edit, as a person would make
  await pg.evaluate(() => { window._app.project.active().entities[0].r += 1; window._app.commit(); });
  await pg.waitForTimeout(4000);
  const st = await pg.evaluate(() => ({ name: window._app.project.name, field: document.getElementById('project-name').value, link: window._app.cloudLink,
    rows: JSON.parse(localStorage.getItem('fake-sb:rows')).map(r => [r.name, r.data.name, r.revision]) }));
  check(JSON.stringify(st.rows) === JSON.stringify([['orbital sketch', 'orbital sketch', 3], ['Simple road bicycle', 'Simple road bicycle', 2]]), `${mobile ? 'phone' : 'desktop'}: the saved sketch keeps its own name; the other is untouched`);
  check(errs.length === 0, `${mobile ? 'phone' : 'desktop'}: no page errors`);
  await b.close();
}
s.close();
if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nall name checks passed');
