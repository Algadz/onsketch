// Records the OnSketch demo (1280×720 .webm) used for the Lemon Squeezy store review
// and marketing. Needs a static server on http://localhost:8099 (python3 -m http.server 8099).
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const OUT = new URL('../marketing/raw/', import.meta.url).pathname;   // the .webm recording; encode with the commands in marketing/README.md
const W = 1280, H = 720;
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, recordVideo: { dir: OUT, size: { width: W, height: H } } });
const t0 = Date.now();
await ctx.route(/umami|jsdelivr|supabase/, r => r.abort());
await ctx.addInitScript(() => {
  localStorage.clear();
  localStorage.setItem('onsketch:prefs', JSON.stringify({ theme: 'light' }));
  addEventListener('DOMContentLoaded', () => {
    const css = document.createElement('style');
    css.textContent = `
      #demo-cursor { position: fixed; z-index: 99999; left: 0; top: 0; width: 22px; height: 22px; pointer-events: none; transform: translate(-3px, -2px); transition: none; }
      #demo-ripple { position: fixed; z-index: 99998; width: 34px; height: 34px; margin: -17px 0 0 -17px; border-radius: 50%; border: 3px solid #2563a5; pointer-events: none; opacity: 0; }
      #demo-ripple.go { animation: rip .45s ease-out; }
      @keyframes rip { from { opacity: .9; transform: scale(.3); } to { opacity: 0; transform: scale(1.3); } }
      #demo-caption { position: fixed; z-index: 99997; left: 50%; bottom: 46px; transform: translateX(-50%); padding: 12px 22px; border-radius: 12px;
        background: rgba(27,32,40,.92); color: #fff; font: 600 22px/1.3 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; letter-spacing: -.2px;
        box-shadow: 0 10px 30px rgba(0,0,0,.25); opacity: 0; transition: opacity .35s; pointer-events: none; white-space: nowrap; }
      #demo-caption.show { opacity: 1; }
      #demo-caption b { color: #7cbcff; }
      #demo-end { position: fixed; inset: 0; z-index: 100000; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px;
        background: rgba(238,241,244,.94); opacity: 0; transition: opacity .6s; pointer-events: none; font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
      #demo-end.show { opacity: 1; }
      #demo-end .t { font-size: 54px; font-weight: 800; color: #1b2028; letter-spacing: -1px; }
      #demo-end .t b { color: #2563a5; }
      #demo-end .s { font-size: 24px; color: #58616d; }
      #demo-end .u { font-size: 20px; color: #2563a5; font-weight: 600; }`;
    document.head.appendChild(css);
    const cur = document.createElement('div'); cur.id = 'demo-cursor';
    cur.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M3 2l7.5 19 2.6-7.9L21 10.5z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    const rip = document.createElement('div'); rip.id = 'demo-ripple';
    const cap = document.createElement('div'); cap.id = 'demo-caption';
    const end = document.createElement('div'); end.id = 'demo-end';
    end.innerHTML = '<svg viewBox="0 0 32 32" width="84" height="84"><rect width="32" height="32" rx="7" fill="#1b2028"/><path d="M7 23 C 11 9, 15 9, 16 16 S 21 24, 25 9" fill="none" stroke="#5aa9ff" stroke-width="3" stroke-linecap="round"/><circle cx="7" cy="23" r="2.6" fill="#fff"/><circle cx="25" cy="9" r="2.6" fill="#fff"/></svg><div class="t">On<b>Sketch</b></div><div class="s">Sketch to scale, in your browser.</div><div class="u">onsketch.io</div>';
    document.body.append(cur, rip, cap, end);
    const move = (e) => { cur.style.left = e.clientX + 'px'; cur.style.top = e.clientY + 'px'; };
    addEventListener('pointermove', move, true); addEventListener('mousemove', move, true);
    addEventListener('pointerdown', (e) => { rip.style.left = e.clientX + 'px'; rip.style.top = e.clientY + 'px'; rip.classList.remove('go'); void rip.offsetWidth; rip.classList.add('go'); }, true);
    window.__caption = (html) => { cap.classList.remove('show'); setTimeout(() => { cap.innerHTML = html; if (html) cap.classList.add('show'); }, html ? 180 : 0); };
    window.__end = () => end.classList.add('show');
  });
});
const page = await ctx.newPage();
await page.goto('http://localhost:8099/app/');
await page.waitForFunction(() => window._app && !document.documentElement.classList.contains('booting'));
// A tidy stage: Tools and Colors only, a view that fits a 1200 × 600 mm desk.
await page.evaluate(() => {
  const a = window._app;
  for (const w of ['props', 'layers', 'sketch', 'equations']) a.windows.toggle(w, false);
  a.windows.toggle('tools', true); a.windows.toggle('colors', true);
  a.view.zoom = 0.48; a.view.panX = 60; a.view.panY = 10; a.requestRender();
  document.getElementById('project-name').value = 'Desk';
  a.project.name = 'Desk';
});
const tReady = Date.now();
const box = await page.locator('#canvas').boundingBox();
const scr = async (x, y) => { const p = await page.evaluate(([x, y]) => window._app.view.worldToScreen({ x, y }), [x, y]); return { x: box.x + p.x, y: box.y + p.y }; };
const wait = (ms) => page.waitForTimeout(ms);
let mouse = { x: 640, y: 360 };
const glide = async (to, steps = 24) => { await page.mouse.move(to.x, to.y, { steps }); mouse = to; };
const click = async (to, steps = 24) => { await glide(to, steps); await wait(120); await page.mouse.click(to.x, to.y); await wait(160); };
const caption = (html) => page.evaluate((h) => window.__caption(h), html);
const type = async (text) => { for (const ch of text) { await page.keyboard.type(ch); await wait(90); } };

