/* =============== ANALYTICS (Umami) =============================
   Custom events sent to Umami (script tag in app/index.html), to see
   which parts of the editor people actually use. Never sent: drawing
   contents, project names, dimension values, typed text.

   - track(name, data): one event every time.
   - trackOnce(name, data): at most once per page load for that name and
     data, for things done many times in a row (drawing a shape, adding
     a constraint): it tells us a feature was used in a session without
     flooding the event quota.

   Safe when Umami is blocked or not loaded yet: events wait in a short
   queue, and are dropped if it never shows up.
   ============================================================ */
const MAX_QUEUE = 50;
const RETRY_MS = 1000;
const MAX_RETRIES = 15;

const queue = [];
const sent = new Set();
let retries = 0;
let timer = null;

function umami() {
  const u = typeof window !== 'undefined' ? window.umami : null;
  return u && typeof u.track === 'function' ? u : null;
}

function flush() {
  timer = null;
  const u = umami();
  if (!u) {
    if (++retries <= MAX_RETRIES) timer = setTimeout(flush, RETRY_MS);
    else queue.length = 0;
    return;
  }
  while (queue.length) {
    const [name, data] = queue.shift();
    try { data ? u.track(name, data) : u.track(name); } catch { /* never break the editor */ }
  }
}

export function track(name, data) {
  if (typeof window === 'undefined') return;
  if (queue.length < MAX_QUEUE) queue.push([name, data]);
  if (!timer) flush();
}

export function trackOnce(name, data) {
  const key = name + '|' + (data ? JSON.stringify(data) : '');
  if (sent.has(key)) return;
  sent.add(key);
  track(name, data);
}

/** For tests. */
export function _resetAnalytics() {
  queue.length = 0; sent.clear(); retries = 0;
  if (timer) clearTimeout(timer);
  timer = null;
}
