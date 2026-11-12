/* =============== ANALYTICS (Umami events) =====================
   Anonymous counts of what people do, sent to Umami (the script tag in
   each page). No cookies, nothing typed by the user, no drawing content:
   only the event name and a few short values (which tool, which source,
   true / false).

   track(name, data)      one event
   trackOnce(name, data)  at most once per page load for that name + data
                          (tool picked, window opened, first dimension…),
                          so heavy use doesn't flood the counts
   trackErrors(page)      uncaught errors, a few per page load

   Events wait (up to 20 s) for the Umami script, which loads deferred.
   Nothing is sent from localhost or from automated browsers; tests can
   see the events with window.__onsketchTrack = (name, data) => {}.
   ============================================================ */
const host = typeof location !== 'undefined' ? location.hostname : '';
const OFF = !host || /^(localhost|127\.|0\.0\.0\.0|\[::1\]$)/.test(host)
  || (typeof navigator !== 'undefined' && navigator.webdriver);

const queue = [];
const sent = new Set();
let timer = null;

function flush() {
  const u = window.umami;
  if (!u || typeof u.track !== 'function') return false;
  while (queue.length) {
    const [name, data] = queue.shift();
    try { data ? u.track(name, data) : u.track(name); } catch { /* blocked or offline: drop */ }
  }
  return true;
}

/** Keeps short strings, numbers and booleans; drops the rest. */
function clean(data) {
  if (!data) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === 'boolean' || (typeof v === 'number' && isFinite(v))) out[k] = v;
    else if (typeof v === 'string' && v) out[k] = v.slice(0, 80);
  }
  return Object.keys(out).length ? out : undefined;
}

export function track(name, data) {
  const d = clean(data);
  if (typeof window !== 'undefined' && typeof window.__onsketchTrack === 'function') {
    try { window.__onsketchTrack(name, d); } catch { /* test hook */ }
  }
  if (OFF) return;
  queue.push([name, d]);
  if (flush() || timer) return;
  let tries = 0;
  timer = setInterval(() => {
    if (flush() || ++tries > 40) {
      clearInterval(timer); timer = null;
      queue.length = 0;           // no Umami (blocked): forget them
    }
  }, 500);
}

export function trackOnce(name, data) {
  const key = name + JSON.stringify(clean(data) || {});
  if (sent.has(key)) return;
  sent.add(key);
  track(name, data);
}

/** Uncaught errors and rejections: message and place, at most 5 per load. */
export function trackErrors(page) {
  let n = 0;
  const report = (message, where) => {
    if (n >= 5) return;
    const msg = String(message || 'unknown').replace(/^Uncaught /, '').slice(0, 80);
    const key = 'error' + msg;
    if (sent.has(key)) return;
    sent.add(key); n++;
    track('error', { page, message: msg, where: String(where || '').replace(/^.*\//, '').replace(/\?v=\w+/, '').slice(0, 60) });
  };
  window.addEventListener('error', (e) => report(e.message, e.filename ? `${e.filename}:${e.lineno}` : ''));
  window.addEventListener('unhandledrejection', (e) => report(e.reason?.message || e.reason, 'promise'));
}
