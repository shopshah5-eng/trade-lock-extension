'use strict';

/*
 * The Pro+ live route, exercised end to end.
 *
 * A stub HTTP server stands in for Upstox, so these tests assert what a paying
 * customer actually receives: real candles to draw, a real chain with greeks,
 * a real spot and a real India VIX - and an honest refusal when the index is
 * not one we support.
 *
 * This exists because the route used to return only `candles: <count>`, which
 * left the chart permanently blank while the UI reported "live feed connected".
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const L = require('../license');

const dataFile = path.join(os.tmpdir(), `trade-lock-marketlive-${process.pid}-${Date.now()}.json`);

const KEY = L.generateLicenseKey();
const HASH = L.hashKey(KEY);

/** 60 fifteen-minute candles, values deliberately distinctive. */
const CANDLES = Array.from({ length: 60 }, (_, i) => {
  const o = 24500 + i * 4;
  return [new Date(Date.parse('2026-10-23T09:15:00+05:30') + i * 900000).toISOString(),
    o, o + 20, o - 10, o + 12, 1000 + i];
});

const upstream = [];
let stub;

function startStub() {
  return new Promise((resolve) => {
    stub = http.createServer((req, res) => {
      upstream.push(req.url);
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

let base;
let appServer;

before(async () => {
  const port = await startStub();
  process.env.UPSTOX_BASE = 'http://127.0.0.1:' + port;
  process.env.UPSTOX_ANALYTICS_TOKEN = 'test-analytics-token';
  process.env.FYERS_ADMIN_TOKEN = 'admin-token-for-tests';
  process.env.TL_DATA_FILE = dataFile;
  process.env.NODE_ENV = 'test';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_KEY = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.GEMINI_API_KEY = '';
  process.env.OPENROUTER_API_KEY = '';

  // Seed an active Pro+ licence BEFORE the store is loaded.
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

  appServer = http.createServer(require('../api/index'));
  await new Promise((resolve) => appServer.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + appServer.address().port;
});

after(async () => {
  if (appServer) await new Promise((resolve) => appServer.close(resolve));
  if (stub) await new Promise((resolve) => stub.close(resolve));
  fs.rmSync(dataFile, { force: true });
  fs.rmSync(dataFile + '.tmp', { force: true });
});

function getLive(params, headers) {
  const url = new URL('/api/market/live', base);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  return fetch(url, { headers: headers || {} });
}

test('a Pro+ buyer receives candles, chain, spot and VIX', async () => {
  upstream.length = 0;
  const res = await getLive({ symbol: 'NIFTY', resolution: '15' },
    { Authorization: 'Bearer ' + KEY });
  assert.strictEqual(res.status, 200);
  const body = await res.json();

  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.provider, 'upstox');
  assert.strictEqual(body.symbol, 'NIFTY');

  // The chart draws from this array. A count here is what left it blank.
  assert.ok(Array.isArray(body.candles), 'candles must be the OHLC series');
  assert.ok(body.candles.length >= 40, 'a usable chart needs more than a handful of bars');
  const first = body.candles[0];
  for (const field of ['t', 'o', 'h', 'l', 'c', 'v']) {
    assert.ok(Number.isFinite(first[field]), `candle field ${field} must be numeric`);
  }
  assert.strictEqual(body.candleCount, body.candles.length);

  // Spot is the close of the newest candle, not the chain's own figure.
  assert.strictEqual(body.spot, CANDLES[CANDLES.length - 1][4]);
  assert.strictEqual(body.vix.value, 14.32);

  assert.strictEqual(body.optionChain.length, 1);
  assert.strictEqual(body.optionChain[0].strike, 24600);
  assert.strictEqual(body.optionChain[0].callTheta, -12.5);
  assert.strictEqual(body.optionChain[0].putIv, 13.8);

  // India VIX must be fetched from its documented instrument key.
  // Query spaces arrive as '+', so normalise before matching.
  const decoded = upstream.map((u) => decodeURIComponent(u).replace(/\+/g, ' '));
  assert.ok(decoded.some((u) => u.includes('NSE_INDEX|India VIX')),
    'the VIX quote must request NSE_INDEX|India VIX; saw: ' + decoded.join(' | '));
});

test('the candle payload is bounded so the response stays small', async () => {
  const res = await getLive({ symbol: 'NIFTY' }, { Authorization: 'Bearer ' + KEY });
  const body = await res.json();
  assert.ok(body.candles.length <= 400, 'never ship an unbounded candle series');
});

test('Bank Nifty asks the provider for Bank Nifty', async () => {
  upstream.length = 0;
  const res = await getLive({ symbol: 'BANKNIFTY' }, { Authorization: 'Bearer ' + KEY });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.symbol, 'BANKNIFTY');

  const text = upstream.map((u) => decodeURIComponent(u)).join(' ');
  assert.ok(text.includes('Nifty Bank'), 'must request the Bank Nifty instrument');
  assert.ok(!text.includes('Nifty 50'), 'must not fall back to Nifty 50');
});

test('an unsupported index is a 400 that names the supported ones', async () => {
  const res = await getLive({ symbol: 'NOT_AN_INDEX' }, { Authorization: 'Bearer ' + KEY });
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.strictEqual(body.error, 'unknown_symbol');
  assert.match(body.detail, /NIFTY/);
});

test('without a Pro+ licence the route refuses to serve market data', async () => {
  const anonymous = await getLive({ symbol: 'NIFTY' });
  assert.strictEqual(anonymous.status, 403);
  assert.strictEqual((await anonymous.json()).error, 'pro_plus_required');

  const bogus = await getLive({ symbol: 'NIFTY' }, { Authorization: 'Bearer TL-BOGUS-KEY' });
  assert.strictEqual(bogus.status, 403);
});

test('AI chat bounds message size and shares a rate-limited remote-model budget', async () => {
  const endpoint = base + '/api/ai/chat';
  const headers = { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
  let response = await fetch(endpoint, {
    method: 'POST', headers, body: JSON.stringify({ message: 'x'.repeat(4001) }),
  });
  assert.strictEqual(response.status, 413);
  assert.strictEqual((await response.json()).error, 'message_too_long');

  response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ message: ' ' }) });
  assert.strictEqual(response.status, 400);

  // The two rejected requests above also consume budget, preventing attackers
  // from bypassing the limit with malformed calls. No remote key is configured.
  for (let i = 0; i < 28; i++) {
    response = await fetch(endpoint, {
      method: 'POST', headers, body: JSON.stringify({ message: 'Review my discipline ' + i }),
    });
    const body = await response.json();
    assert.strictEqual(response.status, 200, JSON.stringify(body));
    assert.strictEqual(body.source, 'local');
  }
  response = await fetch(endpoint, {
    method: 'POST', headers, body: JSON.stringify({ message: 'one request too many' }),
  });
  assert.strictEqual(response.status, 429);
  assert.strictEqual((await response.json()).error, 'rate_limited');
});
