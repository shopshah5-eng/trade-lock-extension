'use strict';

/*
 * Duplicate element ids.
 *
 * document.getElementById returns the first match, so a second element with the
 * same id is unreachable no matter what renders it - the code writes to one node
 * and the user sees another. It is silent in every browser, which is why it is
 * worth a test rather than a convention.
 *
 * This replaces test/scan-duplicate-ids.js, which printed the same information
 * but always exited 0 and was not wired into `npm test`.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const PAGES = ['options/options.html', 'popup/popup.html', 'content/lock.html'];

function duplicateIds(html) {
  const seen = new Map();
  for (const match of html.matchAll(/\bid=["']([^"']+)["']/g)) {
    const [, id] = match;
    const line = html.slice(0, match.index).split('\n').length;
    if (!seen.has(id)) seen.set(id, []);
    seen.get(id).push(line);
  }
  return [...seen.entries()].filter(([, lines]) => lines.length > 1);
}

for (const page of PAGES) {
  test(`no duplicate element ids in ${page}`, () => {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    const dupes = duplicateIds(html);
    const detail = dupes.map(([id, lines]) => `#${id} at lines ${lines.join(', ')}`).join('; ');
    assert.deepStrictEqual(dupes, [], `${page} repeats ids, so one of each pair is unreachable: ${detail}`);
  });
}

test('the popup markup the script looks up is all present', () => {
  // The popup reaches for ids through its els map. A typo there is a dead
  // control with no error, so the list and the markup are compared directly.
  const html = fs.readFileSync(path.join(ROOT, 'popup', 'popup.html'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'popup', 'popup.js'), 'utf8');

  const block = js.slice(js.indexOf('var els = {};'), js.indexOf('].forEach'));
  const ids = [...block.matchAll(/'([A-Za-z0-9_]+)'/g)].map((m) => m[1]);
  assert.ok(ids.length > 30, 'the els map should list the popup controls');

  const missing = ids.filter((id) => !html.includes(`id="${id}"`));
  assert.deepStrictEqual(missing, [], `popup.js looks up ids that do not exist: ${missing.join(', ')}`);
});

test('every script the pages load is a file that exists', () => {
  // A renamed or deleted script tag fails at runtime with a blank panel, not at
  // build time.
  for (const page of PAGES) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    const dir = path.dirname(path.join(ROOT, page));
    for (const match of html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)) {
      const src = match[1];
      if (/^https?:/.test(src)) continue;
      const full = path.resolve(dir, src);
      assert.ok(fs.existsSync(full), `${page} loads ${src}, which does not exist`);
    }
    for (const match of html.matchAll(/<link[^>]+href=["']([^"']+\.css)["']/g)) {
      const full = path.resolve(dir, match[1]);
      assert.ok(fs.existsSync(full), `${page} loads ${match[1]}, which does not exist`);
    }
  }
});
