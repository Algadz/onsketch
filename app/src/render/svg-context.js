/* =============== SVG DRAWING CONTEXT ===========================
   Stands in for a canvas 2D context and writes SVG instead of pixels,
   so the renderer that paints the screen also produces the vector
   export: what is exported is what is drawn, with no second drawing
   code to keep in step.

   Only what the renderer uses is covered: paths (lines, arcs, arcTo,
   quadratic curves, rectangles, rounded rectangles), fill and stroke
   with dashes, caps and joins, text (fill and outline), pictures,
   transforms, global alpha, save / restore. Coordinates are written
   already transformed; curves become cubic Béziers so they stay exact
   under any transform.
   ============================================================ */
const TAU = Math.PI * 2;
const num = (n) => { const r = Math.round(n * 1000) / 1000; return Object.is(r, -0) ? '0' : String(r); };
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** "rgba(r,g,b,a)" → ['rgb(r,g,b)', a]; anything else → [colour, 1].
 *  (rgba() in fill / stroke isn't understood by every SVG reader.) */
export function splitColor(c) {
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+%?))?\s*\)$/i.exec(String(c).trim());
  if (!m) return [String(c), 1];
  let a = 1;
  if (m[4] != null) a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  const hex = (v) => Math.max(0, Math.min(255, Math.round(+v))).toString(16).padStart(2, '0');
  return ['#' + hex(m[1]) + hex(m[2]) + hex(m[3]), Math.max(0, Math.min(1, a))];
}

/** Canvas font shorthand ("600 11px a, b") → SVG attributes. */
export function parseFont(font) {
  const m = /^\s*((?:(?:italic|oblique|normal|bold|bolder|lighter|\d{3})\s+)*)([\d.]+)px(?:\/[\d.]+(?:px|%)?)?\s+(.+)$/i.exec(font || '');
  if (!m) return { size: 10, family: 'sans-serif', weight: null, italic: false };
  const pre = m[1].toLowerCase().split(/\s+/).filter(Boolean);
  const weight = pre.find(w => /^(bold|bolder|lighter|\d{3})$/.test(w)) || null;
  return { size: parseFloat(m[2]), family: m[3].trim(), weight, italic: pre.includes('italic') || pre.includes('oblique') };
}

const STATE = ['strokeStyle', 'fillStyle', 'lineWidth', 'lineCap', 'lineJoin', 'globalAlpha', 'font', 'textAlign', 'textBaseline',
  'globalCompositeOperation', 'imageSmoothingEnabled', 'imageSmoothingQuality'];

export class SvgContext {
  /** `width` × `height` in px; `measure` is a real 2D context used for
   *  text widths (optional: without one, widths are estimated). */
  constructor(width, height, measure = null) {
    this.width = width; this.height = height;
    this._measure = measure;
    this.strokeStyle = '#000'; this.fillStyle = '#000'; this.lineWidth = 1;
    this.lineCap = 'butt'; this.lineJoin = 'miter'; this.globalAlpha = 1;
    this.font = '10px sans-serif'; this.textAlign = 'start'; this.textBaseline = 'alphabetic';
    this.globalCompositeOperation = 'source-over';
    this.imageSmoothingEnabled = true; this.imageSmoothingQuality = 'low';
    this._dash = [];
    this._m = [1, 0, 0, 1, 0, 0];
    this._stack = [];
    this._d = [];
    this._cur = null;            // current point, user space
    this._start = null;          // start of the sub-path, user space
    this.out = [];
  }

  /* ---- state ---- */
  save() {
    const s = { _dash: this._dash.slice(), _m: this._m.slice() };
    for (const k of STATE) s[k] = this[k];
    this._stack.push(s);
  }
  restore() {
    const s = this._stack.pop();
    if (!s) return;
    for (const k of STATE) this[k] = s[k];
    this._dash = s._dash; this._m = s._m;
  }
  setLineDash(d) { this._dash = Array.isArray(d) ? d.filter(v => Number.isFinite(v) && v >= 0) : []; }
  getLineDash() { return this._dash.slice(); }

  /* ---- transforms ---- */
  setTransform(a, b, c, d, e, f) { this._m = typeof a === 'object' && a ? [a.a, a.b, a.c, a.d, a.e, a.f] : [a, b, c, d, e, f]; }
  resetTransform() { this._m = [1, 0, 0, 1, 0, 0]; }
  transform(a, b, c, d, e, f) {
    const m = this._m;
    this._m = [m[0] * a + m[2] * b, m[1] * a + m[3] * b, m[0] * c + m[2] * d, m[1] * c + m[3] * d,
      m[0] * e + m[2] * f + m[4], m[1] * e + m[3] * f + m[5]];
  }
  translate(x, y) { this.transform(1, 0, 0, 1, x, y); }
  scale(x, y) { this.transform(x, 0, 0, y, 0, 0); }
  rotate(a) { const c = Math.cos(a), s = Math.sin(a); this.transform(c, s, -s, c, 0, 0); }
  _pt(x, y) { const m = this._m; return num(m[0] * x + m[2] * y + m[4]) + ' ' + num(m[1] * x + m[3] * y + m[5]); }
  /** Uniform scale of the current transform (line widths, dashes). */
  _k() { const m = this._m; return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1; }

