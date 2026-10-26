'use strict';

/*
 * The live pipeline, end to end, at the one seam nothing covered.
 *
 * server/test/marketLive.test.js proves the route returns candles, spot, VIX and
 * a chain. test/options_page.test.js proves the options page paints a snapshot.
 * Between them sat buildLiveSnapshot - the only code that turns the server's JSON
 * into what the UI reads - and no test ever ran it against a real response.
 *
 * That seam is where "it keeps showing demo" lived: the route returned a candle
 * *count*, the snapshot copied nothing, and the chart and option chain stayed
 * blank while the badge said the feed was live. This test drives the real
 * background service worker against the real server and asserts what lands in
 * chrome.storage.local for the page to render.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const L = require(path.join(ROOT, 'server', 'license'));
const TLRules = require(path.join(ROOT, 'lib', 'rules.js'));

const dataFile = path.join(os.tmpdir(), `trade-lock-pipeline-${process.pid}-${Date.now()}.json`);

const KEY = L.generateLicenseKey();
const HASH = L.hashKey(KEY);

const CANDLES = Array.from({ length: 60 }, (_, i) => {
  const o = 24500 + i * 4;
  return [new Date(Date.parse('2026-10-23T09:15:00+05:30') + i * 900000).toISOString(),
    o, o + 20, o - 10, o + 12, 1000 + i];
});

let stub;
let appServer;
let base;

function startUpstoxStub() {
  return new Promise((resolve) => {
    stub = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url.includes('/market-quote/quotes')) {
        return res.end(JSON.stringify({ data: { v: { last_price: 14.32, close_price: 13.9, net_change: 0.42 } } }));
      }
      if (req.url.includes('/option/chain')) {
        return res.end(JSON.stringify({ data: [{
          strike_price: 24600,
          underlying_spot_price: 24653,
          call_options: { market_data: { ltp: 120, oi: 5000, prev_oi: 4000 }, option_greeks: { theta: -12.5, iv: 14.2 } },
          put_options: { market_data: { ltp: 88, oi: 7000, prev_oi: 7500 }, option_greeks: { theta: -9.1, iv: 13.8 } },
        }] }));
      }
      if (req.url.includes('historical-candle')) {
        return res.end(JSON.stringify({ data: { candles: CANDLES } }));
      }
      res.statusCode = 404;
      return res.end('{}');
    });
    stub.listen(0, '127.0.0.1', () => resolve(stub.address().port));
  });
}

before(async () => {
  const stubPort = await startUpstoxStub();
  process.env.UPSTOX_BASE = 'http://127.0.0.1:' + stubPort;
  process.env.UPSTOX_ANALYTICS_TOKEN = 'test-analytics-token';
  process.env.FYERS_ADMIN_TOKEN = 'admin-token-for-tests';
  process.env.TL_DATA_FILE = dataFile;
  process.env.NODE_ENV = 'test';

  fs.writeFileSync(dataFile, JSON.stringify({
    licenses: {
      [HASH]: {
        hash: HASH, hint: L.keyHint(KEY), email: 'buyer@example.com',
        plan: 'pro_plus_ai_monthly', createdAt: Date.now(),
        expiresAt: Date.now() + 86400000, devices: [],
      },
    },
    orders: {}, processedWebhooks: {},
  }));

  appServer = http.createServer(require(path.join(ROOT, 'server', 'api', 'index')));
  await new Promise((resolve) => appServer.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + appServer.address().port;
});

after(async () => {
  if (appServer) await new Promise((resolve) => appServer.close(resolve));
  if (stub) await new Promise((resolve) => stub.close(resolve));
  fs.rmSync(dataFile, { force: true });
  fs.rmSync(dataFile + '.tmp', { force: true });
});

/** Boot the real background service worker with one Pro+ licence installed. */
function createBackground(settings) {
  const data = {
    tlSettings: Object.assign({ marketSource: 'live', marketSymbol: 'NIFTY', marketEnabled: true }, settings),
    tlState: null,
    tlLicense: { key: KEY, plan: 'pro_plus_ai_monthly', active: true, expiresAt: Date.now() + 86400000 },
  };
  let listener;

  const chrome = {
    storage: {
      local: {
        get(keys, cb) {
          const names = Array.isArray(keys) ? keys : [keys];
          const out = {};
          names.forEach((k) => { if (data[k] !== undefined) out[k] = data[k]; });
          if (cb) { queueMicrotask(() => cb(out)); return undefined; }
          return Promise.resolve(out);
        },
        set(values, cb) {
          Object.assign(data, values);
          if (cb) { queueMicrotask(cb); return undefined; }
          return Promise.resolve();
        },
      },
      onChanged: { addListener() {} },
    },
    runtime: {
      id: 'trade-lock-test',
      onMessage: { addListener(fn) { listener = fn; } },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      getURL: (p) => 'chrome-extension://trade-lock-test/' + p,
      lastError: null,
    },
    alarms: { clear: () => Promise.resolve(true), create: () => Promise.resolve(), onAlarm: { addListener() {} } },
    action: { setBadgeBackgroundColor() {}, setBadgeText() {}, setBadgeImage() {} },
    tabs: {
      query(_q, cb) { if (cb) cb([]); return Promise.resolve([]); },
      get: () => Promise.resolve(null),
      sendMessage: () => Promise.resolve({ ok: true }),
      onUpdated: { addListener() {} },
      onActivated: { addListener() {} },
    },
    scripting: { executeScript: () => Promise.resolve([{}]) },
    declarativeNetRequest: { updateDynamicRules: () => Promise.resolve() },
  };

  const context = {
    chrome, TLRules, TLDetect: require(path.join(ROOT, 'lib', 'detector.js')),
    console, URL, Date, Math, Promise, JSON, Number, String, Boolean, Object, Array,
    setInterval() { return 1; }, clearInterval() {}, setTimeout, clearTimeout,
    importScripts() {}, AbortController,
    fetch: (...args) => fetch(...args),
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'), context, { filename: 'background.js' });

  function send(message) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('message timed out: ' + message.type)), 15000);
      listener(message, { id: 'trade-lock-test', url: 'chrome-extension://trade-lock-test/popup/popup.html' }, (res) => {
        clearTimeout(timer);
        resolve(res);
      });
    });
  }

  return { data, send };
}

