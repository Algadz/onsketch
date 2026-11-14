// The context menu on a selection: its relations, then the ones to add.
// Usage: node tests/relmenu.e2e.mjs [rootDir]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
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

// Two free lines, drawn with the line tool.
async function twoLines(page) {
  const r = await app(page, () => { const b = window._app.canvas.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; });
  const at = (fx, fy) => [r.x + r.w * fx, r.y + r.h * fy];
  for (const [a, b] of [[at(0.42, 0.3), at(0.68, 0.36)], [at(0.42, 0.55), at(0.7, 0.65)]]) {
    await app(page, () => window._app.setTool('line'));
    await page.mouse.click(...a); await page.mouse.click(...b); await page.keyboard.press('Escape');
  }
  await app(page, () => window._app.setTool('select'));
  return linesOnScreen(page);
}
// A point 30 % along each line, on screen (lines move when relations solve).
const linesOnScreen = (page) => app(page, () => {
  const a = window._app, r = a.canvas.getBoundingClientRect();
  return a.activeSketch().entities.filter(e => e.constructor.kind === 'line').map(l => {
    const s = a.view.worldToScreen({ x: l.p1.x + (l.p2.x - l.p1.x) * 0.3, y: l.p1.y + (l.p2.y - l.p1.y) * 0.3 });
    return { id: l.id, x: s.x + r.left, y: s.y + r.top };
  });
});
const pick = async (page, ...ls) => {
  await app(page, () => { window._app.clearSelection(); window._app.refreshUI(); });
  for (const [i, l] of ls.entries()) {
    if (i) await page.keyboard.down('Control');
    await page.mouse.click(l.x, l.y);
    if (i) await page.keyboard.up('Control');
  }
};
const menuText = (page) => app(page, () => document.getElementById('context-menu')?.innerText.replace(/\s*\n\s*/g, ' | ') || '');
const rows = (page) => app(page, () => [...document.querySelectorAll('#context-menu .cm-rel')].map(r => r.querySelector('.cm-rel-name').textContent));
const chips = (page) => app(page, () => [...document.querySelectorAll('#context-menu .cm-chip')].map(c => c.dataset.rel));
const kinds = (page) => app(page, () => window._app.activeSketch().constraints.map(c => c.kind).sort().join(','));

/* ---------------- Desktop: right-click ---------------- */
{
  const { ctx, page, errors } = await open({ viewport: { width: 1280, height: 800 } }, '/app/?new');
  let [l1, l2] = await twoLines(page);
  check(l1 && l2, 'two lines drawn');
  const base0 = await kinds(page);

  // Not selected: the usual menu (what is under the cursor).
  await page.mouse.click(l1.x, l1.y, { button: 'right' });
  check(!(await app(page, () => document.getElementById('context-menu')?.classList.contains('cm-selection'))), 'right-click on an unselected line: the usual menu');
  await page.keyboard.press('Escape'); await app(page, () => window._app.hideContextMenu());

  // Two selected, nothing between them: only chips.
  await pick(page, l1, l2);
  await page.mouse.click(l2.x, l2.y, { button: 'right' });
  let t = await menuText(page);
  check(/2 items/i.test(t) && (await rows(page)).length === 0 && (await chips(page)).includes('parallel'), `two lines: header, no relation yet, Parallel offered (${t})`);
  check(/Delete|construction/i.test(t), 'two lines: the usual actions follow');
  await page.click('#context-menu .cm-chip[data-rel="parallel"]');
  check(!(await app(page, () => !!window._app.contextMenuEl)) && (await kinds(page)).includes('parallel'), 'a chip adds the relation and closes the menu');

  // Now it is between them.
  await page.mouse.click(l2.x, l2.y, { button: 'right' });
  check(JSON.stringify(await rows(page)) === '["Parallel"]' && !(await chips(page)).includes('parallel'), `two lines: Parallel listed, no longer offered (${await rows(page)})`);
  await app(page, () => window._app.hideContextMenu());

  // One selected: its relations, with what they tie it to.
  await pick(page, l1);
  await page.mouse.click(l1.x, l1.y, { button: 'right' });
  t = await menuText(page);
  check(/Parallel/.test(t) && new RegExp('with Line ' + l2.id, 'i').test(t), `one line: its Parallel, "with" the other line (${t})`);
  check((await chips(page)).join() === 'horizontal,vertical,fix', `one line: Horizontal / Vertical / Fix offered (${await chips(page)})`);

  // × removes it and keeps the menu open, rebuilt.
  await page.click('#context-menu .cm-rel .cm-del');
  check(await app(page, () => !!window._app.contextMenuEl) && (await rows(page)).length === 0 && (await kinds(page)) === base0, '× removes the relation; the menu stays, rebuilt');
  await app(page, () => window._app.hideContextMenu());
  await page.keyboard.press('Control+z');
  check((await kinds(page)).includes('parallel'), 'Undo brings it back');

  // A relation on one line alone isn't "between" two selected lines.
  await pick(page, l1);
  await page.mouse.click(l1.x, l1.y, { button: 'right' });
  await page.click('#context-menu .cm-chip[data-rel="horizontal"]');
  await page.waitForTimeout(100);
  [l1, l2] = await linesOnScreen(page);
  await pick(page, l1, l2);
  await page.mouse.click(l1.x, l1.y, { button: 'right' });
  check(JSON.stringify(await rows(page)) === '["Parallel"]', `two lines: one line's Horizontal is not listed between them (${await rows(page)})`);
  await app(page, () => window._app.hideContextMenu());

  // Tapping a relation selects it.
  await pick(page, l1);
  await page.mouse.click(l1.x, l1.y, { button: 'right' });
  await page.click('#context-menu .cm-rel .cm-rel-name');
  check(await app(page, () => { const s = window._app.selectedEntitiesAndPoints(); return s.length === 1 && ['horizontal', 'parallel'].includes(s[0].kind); }), 'clicking a relation selects it');
  check(!errors.length, `desktop: no page errors ${errors.join(' ')}`);
  await ctx.close();
}

/* ---------------- Phone: long press ---------------- */
{
  const { ctx, page, errors, touch } = await open(devices['iPhone 13'], '/app/?new');
  const [l1, l2] = await twoLines(page);
  await page.touchscreen.tap(l1.x, l1.y); await page.waitForTimeout(400);
  await touch('touchStart', [[l1.x, l1.y]]); await page.waitForTimeout(600); await touch('touchEnd', []);
  await page.waitForTimeout(150);
  const t = await menuText(page);
  check(/line/i.test(t) && (await chips(page)).includes('horizontal'), `phone: long press on the selected line shows its relations menu (${t})`);
  const size = await app(page, () => { const b = document.querySelector('#context-menu .cm-chip').getBoundingClientRect(); return b.height; });
  check(size >= 36, `phone: finger-sized chips (${size}px)`);
  await page.waitForTimeout(400);
  await page.tap('#context-menu .cm-chip[data-rel="horizontal"]');
  check((await kinds(page)).includes('horizontal'), 'phone: a chip adds the relation');
  check(l2 && !errors.length, `phone: no page errors ${errors.join(' ')}`);
  await ctx.close();
}

await browser.close();
server.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
