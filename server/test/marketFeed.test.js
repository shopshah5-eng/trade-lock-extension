'use strict';
/*
 * Upstox Analytics Token adapter + market feed orchestration.
 *
 * These tests exist because the whole point of this path is to remove the
 * daily 06:30 IST Fyers token ritual: an Analytics Token is good for a year,
 * so the parsing, symbol mapping and caching have to be right.
 */
const test = require('node:test');
const assert = require('node:assert');

const upstox = require('../providers/upstox');
const feed = require('../marketFeed');

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const CANDLE_PAYLOAD = {
  status: 'success',
  data: {
    candles: [
      ['2026-10-23T09:15:00+05:30', 24500, 24560, 24480, 24540, 1000, 0],
      ['2026-10-23T09:30:00+05:30', 24540, 24600, 24520, 24590, 900, 0],
    ],
  },
};

// ------------------------------------------------------------- symbols ----

test('Upstox: app symbols map to the documented instrument keys', () => {
  assert.strictEqual(upstox.instrumentKeyFor('NIFTY'), 'NSE_INDEX|Nifty 50');
  assert.strictEqual(upstox.instrumentKeyFor('BANKNIFTY'), 'NSE_INDEX|Nifty Bank');
  assert.strictEqual(upstox.instrumentKeyFor('SENSEX'), 'BSE_INDEX|SENSEX');
  // Case / separator tolerant
  assert.strictEqual(upstox.instrumentKeyFor('banknifty'), 'NSE_INDEX|Nifty Bank');
  assert.strictEqual(upstox.instrumentKeyFor('BANK-NIFTY'), 'NSE_INDEX|Nifty Bank');
  // A raw instrument key passes through untouched (e.g. a single stock)
  assert.strictEqual(upstox.instrumentKeyFor('NSE_EQ|INE002A01018'), 'NSE_EQ|INE002A01018');
  // Fyers wire symbols must resolve to the right index, not silently to NIFTY.
  assert.strictEqual(upstox.instrumentKeyFor('NSE:NIFTY50-INDEX'), 'NSE_INDEX|Nifty 50');
  assert.strictEqual(upstox.instrumentKeyFor('NSE:BANKNIFTY-INDEX'), 'NSE_INDEX|Nifty Bank');
  assert.strictEqual(upstox.instrumentKeyFor('NSE:FINNIFTY-INDEX'), 'NSE_INDEX|Nifty Fin Service');
  assert.strictEqual(upstox.instrumentKeyFor('BSE:SENSEX-INDEX'), 'BSE_INDEX|SENSEX');
  // A BSE-prefixed NSE index is a contradiction, not something to guess at.
  assert.strictEqual(upstox.instrumentKeyFor('BSE:BANKNIFTY-INDEX'), null);
  // Unknown symbols return null. Defaulting to NIFTY meant a user who picked
  // Bank Nifty could be served Nifty 50 candles labelled as Bank Nifty.
  assert.strictEqual(upstox.instrumentKeyFor('NONSENSE'), null);
  assert.throws(() => upstox.requireInstrumentKey('NONSENSE'), /unknown_symbol/);
  // An absent symbol is the documented default, not an error.
  assert.strictEqual(upstox.instrumentKeyFor(undefined), 'NSE_INDEX|Nifty 50');
});

test('Upstox: resolutions map to the correct unit/interval pairs', () => {
  assert.deepStrictEqual(upstox.parseResolution('15'), { unit: 'minutes', interval: '15', minutes: 15 });
  assert.deepStrictEqual(upstox.parseResolution('15m'), { unit: 'minutes', interval: '15', minutes: 15 });
  assert.deepStrictEqual(upstox.parseResolution(5), { unit: 'minutes', interval: '5', minutes: 5 });
  assert.deepStrictEqual(upstox.parseResolution('1'), { unit: 'minutes', interval: '1', minutes: 1 });
  assert.deepStrictEqual(upstox.parseResolution('60'), { unit: 'hours', interval: '1', minutes: 60 });
  assert.deepStrictEqual(upstox.parseResolution('D'), { unit: 'days', interval: '1', minutes: 1440 });
  assert.deepStrictEqual(upstox.parseResolution('1D'), { unit: 'days', interval: '1', minutes: 1440 });
  // Nonsense must not produce an invalid unit
  assert.strictEqual(upstox.parseResolution('banana').unit, 'minutes');
});

// ------------------------------------------------------------- parsing ----

test('Upstox: candles normalise to {t,o,h,l,c,v} and sort ascending', () => {
  const out = upstox.normalizeCandles(CANDLE_PAYLOAD);
  assert.strictEqual(out.length, 2);
  assert.deepStrictEqual(Object.keys(out[0]).sort(), ['c', 'h', 'l', 'o', 't', 'v']);
  assert.strictEqual(out[0].o, 24500);
  assert.strictEqual(out[1].c, 24590);
  assert.ok(out[0].t < out[1].t, 'candles must be chronological');
  assert.strictEqual(typeof out[0].t, 'number');
});

