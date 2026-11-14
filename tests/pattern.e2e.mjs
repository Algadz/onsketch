// Linear, circular and point patterns, driven like a user: Tools window,
// the panel in Properties, picks on the canvas, linked copies following
// the seed, editing (live, Done / Cancel / Undo), equations, unlinking.
// Usage: node tests/pattern.e2e.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const root = resolve(new URL('..', import.meta.url).pathname);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
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
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error' && !/umami|Failed to load resource/.test(m.text())) errors.push(m.text()); });
const nativeDialogs = [];
page.on('dialog', d => { nativeDialogs.push(d.message()); d.dismiss(); });
page.route(/umami/, r => r.abort());

let failed = 0;
const check = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) failed++; };
const near = (a, b, tol = 1e-3) => Math.abs(a - b) <= tol;

await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('onsketch:prefs', JSON.stringify({ theme: 'light' })); } catch {} });
await page.goto(`http://localhost:${port}/app/`);
await page.waitForFunction(() => window._app);
const box = await page.locator('#canvas').boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
const app = (fn, arg) => page.evaluate(fn, arg);
const circles = () => app(() => window._app.activeSketch().entities
  .filter(e => e.constructor.kind === 'circle').map(c => ({ x: c.center.x, y: c.center.y, r: c.r, id: c.id })));
const pattern = () => app(() => {
  const c = window._app.activeSketch().constraints.find(k => k.kind === 'pattern');
  return c ? { type: c.type, params: c.params, n: c.instances.length, seeds: c.seeds, skipped: c.skipped } : null;
});
const screen = (p) => app((p) => { const s = window._app.view.worldToScreen(p); const r = window._app.canvas.getBoundingClientRect(); return { x: s.x + r.left, y: s.y + r.top }; }, p);
const fill = async (path, text) => {
  const sel = '#pf-' + path.replace('.', '\\.');
  await page.fill(sel, text);
  await page.locator(sel).press('Enter');
};
const empty = async () => { await page.mouse.click(box.x + 330, box.y + box.height - 60); };   // clears the selection

/* ---------------- Linear: Tools window, defaults, preview, create ---------------- */
await page.keyboard.press('c');
await page.mouse.click(cx + 100, cy + 100); await page.mouse.click(cx + 120, cy + 100);   // r = 5 mm
await page.keyboard.press('Escape'); await page.keyboard.press('s');
await page.mouse.click(cx + 120, cy + 100);                                                // select the circle
await page.locator('.fwin[data-win="tools"] [data-action="linear-pattern"]').click();
check(await app(() => window._app.operationName === 'pattern' && window._app.pattern.seeds.length === 1), 'linear: the selection becomes the seed');
check(await page.locator('#tool-options-title').textContent() === 'Pattern', 'linear: the panel shows in Properties');
check((await page.locator('#pattern-create').textContent()).includes('Create 2 copies'), 'linear: 3 instances by default = 2 copies');
const sp = await app(() => window._app.pattern.params.d1.spacing);
check(sp >= 15 && sp <= 20, `linear: default spacing leaves a gap of about a seed (${sp} mm for a 10 mm circle)`);
check(await app(() => (window._app.getPatternPreview()?.circles || []).length === 2), 'linear: dashed preview of the copies');
await fill('d1.spacing', '25');
await page.locator('.pat-stepper [data-step="d1.count"][data-d="1"]').click();
check((await page.locator('#pattern-create').textContent()).includes('Create 3 copies'), 'linear: + adds an instance');
await page.keyboard.press('Enter');                                                        // Enter creates
let cs = await circles();
check(cs.length === 4 && near(cs[3].x - cs[0].x, 75), `linear: 4 circles, 25 mm apart (${cs.map(c => c.x).join(', ')})`);
check(!!(await pattern()), 'linear: kept linked (a pattern relation)');
check(await app(() => window._app.operationName === null), 'linear: the operation ends');

