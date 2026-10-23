'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fyers = require('../fyers');
const ai = require('../ai');
const mock = require('../mockData');

test('appIdHash is sha256 of appId:secret', () => {
  const expected = crypto.createHash('sha256').update('APP-100:sekret').digest('hex');
  assert.strictEqual(fyers.appIdHash('APP-100', 'sekret'), expected);
});

test('auth URL carries client, redirect and code response type', () => {
  const u = new URL(fyers.buildAuthUrl('APP-100', 'https://example.in/cb'));
  assert.strictEqual(u.searchParams.get('client_id'), 'APP-100');
  assert.strictEqual(u.searchParams.get('response_type'), 'code');
  assert.strictEqual(u.searchParams.get('redirect_uri'), 'https://example.in/cb');
});

test('option chain normalizer groups CE/PE by strike', () => {
  const rows = fyers.normalizeOptionChain({ data: { optionsChain: [
    { strike_price: 25000, option_type: 'CE', oi: 1200, oich: 30 },
    { strike_price: 25000, option_type: 'PE', oi: 3400, oich: -12 },
    { strike_price: 25100, option_type: 'CE', oi: 800, oich: 5 }
  ] } });
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].putOi, 3400);
  assert.strictEqual(rows[0].callOiChange, 30);
});

test('history normalizer maps wire arrays to candles', () => {
  const cs = fyers.normalizeHistory({ candles: [[1700000000, 10, 12, 9, 11, 700]] });
  assert.strictEqual(cs[0].t, 1700000000000);
  assert.strictEqual(cs[0].v, 700);
});

test('demo data is deterministic and analyzable', () => {
  const a = mock.demoCandles('NIFTY');
  const b = mock.demoCandles('NIFTY');
  assert.deepStrictEqual(a, b);
  assert.strictEqual(a.length, 75);
  assert.ok(mock.demoOptionChain('NIFTY').length >= 10);
});

test('local brief works with no OpenRouter key', async () => {
  const analysis = { ok: true, symbol: 'NIFTY', price: 25100, trend: 'uptrend', vwap: 25080, rsi14: 55,
    nearestResistance: [{ price: 25200, source: 'oi' }], nearestSupport: [{ price: 25000 }],
    demandZones: [{ low: 24980, high: 25010, fresh: true, mitigated: false }], supplyZones: [],
    fvgs: [], oi: { pcr: 0.9, maxCallOiStrike: 25200, maxPutOiStrike: 25000, maxPain: 25100 } };
  const out = await ai.summarize({ apiKey: '', analysis });
  assert.strictEqual(out.source, 'local');
  assert.match(out.text, /NIFTY/);
  assert.match(out.text, /PCR/);
});

test('OpenRouter failure falls back to local brief, never throws', async () => {
  const boom = async () => { throw new Error('network down'); };
  const analysis = { ok: true, symbol: 'X', price: 1, trend: 'sideways', vwap: 1, rsi14: 50,
    nearestResistance: [], nearestSupport: [], demandZones: [], supplyZones: [], fvgs: [], oi: null };
  const out = await ai.summarize({ apiKey: 'sk-or-test', analysis }, boom);
  assert.strictEqual(out.source, 'local');
});

test('Gemini summarization parses response correctly', async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: 'Nifty near resistance at 25,200. Respect your stop loss.' }] } }]
    })
  });
  const analysis = { ok: true, symbol: 'NIFTY', price: 25150, trend: 'bullish', vwap: 25100, rsi14: 55,
    nearestResistance: [], nearestSupport: [], demandZones: [], supplyZones: [], fvgs: [], oi: null };
  const out = await ai.summarize({ geminiApiKey: 'test-gemini-key', analysis }, mockFetch);
  assert.match(out.source, /^gemini:/);
  assert.match(out.text, /resistance at 25,200/);
});

test('Gemini failure falls back to local brief, never throws', async () => {
  const boom = async () => { throw new Error('gemini down'); };
  const analysis = { ok: true, symbol: 'X', price: 1, trend: 'sideways', vwap: 1, rsi14: 50,
    nearestResistance: [], nearestSupport: [], demandZones: [], supplyZones: [], fvgs: [], oi: null };
  const out = await ai.summarize({ geminiApiKey: 'test-gemini-key', analysis }, boom);
  assert.strictEqual(out.source, 'local');
});

test('.env parser handles comments, quotes and blanks', () => {
  const { parseEnv } = require('../env');
  const out = parseEnv('# hi\nA=1\nB="two words"\nC=\n\nD = spaced \n');
  assert.strictEqual(out.A, '1');
  assert.strictEqual(out.B, 'two words');
  assert.strictEqual(out.C, '');
  assert.strictEqual(out.D, 'spaced');
});

test('option chain normalizer now captures ltp/theta/iv from greeks', () => {
  const rows = fyers.normalizeOptionChain({ data: { optionsChain: [
    { strike_price: 25000, option_type: 'CE', oi: 100, oich: 1, ltp: 84.5, greeks: { theta: -6.2, iv: 11.8 } },
    { strike_price: 25000, option_type: 'PE', oi: 200, oich: 2, ltp: 79.1, greeks: { theta: -7.4, iv: 13.1 } }
  ] } });
  assert.strictEqual(rows[0].callTheta, -6.2);
  assert.strictEqual(rows[0].putIv, 13.1);
  assert.strictEqual(rows[0].callLtp, 84.5);
});
