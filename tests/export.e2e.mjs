// End-to-end test of Export (every format free on every plan),
// and of the first-run steps with their activation events, on desktop and
// on a phone.
//
// Usage: node tests/export.e2e.mjs [rootDir]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

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
const base = `http://localhost:${server.address().port}/app/`;

const browser = await chromium.launch();
let failed = 0;
const check = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) failed++; };
const errors = [];
async function open(ctx, path = '') {
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(String(e)));
  page.on('dialog', d => { errors.push('native dialog: ' + d.message()); d.dismiss(); });
  page.on('console', m => { if (m.type() === 'error' && !/umami|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.route(/umami|supabase|jsdelivr/, r => r.abort());
  await page.addInitScript(() => { window.__ev = []; window.__onsketchTrack = (ev, data) => window.__ev.push({ ev, ...(data || {}) }); });
  await page.goto(base + path);
  await page.waitForFunction(() => window._app);
  await page.waitForTimeout(300);
  return page;
}
const events = (page, name) => page.evaluate((n) => window.__ev.filter(e => e.ev === n), name);

/* ---------------- Export: desktop ---------------- */
{
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await open(ctx, '?example=desk');
  await page.waitForFunction(() => window._app.activeSketch().entities.length > 4);
  check(!(await page.$('#guide')), 'an example opens without the first-run steps');
  // Selection and hover must not show in an export.
  await page.evaluate(() => { const a = window._app; a.setSelected(a.activeSketch().entities[0], true); a.requestRender(); });
  await page.click('#menubar [data-action="export"]');
  await page.waitForSelector('#export-modal .export-preview canvas');
  check(await page.isChecked('#export-modal [data-opt="dimensions"]'), 'Export opens with a preview; dimensions on, as on screen');
  if (process.env.SHOT_DIR) await page.screenshot({ path: process.env.SHOT_DIR + '/export-dialog.png' });

  // PNG: a real picture, 2×, white background.
  const [png] = await Promise.all([page.waitForEvent('download'), page.click('#export-modal [data-format="png"]')]);
  const pngBuf = await readFile(await png.path());
  const pngW = pngBuf.readUInt32BE(16), pngH = pngBuf.readUInt32BE(20);
  check(/\.png$/.test(png.suggestedFilename()) && pngBuf.subarray(1, 4).toString() === 'PNG' && Math.max(pngW, pngH) >= 2000 && pngBuf.length > 20000,
    `PNG downloads at 2× (${pngW} × ${pngH}, ${Math.round(pngBuf.length / 1024)} kB, ${png.suggestedFilename()})`);
  check(/PNG downloaded/.test(await page.textContent('#export-modal .account-msg')), 'the dialog confirms');

  // SVG: vector, with fills, shapes in ink (no state or selection colours), dimensions as text.
  const [svgDl] = await Promise.all([page.waitForEvent('download'), page.click('#export-modal [data-format="svg"]')]);
  const svg = (await readFile(await svgDl.path())).toString();
  const theme = await page.evaluate(async () => { const t = await import('/app/src/render/theme.js'); const th = t.getTheme('light'); return { selected: th.selected, under: th.under, ink: th.ink }; });
  check(svg.startsWith('<?xml') && /<svg xmlns/.test(svg) && svg.includes('<text') && (svg.match(/<path /g) || []).length > 10, 'SVG downloads: paths and dimension text');
  check(!svg.toLowerCase().includes(`stroke="${theme.selected.toLowerCase()}"`) && svg.toLowerCase().includes(`stroke="${theme.ink.toLowerCase()}"`), 'exported shapes are in ink: no selection or state colour');
  const shown = await page.evaluate(async (text) => {
    const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text.replace(/^<\?xml[^>]*>\s*/, ''));
    await img.decode(); return { w: img.naturalWidth, h: img.naturalHeight };
  }, svg);
  check(shown.w > 300 && shown.h > 100, `the SVG is a valid picture (${shown.w} × ${shown.h})`);
  // Without dimensions: no labels, and a tighter picture.
  await page.uncheck('#export-modal [data-opt="dimensions"]');
  const [svg2Dl] = await Promise.all([page.waitForEvent('download'), page.click('#export-modal [data-format="svg"]')]);
  const svg2 = (await readFile(await svg2Dl.path())).toString();
  check(!/1400/.test(svg2) && /1400/.test(svg), 'Dimensions off: the labels are left out');
  await page.check('#export-modal [data-opt="dimensions"]');

  // Copy image.
  await page.click('#export-modal [data-format="copy"]');
  await page.waitForFunction(() => /copied|can't copy/i.test(document.querySelector('#export-modal .account-msg').textContent));
  const clip = await page.evaluate(async () => { try { const items = await navigator.clipboard.read(); return items.flatMap(i => i.types); } catch (e) { return ['error: ' + e.message]; } });
  check(clip.includes('image/png'), `Copy image puts a PNG on the clipboard (${clip.join(', ')})`);

  check((await events(page, 'export')).length === 4, 'events: export (png, svg ×2, copy)');

  // DXF and printing: free, no plan needed.
  check(await page.evaluate(() => window._app.cloudPlan?.plan !== 'premium') && !(await page.$('#export-modal .pro-tag')), 'DXF and Print / PDF are offered without Pro');
  const [dxfDl] = await Promise.all([page.waitForEvent('download'), page.click('#export-modal [data-format="dxf"]')]);
  const dxf = (await readFile(await dxfDl.path())).toString();
  check(/\.dxf$/.test(dxfDl.suggestedFilename()) && dxf.includes('ENTITIES') && dxf.includes('LINE') && dxf.includes('CIRCLE') && dxf.trim().endsWith('EOF') && !(await page.$('.app-dialog')), 'free plan: DXF downloads straight away (lines, circle, EOF)');
  check(/\r\n700\r\n/.test(dxf) && /\r\n-700\r\n/.test(dxf), 'the DXF is at real size (the 1400 mm desk spans -700 to 700)');
  await page.evaluate(() => { window.__printed = null; window._app._printHook = (html, res) => { window.__printed = { html, pw: res.pw, ph: res.ph, scale: res.scale, fits: res.fits }; }; });
  check(/Auto \(1:10\)/.test(await page.textContent('#export-modal [data-opt="scale"]')), 'printing: Auto picks 1:10 for a 1.4 m desk on A4');
  await page.click('#export-modal [data-format="print"]');
  await page.waitForFunction(() => window.__printed);
  const pr = await page.evaluate(() => window.__printed);
  check(pr.scale === 10 && pr.fits && pr.pw === 297 && pr.ph === 210 && pr.html.includes('@page{size:297mm 210mm') && pr.html.includes('width="297mm"') && pr.html.includes('Scale 1:10'),
    'Print / PDF: one landscape A4 sheet at 1:10, sized in millimetres, with the scale written on it');
  // True scale: the 1400 mm desk is 140 mm on paper = 140 × 96 / 25.4 px in the sheet's own units.
  const deskPx = await page.evaluate(async () => {
    const m = await import('/app/src/render/export.js'); const a = window._app;
    const l = m.printLayout(a._exportSource(), { dimensions: true }, { paper: 'A4' });
    return 1400 * l.view.zoom;
  });
  check(Math.abs(deskPx - 140 * 96 / 25.4) < 0.01, `true scale: 1400 mm is drawn 140 mm wide (${(deskPx * 25.4 / 96).toFixed(2)} mm)`);
  await page.selectOption('#export-modal [data-opt="scale"]', '1');
  await page.evaluate(() => { window.__printed = null; });
  await page.click('#export-modal [data-format="print"]');
  await page.waitForSelector('.app-dialog');
  check(/larger than the sheet/.test(await page.textContent('.app-dialog h3')), 'a scale that doesn\'t fit warns before printing');
  await page.click('.app-dialog .btn');                 // Cancel
  await page.waitForFunction(() => !document.querySelector('.app-dialog'));
  check(await page.evaluate(() => window.__printed === null), '…and Cancel prints nothing');
  await page.keyboard.press('Escape');
  check(!(await page.$('#export-modal')), 'Esc closes Export');
  check(await page.evaluate(() => window._app.activeSketch().entities[0].selected === true), 'the selection is as it was after exporting');
  await ctx.close();
}

/* ---------------- Export: phone ---------------- */
{
  const ctx = await browser.newContext({ ...devices['iPhone 13'], acceptDownloads: true });
  const page = await open(ctx, '?example=desk');
  await page.waitForFunction(() => window._app.activeSketch().entities.length > 4);
  await page.tap('#more-btn');
  await page.tap('[data-more="export"]');
  await page.waitForSelector('#export-modal .export-preview canvas');
  const fit = await page.evaluate(() => { const m = document.querySelector('#export-modal .modal').getBoundingClientRect(); const b = [...document.querySelectorAll('#export-modal .btn')].map(x => x.getBoundingClientRect()); return { w: m.width, vw: innerWidth, inside: b.every(r => r.left >= 0 && r.right <= innerWidth), tall: Math.min(...b.map(r => r.height)) }; });
  check(fit.w <= fit.vw && fit.inside && fit.tall >= 34, `phone: ⋯ ▸ Export fits the screen with finger-sized buttons (${Math.round(fit.tall)} px)`);
  if (process.env.SHOT_DIR) await page.screenshot({ path: process.env.SHOT_DIR + '/export-phone.png' });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.tap('#export-modal [data-format="png"]')]);
  check(/\.png$/.test(dl.suggestedFilename()), 'phone: PNG downloads');
  await ctx.close();
}

