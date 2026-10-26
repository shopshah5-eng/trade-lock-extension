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

// ------------------------------------------------- hardcoded market values ----

test('No demo: no fake market numbers are baked into the markup', () => {
  const html = read('options/options.html');
  const fakes = ['₹24,520.00', '₹24,510', '24,441.20', '24,612.30', '24,400.10', '24,437.55',
    '+82.45 (+0.34%)', '13.85', '48% / 52%', '₹142.50', '₹-18.40', '₹-16.10', '₹-2.75',
    '~13.2% decay', '~11.8% decay', '>1.08<', '24,500', 'Mild Bullish Sentiment', '54.2',
    '13.4% / 14.2%'];
  for (const fake of fakes) {
    assert.strictEqual(html.includes(fake), false, `hardcoded market value still present: ${fake}`);
  }
});

test('No demo: the option chain reads real greeks instead of zero-filled placeholders', () => {
  const options = read('options/options.js');
  assert.strictEqual(/var atmCallTheta = 0;/.test(options), false, 'ATM theta must not be hardcoded to 0');
  assert.strictEqual(/var atmPutTheta = 0;/.test(options), false, 'ATM theta must not be hardcoded to 0');
  assert.strictEqual(options.includes('var spot = cfg.basePrice;'), false,
    'spot must come from the feed, not a built-in base price');
  assert.ok(options.includes('chartState.chainSpot'), 'the live spot must be carried into the options view');
  assert.ok(options.includes('chartState.fullOptionRows = chartState.optionRows'),
    'the live chain must be handed to the options view');
});

test('No demo: free licences can never be minted on a hosted platform', () => {
  const server = read('server/index.js');
  assert.ok(/const isDemoMode = \(\) =>[\s\S]{0,220}!IS_SERVERLESS/.test(server),
    'demo checkout must refuse to run on serverless/hosted platforms');
  assert.ok(server.includes("process.env.NODE_ENV !== 'production'"),
    'demo checkout must refuse to run in production');
});

test('No demo: live PCR / max pain reach the cards that display them', () => {
  const options = read('options/options.js');
  const html = read('options/options.html');
  // The market-tab cards must exist AND be written from live analysis, not left stale.
  for (const id of ['marketPcrVal', 'marketPcrBias', 'marketMaxPainVal']) {
    assert.ok(html.includes('id="' + id + '"'), `${id} must exist in the markup`);
    assert.ok(options.includes("el('" + id + "')"), `${id} must be written by the UI`);
  }
  // The options-tab metrics the code writes to must also exist.
  for (const id of ['optPcrVal', 'optPcrBias', 'optMaxPain', 'optHourlyDecay']) {
    assert.ok(html.includes('id="' + id + '"'), `${id} must exist or its updates are dead code`);
  }
});

test('No demo: the free tier never promises enforcement it does not perform', () => {
  const options = read('options/options.js');
  assert.ok(options.includes('Not enforced on the Free plan'),
    'free users must be told the capital plan is not enforced');
});

test('No demo: the ticker strip and VIX panel render only from a live source', () => {
  const options = read('options/options.js');
  const html = read('options/options.html');
  // Both panels had markup with no writer, so they sat on stale hardcoded values.
  for (const id of ['tickerNiftyPrice', 'tickerBankPrice', 'tickerFinPrice', 'tickerSensexPrice',
    'vixVal', 'vixChg', 'vixSkew', 'vixAlertStatus', 'vixRegimeBadge']) {
    assert.ok(html.includes('id="' + id + '"'), `${id} must exist in the markup`);
  }
  assert.ok(options.includes('function renderTickerStrip'), 'the ticker strip needs a renderer');
  assert.ok(options.includes('function renderVolatilityPanel'), 'the VIX panel needs a renderer');
  // No writer may hardcode a price; unknown sources degrade to an em-dash.
  assert.ok(options.includes("srcEl.textContent = 'NO FEED'"), 'missing feed must be labelled, not guessed');
  assert.ok(options.includes("el('vixRank').textContent = '—'"),
    'IV rank must stay blank rather than invented (needs a year of VIX history)');
});

test('Live: the chart receives real candles, not just a count', () => {
  const server = read('server/index.js');
  const background = read('background.js');
  const options = read('options/options.js');

  // The route used to send candles: <number>, so the client had no OHLC at all
  // and the Pro+ canvas always rendered "no market candle data".
  assert.ok(server.includes('candles: feed.candles.slice(-400)'),
    'the live route must ship the candle series');
  assert.ok(server.includes('candleCount: feed.candles.length'),
    'the count belongs in its own field');
  assert.strictEqual(/candles:\s*feed\.candles\.length\s*,/.test(server), false,
    'candles must never be a bare number again');

  assert.ok(background.includes('candles: Array.isArray(body.candles) ? body.candles : []'),
    'the snapshot must keep the series as an array');
  assert.ok(background.includes('candleCount:'),
    'the snapshot must keep the count separately');

  assert.ok(options.includes('chartState.candles = Array.isArray(snap.candles)'),
    'the chart engine needs its candle source populated');
});

test('Live: the chart is not driven by a field that does not exist', () => {
  const options = read('options/options.js');
  // analysis.candles is a COUNT, not the series.
  assert.ok(!options.includes('drawDedicatedSvgChart(svg, chartState.candles || [])') ||
    options.includes('chartState.candles.length'),
    'the chart must be gated on a populated series');
});
