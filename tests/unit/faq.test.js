import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { buildFaq, unstamped } from '../../scripts/build-faq.mjs';
import { SECTIONS } from '../../scripts/faq-content.mjs';

const html = readFileSync(new URL('../../faq/index.html', import.meta.url), 'utf8');
const root = new URL('../../', import.meta.url);

test('faq/index.html is built from scripts/faq-content.mjs (npm run faq)', () => {
  assert.equal(unstamped(html).replace(/\s+/g, ' '), unstamped(buildFaq()).replace(/\s+/g, ' '));
});

test('structured data: a FAQPage with every question, answers only in tags Google reads', () => {
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => JSON.parse(m[1]));
  const faq = blocks.flat().find(b => b['@type'] === 'FAQPage');
  const questions = SECTIONS.flatMap(s => s.faqs.map(f => f[0]));
  assert.equal(faq.mainEntity.length, questions.length);
  for (const q of faq.mainEntity) {
    assert.equal(q['@type'], 'Question');
    assert.ok(html.includes(`>${q.name.replace(/&/g, '&amp;')}</h3>`), `visible on the page: ${q.name}`);
    const tags = [...q.acceptedAnswer.text.matchAll(/<\/?([a-z0-9]+)/g)].map(m => m[1]);
    for (const t of tags) assert.ok(['a', 'b', 'strong', 'p', 'ul', 'ol', 'li', 'br', 'i', 'em', 'div'].includes(t), `allowed tag <${t}> in "${q.name}"`);
  }
});

test('SEO basics: title, description, canonical, one h1, links to pages that exist', () => {
  const title = html.match(/<title>([^<]+)<\/title>/)[1];
  const desc = html.match(/<meta name="description" content="([^"]+)"/)[1];
  assert.ok(title.length >= 30 && title.length <= 65, `title length ${title.length}`);
  assert.ok(desc.length >= 120 && desc.length <= 170, `description length ${desc.length}`);
  assert.match(html, /<link rel="canonical" href="https:\/\/onsketch\.io\/faq\/" \/>/);
  assert.equal((html.match(/<h1[ >]/g) || []).length, 1);
  for (const [, href] of html.matchAll(/href="(\/[^"#?]*)/g)) {
    const path = href.endsWith('/') ? href + 'index.html' : href;
    assert.ok(existsSync(new URL('.' + path, root)), `link to ${href}`);
  }
  assert.match(readFileSync(new URL('sitemap.xml', root), 'utf8'), /https:\/\/onsketch\.io\/faq\//);
});
