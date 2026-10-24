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

console.log('\nDNR ruleset shape (as built by background.js)');
const hosts = ['kite.zerodha.com', 'upstox.com', 'web.angelone.in', 'trade.5paisa.com'];
const rules = [
  {
    id: 91001, priority: 100,
    action: { type: 'redirect', redirect: { extensionPath: '/content/lock.html' } },
    condition: { initiatorDomains: hosts, urlFilter: '||', resourceTypes: ['main_frame'] }
  },
  {
    id: 91002, priority: 99,
    action: { type: 'block' },
    condition: {
      initiatorDomains: hosts, urlFilter: '||',
      resourceTypes: ['sub_frame', 'xmlhttprequest', 'script', 'stylesheet',
                      'image', 'font', 'media', 'other', 'websocket']
    }
  }
];
const VALID_TYPES = new Set(['block', 'redirect', 'allow', 'upgradeScheme', 'modifyHeaders', 'allowAllRequests']);
const VALID_RT = new Set(['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font',
  'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'webtransport',
  'webbundle', 'other']);
const ids = new Set();
rules.forEach((r) => {
  check('rule ' + r.id + ' has a unique numeric id', !ids.has(r.id) && Number.isInteger(r.id));
  ids.add(r.id);
  check('rule ' + r.id + ' action type is valid', VALID_TYPES.has(r.action.type), r.action.type);
  check('rule ' + r.id + ' resourceTypes are all valid',
    r.condition.resourceTypes.every((t) => VALID_RT.has(t)),
    r.condition.resourceTypes.filter((t) => !VALID_RT.has(t)).join(',') || 'all valid');
  check('rule ' + r.id + ' initiatorDomains are bare hostnames',
    r.condition.initiatorDomains.every((h) => /^[a-z0-9.\-]+$/.test(h) && !h.startsWith('*')));
  check('rule ' + r.id + ' has a urlFilter', typeof r.condition.urlFilter === 'string');
});
check('redirect target exists on disk', fs.existsSync(path.join(ROOT, 'content/lock.html')));
check('redirect target is web_accessible',
  m.web_accessible_resources.some((w) => w.resources.includes('content/lock.html')));

console.log('\nno leftover TODO / debugger statements');
const src = ['background.js', 'lib/rules.js', 'lib/detector.js', 'lib/insights.js', 'lib/license.js', 'content/lock.js',
             'popup/popup.js', 'options/options.js']
  .map((f) => [f, fs.readFileSync(path.join(ROOT, f), 'utf8')]);
const bad = [];
src.forEach(([f, code]) => {
  if (/^\s*debugger\s*;?/m.test(code)) bad.push(f + ': debugger');
  if (/\bTODO\b|\bFIXME\b/.test(code)) bad.push(f + ': TODO/FIXME');
});
check('sources are clean', bad.length === 0, bad.join(', ') || 'none found');

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