test('the server payload survives buildLiveSnapshot and reaches the page intact', async () => {
  const bg = createBackground({ licenseApiBase: base });
  const res = await bg.send({ type: 'TL_CHECK_MARKET_FEED', source: 'live', symbol: 'NIFTY' });

  assert.strictEqual(res && res.ok, true, 'the live probe must succeed: ' + JSON.stringify(res));
  assert.strictEqual(res.connected, true);

  const snap = bg.data.tlMarket;
  assert.ok(snap, 'the snapshot must be cached where the options page reads it');

  // The page trusts these three fields to draw a chart. `candles` used to be a
  // count here while the route sent an array, so nothing was ever drawn.
  assert.strictEqual(snap.source, 'live');
  assert.ok(Array.isArray(snap.candles), 'candles must reach the page as an array');
  assert.strictEqual(snap.candles.length, CANDLES.length);
  assert.strictEqual(snap.candleCount, snap.candles.length);
  assert.deepStrictEqual(
    Object.keys(snap.candles[0]).sort(),
    ['c', 'h', 'l', 'o', 't', 'v'],
    'each candle needs OHLCV and a timestamp'
  );

  assert.strictEqual(typeof snap.spot, 'number', 'spot must be a number, not a placeholder');
  assert.strictEqual(snap.spot, CANDLES[CANDLES.length - 1][4]);
  assert.strictEqual(snap.vix.value, 14.32);
  assert.strictEqual(snap.provider, 'upstox');

  // Chain rows carry what the table prints; a missing field must be null, never 0.
  assert.strictEqual(snap.optionChain.length, 1);
  const row = snap.optionChain[0];
  assert.strictEqual(row.strike, 24600);
  assert.strictEqual(row.callOi, 5000);
  assert.strictEqual(row.putOi, 7000);
  assert.strictEqual(row.callOiChange, 1000, 'OI change must be signed, not absolute');
  assert.strictEqual(row.putOiChange, -500);
  assert.strictEqual(row.callTheta, -12.5);
  for (const field of ['callVol', 'putVol']) {
    assert.ok(field in row, `${field} must exist on the row, even as null`);
  }

  // Nothing in the snapshot may claim to be simulated.
  const serialized = JSON.stringify(snap).toLowerCase();
  for (const word of ['demo', 'simulat', 'mock', 'fake']) {
    assert.ok(!serialized.includes(word), `the live snapshot must not contain "${word}"`);
  }
});

test('without a Pro+ licence the same request is refused, and no snapshot is written', async () => {
  const bg = createBackground({ licenseApiBase: base });
  bg.data.tlLicense = { key: 'TL-FREE-KEY', plan: 'free', active: true };

  const res = await bg.send({ type: 'TL_CHECK_MARKET_FEED', source: 'live', symbol: 'NIFTY' });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.connected, false);
  assert.ok(!bg.data.tlMarket, 'a refused probe must not leave a half-built snapshot behind');
});

test('an unknown index is reported, not silently swapped for NIFTY', async () => {
  const bg = createBackground({ licenseApiBase: base });
  const res = await bg.send({ type: 'TL_CHECK_MARKET_FEED', source: 'live', symbol: 'NOTANINDEX' });

  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.connected, false);
  assert.match(String(res.error), /unknown_symbol/,
    'the caller needs to know the index was rejected, not that the feed is down');
  assert.strictEqual(res.data, undefined, 'a refused probe must not hand back a different index');
  // tlMarket may still hold a snapshot from the worker's own refresh of the
  // configured symbol; that is a different request and must not be NIFTY-by-
  // accident of this one. Assert the configured symbol, not a substitute.
  if (bg.data.tlMarket) {
    assert.strictEqual(bg.data.tlMarket.symbol, 'NIFTY');
  }
});
