import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeClipHTML, encodeClipHTML, inkPayload, inkPlainText, pasteItems, textFromPlain } from '../../app/src/core/ink-clipboard.js';
import { imagePoints, imageSource, registerImage } from '../../app/src/core/images.js';
import { anchorLookup, linkItems } from '../../app/src/core/ink-links.js';
import { line, sketch } from './helpers.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const text = (x, y, t, extra = {}) => ({ id: 'k1', layerId: 'l1', kind: 'text', color: '#111418', opacity: 1, size: 4, text: t, points: [{ x, y }], ...extra });

test('ink round-trips through clipboard HTML, with unicode and pictures', () => {
  const id = registerImage(PNG);
  const items = [
    text(0, 0, 'Cuisine — 12 m² <b>"x"</b>', { group: 'g1', bold: true }),
    { id: 'k2', layerId: 'l1', kind: 'image', image: id, color: '#111418', opacity: 0.5, points: imagePoints({ x: 0, y: 0 }, 4, 2), group: 'g1' },
  ];
  const html = encodeClipHTML(inkPayload(items), inkPlainText(items));
  assert.match(html, /&lt;b&gt;/, 'the visible text is escaped');
  const p = decodeClipHTML('<meta charset="utf-8">' + html);
  assert.equal(p.items.length, 2);
  assert.equal(p.items[0].text, 'Cuisine — 12 m² <b>"x"</b>');
  assert.equal(p.images[id], PNG);
  assert.equal(decodeClipHTML('<p>hello</p>'), null);
  assert.equal(decodeClipHTML('<div data-onsketch="!!!">'), null);
});

test('pasted ink gets new ids and groups, the target layer and the offset', () => {
  const items = [text(0, 0, 'A', { group: 'g1' }), text(10, 0, 'B', { group: 'g1' })];
  const payload = inkPayload(items);
  let seen = null;
  const out = pasteItems(payload, { layerId: 'L2', place: (b) => { seen = b; return { x: 5, y: -5 }; } });
  assert.ok(seen && seen.maxX > 10);
  assert.equal(out.length, 2);
  assert.notEqual(out[0].id, 'k1');
  assert.equal(out[0].layerId, 'L2');
  assert.equal(out[0].group, out[1].group);
  assert.notEqual(out[0].group, 'g1');
  assert.deepEqual(out[1].points[0], { x: 15, y: -5 });
  const again = pasteItems(payload, { layerId: 'L2', place: () => ({ x: 0, y: 0 }) });
  assert.notEqual(again[0].group, out[0].group, 'each paste is its own group');
});

test('links survive only to shapes of this drawing; arrow attachments are dropped', () => {
  const s = sketch();
  const l = line(s, 0, 0, 10, 0);
  const t = text(5, 2, 'On the line');
  linkItems([t], l);
  const arrow = { id: 'k3', layerId: 'l1', kind: 'arrow', color: '#111418', opacity: 1, width: 1, points: [{ x: 0, y: 5 }, { x: 0, y: 0 }], at: [null, { to: l.p1.id }] };
  const payload = inkPayload([t, arrow]);
  const here = pasteItems(payload, { layerId: 'l1', place: () => ({ x: 1, y: 1 }), lookup: anchorLookup([s]) });
  assert.equal(here[0].link.to, l.id);
  assert.equal(here[1].at, undefined);
  const elsewhere = pasteItems(payload, { layerId: 'l1', place: () => ({ x: 1, y: 1 }), lookup: new Map() });
  assert.equal(elsewhere[0].link, undefined);
});

test('pictures in a payload are registered on paste', () => {
  const src = PNG.replace('ggg==', 'ggg=='.replace('g', 'g')) + '';
  const payload = { v: 1, stamp: 'x', items: [{ kind: 'image', image: 'imzz1', opacity: 1, pts: [0, 1, 1, 1, 0, 0] }], images: { imzz1: src } };
  const [it] = pasteItems(payload, { layerId: 'l', place: () => ({ x: 0, y: 0 }) });
  assert.equal(it.kind, 'image');
  assert.equal(imageSource('imzz1'), src);
  const none = pasteItems({ v: 1, items: [{ kind: 'image', image: 'immissing', pts: [0, 1, 1, 1, 0, 0] }] }, { layerId: 'l', place: () => ({ x: 0, y: 0 }) });
  assert.equal(none.length, 0, 'a picture without its data is skipped');
});

test('plain text becomes a text label', () => {
  const t = textFromPlain('\n\nLine 1\r\nLine\t2  \n\n', { layerId: 'l', color: '#ff0000', size: 3, bold: true, box: { color: 'paper' } });
  assert.equal(t.text, 'Line 1\nLine    2');
  assert.equal(t.kind, 'text');
  assert.equal(t.size, 3);
  assert.deepEqual(t.box, { color: 'paper' });
  assert.equal(textFromPlain('   \n ', { layerId: 'l', size: 3 }), null);
  assert.equal(textFromPlain('x'.repeat(5000), { layerId: 'l', size: 3 }).text.length, 2000);
});
