// End-to-end test of text, text boxes, groups and linked ink, driven like a
// user (keyboard, clicks, right-click menus) in headless Chromium.
// Usage: node tests/ink.e2e.mjs [rootDir] [screenshotPath]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const root = resolve(process.argv[2] || new URL('..', import.meta.url).pathname);
const shot = process.argv[3] || null;
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
const box = await page.locator('#canvas').boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
const ink = () => page.evaluate(() => window._app.activeSketch().strokes.map(s => ({
  kind: s.kind, text: s.text, box: s.box || null, group: s.group || null, link: s.link?.to || null,
  x: s.points[0].x, y: s.points[0].y, selected: !!s.selected,
})));
const toScreen = (w) => page.evaluate((w) => { const s = window._app.view.worldToScreen(w); const r = window._app.canvas.getBoundingClientRect(); return { x: s.x + r.left, y: s.y + r.top }; }, w);

// A horizontal line, 200 px long, dimensioned so it can be changed later.
await page.keyboard.press('l');
await page.mouse.click(cx - 100, cy + 80);
await page.mouse.click(cx + 100, cy + 80);
await page.keyboard.press('Escape');
await page.keyboard.press('Escape');
const lineId = await page.evaluate(() => window._app.activeSketch().entities.find(e => e.constructor.kind === 'line').id);

// ---- Text tool: click, type, Enter ----
await page.keyboard.press('t');
check(await page.evaluate(() => window._app.toolName === 'text'), 'T selects the Text tool');
check(await page.isVisible('.fwin[data-win="sketch"] [data-tool="text"]'), 'Text is in the Sketch window');
await page.mouse.click(cx - 40, cy + 40);
await page.waitForSelector('textarea.text-edit');
await page.keyboard.type('Kitchen');
await page.keyboard.press('Shift+Enter');
await page.keyboard.type('12 m2');
check((await ink()).length === 0, 'a text is not in the drawing until it is finished');
await page.keyboard.press('Enter');
let items = await ink();
check(items.length === 1 && items[0].kind === 'text' && items[0].text === 'Kitchen\n12 m2', `Enter finishes; Shift+Enter made a second line (${JSON.stringify(items[0]?.text)})`);
check(!(await page.$('textarea.text-edit')), 'editor closed');

// Click away with an empty new text: nothing is added, no undo step.
const undoBefore = await page.evaluate(() => window._app.undoStack.length);
await page.mouse.click(cx + 250, cy - 200);
await page.waitForSelector('textarea.text-edit');
await page.mouse.click(cx + 300, cy - 250);                 // finishes the empty one, starts nothing
check(!(await page.$('textarea.text-edit')) && (await ink()).length === 1
  && await page.evaluate(() => window._app.undoStack.length) === undoBefore, 'an empty text leaves no trace');

// ---- Box: Outlined, a tint colour, from the Sketch window ----
await page.click('.fwin[data-win="sketch"] [data-boxmode="outline"]');
await page.click('.fwin[data-win="sketch"] [data-boxcolor="#fff3b0"]');
await page.mouse.click(cx + 120, cy - 120);
await page.waitForSelector('textarea.text-edit');
const editorBg = await page.$eval('textarea.text-edit', el => getComputedStyle(el).backgroundColor);
check(editorBg === 'rgb(255, 243, 176)', `the inline editor shows the box colour (${editorBg})`);
await page.keyboard.type('Note');
await page.keyboard.press('Escape');                          // Esc also finishes (keeps the text)
items = await ink();
check(items.length === 2 && items[1].text === 'Note' && items[1].box?.border === true && items[1].box?.color === '#fff3b0',
  `new text takes the box settings (${JSON.stringify(items[1]?.box)})`);
await page.click('.fwin[data-win="sketch"] [data-boxmode="none"]');

// ---- Select: click, Properties, box from Properties, double-click to edit ----
await page.keyboard.press('s');
const t0 = await toScreen({ x: items[0].x + 2, y: items[0].y - 2 });
await page.mouse.click(t0.x, t0.y);
check((await ink())[0].selected, 'clicking a text selects it');
check(await page.isVisible('#sel-body textarea[data-ink-k="text"]'), 'Properties shows the text');
await page.click('#sel-body [data-ink-boxmode="box"]');
check(JSON.stringify((await ink())[0].box) === '{"color":"#fff3b0"}', 'Properties → Box adds a box in the last box colour');
await page.mouse.dblclick(t0.x, t0.y);
await page.waitForSelector('textarea.text-edit');
await page.keyboard.press('End');
await page.keyboard.type('!');
await page.keyboard.press('Enter');
check((await ink())[0].text === 'Kitchen\n12 m2!', 'double-click edits a text in place');

