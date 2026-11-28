// The OAuth consent page (/oauth/consent/) that AI assistants send the
// user to, against the in-page fake of supabase-js: signed out it sends
// them to sign in and back; signed in it shows who is asking and where
// they go back to, and Allow / Don't allow answer and return.
// Usage: node tests/consent.e2e.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { installFake } from './fake-supabase.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = resolve(new URL('..', import.meta.url).pathname);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  try { const body = await readFile(join(root, p)); res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' }); res.end(body); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, r));
const origin = `http://localhost:${server.address().port}`;

let failed = 0;
const check = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) failed++; };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 900, height: 900 } });
const leftFor = [];
await ctx.route(/umami|jsdelivr|supabase\.co/, r => r.abort());
await ctx.route(/assistant\.test/, r => { leftFor.push(r.request().url()); r.fulfill({ status: 200, body: 'back at the assistant' }); });
await ctx.addInitScript(installFake);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
const h1 = () => page.textContent('#consent h1');

// No authorization id.
await page.goto(`${origin}/oauth/consent/`);
await page.waitForFunction(() => !document.querySelector('#consent h1').textContent.includes('Connecting'));
check((await h1()) === 'Nothing to approve', 'without an authorization id: nothing to approve');

// Signed out: sign in, then come back here.
await page.goto(`${origin}/oauth/consent/?authorization_id=abc-123`);
await page.waitForSelector('#consent a.btn.primary');
const signIn = await page.getAttribute('#consent a.btn.primary', 'href');
check(signIn === '/app/?signin&back=%2Foauth%2Fconsent%2F%3Fauthorization_id%3Dabc-123', 'signed out: sign-in link comes back to this request');
await page.click('#consent a.btn.primary');
await page.waitForSelector('#account-modal input[type=email]');
await page.fill('#account-modal input[type=email]', 'me@example.com');
await page.click('#account-modal button[type=submit]');
await page.waitForSelector('#account-modal input[name=code]');
await page.fill('#account-modal input[name=code]', '123456');
await page.click('#account-modal button[type=submit]');
// First sign-in: the editor asks for a public username, then goes back.
await page.waitForSelector('#profile-modal');
await page.fill('#profile-username', 'consent.tester');
await page.waitForFunction(() => /available/.test(document.querySelector('.username-hint').textContent));
await page.click('#profile-modal [data-a="ok"]');
await page.waitForURL(/\/oauth\/consent\/\?authorization_id=abc-123$/, { timeout: 10000 }).catch(() => {});
check(page.url().endsWith('/oauth/consent/?authorization_id=abc-123'), 'after signing in, back on the consent page');

// Signed in: who asks, what it may do, where the answer goes.
await page.waitForSelector('#consent [data-act="allow"]');
check((await h1()) === 'Allow Claude <b> to use OnSketch?', 'names the assistant (as text, not HTML)');
const text = await page.textContent('#consent');
check(text.includes('me@example.com'), 'shows the account it will use');
check(text.includes('go back to assistant.test'), 'shows where the user is sent back to');
check(/create sketches/.test(text) && /can't delete/.test(text), 'says what it can and cannot do');
await page.click('#consent [data-act="allow"]');
await page.waitForFunction(() => location.host === 'assistant.test' || document.body.textContent.includes('back at the assistant'));
check(leftFor.at(-1) === 'https://assistant.test/cb?code=xyz', 'Allow: back to the assistant with a code');

// Don't allow.
await page.goto(`${origin}/oauth/consent/?authorization_id=two`);
await page.waitForSelector('#consent [data-act="deny"]');
await page.click('#consent [data-act="deny"]');
await page.waitForFunction(() => document.body.textContent.includes('back at the assistant'));
check(leftFor.at(-1) === 'https://assistant.test/cb?error=access_denied', "Don't allow: back to the assistant with access_denied");

// Allowed before: straight back. Expired: a message.
await page.goto(`${origin}/oauth/consent/?authorization_id=seen`);
await page.waitForFunction(() => document.body.textContent.includes('back at the assistant'));
check(leftFor.at(-1) === 'https://assistant.test/cb?code=again', 'already allowed: straight back to the assistant');
await page.goto(`${origin}/oauth/consent/?authorization_id=gone`);
await page.waitForFunction(() => document.querySelector('#consent h1')?.textContent === 'Something went wrong');
check((await page.textContent('#consent')).includes('Authorization not found'), 'expired request: says so');

check(errors.length === 0, 'no page errors' + (errors.length ? `: ${errors.join(' | ')}` : ''));
await browser.close();
server.close();
if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nall consent checks passed');
