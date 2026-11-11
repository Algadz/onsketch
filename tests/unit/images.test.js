import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project } from '../../app/src/core/model.js';
import { inkBounds, inkHit, inkInBox, reviveStroke } from '../../app/src/core/strokes.js';
import { anchorLookup, linkItems, syncLinks } from '../../app/src/core/ink-links.js';
import { applyTransform, rotateAbout, scaleAbout, snapshot } from '../../app/src/core/ink-transform.js';
import { imageCorners, imageId, imagePixelSize, imagePoints, imageSize, imageSource, registerImage } from '../../app/src/core/images.js';
import { circle, line, near } from './helpers.js';

// 1 × 1 transparent PNG
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
// 3 × 2 PNG header (IHDR only; enough for the size)
const PNG32 = 'data:image/png;base64,' + Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 3, 0, 0, 0, 2, 8, 6, 0, 0, 0,
]).toString('base64');
const GIF = 'data:image/gif;base64,' + Buffer.from('GIF89a\x05\x00\x07\x00', 'binary').toString('base64');
const JPEG = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 40, 0, 30, 3]).toString('base64');

const image = (id, c, w, h, extra = {}) => ({
  id: 'k' + Math.random().toString(36).slice(2, 7), layerId: 'l', kind: 'image', image: id,
  color: '#111418', opacity: 1, points: imagePoints(c, w, h), ...extra,
});
const sync = (s) => syncLinks(s.strokes, anchorLookup([s]));
const closeP = (a, b, tol = 1e-6) => near(a.x, b.x, tol) && near(a.y, b.y, tol);

test('pixel sizes are read from PNG, GIF and JPEG headers', () => {
  assert.deepEqual(imagePixelSize(PNG), { w: 1, h: 1 });
  assert.deepEqual(imagePixelSize(PNG32), { w: 3, h: 2 });
  assert.deepEqual(imagePixelSize(GIF), { w: 5, h: 7 });
  assert.deepEqual(imagePixelSize(JPEG), { w: 30, h: 40 });
  assert.equal(imagePixelSize('data:image/png;base64,AAAA'), null);
});

test('only image data URLs are registered; the same data gets the same id', () => {
  assert.equal(registerImage('data:text/html;base64,PGI+'), null);
  assert.equal(registerImage('https://example.com/a.png'), null);
  const a = registerImage(PNG), b = registerImage(PNG);
  assert.equal(a, b);
  assert.equal(a, imageId(PNG));
  assert.equal(imageSource(a), PNG);
});

test('images save their data once, in project.images, and undo snapshots leave it out', () => {
  const p = new Project(); const s = p.addSketch('S');
  const id = registerImage(PNG);
  s.strokes.push(image(id, { x: 0, y: 0 }, 10, 5, { layerId: p.layers[0].id, opacity: 0.5 }));
  s.strokes.push(image(id, { x: 20, y: 0 }, 4, 4, { layerId: p.layers[0].id }));
  const full = p.toJSON();
  assert.deepEqual(Object.keys(full.images), [id]);
  assert.equal(full.images[id], PNG);
  assert.equal(full.sketches[0].strokes[0].image, id);
  assert.equal('images' in p.toJSON({ images: false }), false);
  const back = Project.fromJSON(JSON.parse(JSON.stringify(full)));
  const b = back.active().strokes[0];
  assert.equal(b.kind, 'image');
  assert.equal(b.image, id);
  assert.equal(b.opacity, 0.5);
  assert.deepEqual(b.points, s.strokes[0].points);
  // an unused picture isn't saved
  s.strokes = [];
  assert.equal('images' in p.toJSON(), false);
});

test('bad image items are dropped on load', () => {
  assert.equal(reviveStroke({ kind: 'image', image: 'imabc', pts: [0, 0, 1, 0] }), null);
  assert.equal(reviveStroke({ kind: 'image', image: '../x', pts: [0, 0, 1, 0, 0, -1] }), null);
  assert.equal(reviveStroke({ kind: 'image', pts: [0, 0, 1, 0, 0, -1] }), null);
  assert.equal(reviveStroke({ kind: 'image', image: 'imabc', pts: [0, 0, 1, 0, 0, -1] }).points.length, 3);
});

test('hit, bounds and box selection follow the turned picture', () => {
  const it = image('imx', { x: 0, y: 0 }, 10, 4);
  assert.equal(inkHit(it, { x: 4, y: 1.5 }, 0), true);
  assert.equal(inkHit(it, { x: 6, y: 0 }, 0), false);
  assert.equal(inkHit(it, { x: 5.5, y: 0 }, 0.6), true);
  applyTransform(snapshot([it]), rotateAbout({ x: 0, y: 0 }, Math.PI / 4));
  assert.equal(inkHit(it, { x: 4, y: 0 }, 0), false);         // a corner of the unturned box, now outside
  assert.equal(inkHit(it, { x: 2, y: 2 }, 0), true);
  const b = inkBounds(it);
  const half = (10 + 4) / 2 / Math.SQRT2;
  assert.ok(near(b.maxX, half) && near(b.minY, -half));
  assert.equal(inkInBox(it, -half - 0.1, -half - 0.1, half + 0.1, half + 0.1), true);
  assert.equal(inkInBox(it, -3, -3, 3, 3), false);
});

test('resizing and flipping map the corners (stretch and mirror)', () => {
  const it = image('imx', { x: 5, y: 5 }, 10, 10);
  applyTransform(snapshot([it]), scaleAbout({ x: 0, y: 0 }, 2, 1));
  assert.deepEqual(imageSize(it), { w: 20, h: 10 });
  applyTransform(snapshot([it]), scaleAbout({ x: 10, y: 5 }, -1, 1));
  const [a, b] = it.points;
  assert.ok(a.x > b.x, 'flipped: the top-left corner is now on the right');
});

test('a picture linked to a line turns and scales with it', () => {
  const p = new Project(); const s = p.addSketch('S');
  const l = line(s, 0, 0, 10, 0);
  const it = image('imx', { x: 5, y: 2 }, 4, 2);
  s.strokes.push(it);
  linkItems([it], l);
  l.p2.x = 20;                                     // twice as long: the picture doubles
  sync(s);
  assert.ok(near(imageSize(it).w, 8) && near(imageSize(it).h, 4));
  assert.ok(closeP(imageCorners(it)[0], { x: 6, y: 6 }));
  l.p2.x = 0; l.p2.y = 20;                         // turned 90° counter-clockwise, same length
  sync(s);
  assert.ok(near(imageSize(it).w, 8) && near(imageSize(it).h, 4));
  const [a, b] = it.points;
  assert.ok(near(b.x - a.x, 0) && near(b.y - a.y, 8), 'the top edge runs along the line now');
});

test('a picture linked to a circle scales with the radius', () => {
  const p = new Project(); const s = p.addSketch('S');
  const c = circle(s, 0, 0, 5);
  const it = image('imx', { x: 0, y: 0 }, 10, 10);
  s.strokes.push(it);
  linkItems([it], c);
  c.r = 10;
  sync(s);
  assert.ok(near(imageSize(it).w, 20));
  assert.ok(closeP(imageCorners(it)[0], { x: -10, y: 10 }));
});
