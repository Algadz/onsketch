import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { track, trackOnce, _resetAnalytics } from '../../app/src/app/analytics.js';

let calls;
beforeEach(() => {
  _resetAnalytics();
  calls = [];
  globalThis.window = { umami: { track: (name, data) => calls.push(data === undefined ? [name] : [name, data]) } };
});
afterEach(() => { _resetAnalytics(); delete globalThis.window; });

test('track sends every event to umami', () => {
  track('menu', { action: 'grid' });
  track('menu', { action: 'grid' });
  track('project-new');
  assert.deepEqual(calls, [['menu', { action: 'grid' }], ['menu', { action: 'grid' }], ['project-new']]);
});

test('trackOnce sends each name + data only once', () => {
  trackOnce('tool-used', { tool: 'line' });
  trackOnce('tool-used', { tool: 'line' });
  trackOnce('tool-used', { tool: 'circle' });
  assert.deepEqual(calls, [['tool-used', { tool: 'line' }], ['tool-used', { tool: 'circle' }]]);
});

test('events wait until umami loads', async () => {
  const u = globalThis.window.umami;
  delete globalThis.window.umami;
  track('editor-open', { layout: 'desktop' });
  assert.equal(calls.length, 0);
  globalThis.window.umami = u;
  await new Promise(r => setTimeout(r, 1100));
  assert.deepEqual(calls, [['editor-open', { layout: 'desktop' }]]);
});

test('a throwing umami never breaks the caller', () => {
  globalThis.window.umami.track = () => { throw new Error('blocked'); };
  assert.doesNotThrow(() => track('menu', { action: 'undo' }));
});

test('no window (node) is a no-op', () => {
  delete globalThis.window;
  assert.doesNotThrow(() => track('x'));
});
