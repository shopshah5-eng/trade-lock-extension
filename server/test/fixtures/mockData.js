'use strict';
/* Deterministic demo candles + option chain so the whole market feature can
 * be tried (and screenshotted) with no Fyers account. Seeded — same output
 * every run. */
function mulberry(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function demoCandles(symbol) {
  const rnd = mulberry(symbol === 'BANKNIFTY' ? 42 : 7);
  const base = symbol === 'BANKNIFTY' ? 45200 : 25100;
  const step = symbol === 'BANKNIFTY' ? 90 : 50;
  const start = Date.UTC(2026, 9, 16, 3, 45, 0); // 09:15 IST
  const out = [];
  let price = base;
  for (let i = 0; i < 75; i++) {
    // quiet base, strong demand departure, drift, supply rejection, FVG left behind
    let drift = (rnd() - 0.48) * step * 0.5;
    if (i >= 20 && i < 24) drift += step * 0.9;          // demand departure
    if (i >= 48 && i < 52) drift -= step * 0.8;          // supply rejection
    if (i >= 60) drift += step * 0.45;                   // recovery leg
    const o = price;
    const c = o + drift;
    const h = Math.max(o, c) + rnd() * step * 0.35;
    const l = Math.min(o, c) - rnd() * step * 0.35;
    out.push({ t: start + i * 5 * 60000, o: r2(o), h: r2(h), l: r2(l), c: r2(c), v: Math.round(40000 + rnd() * 90000) });
    price = c;
  }
  return out;
}

function demoOptionChain(symbol, spotHint) {
  const step = symbol === 'BANKNIFTY' ? 100 : 50;
  const spot = spotHint || (symbol === 'BANKNIFTY' ? 45300 : 25200);
  const atm = Math.round(spot / step) * step;
  const rows = [];
  for (let k = -8; k <= 8; k++) {
    const strike = atm + k * step;
    const dist = Math.abs(k);
    const timeVal = 95 * Math.exp(-dist * 0.3);
    const callLtp = Math.max(spot - strike, 0) + timeVal;
    const putLtp = Math.max(strike - spot, 0) + timeVal * 1.08; // put skew
    rows.push({
      strike,
      callOi: Math.round(900000 * Math.exp(-dist * 0.28) * (k === 4 ? 2.6 : 1)),
      putOi: Math.round(850000 * Math.exp(-dist * 0.28) * (k === -4 ? 2.4 : 1)),
      callOiChange: Math.round((k > 0 ? 42000 : -15000) * Math.exp(-dist * 0.2)),
      putOiChange: Math.round((k < 0 ? 38000 : -12000) * Math.exp(-dist * 0.2)),
      callLtp: Math.round(callLtp), putLtp: Math.round(putLtp),
      // puts decay a bit faster in this demo (higher IV/skew on the put side)
      callTheta: -Math.round(timeVal * 0.085), putTheta: -Math.round(timeVal * 1.08 * 0.115),
      callIv: 11.5, putIv: 13.5
    });
  }
  return rows;
}

function r2(x) { return Math.round(x * 100) / 100; }
module.exports = { demoCandles, demoOptionChain };
