// End-to-end test: no browser context menu in the editor (right-click opens
// only the app menu), except in text fields.
//
// Usage: node tests/ctxmenu.e2e.mjs [rootDir]
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
page.route(/umami/, r => r.abort());
let failed = 0;
const check = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) failed++; };
await page.goto(`http://localhost:${port}/app/`);
await page.waitForFunction(() => window._app);
const P = (id, x, y) => ({ type: 'point', id, x, y });
await page.evaluate((proj) => {
  const a = window._app; a.project = a.project.constructor.fromJSON(proj); a._afterStateSwap();
  a.view.zoom = 5; a.view.panX = 0; a.view.panY = 0; a.commit({ diagnostics: 'sync' }); a.setTool('select'); a.refreshUI();
}, { version: 3, activeLayerId: 'l', layers: [{ id: 'l', name: 'L' }],
  sketches: [{ id: 's', name: 'S', entities: [{ type: 'line', id: 'A', p1: P('a', -30, 0), p2: P('b', 30, 0) }], constraints: [] }] });

// Record what the browser would do with every contextmenu event: a window
// listener registered last sees whether the page prevented it.
await page.evaluate(() => {
  window.__ctx = [];
  window.addEventListener('contextmenu', (e) => window.__ctx.push({ on: e.target.id || e.target.className || e.target.tagName, prevented: e.defaultPrevented }));
});
const box = await page.locator('#canvas').boundingBox();
const at = await page.evaluate(() => { const a = window._app, p = a.view.worldToScreen({ x: 10, y: 0 }); return p; });
await page.mouse.click(box.x + at.x, box.y + at.y, { button: 'right' });
await page.waitForSelector('#context-menu');
check(await page.isVisible('#context-menu'), 'right-click on a line opens the app menu');
let log = await page.evaluate(() => window.__ctx);
check(log.length > 0 && log.every(e => e.prevented), `the browser menu is blocked (${JSON.stringify(log)})`);

// Windows fires contextmenu on mouse-up, after the app menu is open under
// the cursor: aimed at the app menu, not the canvas.
const fire = (sel) => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
  el.dispatchEvent(ev);
  return ev.defaultPrevented;
}, sel);
check(await fire('#context-menu .context-menu-item'), 'over the app menu (Windows: mouse-up): blocked');
check(await fire('#canvas'), 'over the canvas: blocked');
check(await fire('#menubar'), 'over the menu bar: blocked');
check(await fire('.fwin'), 'over a window: blocked');
check(!(await fire('#project-name')), 'in a text field: the browser menu stays (copy, paste)');

check(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
server.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