await page.mouse.move(mouse.x, mouse.y);
await wait(700);

// 1. Draw
await caption('<b>Sketch</b> it: lines, rectangles, circles…');
await page.keyboard.press('r'); await wait(400);
await click(await scr(-560, 270), 30);
await click(await scr(580, -290), 40);
await page.keyboard.press('Escape'); await wait(900);

// 2. Dimension
await caption('Give it <b>real dimensions</b>: it snaps to them');
await page.keyboard.press('d'); await wait(300);
await click(await scr(10, 270));                    // top edge
await click(await scr(10, 380), 18);                 // place above
await page.waitForSelector('.dim-input');
await wait(300); await page.locator('.dim-input').fill(''); await type('1200mm'); await wait(250); await page.keyboard.press('Enter'); await wait(900);
const top = await page.evaluate(() => { const l = window._app.activeSketch().entities.filter(e => e.constructor.kind === 'line'); return l.map(x => [x.p1.x, x.p1.y, x.p2.x, x.p2.y]); });
// pick the right-hand vertical edge, wherever it is now
const right = top.map(([a, b2, c, d]) => ({ x: (a + c) / 2, y: (b2 + d) / 2, v: Math.abs(a - c) < 1 })).filter(l => l.v).sort((p, q) => q.x - p.x)[0];
await click(await scr(right.x, right.y));
await click(await scr(right.x + 130, right.y), 18);
await page.waitForSelector('.dim-input');
await wait(300); await page.locator('.dim-input').fill(''); await type('600mm'); await wait(250); await page.keyboard.press('Enter'); await wait(1000);

// 3. Hole
await caption('Add details: a cable hole, <b>⌀ 80 mm</b>');
await page.keyboard.press('Escape'); await page.keyboard.press('c'); await wait(300);
const mid = await page.evaluate(() => { const ps = window._app.activeSketch().entities.filter(e => e.constructor.kind === 'line').flatMap(l => [l.p1, l.p2]);
  const xs = ps.map(p => p.x), ys = ps.map(p => p.y); return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2, top: Math.max(...ys), left: Math.min(...xs), right: Math.max(...xs), bottom: Math.min(...ys) }; });
await click(await scr(mid.x, mid.top - 110));
await click(await scr(mid.x + 45, mid.top - 110), 14);
await page.keyboard.press('Escape'); await page.keyboard.press('d'); await wait(250);
await click(await scr(mid.x + 40, mid.top - 110 + 15));
await click(await scr(mid.x + 120, mid.top - 30), 16);
await page.waitForSelector('.dim-input');
await wait(250); await page.locator('.dim-input').fill(''); await type('80mm'); await wait(250); await page.keyboard.press('Enter'); await wait(900);

