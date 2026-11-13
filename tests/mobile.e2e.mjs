// Mobile end-to-end checks: phone layout, touch input and the landing page
// on emulated devices, plus a check that a desktop mouse session gets none
// of it. Usage: node tests/mobile.e2e.mjs [rootDir]
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
const lineMidOnScreen = (page, t = 0.5) => app(page, (t) => {
  const a = window._app, l = a.activeSketch().entities.find(e => e.constructor.kind === 'line' && a.isEntityInteractive(e));
  const s = a.view.worldToScreen({ x: l.p1.x + (l.p2.x - l.p1.x) * t, y: l.p1.y + (l.p2.y - l.p1.y) * t }); const r = a.canvas.getBoundingClientRect();
  return { x: s.x + r.left, y: s.y + r.top, id: l.id };
}, t);

/* ---------------- Phone: iPhone 13 portrait ---------------- */
{
  const { ctx, page, errors, touch, drag } = await open(devices['iPhone 13']);
  const m = await app(page, () => ({ compact: document.documentElement.classList.contains('compact'), sw: document.documentElement.scrollWidth,
    iw: innerWidth, vh: innerHeight, canvasH: document.getElementById('canvas').getBoundingClientRect().height,
    open: [...document.querySelectorAll('.fwin')].filter(w => !w.hidden).length, bar: !!document.querySelector('#mobilebar [data-slot]') }));
  check(m.compact && m.bar, 'phone: phone layout with a bottom bar');
  check(m.sw === m.iw && m.iw === 390, `phone: page is exactly the screen width (${m.sw} / ${m.iw})`);
  check(m.open === 0 && m.canvasH / m.vh > 0.7, `phone: no window open, canvas ${Math.round(m.canvasH / m.vh * 100)}% of the height`);

  // Draw fly-out → rectangle by two taps.
  await page.tap('[data-slot="draw"]');
  await page.tap('#mb-flyout [data-id="rectangle"]');
  const n0 = await app(page, () => window._app.activeSketch().entities.length);
  await page.touchscreen.tap(60, 420); await page.touchscreen.tap(160, 500);
  check(await app(page, () => window._app.activeSketch().entities.length) === n0 + 4, 'phone: Draw ▸ Rectangle, two taps draw it');
  check(await app(page, () => !!document.querySelector('#optbar [data-touch="done"]')), 'phone: drawing tools show Done');
  await page.tap('#optbar [data-touch="done"]');

  // Line: one drag = one line (placed on lift); tap–tap chains; tap the last point to end.
  await app(page, () => window._app.setTool('line'));
  const lines = () => app(page, () => window._app.activeSketch().entities.filter(e => e.constructor.kind === 'line').length);
  const L0 = await lines();
  await drag(Array.from({ length: 10 }, (_, i) => [60 + i * 24, 140]));
  check(await lines() === L0 + 1 && await app(page, () => !window._app.tool.startPt), 'phone: Line, one drag draws one line, placed on lift');
  await drag(Array.from({ length: 10 }, (_, i) => [60 + i * 24, 200 + i * 3]));
  check(await lines() === L0 + 2, 'phone: Line, a second drag draws a second, separate line');
  await page.touchscreen.tap(60, 260); await page.waitForTimeout(350);
  check(await lines() === L0 + 2 && await app(page, () => !!window._app.tool.startPt), 'phone: Line, a tap sets the start only');
  await drag(Array.from({ length: 8 }, (_, i) => [100 + i * 20, 300]));
  check(await lines() === L0 + 3, 'phone: Line, the next touch aims the end and places it on lift');
  await page.touchscreen.tap(240, 300); await page.waitForTimeout(350);
  check(await lines() === L0 + 3 && await app(page, () => !window._app.tool.startPt), 'phone: Line, tapping the last point ends the chain');
  const doneBox = await page.locator('#optbar [data-touch="done"]').boundingBox();
  check(doneBox && doneBox.x + doneBox.width <= 390, 'phone: Done is on screen without scrolling the options bar');
  await app(page, () => window._app.setTool('select'));

  // Pen with one finger.
  await page.tap('[data-slot="paint"]'); await page.tap('#mb-flyout [data-id="pen"]');
  const s0 = await app(page, () => window._app.activeSketch().strokes.length);
  await drag(Array.from({ length: 12 }, (_, i) => [60 + i * 20, 120 + i * 6]));
  check(await app(page, () => window._app.activeSketch().strokes.length) === s0 + 1, 'phone: one-finger drag draws with the pen');

  // Pinch zooms the drawing, not the page.
  const z0 = await app(page, () => window._app.view.zoom);
  await touch('touchStart', [[150, 300], [240, 330]]);
  for (let i = 1; i <= 8; i++) await touch('touchMove', [[150 - i * 8, 300 - i * 6], [240 + i * 8, 330 + i * 6]]);
  await touch('touchEnd', []);
  const z1 = await app(page, () => [window._app.view.zoom, visualViewport.scale]);
  check(z1[0] > z0 * 1.5 && z1[1] === 1, `phone: pinch zooms the drawing (${z0.toFixed(2)} → ${z1[0].toFixed(2)}), page scale ${z1[1]}`);
  check(await app(page, () => window._app.activeSketch().strokes.length) === s0 + 1, 'phone: pinching does not draw');
  await page.tap('#more-btn'); await page.tap('[data-more="zoom-fit"]');

  // Tap to select, Delete in the options bar, two-finger tap undo.
  await page.tap('[data-slot="select"]');
  let lm = await lineMidOnScreen(page);
  await page.touchscreen.tap(lm.x + 2, lm.y + 5);
  check(await app(page, () => window._app.selectedEntitiesAndPoints().length) === 1, 'phone: a tap near a line selects it (finger tolerance)');
  const fab = await app(page, () => { const b = document.getElementById('fab-delete').getBoundingClientRect();
    return { shown: !document.getElementById('fab-delete').hidden && b.width > 0, inside: b.left >= 0 && b.right <= innerWidth && b.bottom <= innerHeight, nudge: !!document.querySelector('#optbar [data-nudge]') }; });
  check(fab.shown && fab.inside && fab.nudge, `phone: a selection shows an on-screen Delete button and nudge arrows (${JSON.stringify(fab)})`);
  const count = () => app(page, () => { const s = window._app.activeSketch(); return s.entities.length + s.constraints.length; });
  const e0 = await count();
  await page.tap('#fab-delete');
  const e1 = await count();
  await touch('touchStart', [[120, 200], [200, 210]]); await touch('touchEnd', []);
  const e2 = await count();
  check(e1 < e0 && e2 === e0, `phone: Delete removes, two-finger tap undoes (${e0} → ${e1} → ${e2})`);

  // Long press: context menu with the shape actions, Delete included
  // (at 75%: the rest of this edge carries dimension labels).
  lm = await lineMidOnScreen(page, 0.75);
  await touch('touchStart', [[lm.x, lm.y]]); await page.waitForTimeout(600); await touch('touchEnd', []);
  const menu = await app(page, () => [...document.querySelectorAll('#context-menu .action')].map(e => e.dataset.action).join(','));
  check(/construction/.test(menu) && /midpoint/.test(menu) && /delete/.test(menu), `phone: long press opens the shape menu (${menu})`);
  const beforeDel = await count();
  await page.tap('#context-menu [data-action="delete"]');
  check(await count() < beforeDel, 'phone: Delete in the long-press menu removes the shape');
  await touch('touchStart', [[120, 200], [200, 210]]); await touch('touchEnd', []);

  // Dimensions: tap the label then Delete; long press the label for its menu.
  await app(page, () => { window._app.clearSelection(); window._app.requestRender(); });
  await page.waitForTimeout(100);
  const dimAt = () => app(page, () => { const a = window._app, r = a.renderer.lastDimRects.find(x => x.constraint.name === 'D4'), c = a.canvas.getBoundingClientRect();
    return { x: c.left + r.x + r.w / 2, y: c.top + r.y + r.h / 2 }; });
  let da = await dimAt();
  await touch('touchStart', [[da.x, da.y]]); await page.waitForTimeout(600); await touch('touchEnd', []);
  const dmenu = await app(page, () => [document.querySelector('#context-menu .context-menu-title')?.textContent, [...document.querySelectorAll('#context-menu .action')].map(e => e.dataset.action).join(',')]);
  check(/Dimension D4/.test(dmenu[0]) && dmenu[1] === 'edit,delete', `phone: long press on a dimension offers Edit value and Delete (${dmenu})`);
  await page.tap('#context-menu [data-action="delete"]');
  const gone = await app(page, () => !window._app.activeSketch().constraints.some(c => c.name === 'D4'));
  check(gone, 'phone: Delete dimension removes it');
  await touch('touchStart', [[120, 200], [200, 210]]); await touch('touchEnd', []);
  await page.waitForTimeout(100);
  da = await dimAt();
  await page.touchscreen.tap(da.x, da.y);
  const fabDim = await app(page, () => !document.getElementById('fab-delete').hidden);
  await page.tap('#fab-delete');
  check(fabDim && await app(page, () => !window._app.activeSketch().constraints.some(c => c.name === 'D4')), 'phone: tap a dimension, then the Delete button removes it');
  check(await app(page, () => document.getElementById('fab-delete').hidden), 'phone: the Delete button hides when nothing is selected');

  // Panels as bottom sheets, one at a time.
  await page.tap('[data-slot="panels"]'); await page.tap('#mb-flyout [data-id="panel:layers"]');
  await page.tap('[data-slot="panels"]'); await page.tap('#mb-flyout [data-id="panel:colors"]');
  const sheets = await app(page, () => [...document.querySelectorAll('.fwin')].filter(w => !w.hidden).map(w => [w.dataset.win, Math.round(w.getBoundingClientRect().left), Math.round(w.getBoundingClientRect().width)]));
  check(sheets.length === 1 && sheets[0][0] === 'colors' && sheets[0][1] === 0 && sheets[0][2] === 390, `phone: panels open as one full-width sheet (${JSON.stringify(sheets)})`);
  const head = await page.locator('.fwin[data-win="colors"] .fwin-head').boundingBox();
  await drag([[head.x + 150, head.y + 15], [head.x + 150, head.y + 60], [head.x + 150, head.y + 120]]);
  check(await app(page, () => document.querySelector('.fwin[data-win="colors"]').hidden), 'phone: swiping a sheet down closes it');

  // ⋯ menu toggles.
  // (Right after the sheet swipe the first tap can land while the sheet is
  // still closing; tap again if the menu didn't open.)
  await page.waitForTimeout(250);
  await page.tap('#more-btn');
  if (!(await page.locator('[data-more="grid"]').isVisible())) { await page.waitForTimeout(250); await page.tap('#more-btn'); }
  await page.tap('[data-more="grid"]');
  check(await app(page, () => window._app.gridOn) === false, 'phone: ⋯ menu toggles the grid');

  // Keypad for dimensions.
  await app(page, () => { const a = window._app; a.requestRender(); });
  await page.waitForTimeout(100);
  await app(page, () => { const a = window._app; a.editDimValue(a.activeSketch().constraints.find(c => c.name === 'D1')); });
  await page.waitForSelector('#dimpad');
  for (const k of ['clear', '1', '.', '6', 'm', 'enter']) await page.tap(`#dimpad [data-k="${k}"]`);
  await page.waitForTimeout(200);
  const d1 = await app(page, () => window._app.activeSketch().constraints.find(c => c.name === 'D1').value);
  check(d1 === 1600 && !(await page.isVisible('#dimpad')), `phone: dimension keypad types 1.6m (D1 = ${d1})`);

  // Tap a dimension, tap it again: the value box opens and stays open, even
  // when the phone's late compatibility mousedown takes the focus away (it
  // used to close at once: a flicker), and even with a relation badge in
  // finger reach of the label.
  await app(page, () => { const a = window._app; a.clearSelection(); a.refreshUI(); a.requestRender(); });
  await page.waitForTimeout(150);
  const lbl = await app(page, () => {
    const a = window._app, c = a.canvas.getBoundingClientRect();
    const r = a.renderer.lastDimRects.find(x => !x.constraint.driven && !a.hitRelationAtScreen(x.x + x.w / 2, x.y + x.h / 2)
      && a.hitDimAtScreen(x.x + x.w / 2, x.y + x.h / 2) === x.constraint);
    return { x: c.left + r.x + r.w / 2, y: c.top + r.y + r.h / 2, name: r.constraint.name };
  });
  await page.touchscreen.tap(lbl.x, lbl.y);
  await page.waitForTimeout(400);
  const picked = await app(page, () => window._app.activeSketch().constraints.filter(c => c.selected).map(c => c.name).join());
  check(picked === lbl.name, `phone: a tap selects dimension ${lbl.name} (${picked})`);
  await page.touchscreen.tap(lbl.x, lbl.y);
  await page.waitForSelector('.dim-input');
  await page.waitForTimeout(30);
  await app(page, () => document.activeElement?.blur());       // what the late mousedown does
  await page.waitForTimeout(300);
  check(await page.isVisible('.dim-input') && await app(page, () => document.activeElement?.classList.contains('dim-input')),
    `phone: tapping a selected dimension (${lbl.name}) opens its value box and it stays open`);
  await page.tap('#dimpad [data-k="cancel"]');
  await page.waitForTimeout(150);
  check(!(await page.isVisible('.dim-input')), 'phone: Cancel closes the value box');

  check(errors.length === 0, `phone: no page errors${errors.length ? ': ' + errors.join(' / ') : ''}`);
  await ctx.close();
}

