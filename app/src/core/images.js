/* =============== IMPORTED IMAGES ===============================
   A picture (PNG, JPEG, WebP, GIF) placed on a layer as ink. It is a
   stroke-like item, so it selects, moves, groups, links, resizes, turns,
   flips, erases and undoes like any other ink:

     image { id, layerId, kind: 'image', image: 'im…', opacity, pts: [p0, p1, p2] }

   p0 is the top-left corner of the picture, p1 its top-right corner and
   p2 its bottom-left corner, in world units. Any affine map (moving,
   scaling, turning, flipping, following a linked shape) maps those three
   points, so the picture is stretched, turned or mirrored with them.
   Transparency (PNG, WebP, GIF) is kept: the file is stored as it was
   imported, never re-encoded.

   The file itself lives once per project, in `project.images`
   { id: data URL } (only the ones still used are saved). While the
   editor runs, every image ever seen is kept in a registry keyed by a
   hash of its data, so undo snapshots don't have to carry megabytes.
   ============================================================ */

/** Largest file accepted, in bytes. */
export const IMAGE_MAX_BYTES = 3 * 1024 * 1024;
/** Largest total of picture data in one project (data URL characters):
 *  a saved sketch must stay under 5 MB (cloud limit, browser storage). */
export const IMAGES_TOTAL_MAX = 4_500_000;
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

const sources = new Map();       // id → data URL
const elements = new Map();      // id → HTMLImageElement (once asked for)
const listeners = new Set();

export const isImage = (item) => !!item && item.kind === 'image';

/** Id of an image's data (the same picture always gets the same id). */
export function imageId(src) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 + c, 2246822519) ^ (h2 >>> 13);
  }
  return 'im' + (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36) + src.length.toString(36);
}

const DATA_URL = /^data:image\/(png|jpeg|webp|gif);base64,/i;

/** Keeps a picture for this session. Returns its id, or null when it
 *  isn't an accepted image data URL. */
export function registerImage(src, id = null) {
  if (typeof src !== 'string' || !DATA_URL.test(src)) return null;
  const key = id && /^im[a-z0-9]+$/.test(id) ? id : imageId(src);
  if (!sources.has(key)) sources.set(key, src);
  return key;
}

export function imageSource(id) { return sources.get(id) || null; }

/** Called (with no arguments) whenever a picture finishes loading. */
export function onImageLoad(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** The loaded <img> for an id, or null while it loads (or without a DOM). */
export function imageElement(id) {
  let el = elements.get(id);
  if (!el) {
    const src = sources.get(id);
    if (!src || typeof Image === 'undefined') return null;
    el = new Image();
    el.decoding = 'async';
    el.onload = () => { for (const fn of listeners) fn(); };
    el.src = src;
    elements.set(id, el);
  }
  return el.complete && el.naturalWidth > 0 ? el : null;
}

/** Pixel size of a data URL's picture (PNG, JPEG, GIF, WebP headers), or
 *  null. Read from the bytes, so it works without a DOM. */
export function imagePixelSize(src) {
  try {
    const b64 = src.slice(src.indexOf(',') + 1, src.indexOf(',') + 1 + 65536);
    const bin = typeof atob === 'function' ? atob(b64.slice(0, b64.length - (b64.length % 4))) : Buffer.from(b64, 'base64').toString('binary');
    const u8 = (i) => bin.charCodeAt(i) & 255;
    const be16 = (i) => (u8(i) << 8) | u8(i + 1), le16 = (i) => u8(i) | (u8(i + 1) << 8);
    const be32 = (i) => ((u8(i) << 24) | (u8(i + 1) << 16) | (u8(i + 2) << 8) | u8(i + 3)) >>> 0;
    if (bin.startsWith('\x89PNG')) return { w: be32(16), h: be32(20) };
    if (bin.startsWith('GIF')) return { w: le16(6), h: le16(8) };
    if (bin.startsWith('RIFF') && bin.slice(8, 12) === 'WEBP') {
      const kind = bin.slice(12, 16);
      if (kind === 'VP8X') return { w: 1 + (u8(24) | (u8(25) << 8) | (u8(26) << 16)), h: 1 + (u8(27) | (u8(28) << 8) | (u8(29) << 16)) };
      if (kind === 'VP8L') { const b = (u8(21) | (u8(22) << 8) | (u8(23) << 16) | (u8(24) << 24)) >>> 0; return { w: (b & 0x3fff) + 1, h: ((b >>> 14) & 0x3fff) + 1 }; }
      if (kind === 'VP8 ') return { w: le16(26) & 0x3fff, h: le16(28) & 0x3fff };
    }
    if (u8(0) === 0xff && u8(1) === 0xd8) {
      let i = 2;
      while (i + 9 < bin.length) {
        if (u8(i) !== 0xff) { i++; continue; }
        const m = u8(i + 1);
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: be16(i + 7), h: be16(i + 5) };
        i += 2 + be16(i + 2);
      }
    }
  } catch { /* not readable */ }
  return null;
}

/* ---- Geometry of an image item ---- */

/** The four world corners, clockwise from the top-left. */
export function imageCorners(item) {
  const [a, b, c] = item.points;
  return [a, b, { x: b.x + c.x - a.x, y: b.y + c.y - a.y }, c];
}

/** True when a circle of radius r at p touches the picture. */
export function imageHit(item, p, r) {
  const [a, b, c] = item.points;
  const ux = b.x - a.x, uy = b.y - a.y, vx = c.x - a.x, vy = c.y - a.y;
  const det = ux * vy - uy * vx;
  if (Math.abs(det) < 1e-18) return false;
  const qx = p.x - a.x, qy = p.y - a.y;
  const s = (qx * vy - qy * vx) / det, t = (ux * qy - uy * qx) / det;
  const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
  const ms = r / (lu || 1), mt = r / (lv || 1);
  return s >= -ms && s <= 1 + ms && t >= -mt && t <= 1 + mt;
}

/** Corners of a w × h picture centred on c (world units, y up). */
export function imagePoints(c, w, h) {
  return [{ x: c.x - w / 2, y: c.y + h / 2 }, { x: c.x + w / 2, y: c.y + h / 2 }, { x: c.x - w / 2, y: c.y - h / 2 }];
}

/** Width and height of the picture in world units (lengths of its sides). */
export function imageSize(item) {
  const [a, b, c] = item.points;
  return { w: Math.hypot(b.x - a.x, b.y - a.y), h: Math.hypot(c.x - a.x, c.y - a.y) };
}

/** Image ids used by a project's ink. */
export function usedImageIds(project) {
  const ids = new Set();
  for (const s of project.sketches) for (const st of s.strokes || []) if (isImage(st)) ids.add(st.image);
  return ids;
}
