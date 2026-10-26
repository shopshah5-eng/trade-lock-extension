'use strict';

/*
 * The popup's detection-coverage note.
 *
 * Auto-counting is only verified on a handful of brokers. On the others the
 * trade counter can legitimately stay at 0 while real trades are placed, which
 * makes the daily limit look respected when nothing is measuring it. The popup
 * is where a user checks that number, so the caveat has to be there - as text,
 * never as an overlay or a popup of its own.
 *
 * popup.js is an IIFE with no exports, so this boots the real popup.html and
 * popup.js in linkedom against a stubbed chrome API and reads the rendered note.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const ROOT = path.join(__dirname, '..');

const DETECTOR = require(path.join(ROOT, 'lib', 'detector.js'));
const RULES = require(path.join(ROOT, 'lib', 'rules.js'));

/** The popup loads its libs with <script> tags, which linkedom does not run. */
const LIB_SCRIPTS = ['lib/rules.js', 'lib/detector.js', 'lib/insights.js'];

const LICENSE = {
  key: 'TL-TEST-KEY-0001',
  plan: 'pro_monthly',
  active: true,
  status: 'active',
  expiresAt: Date.now() + 20 * 24 * 3600 * 1000,
  deviceId: 'dev-test',
};

/** Boot the real popup page with one active tab and the given settings. */
async function bootPopup({ tabUrl, settings }) {
  const html = fs.readFileSync(path.join(ROOT, 'popup', 'popup.html'), 'utf8');
  const script = fs.readFileSync(path.join(ROOT, 'popup', 'popup.js'), 'utf8');

  // linkedom has no layout, but the popup reads style.display and classes only.
  const dom = parseHTML(html);
  const document = dom.document;
  const errors = [];

  // linkedom's window is a proxy that refuses writes to unknown properties, so
  // the page gets a plain stand-in that forwards the DOM to linkedom.
  const window = {
    document,
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    setTimeout: (fn) => { try { fn(); } catch (e) { errors.push(e); } return 0; },
    clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: () => 0,
    location: { href: 'chrome-extension://test/popup/popup.html' },
    history: { replaceState() {}, pushState() {} },
    localStorage: { getItem: () => null, setItem() {} },
    close() {}, open() { return null; },
    URL,
  };
  window.window = window;
  window.self = window;
  window.top = window;
  window.parent = window;

  const store = {
    tlSettings: settings,
    tlLicense: LICENSE,
    tlState: null,
  };

  const chrome = {
    storage: { local: { get(keys, cb) { cb(Object.assign({}, store)); }, set(obj, cb) { if (cb) cb(); } } },
    runtime: {
      lastError: null,
      sendMessage(msg, cb) { if (typeof cb === 'function') cb({ ok: true }); },
      getURL: (p) => 'chrome-extension://test/' + p,
      openOptionsPage() {},
    },
    tabs: {
      query(_q, cb) {
        const tabs = [{ id: 1, url: tabUrl, windowId: 1, active: true }];
        if (typeof cb === 'function') return cb(tabs);
        return Promise.resolve(tabs);
      },
      create() {},
      update() {},
      // No content script answers, so the popup takes its stored-state path -
      // the same path a user sees before the page finishes loading.
      sendMessage(_id, _msg, cb) { if (typeof cb === 'function') cb(null); },
    },
    sidePanel: { open: async () => {} },
    windows: { getCurrent: (cb) => cb({ id: 1 }) },
    alarms: { create() {}, clear() {} },
    commands: { getAll: (cb) => cb([]) },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
  };

  const context = vm.createContext({
    window, document, chrome, console,
    globalThis: null,
    setTimeout: window.setTimeout,
    clearTimeout: () => {},
    setInterval: () => 0,
    URL,
    Intl,
    Date,
    Math,
    JSON,
    localStorage: { getItem: () => null, setItem() {} },
  });
  context.globalThis = context;
  context.self = context;

  // Mirror the page's script order so R, TLDetect and the rest exist as they do
  // in Chrome.
  for (const rel of LIB_SCRIPTS) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), context, { filename: rel });
  }
  vm.runInContext(script, context, { filename: 'popup/popup.js' });

  // The popup renders once storage resolves; the stub answers synchronously.
  await new Promise((r) => setImmediate(r));
  return { document, window, errors, context };
}

function noteText(document) {
  const node = document.getElementById('detectNote');
  assert.ok(node, 'the popup must carry a #detectNote element');
  return (node.textContent || '').trim();
}

test('a verified broker gets no note', async () => {
  const page = await bootPopup({
    tabUrl: 'https://kite.zerodha.com/orders',
    settings: Object.assign({}, RULES.DEFAULT_SETTINGS, { autoDetect: true }),
  });
  assert.strictEqual(noteText(page.document), '');
  assert.strictEqual(page.document.getElementById('detectNote').style.display, 'none');
});

test('an unverified broker says trades may be missed', async () => {
  // Dhan is a recognised domain whose trade detection is not verified.
  const page = await bootPopup({
    tabUrl: 'https://web.dhan.co/positions',
    settings: Object.assign({}, RULES.DEFAULT_SETTINGS, { autoDetect: true }),
  });
  const text = noteText(page.document);
  assert.match(text, /not verified/i);
  assert.match(text, /Dhan/i);
  assert.match(text, /Journal/, 'the note must say what to do instead');
  assert.strictEqual(page.document.getElementById('detectNote').style.display, 'block');
});

test('turning auto-detect off keeps the popup quiet', async () => {
  const page = await bootPopup({
    tabUrl: 'https://web.dhan.co/positions',
    settings: Object.assign({}, RULES.DEFAULT_SETTINGS, { autoDetect: false }),
  });
  assert.strictEqual(noteText(page.document), '',
    'no auto-detection is running, so there is nothing to warn about');
});

test('an unset autoDetect is treated as on, because that is the default', async () => {
  const settings = Object.assign({}, RULES.DEFAULT_SETTINGS);
  delete settings.autoDetect;
  const page = await bootPopup({ tabUrl: 'https://web.dhan.co/positions', settings });
  assert.match(noteText(page.document), /not verified/i,
    'the default is on, so the caveat must still appear');
});

test('a non-broker tab gets no note', async () => {
  const page = await bootPopup({
    tabUrl: 'https://example.com/',
    settings: Object.assign({}, RULES.DEFAULT_SETTINGS, { autoDetect: true }),
  });
  assert.strictEqual(noteText(page.document), '');
});

test('the note is text only - it never injects an overlay', () => {
  const html = fs.readFileSync(path.join(ROOT, 'popup', 'popup.html'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'popup', 'popup.js'), 'utf8');
  assert.ok(html.includes('id="detectNote"'));
  // A note that opens its own window would repeat the popup-on-broker-open
  // behaviour that was explicitly rejected.
  const fn = js.slice(js.indexOf('function detectNoteText'), js.indexOf('function isBrokerUrl'));
  assert.ok(!/window\.open|alert\(|createElement\('iframe'\)/.test(fn));
});