/* ---------------- Phone in landscape ---------------- */
{
  const { ctx, page, errors } = await open(devices['iPhone 13 landscape']);
  const m = await app(page, () => { const b = document.getElementById('mobilebar').getBoundingClientRect();
    return { land: document.documentElement.classList.contains('compact-land'), w: b.width, h: b.height, sw: document.documentElement.scrollWidth, iw: innerWidth }; });
  check(m.land && m.h > m.w && m.sw === m.iw, `landscape phone: tools on a side rail, no overflow (${JSON.stringify(m)})`);
  check(errors.length === 0, 'landscape phone: no page errors');
  await ctx.close();
}

/* ---------------- Pixel 7 ---------------- */
{
  const { ctx, page, errors } = await open(devices['Pixel 7']);
  const m = await app(page, () => ({ compact: document.documentElement.classList.contains('compact'), sw: document.documentElement.scrollWidth, iw: innerWidth }));
  check(m.compact && m.sw === m.iw, `Pixel 7: phone layout, no overflow (${m.sw} / ${m.iw})`);
  check(errors.length === 0, 'Pixel 7: no page errors');
  await ctx.close();
}

/* ---------------- Tablet: desktop layout, touch input ---------------- */
{
  const { ctx, page, errors, touch, drag } = await open(devices['iPad (gen 7)']);
  check(!(await app(page, () => document.documentElement.classList.contains('compact'))) && await page.isVisible('[data-window="layers"]'),
    'iPad: keeps the desktop layout');
  await app(page, () => { for (const w of ['tools', 'sketch', 'colors', 'layers', 'props']) window._app.windows.toggle(w, false); window._app.setTool('pen'); });
  const s0 = await app(page, () => window._app.activeSketch().strokes.length);
  await drag(Array.from({ length: 10 }, (_, i) => [200 + i * 25, 300 + i * 4]));
  check(await app(page, () => window._app.activeSketch().strokes.length) === s0 + 1, 'iPad: finger drawing works');
  await app(page, () => window._app.setTool('select'));
  const lm = await lineMidOnScreen(page);
  await touch('touchStart', [[lm.x, lm.y]]); await page.waitForTimeout(600); await touch('touchEnd', []);
  check(await app(page, () => !!document.getElementById('context-menu')), 'iPad: long press opens the menu');
  check(errors.length === 0, 'iPad: no page errors');
  await ctx.close();
}