// ---- Link by right-click → "Link to a shape…" → click the line ----
await page.mouse.click(t0.x, t0.y);
await page.mouse.click(t0.x, t0.y, { button: 'right' });
await page.waitForSelector('#context-menu [data-action="link"]');
const menuText = await page.textContent('#context-menu');
check(/Edit text/.test(menuText) && /Link to a shape/.test(menuText), `right-click on a text offers its actions (${menuText.replace(/\s+/g, ' ').trim()})`);
await page.click('#context-menu [data-action="link"]');
check(await page.evaluate(() => !!window._app.linkPick), 'link pick mode is on');
const mid = await toScreen(await page.evaluate((id) => { const l = window._app.activeSketch().entities.find(e => e.id === id); return { x: (l.p1.x + l.p2.x) / 2 + 3, y: l.p1.y }; }, lineId));
await page.mouse.click(mid.x, mid.y);
items = await ink();
check(items[0].link === lineId, `the text is linked to the line (${items[0].link})`);

// Changing the geometry carries the text: move the line by 10 units up.
const before = items[0], noteBefore = items[1];
await page.evaluate((id) => {
  const a = window._app, l = a.activeSketch().entities.find(e => e.id === id);
  l.p1.y += 10; l.p2.y += 10; a.commit();
}, lineId);
items = await ink();
check(Math.abs(items[0].y - before.y - 10) < 1e-6 && Math.abs(items[0].x - before.x) < 1e-6, 'linked text follows the line');
check(items[1].x === noteBefore.x && items[1].y === noteBefore.y, 'unlinked text stays');
await page.evaluate(() => window._app.undo());
items = await ink();
check(Math.abs(items[0].y - before.y) < 1e-3, 'undo puts the text back with the line');   // saved to 1/1000

// ---- Link the other way: ink selected, right-click the line ----
const t1 = await toScreen({ x: items[1].x + 1, y: items[1].y - 1 });
await page.mouse.click(t1.x, t1.y);
await page.mouse.click(mid.x, mid.y, { button: 'right' });
await page.waitForSelector('#context-menu [data-action="link-here"]');
await page.click('#context-menu [data-action="link-here"]');
check((await ink())[1].link === lineId, 'right-click a shape → "Link selected text to this line"');

// Dragging linked ink re-places it and keeps the link (no double move later).
const tn = await toScreen({ x: items[1].x + 1, y: items[1].y - 1 });
await page.mouse.move(tn.x, tn.y);
await page.mouse.down();
await page.mouse.move(tn.x + 40, tn.y, { steps: 4 });
await page.mouse.up();
const dragged = (await ink())[1];
await page.evaluate((id) => { const a = window._app, l = a.activeSketch().entities.find(e => e.id === id); l.p1.x += 5; l.p2.x += 5; a.commit(); }, lineId);
const after = (await ink())[1];
check(dragged.link === lineId && Math.abs(after.x - dragged.x - 5) < 1e-6, 'dragged linked text keeps its link from the new spot');

// ---- Group with Ctrl+G: one click selects both, they move together ----
await page.mouse.click(cx + 400, cy + 300);                   // clear
await page.keyboard.press('n');
await page.mouse.move(cx - 300, cy - 130); await page.mouse.down();
await page.mouse.move(cx - 250, cy - 80, { steps: 5 }); await page.mouse.up();
await page.keyboard.press('s');
await page.evaluate(() => { const a = window._app; a.clearSelection(); for (const s of a.activeSketch().strokes) if (s.kind === 'pen' || s.text === 'Note') s.selected = true; a.refreshUI(); });
await page.keyboard.press('Control+g');
items = await ink();
const g = items.find(i => i.kind === 'pen').group;
check(g && items.find(i => i.text === 'Note').group === g, 'Ctrl+G groups the selected ink');
check(items.find(i => i.kind === 'pen').link === lineId, 'the stroke joins the group\'s link');
await page.mouse.click(cx + 400, cy + 300);
const pen = await toScreen((await page.evaluate(() => window._app.activeSketch().strokes.find(s => s.kind === 'pen').points[0])));
await page.mouse.click(pen.x, pen.y);
check((await ink()).filter(i => i.selected).length === 2, 'clicking one grouped item selects the group');
await page.mouse.click(pen.x, pen.y, { button: 'right' });
await page.waitForSelector('#context-menu [data-action="ungroup"]');
check(/Ungroup/.test(await page.textContent('#context-menu')), 'the menu offers Ungroup');
await page.click('#context-menu [data-action="unlink"]');
check((await ink()).filter(i => i.selected).every(i => !i.link), 'Unlink frees the group');
if (shot) {
  await page.evaluate(() => { const a = window._app; a.clearSelection(); a.activeSketch().strokes[0].selected = true; a.requestRender(); });
  await page.screenshot({ path: shot });
}

// Reload keeps everything.
await page.evaluate(() => window._app._writeLocal());
await page.reload();
await page.waitForFunction(() => window._app);
items = await ink();
check(items.length === 3 && items[0].box?.color === '#fff3b0' && items[0].link === lineId && !!items[1].group, 'texts, boxes, groups and links survive a reload');

check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' / ') : ''}`);
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