/* ---------------- Linked: the copies follow the seed ---------------- */
await empty();
let seedAt = await screen(cs[0]);
await page.mouse.move(seedAt.x, seedAt.y); await page.mouse.down();
await page.mouse.move(seedAt.x + 20, seedAt.y - 40, { steps: 6 }); await page.mouse.up();
let cs2 = await circles();
check(near(cs2[0].y - cs[0].y, 10, 0.5) && near(cs2[3].y, cs2[0].y) && near(cs2[3].x - cs2[0].x, 75), 'linked: dragging the seed moves the copies with it');
const copyRim = await screen({ x: cs2[2].x + cs2[2].r, y: cs2[2].y });
await page.mouse.move(copyRim.x, copyRim.y); await page.mouse.down();
await page.mouse.move(copyRim.x + 12, copyRim.y, { steps: 6 }); await page.mouse.up();
cs2 = await circles();
check(cs2.every(c => near(c.r, cs2[0].r)) && cs2[0].r > 6, `linked: resizing a copy resizes them all (r = ${cs2[0].r.toFixed(2)})`);
check(await app(() => window._app.activeSketch().constraints.some(c => c.kind === 'pattern') && document.getElementById('status-solve').textContent.startsWith('solved')), 'linked: the drawing still solves');

/* ---------------- Properties: pattern card, relation badge ---------------- */
await page.mouse.click((await screen({ x: cs2[1].x + cs2[1].r, y: cs2[1].y })).x, (await screen({ x: cs2[1].x + cs2[1].r, y: cs2[1].y })).y);
check(await page.locator('#sel-body .pat-card').count() === 1, 'properties: a copy shows its pattern card');
check((await page.locator('#sel-body .pat-card').textContent()).includes('Linear pattern'), 'properties: card names the pattern');
check(await app(() => window._app.renderer.lastRelRects.some(r => r.constraint.kind === 'pattern')), 'canvas: a ▦ badge on the seed');

/* ---------------- Edit: live, Cancel, Done, Undo ---------------- */
await page.locator('#sel-body [data-pattern-edit]').click();
check(await app(() => window._app.pattern?.mode === 'edit'), 'edit: Edit opens the pattern');
check((await page.locator('#tool-options-title').textContent()) === 'Edit linear pattern', 'edit: titled Edit linear pattern');
const firstIds = (await circles()).map(c => c.id);
await fill('d1.count', '6');
check((await circles()).length === 6, 'edit: changing the count adds copies at once');
check((await circles()).slice(0, 4).every((c, i) => c.id === firstIds[i]), 'edit: existing copies keep their ids');
await page.keyboard.press('Escape');
check((await circles()).length === 4 && await app(() => window._app.operationName === null), 'edit: Esc cancels, drawing as before');
await page.locator('#sel-body [data-pattern-edit]').first().click().catch(async () => {
  await app(() => { const a = window._app; a.editPattern(a.activeSketch().constraints.find(c => c.kind === 'pattern')); });
});
if (!(await app(() => window._app.pattern?.mode === 'edit'))) await app(() => { const a = window._app; a.editPattern(a.activeSketch().constraints.find(c => c.kind === 'pattern')); });
await fill('d1.spacing', '15');
await page.locator('[data-dir2]').check({ force: true });
await fill('d2.spacing', '30');
await page.locator('#pattern-done').click();
cs = await circles();
check(cs.length === 8, `edit: Direction 2 makes a 4 × 2 grid (${cs.length} circles)`);
check(cs.some(c => near(c.x - cs[0].x, 45) && near(c.y - cs[0].y, 30)), 'edit: grid spacing 15 × 30, direction 2 at 90°');
check(near(cs[0].x, cs2[0].x) && near(cs[0].y, cs2[0].y), 'edit: the seed stays where it was');
await page.keyboard.press('Control+z');
check((await circles()).length === 4, 'edit: one Undo takes the whole edit back');
await page.keyboard.press('Control+y');
check((await circles()).length === 8, 'edit: Redo');