/* ---------------- Landing page on a phone ---------------- */
{
  const { ctx, page, errors } = await open(devices['iPhone 13'], '/');
  await page.waitForLoadState('networkidle');
  const m = await app(page, () => {
    const svg = document.getElementById('demo').getBoundingClientRect();
    const lbl = parseFloat(getComputedStyle(document.querySelector('#demo .lbl text')).fontSize) * svg.width / 560;
    const sw = document.querySelector('.swatches button').getBoundingClientRect();
    const img = document.querySelector('.window img');
    return { sw: document.documentElement.scrollWidth, iw: innerWidth, lbl, swatch: sw.width, hero: img.currentSrc, nav: document.querySelector('.nav-btn').getBoundingClientRect().width };
  });
  check(m.sw === m.iw, `landing: no horizontal overflow (${m.sw} / ${m.iw})`);
  check(m.lbl >= 10.5, `landing: demo labels readable (${m.lbl.toFixed(1)} px)`);
  check(m.swatch >= 32 && m.nav >= 40, `landing: finger-sized swatches (${m.swatch}) and arrows (${m.nav})`);
  check(/app-preview-phone\.webp/.test(m.hero), 'landing: phones get the light hero image');
  check(errors.length === 0, 'landing: no page errors');
  await ctx.close();
}

