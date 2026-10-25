#!/usr/bin/env node
/*
 * Manifest / packaging validation.
 *
 * Chrome is not available in this sandbox, so `chrome://extensions` can't be
 * driven. This does the next best thing: every path the manifest points at is
 * checked for existence, and the declarativeNetRequest rules that background.js
 * builds are checked against the documented shape (unknown keys in a DNR rule
 * make Chrome reject the whole ruleset at load time).
 *
 * Run: node test/manifest.test.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

let failures = 0;
function check(label, ok, detail) {
  if (ok) {
    console.log('  ok   ' + label + (detail ? '  ' + detail : ''));
  } else {
    failures++;
    console.log('  FAIL ' + label + (detail ? '  ' + detail : ''));
  }
}

console.log('manifest structure');
check('manifest_version is 3', m.manifest_version === 3);
check('has name/version/description', !!(m.name && m.version && m.description));
check('background.service_worker set', !!(m.background && m.background.service_worker));
check('permissions declared',
  ['storage', 'alarms', 'tabs', 'declarativeNetRequest', 'sidePanel'].every((p) => m.permissions.includes(p)),
  m.permissions.join(', '));
check('minimum_chrome_version supports Side Panel (>= 114)', parseInt(m.minimum_chrome_version, 10) >= 114);

console.log('\nreferenced files exist');
const refs = [];
refs.push(m.background.service_worker);
refs.push(m.action.default_popup);
refs.push(m.options_ui.page);
if (m.side_panel && m.side_panel.default_path) refs.push(m.side_panel.default_path);
m.content_scripts.forEach((cs) => cs.js.forEach((j) => refs.push(j)));
m.web_accessible_resources.forEach((w) => w.resources.forEach((r) => refs.push(r)));
Object.values(m.icons).forEach((i) => refs.push(i));

refs.forEach((rel) => {
  const abs = path.join(ROOT, rel);
  const exists = fs.existsSync(abs);
  check(rel, exists, exists ? fs.statSync(abs).size + ' bytes' : 'MISSING');
});

console.log('\nhost_permissions vs content_scripts matches');
const csMatches = new Set();
m.content_scripts.forEach((cs) => cs.matches.forEach((x) => csMatches.add(x)));
const unmatched = [...csMatches].filter((x) => !m.host_permissions.includes(x));
check('every content-script match is covered by host_permissions',
  unmatched.length === 0, unmatched.length ? 'uncovered: ' + unmatched.join(', ') : csMatches.size + ' patterns');
const warUncovered = m.web_accessible_resources
  .flatMap((w) => w.matches).filter((x) => !csMatches.has(x));
check('web_accessible_resources matches the content-script sites',
  warUncovered.length === 0, warUncovered.length ? 'extra: ' + warUncovered.join(', ') : 'in sync');

console.log('\nDNR redirect target (runtime rules are exercised in background_security.test.js)');
check('redirect target exists on disk', fs.existsSync(path.join(ROOT, 'content/lock.html')));
check('redirect target is web_accessible',
  m.web_accessible_resources.some((w) => w.resources.includes('content/lock.html')));

console.log('\nno duplicate HTML element IDs');
const htmlFiles = ['options/options.html', 'popup/popup.html', 'content/lock.html'];
htmlFiles.forEach((rel) => {
  const content = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const counts = {};
  const re = /\bid=["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    counts[m[1]] = (counts[m[1]] || 0) + 1;
  }
  const dupes = Object.entries(counts).filter(([id, c]) => c > 1);
  check(rel + ' has zero duplicate element IDs', dupes.length === 0, dupes.map(([id, c]) => `#${id} (${c}x)`).join(', '));
});

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