/* ---------------- Equations ---------------- */
await app(async () => {
  const a = window._app, s = a.activeSketch();
  const seed = s.entities.find(e => e.id === s.constraints.find(c => c.kind === 'pattern').seeds[0]);
  a.clearSelection(); a.setSelected(seed, true);
});
await app(() => { const a = window._app; a.editPattern(a.activeSketch().constraints.find(c => c.kind === 'pattern')); });
await fill('d1.spacing', '=width * 2');                    // unknown name: refused
check(await page.locator('#pf-d1\\.spacing').evaluate(el => el.classList.contains('bad')), 'equations: an unknown name is flagged');
await app(() => { const a = window._app; a.project.variables.push({ name: 'pitch', expr: '12' }); a._applyEquations(); });
await fill('d1.spacing', '=pitch * 2');
await page.locator('#pattern-done').click();
cs = await circles();
check(cs.some(c => near(c.x - cs[0].x, 72)), 'equations: spacing = pitch * 2 (24 mm)');
await app(() => { const a = window._app; a.project.variables[0].expr = '10'; a.commit(); });
cs = await circles();
check(cs.some(c => near(c.x - cs[0].x, 60)) && !cs.some(c => near(c.x - cs[0].x, 72)), 'equations: changing pitch re-spaces the copies');

/* ---------------- Deleting a copy skips it; deleting the relation unlinks ---------------- */
await app(() => {
  const a = window._app, s = a.activeSketch(), c = s.constraints.find(k => k.kind === 'pattern');
  const copy = s.entities.find(e => e.id === c.instances[0].pairs.find(p => p[2] === 'r')[1]);
  a.clearSelection(); a.setSelected(copy, true); a.deleteSelection();
});
const p1 = await pattern();
check(p1 && p1.skipped.length === 1 && (await circles()).length === 7, 'delete: deleting a copy leaves that instance out, the pattern stays');
await app(() => { const a = window._app, c = a.activeSketch().constraints.find(k => k.kind === 'pattern'); a.clearSelection(); a.setSelected(c, true); a.refreshUI(); });
check(await page.locator('#sel-body [data-pattern-unlink]').count() === 1, 'properties: the pattern relation offers Edit / Unlink / Delete copies');
await page.keyboard.press('Delete');
check(!(await pattern()) && (await circles()).length === 7, 'delete: deleting the pattern relation keeps the copies (unlinked)');
await page.keyboard.press('Control+z');

/* ---------------- Circular: centre on empty canvas ---------------- */
await page.keyboard.press('Control+z');
await app(() => { const a = window._app; for (const s of a.project.sketches) { s.entities = []; s.constraints = []; } a.commit(); a.refreshUI(); });
await page.keyboard.press('l');
await page.mouse.click(cx + 120, cy); await page.mouse.click(cx + 160, cy);
await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await page.keyboard.press('s');
await page.mouse.click(cx + 140, cy);
await page.locator('.fwin[data-win="tools"] [data-action="circular-pattern"]').click();
check(await app(() => window._app.pattern.pick === 'center'), 'circular: with a seed, it asks for the centre next');
check(await page.locator('#pattern-create').isDisabled(), 'circular: Create waits for a centre');
await page.mouse.click(cx + 3, cy + 2);                      // empty canvas (snaps to the origin)
check(await app(() => !!window._app.pattern.params.center?.pending), 'circular: a click on empty canvas sets a new centre');
await fill('count', '4');
await page.locator('#pattern-create').click();
const lines = await app(() => window._app.activeSketch().entities.filter(e => e.constructor.kind === 'line').map(l => [l.p1.x, l.p1.y, l.p2.x, l.p2.y]));
check(lines.length === 4 && lines.some(l => near(l[0], 0, 0.6) && near(l[1], 30, 0.6)), `circular: 4 spokes a quarter turn apart (${lines.map(l => l.map(v => v.toFixed(1)).join(',')).join(' | ')})`);
check(await app(() => window._app.activeSketch().entities.some(e => e.constructor.kind === 'point')), 'circular (linked): the new centre is a point of the drawing');