/* ---------------- Desktop mouse: none of the above ---------------- */
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(base + '/app/'); await page.waitForFunction(() => window._app);
  await page.mouse.move(600, 400); await page.mouse.down(); await page.mouse.up();
  const m = await app(page, () => ({ cls: document.documentElement.className, bar: getComputedStyle(document.getElementById('mobilebar')).display,
    more: getComputedStyle(document.getElementById('more-btn')).display, fab: getComputedStyle(document.getElementById('fab-delete')).display, tol: window._app.snap.tolPx, badge: window._app.renderer.badgeSize }));
  check(!/compact|touch-ui/.test(m.cls) && m.bar === 'none' && m.more === 'none' && m.fab === 'none' && m.tol === 10 && !m.badge, `desktop: no phone or touch UI (${JSON.stringify(m)})`);
  const narrow = await browser.newContext({ viewport: { width: 600, height: 700 } });
  const p2 = await narrow.newPage(); await p2.goto(base + '/app/'); await p2.waitForFunction(() => window._app);
  check(!(await p2.evaluate(() => document.documentElement.classList.contains('compact'))), 'desktop: a narrow mouse window keeps the desktop layout');
  await narrow.close();
  await ctx.close();
}

await browser.close();
server.close();
process.exit(failed ? 1 : 0);
