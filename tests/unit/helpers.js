// Small builders shared by the unit tests.
import { Point, Line, Circle, Arc } from '../../app/src/core/entities.js';
import { Sketch } from '../../app/src/core/model.js';
import { Solver } from '../../app/src/core/solver.js';
import { deflateSync } from 'node:zlib';

export const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
export const ref = (line) => ({ a: line.p1.id, b: line.p2.id });

export function sketch() { return new Sketch('Test'); }
export function line(s, x1, y1, x2, y2) {
  const l = new Line(new Point(x1, y1), new Point(x2, y2)); s.addEntity(l); return l;
}
export function circle(s, x, y, r) { const c = new Circle(new Point(x, y), r); s.addEntity(c); return c; }
export function arc(s, x, y, r, a0, a1) { const a = new Arc(new Point(x, y), r, a0, a1); s.addEntity(a); return a; }
export function point(s, x, y) { const p = new Point(x, y); s.addEntity(p); return p; }

export function solve(s, options = {}) {
  return new Solver().solve(s, [s], [], { diagnostics: true, ...options });
}

/** A real w × h PNG, one colour, as a data URL. */
export function pngDataUrl(w, h, rgb = [220, 60, 60]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows = Buffer.concat(Array.from({ length: h }, () => Buffer.from([0, ...Array.from({ length: w }, () => rgb).flat()])));
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
  return 'data:image/png;base64,' + png.toString('base64');
}
