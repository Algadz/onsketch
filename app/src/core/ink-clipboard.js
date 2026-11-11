import { newId } from './entities.js';
import { imageSource, isImage, registerImage } from './images.js';
import { TEXT_MAX, isText, reviveStroke, strokeToJSON, unionBounds } from './strokes.js';

/* =============== COPY AND PASTE INK ============================
   Ctrl+C / Ctrl+X put the selected ink (strokes, arrows, texts, images)
   on the system clipboard in three forms:
     text/html   <div data-onsketch="…">…</div>: the items as saved
                 (with their pictures' data), base64 JSON, so OnSketch
                 pastes them back exactly, in this tab, another tab or
                 another browser window;
     text/plain  the texts' words, for any other app;
     image/png   a single selected picture, for any other app (where
                 the browser allows writing images).
   Ctrl+V reads, in order: OnSketch ink, an image file, plain text (a new
   text label). Pasted ink gets new ids and groups, lands on the active
   layer, keeps links to shapes that exist in this drawing and drops
   arrow attachments (the copy sits apart from the shapes).
   ============================================================ */

export const CLIP_ATTR = 'data-onsketch';

const toB64 = (s) => {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const fromB64 = (b) => new TextDecoder().decode(Uint8Array.from(atob(b), c => c.charCodeAt(0)));
const esc = (t) => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Clipboard payload for ink items: { v, stamp, items, images }. */
export function inkPayload(items) {
  const images = {};
  for (const it of items) if (isImage(it)) { const src = imageSource(it.image); if (src) images[it.image] = src; }
  return { v: 1, stamp: newId('c') + Date.now().toString(36), items: items.map(strokeToJSON), images };
}

/** The words of the copied texts, one text per line. */
export function inkPlainText(items) {
  return items.filter(isText).map(t => t.text).join('\n');
}

export function encodeClipHTML(payload, plain = '') {
  return `<div ${CLIP_ATTR}="${toB64(JSON.stringify(payload))}">${esc(plain).replace(/\n/g, '<br>')}</div>`;
}

/** Payload from clipboard HTML, or null when it isn't OnSketch ink. */
export function decodeClipHTML(html) {
  if (typeof html !== 'string' || !html.includes(CLIP_ATTR)) return null;
  const m = html.match(new RegExp(`${CLIP_ATTR}="([A-Za-z0-9+/=]+)"`));
  if (!m) return null;
  try {
    const p = JSON.parse(fromB64(m[1]));
    return p && p.v === 1 && Array.isArray(p.items) ? p : null;
  } catch { return null; }
}

/**
 * Fresh items from a payload, ready to add to a sketch.
 * @param {object} payload
 * @param {object} o
 * @param {string} o.layerId  layer they land on
 * @param {(b: {minX, minY, maxX, maxY}) => {x, y}} o.place  offset to apply, given their bounds
 * @param {Map} [o.lookup]    anchors of this drawing (links to others are dropped)
 */
export function pasteItems(payload, { layerId, place, lookup = null }) {
  if (payload.images && typeof payload.images === 'object') {
    for (const [id, src] of Object.entries(payload.images)) registerImage(src, id);
  }
  const items = payload.items.map(reviveStroke).filter(Boolean)
    .filter(it => !isImage(it) || imageSource(it.image));
  if (!items.length) return [];
  const groups = new Map();
  const d = place(unionBounds(items)) || { x: 0, y: 0 };
  for (const it of items) {
    it.id = newId('k');
    it.layerId = layerId;
    if (it.group) {
      if (!groups.has(it.group)) groups.set(it.group, newId('g'));
      it.group = groups.get(it.group);
    }
    delete it.at;
    if (it.link && !(lookup && lookup.has(it.link.to))) delete it.link;
    it.points = it.points.map(p => ({ x: p.x + d.x, y: p.y + d.y }));
  }
  return items;
}

/** A text item for pasted plain text, or null when there are no words. */
export function textFromPlain(text, style) {
  const t = String(text ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').replace(/\s+$/, '').replace(/^\n+/, '').slice(0, TEXT_MAX);
  if (!t.trim()) return null;
  const item = {
    id: newId('k'), layerId: style.layerId, kind: 'text', color: style.color, opacity: 1,
    size: style.size, bold: !!style.bold, text: t, points: [{ x: 0, y: 0 }],
  };
  if (style.box) item.box = { ...style.box };
  return item;
}
