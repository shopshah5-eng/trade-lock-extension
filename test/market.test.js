'use strict';
const test = require('node:test');
const assert = require('node:assert');
const M = require('../lib/market.js');

let t = 0;
const C = (o, h, l, c, v) => ({ t: (t += 300000), o, h, l, c, v: v || 1000 });
function reset() { t = 0; }

test('normCandles accepts Fyers wire arrays', () => {
  const cs = M.normCandles([[1700000000, 10, 12, 9, 11, 500]]);
  assert.strictEqual(cs[0].c, 11);
  assert.strictEqual(cs[0].v, 500);
});

test('classic pivots from previous day', () => {
  const p = M.classicPivots({ h: 110, l: 90, c: 100 });
  assert.strictEqual(p.pivot, 100);
  assert.strictEqual(p.r1, 110);
  assert.strictEqual(p.s1, 90);
});

test('VWAP weights by volume and EMA tracks price', () => {
  reset();
  const cs = [C(100, 102, 98, 100, 100), C(110, 112, 108, 110, 300)];
  const vw = M.vwap(cs);
  assert.ok(vw[1] > 100 && vw[1] < 110);
  const e = M.ema([100, 110, 120], 2);
  assert.ok(e[2] > e[0]);
});

test('bullish FVG: low of candle 3 above high of candle 1', () => {
  reset();
  const cs = [C(100, 101, 99, 100), C(104, 106, 103, 105), C(108, 110, 107, 109)];
  const gaps = M.fairValueGaps(cs);
  assert.strictEqual(gaps.length, 1);
  assert.strictEqual(gaps[0].type, 'bullish');
  assert.strictEqual(gaps[0].low, 101);
  assert.strictEqual(gaps[0].high, 107);
});

test('bearish FVG detected and mitigation flagged', () => {
  reset();
  const cs = [C(100, 101, 99, 100), C(96, 97, 94, 95), C(92, 93, 90, 91),
              C(95, 99, 94, 98)]; // pushes back up through the gap -> mitigated
  const gaps = M.fairValueGaps(cs);
  assert.strictEqual(gaps[0].type, 'bearish');
  assert.strictEqual(gaps[0].mitigated, true);
});

test('demand zone: quiet base then strong up departure', () => {
  reset();
  const cs = [];
  for (let i = 0; i < 16; i++) cs.push(C(100, 101, 99, 100));       // ATR settles
  cs.push(C(100, 100.6, 99.6, 100.2));                              // quiet base
  cs.push(C(100.2, 108, 100, 107));                                 // strong departure
  cs.push(C(107, 109, 105, 108));
  const zones = M.demandSupplyZones(cs);
  assert.ok(zones.some((z) => z.type === 'demand' && !z.mitigated), JSON.stringify(zones));
});

test('OI summary: PCR, walls and max pain', () => {
  const rows = [];
  for (let s = 90; s <= 110; s += 5) {
    rows.push({ strike: s, callOi: s === 110 ? 5000 : 1000, putOi: s === 90 ? 6000 : 1000,
                callOiChange: 100, putOiChange: 50 });
  }
  const oi = M.oiSummary(rows);
  assert.strictEqual(oi.pcr, 1.11); // (6000+4000)/(5000+4000) = 10000/9000
  assert.strictEqual(oi.maxCallOiStrike, 110);
  assert.strictEqual(oi.maxPutOiStrike, 90);
  assert.ok(oi.maxPain >= 90 && oi.maxPain <= 110);
  assert.strictEqual(M.oiSummary([]), null);
});

test('analyze returns trend, nearest levels and zones together', () => {
  reset();
  const cs = [];
  let price = 100;
  for (let i = 0; i < 60; i++) { price += 0.6; cs.push(C(price - 0.4, price + 0.5, price - 0.9, price)); }
  const a = M.analyze(cs, { symbol: 'TEST', prevDay: { h: 120, l: 80, c: 110 },
                             optionChain: [{ strike: 140, callOi: 9000, putOi: 100 }, { strike: 100, callOi: 100, putOi: 9000 }] });
  assert.strictEqual(a.ok, true);
  assert.strictEqual(a.trend, 'uptrend');
  assert.ok(a.nearestResistance.length >= 1);
  assert.ok(a.oi && a.oi.pcr > 0);
});

test('analyze refuses too few candles', () => {
  reset();
  assert.strictEqual(M.analyze([C(1, 2, 1, 2)]).ok, false);
});

