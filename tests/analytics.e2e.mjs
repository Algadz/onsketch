// End-to-end test of the Umami events (ui/analytics.js): what is counted,
// once-per-visit counts, short values, and nothing sent from automated browsers.
// Usage: node tests/analytics.e2e.mjs [rootDir]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const root = resolve(process.argv[2] || new URL('..', import.meta.url).pathname);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  try {
    const body = await readFile(join(root, p));
    res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', e => { if (!/analytics test/.test(String(e))) errors.push(String(e)); });
page.on('dialog', d => { errors.push('native dialog: ' + d.message()); d.dismiss(); });
page.route(/umami|jsdelivr|supabase/, r => r.abort());
let failed = 0;
const check = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) failed++; };

// Events are captured through the test hook. A fake Umami shows that
// nothing is sent from an automated browser on localhost.
await page.addInitScript(() => {
  window.__ev = [];
  window.__onsketchTrack = (ev, data) => window.__ev.push({ ev, ...(data || {}) });
  window.__sent = [];
  window.umami = { track: (...a) => window.__sent.push(a) };
  try { localStorage.setItem('onsketch:prefs', JSON.stringify({ theme: 'light' })); } catch { /* none */ }
});
const events = () => page.evaluate(() => window.__ev);
const count = async (ev, props = {}) => (await events()).filter(e => e.ev === ev && Object.entries(props).every(([k, v]) => e[k] === v)).length;

// ---- Editor ----
await page.goto(`http://localhost:${port}/app/?example=desk`);
await page.waitForFunction(() => window._app);
await page.waitForFunction(() => window.__ev.some(e => e.ev === 'sketch-open'), null, { timeout: 5000 }).catch(() => {});
check(await count('sketch-open', { from: 'example', example: 'desk' }) === 1, 'opening an example: sketch-open {from: example, example: desk}');

await page.click('#tools-body [data-tool="line"]');
await page.click('#tools-body [data-tool="select"]');
await page.click('#tools-body [data-tool="line"]');
check(await count('tool', { name: 'line' }) === 1, 'tool {name: line}, once per visit however often it is picked');

// a new dimension is counted by kind (added the way the tools add them: push + commit)
await page.keyboard.press('Escape');
await page.evaluate(async () => {
  const a = window._app, s = a.activeSketch();
  const { DistanceConstraint } = await import('./src/core/constraints.js');
  const line = s.entities.find(e => e.constructor.kind === 'line');
  s.constraints.push(new DistanceConstraint(line.p1.id, line.p2.id, Math.hypot(line.p2.x - line.p1.x, line.p2.y - line.p1.y)));
  a.commit();
});
check(await count('dimension', { kind: 'distance' }) === 1, 'a new dimension: dimension {kind: distance}');

await page.click('#menubar [data-action="undo"]');
await page.click('#menubar [data-action="undo"]');
check(await count('undo') === 1, 'undo, once per visit');

await page.click('#menubar [data-action="theme"]');
check(await count('theme', { to: 'dark' }) === 1, 'theme {to: dark}');
await page.click('#menubar [data-action="theme"]');

await page.click('#menubar [data-window="equations"]');
check(await count('window', { name: 'equations' }) === 1, 'window {name: equations} when the user opens it');

await page.click('#report-open');
check(await count('report-open') === 1, 'report-open');
await page.keyboard.press('Escape');

await page.click('#menubar [data-action="save"]');
check(await count('sketch-save', { signed_in: false }) === 1, 'save: sketch-save {to, signed_in: false}');
await page.keyboard.press('Escape');
await page.evaluate(() => window._app.closeAccount?.());

page.once('dialog', d => d.accept());
await page.evaluate(() => { window._app._skipConfirm = true; return window._app.newProject(); });
check(await count('sketch-new') === 1, 'new sketch: sketch-new');

await page.evaluate(() => setTimeout(() => { throw new Error('analytics test'); }));
await page.waitForTimeout(100);
check(await count('error', { page: 'editor', message: 'Error: analytics test' }) === 1, 'uncaught error: error {page: editor, message}');

const leaks = await page.evaluate(() => window.__ev.filter(e => Object.values(e).some(v => typeof v === 'string' && v.length > 80)));
check(leaks.length === 0, 'event values are short labels');
check(await page.evaluate(() => window.__sent.length) === 0, 'nothing is sent to Umami from localhost / automated browsers');

// ---- Pricing page ----
await page.goto(`http://localhost:${port}/pricing/`);
await page.waitForTimeout(500);
await page.click('.pr-toggle [data-interval="month"]');
check(await count('pricing-interval', { interval: 'month' }) === 1, 'pricing: pricing-interval {interval: month}');

// ---- Landing page: Umami script and tagged buttons ----
await page.goto(`http://localhost:${port}/`);
check(await page.$('script[src*="umami"]') !== null, 'landing page loads Umami');
check(await page.$$eval('[data-umami-event="landing-cta"]', l => l.length) >= 4, 'landing CTAs carry data-umami-event');

check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' / ') : ''}`);
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