/* ---------------- First run: desktop ---------------- */
for (const phone of [false, true]) {
  const tag = phone ? 'phone' : 'desktop';
  const ctx = await browser.newContext(phone ? { ...devices['iPhone 13'] } : { viewport: { width: 1400, height: 900 } });
  const page = await open(ctx);
  await page.waitForSelector('#guide');
  check(/Draw a rectangle/.test(await page.textContent('#guide')) && (await events(page, 'guide')).some(e => e.step === 'shown'), `${tag}: a first visit on an empty canvas shows step 1, Draw a rectangle`);
  const box = await page.locator('#canvas').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2 + (phone ? 60 : 0);
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i })) });
  const tap = async (x, y) => { if (!phone) { await page.mouse.click(x, y); return; } await touch('touchStart', [[x, y]]); await touch('touchEnd', []); await page.waitForTimeout(380); };
  await page.click('#guide [data-a="tool"]');
  check(await page.evaluate(() => window._app.toolName) === 'rectangle' && !(await page.$('#guide [data-a="tool"]')), `${tag}: the step's button picks the Rectangle tool`);
  const A = [cx - 70, cy - 20], B = [cx + 70, cy + 80];
  if (phone) { await touch('touchStart', [A]); for (let i = 1; i <= 8; i++) await touch('touchMove', [[A[0] + (B[0] - A[0]) * i / 8, A[1] + (B[1] - A[1]) * i / 8]]); await touch('touchEnd', []); await page.waitForTimeout(200); }
  else { await page.mouse.click(...A); await page.mouse.click(...B); }
  await page.waitForFunction(() => /Give it a size/.test(document.getElementById('guide').textContent));
  check(true, `${tag}: drawing the rectangle moves on to step 2, Give it a size`);
  await page.click('#guide [data-a="tool"]');
  await tap(cx, cy + 80); await tap(cx, cy + 115);
  if (phone) { await page.waitForSelector('#dimpad'); for (const k of ['clear', '1', '2', '0', 'enter']) await page.tap(`#dimpad [data-k="${k}"]`); }
  else { await page.waitForFunction(() => !!window._app._valueInput); await page.waitForTimeout(300);   /* the box takes the focus */ await page.keyboard.type('120'); await page.keyboard.press('Enter'); }
  await page.waitForFunction(() => /Colour it/.test(document.getElementById('guide').textContent));
  check(await page.evaluate(() => window._app.activeSketch().constraints.some(c => c.kind === 'distance' && Math.abs(c.value - 120) < 1e-6)), `${tag}: typing 120 sets the size and moves on to step 3, Colour it`);
  await page.click('#guide [data-a="tool"]');
  const inside = await page.evaluate(() => { const a = window._app, s = a.activeSketch(); let x = 0, y = 0, n = 0; for (const e of s.entities) for (const c of e.children()) { x += c.x; y += c.y; n++; } const p = a.view.worldToScreen({ x: x / n, y: y / n }); const r = a.canvas.getBoundingClientRect(); return [p.x + r.left, p.y + r.top]; });
  await tap(...inside);
  await page.waitForFunction(() => /That's the idea/.test(document.getElementById('guide').textContent));
  check(await page.evaluate(() => window._app.activeSketch().fills.length === 1), `${tag}: filling the rectangle finishes the steps`);
  const act = (await events(page, 'activation')).map(e => e.step + (e.guided ? '' : '?')).join(',');
  const done = await events(page, 'activated');
  check(act === 'shape,dimension,fill' && done.length === 1 && done[0].guided === true, `${tag}: activation is counted once per step, then "activated" (${act})`);
  if (process.env.SHOT_DIR) await page.screenshot({ path: process.env.SHOT_DIR + `/guide-${tag}.png` });
  await page.click('#guide [data-a="ok"]');
  check(!(await page.$('#guide')), `${tag}: Got it closes the card`);
  await page.waitForTimeout(700);
  await page.reload(); await page.waitForFunction(() => window._app); await page.waitForTimeout(300);
  check(!(await page.$('#guide')), `${tag}: it never comes back`);
  // Activation is once per browser: doing it all again counts nothing.
  await page.evaluate(() => { const a = window._app; a._skipConfirm = true; a.newProject(); });
  check(!(await page.$('#guide')) && (await events(page, 'activation')).length === 0, `${tag}: a later new sketch shows no steps and counts no activation twice`);
  await ctx.close();
}

/* ---------------- First run: skipping ---------------- */
{
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await open(ctx);
  await page.waitForSelector('#guide');
  await page.click('#guide [data-a="skip"]');
  check(!(await page.$('#guide')) && (await events(page, 'guide')).some(e => e.step === 'skipped' && e.at === 'shape'), '× hides the steps for good (guide: skipped, at shape)');
  // Unguided activation still counts.
  const box = await page.locator('#canvas').boundingBox();
  await page.keyboard.press('r');
  await page.mouse.click(box.x + 500, box.y + 300); await page.mouse.click(box.x + 650, box.y + 420);
  const act = await events(page, 'activation');
  check(act.length === 1 && act[0].step === 'shape' && act[0].guided === false, 'activation is counted without the guide too (guided: false)');
  await page.waitForTimeout(700);
  await page.reload(); await page.waitForFunction(() => window._app);
  check(!(await page.$('#guide')), 'a saved drawing reopens without the steps');
  await ctx.close();
}

check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
server.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