test('marketWarnings: price inside supply is a danger warning', () => {
  const a = { ok: true, price: 25260, trend: 'uptrend', rsi14: 55, vwap: 25100,
    supplyZones: [{ low: 25245, high: 25280, mitigated: false }],
    demandZones: [], nearestResistance: [], nearestSupport: [] };
  const w = M.marketWarnings(a, { trades: 1 }, { maxTradesPerDay: 5 });
  assert.ok(w.some((x) => x.code === 'in-supply' && x.level === 'danger'));
});

test('marketWarnings: hot trade count into supply escalates', () => {
  const a = { ok: true, price: 25260, trend: 'uptrend', rsi14: 55, vwap: 25100,
    supplyZones: [{ low: 25245, high: 25280, mitigated: false }],
    demandZones: [], nearestResistance: [], nearestSupport: [] };
  const w = M.marketWarnings(a, { trades: 4 }, { maxTradesPerDay: 5 });
  assert.ok(w.some((x) => x.code === 'hot-into-supply'));
});

test('marketWarnings: quiet market produces no warnings', () => {
  const a = { ok: true, price: 100, trend: 'sideways', rsi14: 50, vwap: 100,
    supplyZones: [], demandZones: [], nearestResistance: [{ price: 130 }], nearestSupport: [{ price: 70 }] };
  assert.deepStrictEqual(M.marketWarnings(a, { trades: 0 }, { maxTradesPerDay: 5 }), []);
});

test('thetaSummary: puts decaying faster when PE theta % is higher', () => {
  const rows = [];
  for (let s = 90; s <= 110; s += 5) {
    rows.push({ strike: s, callLtp: 40, putLtp: 40,
                callTheta: -3, putTheta: -5, callIv: 11, putIv: 14 });
  }
  const th = M.thetaSummary(rows, 100, 2);
  assert.strictEqual(th.fasterSide, 'PE');
  assert.ok(th.call.thetaPctOfPremium < th.put.thetaPctOfPremium);
  assert.match(th.verdict, /Put side is decaying faster/);
});

test('thetaSummary: balanced decay reports BOTH', () => {
  const rows = [{ strike: 100, callLtp: 50, putLtp: 50, callTheta: -4, putTheta: -4.2, callIv: 12, putIv: 12 }];
  assert.strictEqual(M.thetaSummary(rows, 100, 3).fasterSide, 'BOTH');
});

test('thetaSummary: Black-Scholes fills in when feed theta is missing', () => {
  const rows = [{ strike: 100, callLtp: 3.2, putLtp: 3.1, callTheta: 0, putTheta: 0, callIv: 12, putIv: 12 }];
  const th = M.thetaSummary(rows, 100, 5);
  assert.ok(th.call.avgThetaPerDay > 0, 'BS theta estimated: ' + th.call.avgThetaPerDay);
  assert.ok(M.bsThetaPerDay(100, 100, 5, 12, true) < 0, 'long option theta is negative');
});

test('thetaSummary: expiry day adds acceleration warning', () => {
  const rows = [{ strike: 100, callLtp: 20, putLtp: 20, callTheta: -6, putTheta: -6, callIv: 12, putIv: 12 }];
  assert.match(M.thetaSummary(rows, 100, 0).verdict, /Expiry is near/);
  assert.strictEqual(M.thetaSummary([], 100, 1), null);
});


test('RSI uses Wilder smoothing after the initial average', () => {
  const closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42,
    45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 46.55];
  const candles = closes.map((c, i) => ({ t: i, o: c, h: c, l: c, c, v: 1 }));
  assert.strictEqual(M.rsi(candles.slice(0, 15), 14), 70.46);
  assert.strictEqual(M.rsi(candles, 14), 68.86);
  assert.strictEqual(M.rsi(candles.map(c => ({ ...c, c: 50 })), 14), 50);
});

test('chartWindow applies pan offset and clamps it to available history', () => {
  const candles = Array.from({ length: 60 }, (_, i) => ({ t: i, c: i }));
  const latest = M.chartWindow(candles, 2, 0);
  assert.strictEqual(latest.startIndex, 30);
  assert.strictEqual(latest.candles.at(-1).c, 59);
  const panned = M.chartWindow(candles, 2, 10);
  assert.strictEqual(panned.startIndex, 20);
  assert.strictEqual(panned.candles.at(-1).c, 49);
  const clamped = M.chartWindow(candles, 2, 9999);
  assert.strictEqual(clamped.startIndex, 0);
  assert.strictEqual(clamped.candles.length, 30);
});

test('weekly demo generation returns 60 aggregated candles without minute-scale work', () => {
  const started = Date.now();
  const candles = M.generateCandles('NIFTY', '1W', 60);
  assert.strictEqual(candles.length, 60);
  assert.ok(Date.now() - started < 1000, 'weekly generation should not simulate 604,800 one-minute rows');
});