/* ---------------- Points: targets, box-select, unlinked ---------------- */
await app(() => { const a = window._app; for (const s of a.project.sketches) { s.entities = []; s.constraints = []; } a.commit(); a.refreshUI(); });
await page.keyboard.press('r');
await page.mouse.click(cx + 100, cy - 100); await page.mouse.click(cx + 130, cy - 80);
await page.keyboard.press('p');
await page.mouse.click(cx + 250, cy - 50);
await page.mouse.click(cx + 300, cy + 50);
await page.keyboard.press('Escape'); await page.keyboard.press('s');
await page.mouse.move(cx + 90, cy - 110); await page.mouse.down(); await page.mouse.move(cx + 140, cy - 70, { steps: 5 }); await page.mouse.up();
await page.locator('.fwin[data-win="tools"] [data-action="point-pattern"]').click();
check(await app(() => window._app.pattern.pick === 'targets' && !!window._app.pattern.params.origin), 'points: origin defaults to a seed corner, targets next');
await page.mouse.move(cx + 230, cy - 70); await page.mouse.down(); await page.mouse.move(cx + 320, cy + 70, { steps: 5 }); await page.mouse.up();
check(await app(() => window._app.pattern.params.targets.length === 2), 'points: box-select adds the points inside as targets');
await page.mouse.click(cx - 50, cy + 150);                   // empty canvas: a new target
check(await app(() => window._app.pattern.params.targets.length === 3), 'points: a click on empty canvas adds a target');
await page.locator('#pattern-linked').uncheck({ force: true });
await page.locator('#pattern-create').click();
const res = await app(() => { const s = window._app.activeSketch(); return { lines: s.entities.filter(e => e.constructor.kind === 'line').length,
  points: s.entities.filter(e => e.constructor.kind === 'point').length, pats: s.constraints.filter(c => c.kind === 'pattern').length,
  hv: s.constraints.filter(c => c.kind === 'horizontal' || c.kind === 'vertical').length }; });
check(res.lines === 16 && res.pats === 0, `points (unlinked): 3 plain copies of the rectangle (${res.lines} lines, no pattern)`);
check(res.hv === 16, `points (unlinked): copies keep the rectangle's relations (${res.hv} horizontal / vertical)`);
check(res.points === 2, 'points (unlinked): no point is made for the clicked spot');

/* ---------------- Context menu, saving ---------------- */
await empty();
await page.locator('.fwin[data-win="tools"] [data-action="linear-pattern"]').click();
await page.mouse.click(cx + 115, cy - 100);                 // a seed line
check(!(await page.locator('#pattern-linked').isChecked()), 'link: the last choice (unlinked) is remembered');
await page.locator('#pattern-linked').check({ force: true });
await page.keyboard.press('Enter');
const lineMid = await app(() => { const a = window._app, s = a.activeSketch(); const c = s.constraints.find(k => k.kind === 'pattern');
  const l = s.entities.find(e => e.id === c.instances[0].pairs.find(p => p[2] === 'e')[1]);
  const p = a.view.worldToScreen({ x: (l.p1.x + l.p2.x) / 2, y: (l.p1.y + l.p2.y) / 2 }); const r = a.canvas.getBoundingClientRect(); return { x: p.x + r.left, y: p.y + r.top }; });
await page.mouse.click(lineMid.x, lineMid.y, { button: 'right' });
check(await page.getByText('Edit linear pattern…').count() === 1, 'context menu: Edit linear pattern… on a copy');
await page.keyboard.press('Escape');
const saved = await app(() => JSON.stringify(window._app.project.toJSON()));
const back = await app((json) => { const s = window._app.project.constructor.fromJSON(JSON.parse(json)).sketches[0]; const c = s.constraints.find(k => k.kind === 'pattern'); return c && c.instances.length; }, saved);
check(back === 2, 'saving: the pattern loads back with its copies');

check(nativeDialogs.length === 0, 'no browser pop-ups');
check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
