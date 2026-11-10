// End-to-end test: grid / snap / dimensions / relations are saved with the
// project and restored when it opens, in headless Chromium.
// Usage: node tests/display.e2e.mjs [rootDir]
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
page.on('pageerror', e => errors.push(String(e)));
page.on('dialog', d => { errors.push('native dialog: ' + d.message()); d.dismiss(); });
page.on('console', m => { if (m.type() === 'error' && !/umami|Failed to load resource/.test(m.text())) errors.push(m.text()); });
page.route(/umami/, r => r.abort());
let failed = 0;
const check = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) failed++; };

await page.addInitScript(() => { try { localStorage.setItem('onsketch:prefs', JSON.stringify({ theme: 'light' })); } catch { /* none */ } });
await page.goto(`http://localhost:${port}/app/`);
await page.waitForFunction(() => window._app);


const state = () => page.evaluate(() => {
  const a = window._app;
  return {
    app: a.displaySettings(),
    project: a.project.display,
    buttons: ['grid', 'snap', 'dimensions', 'relations'].map(k => document.querySelector(`#menubar [data-action="${k}"]`).classList.contains('on')),
  };
});

let s = await state();
check(JSON.stringify(s.app) === JSON.stringify(s.project), 'a new drawing carries the current display');

// Turn grid, relations and dimensions off from the toolbar, snap off with its button.
for (const k of ['grid', 'snap', 'relations', 'dimensions']) await page.click(`#menubar [data-action="${k}"]`);
s = await state();
check(s.buttons.every(b => !b) && s.project.grid === false && s.project.snap === false
  && s.project.relations === false && s.project.dimensions === false, 'toggling writes into the project');
const undoLen = await page.evaluate(() => window._app.undoStack.length);
check(undoLen <= 1, `toggling is not an undo step (${undoLen})`);

// Draw something, then undo: the toggles don't come back.
await page.keyboard.press('l');
const b = await page.locator('#canvas').boundingBox();
await page.mouse.click(b.x + 300, b.y + 300);
await page.mouse.click(b.x + 500, b.y + 300);
await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
await page.evaluate(() => window._app.undo());
s = await state();
check(s.app.grid === false && s.app.relations === false && s.buttons.every(x => !x), 'undo keeps the current display');

// Reload: the saved project opens with the same display, even though the
// browser preferences say otherwise.
await page.evaluate(() => { window._app._writeLocal(); localStorage.setItem('onsketch:prefs', JSON.stringify({ theme: 'light' })); });
await page.reload();
await page.waitForFunction(() => window._app);
s = await state();
check(s.app.grid === false && s.app.snap === false && s.app.relations === false && s.app.dimensions === false && s.buttons.every(x => !x),
  `a reload opens with the project's display (${JSON.stringify(s.app)})`);

// Opening another project (as from the account / an example) applies its display.
await page.evaluate(() => {
  const a = window._app;
  const json = a.project.toJSON();
  json.display = { grid: true, snap: true, dimensions: true, relations: false, dimNames: true };
  a._openCloudRow({ id: 'x', name: 'Other', data: json, updated_at: new Date().toISOString() });
});
s = await state();
check(s.app.grid && s.app.snap && s.app.dimensions && !s.app.relations && s.app.dimNames && JSON.stringify(s.buttons) === JSON.stringify([true, true, true, false]),
  'opening a project applies its own display');
await page.evaluate(() => window._app._cloudUnlink?.());

// A file from before (no display) keeps the current setup and takes it on.
await page.evaluate(() => {
  const a = window._app;
  a.setGridVisible(false);
  const json = a.project.toJSON(); delete json.display;
  a._openCloudRow({ id: 'y', name: 'Old', data: json, updated_at: new Date().toISOString() });
});
s = await state();
check(s.app.grid === false && s.project && s.project.grid === false, 'an older file keeps the current setup');
await page.evaluate(() => window._app._cloudUnlink?.());

// New sketch: inherits the current setup.
await page.evaluate(() => { const a = window._app; a._skipConfirm = true; return a.newProject(); });
s = await state();
check(s.project && s.project.grid === false && JSON.stringify(s.app) === JSON.stringify(s.project), 'a new sketch starts with the current setup');

check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' / ') : ''}`);
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
