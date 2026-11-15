// Shapes never collapse: a line to a point, a circle / arc to its centre.
// Usage: node tests/collapse.e2e.mjs [rootDir]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = resolve(process.argv[2] || new URL('..', import.meta.url).pathname);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  try { const body = await readFile(join(root, p)); res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' }); res.end(body); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;
const browser = await chromium.launch();
let failed = 0;
const check = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) failed++; };

async function open(device, path = '/app/?example=desk') {
  const ctx = await browser.newContext({ ...device });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.route(/formspree|umami/, r => r.abort());
  await page.addInitScript(() => { if (!sessionStorage.getItem('t')) { localStorage.clear(); sessionStorage.setItem('t', '1'); } });
  await page.goto(base + path);
  if (path.startsWith('/app/')) {
    await page.waitForFunction(() => window._app && (!location.search || window._app.project.name === 'Desk concept'));
    if (path.includes('example')) await page.waitForFunction(() => window._app.project.name === 'Desk concept');
    await page.waitForTimeout(300);
  }
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i })) });
  const drag = async (pts) => { await touch('touchStart', [pts[0]]); for (const p of pts.slice(1)) await touch('touchMove', [p]); await touch('touchEnd', []); };
  return { ctx, page, errors, touch, drag };
}
const app = (page, fn, arg) => page.evaluate(fn, arg);


const X = 640, Y = 400;
const lineLens = (page) => app(page, () => window._app.activeSketch().entities.filter(e => e.constructor.kind === 'line').map(l => Math.hypot(l.p2.x - l.p1.x, l.p2.y - l.p1.y)));
const kinds = (page) => app(page, () => window._app.activeSketch().constraints.map(c => c.kind).sort().join(','));
async function dragTo(page, from, to) {
  await page.mouse.move(...from); await page.mouse.down();
  for (let i = 1; i <= 15; i++) await page.mouse.move(from[0] + (to[0] - from[0]) * i / 15, from[1] + (to[1] - from[1]) * i / 15);
  await page.waitForTimeout(60);
  const snapped = await app(page, () => (window._app.lastDragSnaps || []).map(s => s.kind).join() || window._app.lastSnap?.kind || '');
  await page.mouse.up(); await page.waitForTimeout(200);
  return snapped;
}
const fixPoint = (page, kind, key) => app(page, ([kind, key]) => {
  const a = window._app, e = a.activeSketch().entities.find(e => e.constructor.kind === kind);
  a.clearSelection(); a.setSelected(e[key], true); a.toggleRelation('fix'); a.clearSelection(); a.refreshUI();
}, [kind, key]);

{
  const { ctx, page, errors } = await open({ viewport: { width: 1280, height: 800 } }, '/app/?new');
  // A line held at one end: dragging the other end onto it doesn't snap.
  await app(page, () => window._app.setTool('line'));
  await page.mouse.click(X, Y); await page.mouse.click(X + 200, Y + 60); await page.keyboard.press('Escape');
  await app(page, () => window._app.setTool('select'));
  await fixPoint(page, 'line', 'p1');
  // Snaps onto other points as before…
  await app(page, () => window._app.setTool('point'));
  await page.mouse.click(X + 300, Y - 80);
  await app(page, () => window._app.setTool('select'));
  await dragTo(page, [X + 200, Y + 60], [X + 300, Y - 80]);
  check((await kinds(page)).includes('coincident'), 'a line end still snaps onto another point');
  await page.keyboard.press('Control+z'); await page.waitForTimeout(150);
  // …but not onto its own other end.
  const snapped = await dragTo(page, [X + 200, Y + 60], [X + 1, Y + 1]);
  const [len] = await lineLens(page);
  check(len > 0.05 && !(await kinds(page)).includes('coincident'), `a line end dropped on its other end: no snap, no Coincident, length ${len.toFixed(3)} (snap: ${snapped || 'none'})`);
  check(!errors.length, `no page errors ${errors.join(' ')}`);
  await ctx.close();
}

{
  const { ctx, page, errors } = await open({ viewport: { width: 1280, height: 800 } }, '/app/?new');
  // Horizontal, then Vertical on one line: only a point is both. Refused,
  // with a word, and no undo step.
  await app(page, () => window._app.setTool('line'));
  await page.mouse.click(X, Y); await page.mouse.click(X + 200, Y + 60); await page.keyboard.press('Escape');
  await app(page, () => window._app.setTool('select'));
  await app(page, () => { const a = window._app, l = a.activeSketch().entities.find(e => e.constructor.kind === 'line'); a.clearSelection(); a.setSelected(l, true); a.refreshUI(); a.applyConstraint('horizontal'); });
  const undo0 = await app(page, () => window._app.undoStack.length);
  await app(page, () => { window._app.applyConstraint('vertical'); });
  await page.waitForTimeout(150);
  const [len] = await lineLens(page);
  const hint = await app(page, () => document.getElementById('status-hint')?.textContent || '');
  check(len > 10 && (await kinds(page)) === 'horizontal', `Vertical on a horizontal line is not added (length ${len.toFixed(2)}, ${await kinds(page)})`);
  check(/not added.*shrink Line/i.test(hint), `and the status bar says why (${hint})`);
  check(await app(page, () => /shrink Line/.test(document.body.innerText)), 'and a notice says it (visible on phones too)');
  check(await app(page, () => window._app.undoStack.length) === undo0, 'no undo step left for it');
  check(!errors.length, `no page errors ${errors.join(' ')}`);
  await ctx.close();
}

await browser.close();
server.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