test('Upstox: malformed candles are dropped, not passed to the engine', () => {
  const out = upstox.normalizeCandles({
    data: { candles: [['2026-10-23T09:15:00+05:30', null, null, null, null, 0, 0], [null, 1, 2, 3, 4, 5, 0]] },
  });
  assert.deepStrictEqual(out, []);
  assert.deepStrictEqual(upstox.normalizeCandles(null), []);
  assert.deepStrictEqual(upstox.normalizeCandles({}), []);
});

test('Upstox: 1-minute candles aggregate into the requested bucket', () => {
  const base = Date.parse('2026-10-23T09:15:00+05:30');
  const oneMin = [0, 1, 2, 14, 15, 16].map((i) => ({
    t: base + i * 60000, o: 100 + i, h: 110 + i, l: 90 + i, c: 105 + i, v: 10,
  }));
  const fifteen = upstox.aggregate(oneMin, 15);
  assert.strictEqual(fifteen.length, 2, 'two 15-minute buckets');
  assert.strictEqual(fifteen[0].o, 100, 'open is the first minute of the bucket');
  assert.strictEqual(fifteen[0].c, 119, 'close is the last minute inside the bucket');
  assert.strictEqual(fifteen[0].h, 124, 'high spans the bucket');
  assert.strictEqual(fifteen[0].l, 90, 'low spans the bucket');
  assert.strictEqual(fifteen[0].v, 40, 'volume is summed across the 4 minutes in the bucket');
});

test('Upstox: option chain maps to the engine shape with prev-OI deltas', () => {
  const chain = upstox.normalizeOptionChain({
    status: 'success',
    data: [{
      strike_price: 24600,
      call_options: {
        market_data: { ltp: 120.5, oi: 5000, prev_oi: 4000 },
        option_greeks: { theta: -12.5, iv: 14.2 },
      },
      put_options: {
        market_data: { ltp: 88.25, oi: 7000, prev_oi: 7500 },
        option_greeks: { theta: -9.1, iv: 13.8 },
      },
    }],
  });
  assert.strictEqual(chain.length, 1);
  const row = chain[0];
  assert.strictEqual(row.strike, 24600);
  assert.strictEqual(row.callOi, 5000);
  assert.strictEqual(row.putOi, 7000);
  assert.strictEqual(row.callOiChange, 1000);
  assert.strictEqual(row.putOiChange, -500);
  assert.strictEqual(row.callLtp, 120.5);
  assert.strictEqual(row.callTheta, -12.5);
  assert.strictEqual(row.callIv, 14.2);
  assert.deepStrictEqual(upstox.normalizeOptionChain({ data: 'nope' }), []);
});

// ------------------------------------------------------------- requests ----

test('Upstox: history sends a Bearer token and the documented v3 path', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, headers: opts.headers });
    return jsonResponse(CANDLE_PAYLOAD);
  };
  const client = upstox.createClient({ accessToken: 'tok_123' }, fakeFetch, 'https://api.upstox.test');
  const candles = await client.history({
    instrumentKey: 'NIFTY', resolution: '15', fromDate: '2026-10-01', toDate: '2026-10-23',
  });
  assert.strictEqual(candles.length, 2);
  assert.strictEqual(calls.length, 1);
  assert.match(calls[0].url, /\/v3\/historical-candle\/NSE_INDEX%7CNifty%2050\/minutes\/15\/2026-10-23\/2026-10-01$/);
  assert.strictEqual(calls[0].headers.Authorization, 'Bearer tok_123');
});

test('Upstox: index requests fall back to v2 and re-aggregate when v3 rejects them', async () => {
  const calls = [];
  const base = Date.parse('2026-10-23T09:15:00+05:30');
  const oneMinute = {
    data: { candles: [0, 1, 2].map((i) => [
      new Date(base + i * 60000).toISOString(), 100 + i, 101 + i, 99 + i, 100.5 + i, 5, 0,
    ]) },
  };
  const fakeFetch = async (url) => {
    calls.push(url);
    if (url.includes('/v3/')) return jsonResponse({ errors: [{ message: 'bad request' }] }, 400);
    return jsonResponse(oneMinute);
  };
  const client = upstox.createClient({ accessToken: 'tok' }, fakeFetch, 'https://api.upstox.test');
  const candles = await client.history({ instrumentKey: 'NIFTY', resolution: '15' });
  assert.strictEqual(calls.length, 2, 'v3 then v2');
  assert.match(calls[0], /\/v3\//);
  assert.match(calls[1], /\/v2\/historical-candle\/.+\/1minute\//);
  assert.strictEqual(candles.length, 1, 'three 1-minute candles collapse into one 15-minute bar');
  assert.strictEqual(candles[0].v, 15);
});

test('Upstox: a rejected token surfaces as token_rejected', async () => {
  const fakeFetch = async () => jsonResponse({ errors: [{ message: 'Invalid token' }] }, 401);
  const check = await upstox.verifyToken('bad', fakeFetch, 'https://api.upstox.test');
  assert.strictEqual(check.ok, false);
  assert.strictEqual(check.status, 401);
  assert.strictEqual(check.error, 'token_rejected');
});

test('Upstox: a good token verifies without touching any order API', async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    return jsonResponse({ data: { 'NSE_INDEX:Nifty 50': { last_price: 24600 } } });
  };
  const check = await upstox.verifyToken('good', fakeFetch, 'https://api.upstox.test');
  assert.strictEqual(check.ok, true);
  assert.match(calls[0], /\/v2\/market-quote\/ltp/);
  assert.ok(!/order/i.test(calls[0]), 'must never call an order endpoint');
  assert.strictEqual((await upstox.verifyToken('', fakeFetch)).error, 'missing_token');
});