// 4. Change a number: the drawing follows
await caption('Change a number: <b>the drawing follows</b>');
await page.keyboard.press('Escape'); await page.keyboard.press('s'); await wait(300);
const label = await page.evaluate(() => { const r = window._app.renderer.lastDimRects.find(r => Math.abs(r.constraint.value - 1200) < 1e-6); return r ? { x: r.x + r.w / 2, y: r.y + r.h / 2 } : null; });
if (label) {
  const L = { x: box.x + label.x, y: box.y + label.y };
  await click(L); await wait(250); await click(L, 4);
  await page.waitForSelector('.dim-input', { timeout: 3000 }).catch(() => {});
  if (await page.locator('.dim-input').count()) {
    await wait(300); await page.locator('.dim-input').fill(''); await type('1600mm'); await wait(250); await page.keyboard.press('Enter');
  }
}
await wait(400);
// Frame the (now wider) desk to the right of the windows, with a smooth zoom.
await page.evaluate(() => new Promise((done) => {
  const a = window._app; a.clearSelection?.(); a.selectionOrder = [];
  const ps = a.activeSketch().entities.flatMap(e => e.constructor.kind === 'line' ? [e.p1, e.p2] : []);
  const xs = ps.map(p => p.x), ys = ps.map(p => p.y);
  const l = Math.min(...xs), r = Math.max(...xs), b = Math.min(...ys), t = Math.max(...ys);
  const v = a.view, area = { x0: 300, x1: 1220, y0: 110, y1: 600 };            // screen region clear of the windows
  const z = Math.min((area.x1 - area.x0) / (r - l + 260), (area.y1 - area.y0) / (t - b + 240));
  const cx = (l + r) / 2, cy = (b + t) / 2, sx = (area.x0 + area.x1) / 2, sy = (area.y0 + area.y1) / 2;
  const to = { zoom: z, panX: sx - v.cssW / 2 - cx * z, panY: sy - v.cssH / 2 + cy * z };
  const from = { zoom: v.zoom, panX: v.panX, panY: v.panY }, t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / 700), e = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    v.zoom = from.zoom + (to.zoom - from.zoom) * e; v.panX = from.panX + (to.panX - from.panX) * e; v.panY = from.panY + (to.panY - from.panY) * e;
    a.requestRender();
    if (k < 1) requestAnimationFrame(step); else done();
  };
  requestAnimationFrame(step);
}));
await wait(900);

// 5. Fill and annotate
await caption('<b>Colour</b> it in and <b>sketch</b> notes on top');
const geo = await page.evaluate(() => {
  const s = window._app.activeSketch();
  const ps = s.entities.filter(e => e.constructor.kind === 'line').flatMap(l => [l.p1, l.p2]);
  const c = s.entities.find(e => e.constructor.kind === 'circle');
  const xs = ps.map(p => p.x), ys = ps.map(p => p.y);
  return { l: Math.min(...xs), r: Math.max(...xs), b: Math.min(...ys), t: Math.max(...ys), hx: c.center.x, hy: c.center.y, hr: c.r };
});
const swatch = async (c) => { const el = await page.locator(`#colors-body .palette .sw[data-c="${c}"]`).boundingBox(); return { x: el.x + el.width / 2, y: el.y + el.height / 2 }; };
await page.keyboard.press('b'); await wait(300);
await click(await swatch('#e07b00'));
await click(await scr(geo.l + 260, geo.b + 150));
await wait(700);
await page.keyboard.press('n'); await wait(250);
await click(await swatch('#d63a3a'));
const stroke = async (pts, steps = 7) => {
  const a0 = await scr(...pts[0]); await glide(a0, 16); await page.mouse.down();
  for (const pt of pts.slice(1)) { const q = await scr(...pt); await page.mouse.move(q.x, q.y, { steps }); }
  await page.mouse.up(); await wait(120);
};
const hx = geo.hx, hy = geo.hy, gap = geo.hr + 25;
await stroke([[hx + 330, hy - 260], [hx + 250, hy - 190], [hx + 160, hy - 110], [hx + gap * 0.75, hy - gap * 0.6]]);
await stroke([[hx + gap * 0.75 + 70, hy - gap * 0.6 - 10], [hx + gap * 0.75, hy - gap * 0.6], [hx + gap * 0.75 + 20, hy - gap * 0.6 - 70]], 6);
await stroke([[hx + 300, hy - 300], [hx + 340, hy - 315], [hx + 380, hy - 298], [hx + 420, hy - 312], [hx + 460, hy - 296]], 6);
await page.keyboard.press('s');
await glide({ x: 1180, y: 640 }, 20);
await wait(1400);

// 6. Save, share
await caption('Save to your account and <b>share</b> it in the library');
await glide(await (async () => { const el = await page.locator('#menubar [data-action="save"]').boundingBox(); return { x: el.x + el.width / 2, y: el.y + el.height / 2 }; })(), 30);
await wait(1600);
await caption('');
await page.evaluate(() => window.__end());
await wait(2600);
const tEnd = Date.now();
const video = page.video();
await ctx.close();
await b.close();
console.log(JSON.stringify({ path: await video.path(), start: (tReady - t0) / 1000, end: (tEnd - t0) / 1000, label: !!label }));
