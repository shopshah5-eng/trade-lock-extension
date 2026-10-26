'use strict';
/*
 * Project-wide invariants for the "no demo data, no unsolicited UI" policy.
 *
 * These are guardrails, not feature tests: they fail if fabricated market data
 * or an auto-injected on-page widget creeps back in.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const SHIPPED_UI = ['options/options.js', 'options/options.html', 'popup/popup.js',
  'content/lock.js', 'content/lockpage.js', 'background.js', 'lib/rules.js', 'lib/market.js'];

// ------------------------------------------------------------ demo data ----

test('No demo: the fabricated-candle endpoint is gone', () => {
  const server = read('server/index.js');
  assert.strictEqual(server.includes('/api/market/demo'), false, 'demo endpoint must not be routed');
  assert.strictEqual(server.includes("require('./mockData')"), false, 'server must not bundle mock data');
});

test('No demo: synthetic candle generator is deleted from the shipped server', () => {
  assert.strictEqual(fs.existsSync(path.join(root, 'server/mockData.js')), false,
    'server/mockData.js must not ship; fixtures live under server/test/fixtures');
  assert.ok(fs.existsSync(path.join(root, 'server/test/fixtures/mockData.js')),
    'the test fixture copy should still exist for unit tests');
});

test('No demo: no shipped file claims or renders simulated market data', () => {
  for (const rel of SHIPPED_UI) {
    const src = read(rel);
    assert.strictEqual(/SIMULATED DEMO DATA/i.test(src), false, `${rel} still advertises simulated demo data`);
    assert.strictEqual(/Demo Render Time/i.test(src), false, `${rel} still stamps a demo render time`);
    assert.strictEqual(/\[DEMO\]/.test(src), false, `${rel} still labels output as [DEMO]`);
  }
});

test('No demo: the offline market path clears state instead of reusing stale numbers', () => {
  const options = read('options/options.js');
  assert.ok(options.includes("renderDisconnectedMarketState(symbol, 'no_feed'"),
    'market view must fall back to the explicit offline state');
  assert.ok(options.includes('chartState.candles = [];'), 'offline state must clear candles');
  assert.ok(options.includes('chartState.optionRows = [];'), 'offline state must clear the option chain');
  assert.strictEqual(options.includes('generateSampleCandles'), false, 'sample candle generator must stay deleted');
  assert.strictEqual(options.includes('computeLocalMarket'), false, 'local market modelling must stay deleted');
  assert.strictEqual(options.includes('dteFactor'), false, 'locally modelled DTE scaling must stay deleted');
});

test('No demo: a feed-less market view never prints a price', () => {
  const options = read('options/options.js');
  // The offline branch must blank the spot/theta fields rather than derive them.
  assert.ok(/marketSpotVal'\)\) el\('marketSpotVal'\)\.textContent = '—'/.test(options),
    'offline state must blank the spot price');
  assert.ok(/marketThetaVal'\)\) el\('marketThetaVal'\)\.textContent = '—'/.test(options),
    'offline state must blank theta');
});

// ------------------------------------------------------------ popup / hud ----

test('No unsolicited UI: the on-page widget is off by default', () => {
  const rules = read('lib/rules.js');
  assert.ok(/showHud:\s*false/.test(rules), 'showHud must default to false');
});

test('No unsolicited UI: the widget builder refuses to run unless opted in', () => {
  const lock = read('content/lock.js');
  const start = lock.indexOf('function buildHud()');
  assert.ok(start !== -1, 'buildHud must exist');
  const body = lock.slice(start, start + 400);
  assert.ok(/settings\.showHud !== true/.test(body),
    'buildHud must return early unless showHud is explicitly true');
  // The guard has to come before the DOM node is created.
  const guardAt = body.indexOf('showHud !== true');
  const createAt = body.indexOf("document.createElement('div')");
  assert.ok(guardAt !== -1 && guardAt < createAt, 'the guard must precede element creation');
});

test('No unsolicited UI: the widget is exposed as an explicit setting', () => {
  const html = read('options/options.html');
  const options = read('options/options.js');
  assert.ok(html.includes('id="showHud"'), 'options must expose a showHud toggle');
  assert.ok(/BOOL = \[[^\]]*'showHud'/.test(options), 'showHud must be persisted with the other booleans');
});

// ------------------------------------------------------------ deployment ----

test('Deployment: a self-hosted API origin can be granted without a rebuild', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.ok(Array.isArray(manifest.optional_host_permissions),
    'manifest must declare optional_host_permissions');
  assert.ok(manifest.optional_host_permissions.some((p) => p.includes('https://')), 'https origins must be requestable');
  assert.ok(manifest.optional_host_permissions.some((p) => p.includes('localhost')), 'localhost dev must be requestable');
  const options = read('options/options.js');
  assert.ok(options.includes('chrome.permissions.request'), 'options must request the origin at runtime');
});