// ---------------------------------------------------------- feed layer ----

test('Market feed: provider preference is Upstox (1-year) over Fyers (daily)', () => {
  const upstoxOnly = feed.resolveProvider({ UPSTOX_ANALYTICS_TOKEN: 'u' });
  assert.strictEqual(upstoxOnly.id, 'upstox');
  assert.strictEqual(upstoxOnly.configured, true);

  const both = feed.resolveProvider({ UPSTOX_ANALYTICS_TOKEN: 'u', FYERS_APP_ID: 'a', FYERS_ACCESS_TOKEN: 'f' });
  assert.strictEqual(both.id, 'upstox', 'the long-lived credential wins');

  const fyersOnly = feed.resolveProvider({ FYERS_APP_ID: 'a', FYERS_ACCESS_TOKEN: 'f' });
  assert.strictEqual(fyersOnly.id, 'fyers');
  assert.match(fyersOnly.tokenNote, /daily/i);

  const none = feed.resolveProvider({});
  assert.strictEqual(none.configured, false);
  assert.strictEqual(none.id, null);
});

test('Market feed: unconfigured feed fails closed instead of inventing candles', async () => {
  const prevU = process.env.UPSTOX_ANALYTICS_TOKEN;
  const prevA = process.env.FYERS_APP_ID;
  const prevT = process.env.FYERS_ACCESS_TOKEN;
  delete process.env.UPSTOX_ANALYTICS_TOKEN;
  delete process.env.FYERS_APP_ID;
  delete process.env.FYERS_ACCESS_TOKEN;
  try {
    const res = await feed.fetchMarket({ symbol: 'NIFTY', resolution: '15' });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, 'market_feed_not_configured');
    assert.strictEqual(res.candles, undefined, 'no candles may be fabricated');
  } finally {
    if (prevU !== undefined) process.env.UPSTOX_ANALYTICS_TOKEN = prevU;
    if (prevA !== undefined) process.env.FYERS_APP_ID = prevA;
    if (prevT !== undefined) process.env.FYERS_ACCESS_TOKEN = prevT;
  }
});

test('Market feed: repeated requests are served from cache, not upstream', async () => {
  const prev = process.env.UPSTOX_ANALYTICS_TOKEN;
  process.env.UPSTOX_ANALYTICS_TOKEN = 'cache_test_token';
  feed.clearCache();
  let upstream = 0;
  const fakeFetch = async (url) => {
    upstream += 1;
    if (url.includes('/option/chain')) return jsonResponse({ data: [] });
    return jsonResponse(CANDLE_PAYLOAD);
  };
  try {
    const first = await feed.fetchMarket({ symbol: 'NIFTY', resolution: '15', fetchImpl: fakeFetch });
    assert.strictEqual(first.ok, true);
    assert.strictEqual(first.provider, 'upstox');
    const afterFirst = upstream;

    const second = await feed.fetchMarket({ symbol: 'NIFTY', resolution: '15', fetchImpl: fakeFetch });
    assert.strictEqual(second.ok, true);
    assert.strictEqual(second.cached, true, 'second call must hit the cache');
    assert.strictEqual(upstream, afterFirst, 'no additional upstream calls');

    // A different resolution is a different cache key.
    await feed.fetchMarket({ symbol: 'BANKNIFTY', resolution: '5', fetchImpl: fakeFetch });
    assert.ok(upstream > afterFirst, 'a different symbol/resolution refetches');
  } finally {
    feed.clearCache();
    if (prev === undefined) delete process.env.UPSTOX_ANALYTICS_TOKEN;
    else process.env.UPSTOX_ANALYTICS_TOKEN = prev;
  }
});

test('Market feed: an empty provider response is an error, never a blank chart', async () => {
  const prev = process.env.UPSTOX_ANALYTICS_TOKEN;
  process.env.UPSTOX_ANALYTICS_TOKEN = 'empty_test_token';
  feed.clearCache();
  const fakeFetch = async () => jsonResponse({ data: { candles: [] } });
  try {
    const res = await feed.fetchMarket({ symbol: 'NIFTY', resolution: '15', fetchImpl: fakeFetch });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, 'no_candles_returned');
  } finally {
    feed.clearCache();
    if (prev === undefined) delete process.env.UPSTOX_ANALYTICS_TOKEN;
    else process.env.UPSTOX_ANALYTICS_TOKEN = prev;
  }
});