  /* ---- paths ---- */
  beginPath() { this._d = []; this._cur = null; this._start = null; }
  moveTo(x, y) { this._d.push('M' + this._pt(x, y)); this._cur = { x, y }; this._start = { x, y }; }
  lineTo(x, y) {
    if (!this._cur) { this.moveTo(x, y); return; }
    this._d.push('L' + this._pt(x, y)); this._cur = { x, y };
  }
  closePath() { if (this._cur) { this._d.push('Z'); this._cur = this._start ? { ...this._start } : null; } }
  quadraticCurveTo(cx, cy, x, y) {
    if (!this._cur) this.moveTo(cx, cy);
    this._d.push('Q' + this._pt(cx, cy) + ' ' + this._pt(x, y)); this._cur = { x, y };
  }
  bezierCurveTo(c1x, c1y, c2x, c2y, x, y) {
    if (!this._cur) this.moveTo(c1x, c1y);
    this._d.push('C' + this._pt(c1x, c1y) + ' ' + this._pt(c2x, c2y) + ' ' + this._pt(x, y)); this._cur = { x, y };
  }
  rect(x, y, w, h) {
    this.moveTo(x, y); this.lineTo(x + w, y); this.lineTo(x + w, y + h); this.lineTo(x, y + h); this.closePath();
  }
  roundRect(x, y, w, h, r = 0) {
    r = Array.isArray(r) ? (r[0] ?? 0) : r;
    r = Math.max(0, Math.min(+r || 0, Math.abs(w) / 2, Math.abs(h) / 2));
    if (!r) { this.rect(x, y, w, h); return; }
    this.moveTo(x + r, y);
    this.arcTo(x + w, y, x + w, y + h, r);
    this.arcTo(x + w, y + h, x, y + h, r);
    this.arcTo(x, y + h, x, y, r);
    this.arcTo(x, y, x + w, y, r);
    this.closePath();
  }
  arc(x, y, r, a0, a1, ccw = false) {
    let sweep = a1 - a0;
    if (!ccw) {
      if (sweep >= TAU) sweep = TAU;
      else { sweep %= TAU; if (sweep < 0) sweep += TAU; }
    } else if (sweep <= -TAU) sweep = -TAU;
    else { sweep %= TAU; if (sweep > 0) sweep -= TAU; }
    const sx = x + r * Math.cos(a0), sy = y + r * Math.sin(a0);
    if (!this._cur) this.moveTo(sx, sy);
    else if (Math.hypot(this._cur.x - sx, this._cur.y - sy) > 1e-9) this.lineTo(sx, sy);
    const n = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
    const step = sweep / n, k = (4 / 3) * Math.tan(step / 4);
    let a = a0;
    for (let i = 0; i < n; i++) {
      const b = a + step;
      const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
      this.bezierCurveTo(x + r * (ca - k * sa), y + r * (sa + k * ca), x + r * (cb + k * sb), y + r * (sb - k * cb), x + r * cb, y + r * sb);
      a = b;
    }
  }
  arcTo(x1, y1, x2, y2, r) {
    const p0 = this._cur;
    if (!p0) { this.moveTo(x1, y1); return; }
    const ax = p0.x - x1, ay = p0.y - y1, bx = x2 - x1, by = y2 - y1;
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la < 1e-9 || lb < 1e-9 || !(r > 0)) { this.lineTo(x1, y1); return; }
    const ux = ax / la, uy = ay / la, vx = bx / lb, vy = by / lb;
    const cross = ux * vy - uy * vx;
    if (Math.abs(cross) < 1e-9) { this.lineTo(x1, y1); return; }
    const theta = Math.acos(Math.max(-1, Math.min(1, ux * vx + uy * vy)));
    const d = r / Math.tan(theta / 2);
    const t1 = { x: x1 + ux * d, y: y1 + uy * d }, t2 = { x: x1 + vx * d, y: y1 + vy * d };
    const bl = Math.hypot(ux + vx, uy + vy) || 1, h = r / Math.sin(theta / 2);
    const cx = x1 + (ux + vx) / bl * h, cy = y1 + (uy + vy) / bl * h;
    const a0 = Math.atan2(t1.y - cy, t1.x - cx), a1 = Math.atan2(t2.y - cy, t2.x - cx);
    let delta = a1 - a0;
    while (delta > Math.PI) delta -= TAU;
    while (delta < -Math.PI) delta += TAU;
    this.lineTo(t1.x, t1.y);
    this.arc(cx, cy, r, a0, a0 + delta, delta < 0);
  }

  /* ---- painting ---- */
  _alpha(a) { const o = this.globalAlpha * a; return o < 0.999 ? ` opacity="${num(o)}"` : ''; }
  fill(rule) {
    if (!this._d.length) return;
    const [c, a] = splitColor(this.fillStyle);
    this.out.push(`<path d="${this._d.join('')}" fill="${esc(c)}"${rule === 'evenodd' ? ' fill-rule="evenodd"' : ''}${this._alpha(a)}/>`);
  }
  _strokeAttrs() {
    const [c, a] = splitColor(this.strokeStyle);
    const k = this._k();
    let s = ` fill="none" stroke="${esc(c)}" stroke-width="${num(this.lineWidth * k)}"`;
    if (this.lineCap !== 'butt') s += ` stroke-linecap="${this.lineCap}"`;
    if (this.lineJoin !== 'miter') s += ` stroke-linejoin="${this.lineJoin}"`;
    if (this._dash.length) s += ` stroke-dasharray="${this._dash.map(v => num(v * k)).join(' ')}"`;
    return s + this._alpha(a);
  }
  stroke() {
    if (!this._d.length) return;
    this.out.push(`<path d="${this._d.join('')}"${this._strokeAttrs()}/>`);
  }
  _rectPath(x, y, w, h, fn) {
    const keep = [this._d, this._cur, this._start];
    this.beginPath(); this.rect(x, y, w, h); fn();
    [this._d, this._cur, this._start] = keep;
  }
  fillRect(x, y, w, h) { this._rectPath(x, y, w, h, () => this.fill()); }
  strokeRect(x, y, w, h) { this._rectPath(x, y, w, h, () => this.stroke()); }
  clearRect() { /* nothing is under a fresh drawing */ }
  clip() { /* not used by the renderer */ }

  /* ---- text ---- */
  measureText(text) {
    if (this._measure) { this._measure.font = this.font; return this._measure.measureText(text); }
    return { width: String(text).length * parseFont(this.font).size * 0.55 };
  }
  _text(text, x, y, paint) {
    const f = parseFont(this.font);
    const anchor = { center: 'middle', right: 'end', end: 'end' }[this.textAlign] || 'start';
    // Baseline as a shift in em: understood everywhere, unlike dominant-baseline.
    const dy = { middle: 0.35, top: 0.8, hanging: 0.8, bottom: -0.2, ideographic: -0.2 }[this.textBaseline] || 0;
    const m = this._m;
    let s = `<text xml:space="preserve" transform="matrix(${m.map(num).join(' ')})" x="${num(x)}" y="${num(y + dy * f.size)}"`
      + ` font-family="${esc(f.family.replace(/"/g, "'"))}" font-size="${num(f.size)}"`;
    if (f.weight) s += ` font-weight="${f.weight}"`;
    if (f.italic) s += ' font-style="italic"';
    if (anchor !== 'start') s += ` text-anchor="${anchor}"`;
    this.out.push(s + paint + '>' + esc(text) + '</text>');
  }
  fillText(text, x, y) {
    const [c, a] = splitColor(this.fillStyle);
    this._text(text, x, y, ` fill="${esc(c)}"${this._alpha(a)}`);
  }
  strokeText(text, x, y) {
    const [c, a] = splitColor(this.strokeStyle);
    this._text(text, x, y, ` fill="none" stroke="${esc(c)}" stroke-width="${num(this.lineWidth)}"`
      + (this.lineJoin !== 'miter' ? ` stroke-linejoin="${this.lineJoin}"` : '') + this._alpha(a));
  }

  /* ---- pictures ---- */
  drawImage(img, x = 0, y = 0, w, h) {
    const src = img && (img.currentSrc || img.src);
    if (!src) return;
    w = w ?? img.naturalWidth ?? img.width; h = h ?? img.naturalHeight ?? img.height;
    this.out.push(`<image href="${esc(src)}" x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" preserveAspectRatio="none"`
      + ` transform="matrix(${this._m.map(num).join(' ')})"${this._alpha(1)}/>`);
  }

  /** The finished document. `size` sets a physical size, e.g.
   *  { width: '210mm', height: '297mm' }; the default is px. */
  toSVG({ size = null, title = '' } = {}) {
    const w = num(this.width), h = num(this.height);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size ? size.width : w}" height="${size ? size.height : h}" viewBox="0 0 ${w} ${h}">`
      + (title ? `<title>${esc(title)}</title>` : '') + this.out.join('') + '</svg>';
  }
}
