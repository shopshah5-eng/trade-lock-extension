/*
 * Trade Lock — Market intelligence engine (pure, deterministic).
 *
 * Candles in:  [{t, o, h, l, c, v}]  (t = epoch ms or seconds)
 * Option rows: [{strike, callOi, putOi, callOiChange, putOiChange}]
 *
 * Everything here is testable maths — swing/pivot support & resistance,
 * demand/supply zones, fair value gaps, VWAP/EMA/RSI/ATR and option-OI
 * structure. The AI (if enabled) only narrates this output; it never
 * invents the numbers.
 *
 * globalThis.TLMarket / module.exports
 */
(function (root) {
  'use strict';

  function n(x) { var v = Number(x); return isFinite(v) ? v : 0; }
  function round2(x) { return Math.round(n(x) * 100) / 100; }

  function normCandles(candles) {
    return (Array.isArray(candles) ? candles : []).map(function (c) {
      if (Array.isArray(c)) { // Fyers wire format [epoch, o, h, l, c, v]
        return { t: n(c[0]), o: n(c[1]), h: n(c[2]), l: n(c[3]), c: n(c[4]), v: n(c[5]) };
      }
      return { t: n(c.t), o: n(c.o), h: n(c.h), l: n(c.l), c: n(c.c), v: n(c.v || c.volume) };
    }).filter(function (c) { return c.h >= c.l && c.c > 0; })
      .sort(function (a, b) { return a.t - b.t; });
  }

  // ------------------------------------------------------------ indicators ----

  function ema(values, period) {
    if (!values.length || period < 1) return [];
    var k = 2 / (period + 1), out = [], prev = values[0];
    values.forEach(function (v, i) { prev = i === 0 ? v : v * k + prev * (1 - k); out.push(round2(prev)); });
    return out;
  }

  function atr(candles, period) {
    period = period || 14;
    var cs = normCandles(candles), trs = [];
    cs.forEach(function (c, i) {
      if (i === 0) { trs.push(c.h - c.l); return; }
      var pc = cs[i - 1].c;
      trs.push(Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc)));
    });
    var out = [], avg = 0;
    trs.forEach(function (tr, i) {
      avg = i === 0 ? tr : (avg * (Math.min(i, period - 1)) + tr) / Math.min(i + 1, period);
      out.push(round2(avg));
    });
    return out;
  }

  function rsi(candles, period) {
    period = period || 14;
    var cs = normCandles(candles);
    if (cs.length < 2) return cs.length ? 50 : 0;
    var gains = 0, losses = 0;
    var samples = Math.min(period, cs.length - 1);
    for (var i = 1; i <= samples; i++) {
      var d = cs[i].c - cs[i - 1].c;
      if (d > 0) gains += d; else losses -= d;
    }
    var avgGain = gains / samples;
    var avgLoss = losses / samples;
    for (var j = samples + 1; j < cs.length; j++) {
      var change = cs[j].c - cs[j - 1].c;
      avgGain = ((avgGain * (period - 1)) + Math.max(0, change)) / period;
      avgLoss = ((avgLoss * (period - 1)) + Math.max(0, -change)) / period;
    }
    if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
    var rs = avgGain / avgLoss;
    return round2(100 - 100 / (1 + rs));
  }

  function vwap(candles) {
    var cs = normCandles(candles), pv = 0, vol = 0, out = [];
    cs.forEach(function (c) {
      var tp = (c.h + c.l + c.c) / 3;
      pv += tp * c.v; vol += c.v;
      out.push(vol ? round2(pv / vol) : round2(tp));
    });
    return out;
  }

  // ------------------------------------------------- support & resistance ----

  function classicPivots(prev) {
    if (!prev) return null;
    var p = (prev.h + prev.l + prev.c) / 3, rng = prev.h - prev.l;
    return {
      pivot: round2(p),
      r1: round2(2 * p - prev.l), s1: round2(2 * p - prev.h),
      r2: round2(p + rng), s2: round2(p - rng),
      r3: round2(p + 2 * rng), s3: round2(p - 2 * rng),
      prevHigh: prev.h, prevLow: prev.l, prevClose: prev.c
    };
  }

  /** Fractal swing highs/lows, clustered into levels with touch counts. */
  function swingLevels(candles, opts) {
    opts = opts || {};
    var cs = normCandles(candles);
    var wing = opts.wing || 2;
    var a = atr(cs, 14), lastAtr = a.length ? a[a.length - 1] : 0;
    var tol = Math.max(lastAtr * (opts.toleranceAtr || 0.35), cs.length ? cs[cs.length - 1].c * 0.0005 : 0);
    var raw = [];
    for (var i = wing; i < cs.length - wing; i++) {
      var hi = true, lo = true;
      for (var j = 1; j <= wing; j++) {
        if (cs[i].h < cs[i - j].h || cs[i].h < cs[i + j].h) hi = false;
        if (cs[i].l > cs[i - j].l || cs[i].l > cs[i + j].l) lo = false;
      }
      if (hi) raw.push({ price: cs[i].h, type: 'resistance', at: cs[i].t });
      if (lo) raw.push({ price: cs[i].l, type: 'support', at: cs[i].t });
    }
    var levels = [];
    raw.sort(function (x, y) { return x.price - y.price; }).forEach(function (pt) {
      var found = null;
      levels.forEach(function (lv) { if (Math.abs(lv.price - pt.price) <= tol && lv.type === pt.type) found = lv; });
      if (found) { found.touches++; found.price = round2((found.price * (found.touches - 1) + pt.price) / found.touches); }
      else levels.push({ price: round2(pt.price), type: pt.type, touches: 1 });
    });
    return levels.sort(function (a, b) { return b.touches - a.touches || a.price - b.price; });
  }

  // ------------------------------------------------------- zones & gaps ----

  /**
   * Demand/supply zones: a quiet base followed by a strong departure candle.
   * Demand = base then strong up-move; supply = base then strong down-move.
   * `mitigated` once later price trades back through the zone.
   */
  function demandSupplyZones(candles, opts) {
    opts = opts || {};
    var cs = normCandles(candles);
    var a = atr(cs, 14);
    var zones = [];
    for (var i = 2; i < cs.length; i++) {
      var cur = cs[i], base = cs[i - 1], curAtr = a[i] || (cur.h - cur.l) || 1;
      var body = cur.c - cur.o;
      var baseRange = base.h - base.l;
      if (baseRange > curAtr * 0.7) continue;             // base must be quiet
      if (Math.abs(body) < curAtr * (opts.strengthAtr || 0.9)) continue; // departure must be strong
      var type = body > 0 ? 'demand' : 'supply';
      var zone = {
        type: type,
        high: round2(base.h), low: round2(base.l),
        mid: round2((base.h + base.l) / 2),
        at: base.t, strength: round2(Math.abs(body) / curAtr),
        mitigated: false, fresh: true
      };
      for (var k = i + 1; k < cs.length; k++) {
        if (type === 'demand' && cs[k].l < zone.low) { zone.mitigated = true; zone.fresh = false; break; }
        if (type === 'demand' && cs[k].l <= zone.high) zone.fresh = false;
        if (type === 'supply' && cs[k].h > zone.high) { zone.mitigated = true; zone.fresh = false; break; }
        if (type === 'supply' && cs[k].h >= zone.low) zone.fresh = false;
      }
      zones.push(zone);
    }
    var seen = {};
    return zones.filter(function (z) {
      var key = z.type + ':' + z.low + ':' + z.high;
      if (seen[key]) return false; seen[key] = true; return true;
    }).slice(-(opts.maxZones || 8));
  }

  /** Fair value gaps: 3-candle imbalances, with mitigation status.
   *  Gaps narrower than 20% of ATR are noise in a trend and are dropped. */
  function fairValueGaps(candles) {
    var cs = normCandles(candles), gaps = [];
    var atrArr = atr(cs, 14);
    for (var i = 2; i < cs.length; i++) {
      var a = cs[i - 2], c = cs[i];
      var minWidth = (atrArr[i] || 0) * 0.2;
      if (c.l > a.h && (c.l - a.h) >= minWidth) gaps.push({ type: 'bullish', high: round2(c.l), low: round2(a.h), mid: round2((c.l + a.h) / 2), at: c.t, mitigated: false });
      else if (c.h < a.l && (a.l - c.h) >= minWidth) gaps.push({ type: 'bearish', high: round2(a.l), low: round2(c.h), mid: round2((a.l + c.h) / 2), at: c.t, mitigated: false });
    }
    gaps.forEach(function (g) {
      var idx = cs.findIndex(function (x) { return x.t === g.at; });
      for (var k = idx + 1; k < cs.length; k++) {
        if (g.type === 'bullish' && cs[k].l <= g.low) { g.mitigated = true; break; }
        if (g.type === 'bearish' && cs[k].h >= g.high) { g.mitigated = true; break; }
      }
    });
    return gaps.slice(-12);
  }

  // ------------------------------------------------------------------ OI ----

  function oiSummary(rows) {
    var r = (Array.isArray(rows) ? rows : []).map(function (x) {
      return { strike: n(x.strike), callOi: n(x.callOi), putOi: n(x.putOi),
               callOiChange: n(x.callOiChange), putOiChange: n(x.putOiChange) };
    }).filter(function (x) { return x.strike > 0; });
    if (!r.length) return null;
    var callTotal = r.reduce(function (a, x) { return a + x.callOi; }, 0);
    var putTotal = r.reduce(function (a, x) { return a + x.putOi; }, 0);
    var byCall = r.slice().sort(function (a, b) { return b.callOi - a.callOi; });
    var byPut = r.slice().sort(function (a, b) { return b.putOi - a.putOi; });
    // Max pain: spot at expiry that minimises total option-holder payout.
    var best = null;
    r.forEach(function (spot) {
      var pain = 0;
      r.forEach(function (x) {
        if (spot.strike > x.strike) pain += (spot.strike - x.strike) * x.callOi;
        if (spot.strike < x.strike) pain += (x.strike - spot.strike) * x.putOi;
      });
      if (!best || pain < best.pain) best = { strike: spot.strike, pain: pain };
    });
    return {
      totalCallOi: callTotal, totalPutOi: putTotal,
      pcr: callTotal ? round2(putTotal / callTotal) : 0,
      maxCallOiStrike: byCall[0].strike, maxPutOiStrike: byPut[0].strike,
      callWalls: byCall.slice(0, 3).map(function (x) { return { strike: x.strike, oi: x.callOi }; }),
      putWalls: byPut.slice(0, 3).map(function (x) { return { strike: x.strike, oi: x.putOi }; }),
      callOiChange: r.reduce(function (a, x) { return a + x.callOiChange; }, 0),
      putOiChange: r.reduce(function (a, x) { return a + x.putOiChange; }, 0),
      maxPain: best ? best.strike : null
    };
  }


  // ------------------------------------------------------------ theta ----

  function normPdf(x) { return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI); }
  function normCdf(x) { // Abramowitz–Stegun
    var s = x < 0 ? -1 : 1, ax = Math.abs(x) / Math.sqrt(2);
    var erf = 1 - Math.pow(1 + 0.278393 * ax + 0.230389 * ax * ax + 0.000972 * ax * ax * ax - 0.078108 * Math.pow(ax, 4), -4);
    return 0.5 * (1 + s * erf);
  }

  /** Black–Scholes theta per day (long option; negative = decay). Fallback
   *  when the feed gives IV but no theta. */
  function bsThetaPerDay(spot, strike, daysToExpiry, ivPct, isCall) {
    var T = Math.max(daysToExpiry, 0.02) / 365, r = 0.065, vol = (ivPct || 0) / 100;
    if (!(spot > 0 && strike > 0 && vol > 0)) return 0;
    var d1 = (Math.log(spot / strike) + (r + vol * vol / 2) * T) / (vol * Math.sqrt(T));
    var d2 = d1 - vol * Math.sqrt(T);
    var term1 = -(spot * normPdf(d1) * vol) / (2 * Math.sqrt(T));
    var thetaYear = isCall
      ? term1 - r * strike * Math.exp(-r * T) * normCdf(d2)
      : term1 + r * strike * Math.exp(-r * T) * normCdf(-d2);
    return round2(thetaYear / 365 * 100) / 100;
  }

  /**
   * Which side is melting faster — calls, puts, or both?
   * rows: [{strike, callTheta, putTheta, callLtp, putLtp, callIv, putIv}]
   * Theta from the feed wins; Black–Scholes fills gaps when IV exists.
   * Long options lose theta on BOTH sides; option sellers collect it.
   */
  function thetaSummary(rows, spot, daysToExpiry) {
    var r = (Array.isArray(rows) ? rows : []).filter(function (x) { return n(x.strike) > 0; });
    if (!r.length || !(spot > 0)) return null;
    var dte = (typeof daysToExpiry === 'number' && daysToExpiry >= 0) ? daysToExpiry : 1;
    var sorted = r.slice().sort(function (a, b) { return Math.abs(a.strike - spot) - Math.abs(b.strike - spot); });
    var near = sorted.slice(0, Math.min(5, sorted.length)); // ATM ± a few strikes

    function side(isCall) {
      var thetas = [], pcts = [], extrPcts = [];
      near.forEach(function (x) {
        var ltp = isCall ? n(x.callLtp) : n(x.putLtp);
        var th = isCall ? n(x.callTheta) : n(x.putTheta);
        var iv = isCall ? n(x.callIv) : n(x.putIv);
        if (!th && iv) th = bsThetaPerDay(spot, x.strike, dte, iv, isCall);
        if (!th) return;
        var intrinsic = isCall ? Math.max(spot - x.strike, 0) : Math.max(x.strike - spot, 0);
        var extrinsic = Math.max(ltp - intrinsic, 0);
        thetas.push(Math.abs(th));
        if (ltp > 0) pcts.push(Math.abs(th) / ltp * 100);
        if (extrinsic > 0.05) extrPcts.push(Math.abs(th) / extrinsic * 100);
      });
      var avg = function (a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : 0; };
      return { avgThetaPerDay: round2(avg(thetas)), thetaPctOfPremium: round2(avg(pcts)), extrinsicDecayPctPerDay: round2(avg(extrPcts)), samples: thetas.length };
    }

    var call = side(true), put = side(false);
    // Compare on theta as % of premium: extrinsic-only comparisons get
    // distorted by ITM strikes whose extrinsic value is near zero.
    var metric = function (s) { return s.thetaPctOfPremium || s.extrinsicDecayPctPerDay; };
    var cm = metric(call), pm = metric(put);
    var fasterSide = 'BOTH', verdict;
    if (cm && pm && Math.abs(cm - pm) / Math.max(cm, pm) > 0.15) {
      fasterSide = cm > pm ? 'CE' : 'PE';
      verdict = (fasterSide === 'CE' ? 'Call' : 'Put') + ' side is decaying faster near ATM — long ' +
        (fasterSide === 'CE' ? 'calls' : 'puts') + ' are melting quicker; sellers on that side collect faster.';
    } else {
      verdict = 'Both sides are decaying at a similar pace near ATM — theta is a wash; direction and IV matter more today.';
    }
    if (dte <= 1) verdict += ' Expiry is near: decay accelerates sharply into the close.';
    return {
      atmStrike: sorted[0].strike, daysToExpiry: dte, call: call, put: put,
      fasterSide: fasterSide, verdict: verdict,
      note: 'Long options lose this value daily on both sides; option writers/sellers earn it. Near expiry the decay is non-linear.'
    };
  }

  // -------------------------------------------------------------- analyze ----

  function analyze(candles, opts) {
    opts = opts || {};
    var cs = normCandles(candles);
    if (cs.length < 5) return { ok: false, reason: 'not_enough_candles', candles: cs.length };
    var closes = cs.map(function (c) { return c.c; });
    var price = closes[closes.length - 1];
    var e9 = ema(closes, 9), e20 = ema(closes, 20), vw = vwap(cs), at = atr(cs, 14);
    var pivots = opts.prevDay ? classicPivots(opts.prevDay) : null;
    var levels = swingLevels(cs, opts);
    if (pivots) {
      levels.push({ price: pivots.r1, type: 'resistance', touches: 1, source: 'pivot' });
      levels.push({ price: pivots.s1, type: 'support', touches: 1, source: 'pivot' });
      levels.push({ price: pivots.prevHigh, type: 'resistance', touches: 1, source: 'prevDay' });
      levels.push({ price: pivots.prevLow, type: 'support', touches: 1, source: 'prevDay' });
    }
    var zones = demandSupplyZones(cs, opts);
    var gaps = fairValueGaps(cs);
    var oi = opts.optionChain ? oiSummary(opts.optionChain) : null;
    var theta = opts.optionChain ? thetaSummary(opts.optionChain, price, opts.daysToExpiry) : null;
    if (oi) {
      levels.push({ price: oi.maxCallOiStrike, type: 'resistance', touches: 3, source: 'oi' });
      levels.push({ price: oi.maxPutOiStrike, type: 'support', touches: 3, source: 'oi' });
    }
    var above = levels.filter(function (l) { return l.price > price; }).sort(function (a, b) { return a.price - b.price; });
    var below = levels.filter(function (l) { return l.price <= price; }).sort(function (a, b) { return b.price - a.price; });
    var lastVwap = vw[vw.length - 1];
    var trend = price > lastVwap && e9[e9.length - 1] >= e20[e20.length - 1] ? 'uptrend'
      : price < lastVwap && e9[e9.length - 1] <= e20[e20.length - 1] ? 'downtrend' : 'sideways';

    return {
      ok: true, symbol: opts.symbol || '', timeframe: opts.timeframe || '',
      price: round2(price), candles: cs.length,
      trend: trend,
      vwap: lastVwap, ema9: e9[e9.length - 1], ema20: e20[e20.length - 1],
      rsi14: rsi(cs, 14), atr14: at[at.length - 1],
      pivots: pivots,
      nearestResistance: above.slice(0, 3), nearestSupport: below.slice(0, 3),
      demandZones: zones.filter(function (z) { return z.type === 'demand'; }),
      supplyZones: zones.filter(function (z) { return z.type === 'supply'; }),
      fvgs: gaps, oi: oi, theta: theta
    };
  }


  /**
   * Intraday warnings: market context x the trader's own state.
   * This is where "price is entering supply" meets "you are at 4/5 trades".
   */
  function marketWarnings(analysis, session, settings) {
    var out = [];
    if (!analysis || !analysis.ok) return out;
    var s = settings || {}, sess = session || {};
    var price = analysis.price;
    var inSupply = (analysis.supplyZones || []).find(function (z) { return !z.mitigated && price >= z.low && price <= z.high; });
    var inDemand = (analysis.demandZones || []).find(function (z) { return !z.mitigated && price >= z.low && price <= z.high; });
    var near = function (lvl) { return lvl && Math.abs(lvl.price - price) / price <= 0.0015; };
    var res = (analysis.nearestResistance || [])[0];
    var sup = (analysis.nearestSupport || [])[0];
    var tradesHot = s.maxTradesPerDay > 0 && sess.trades >= Math.ceil(s.maxTradesPerDay * 0.8);

    if (inSupply) out.push({ level: 'danger', code: 'in-supply',
      text: 'Price is inside supply ' + inSupply.low + '–' + inSupply.high + '. Avoid fresh longs here.' });
    if (near(res)) out.push({ level: 'warn', code: 'near-resistance',
      text: 'Approaching resistance ' + res.price + (res.source === 'oi' ? ' (OI call wall)' : '') + '.' });
    if (inDemand) out.push({ level: 'ok', code: 'in-demand',
      text: 'Price is in demand ' + inDemand.low + '–' + inDemand.high + (inDemand.fresh ? ' (fresh zone)' : '') + '.' });
    if (near(sup)) out.push({ level: 'warn', code: 'near-support',
      text: 'Near support ' + sup.price + (sup.source === 'oi' ? ' (OI put wall)' : '') + ' — watch for reaction, do not pre-empt.' });
    if (analysis.rsi14 >= 75) out.push({ level: 'warn', code: 'rsi-hot', text: 'RSI ' + analysis.rsi14 + ' — momentum stretched.' });
    if (analysis.rsi14 <= 25 && analysis.rsi14 > 0) out.push({ level: 'warn', code: 'rsi-cold', text: 'RSI ' + analysis.rsi14 + ' — oversold; shorts are late here.' });
    if (tradesHot && (inSupply || near(res))) out.push({ level: 'danger', code: 'hot-into-supply',
      text: 'You have used ' + sess.trades + '/' + s.maxTradesPerDay + ' trades into resistance/supply. This is where accounts leak.' });
    return out;
  }

  // ------------------------------------------------ extended analytics & greeks ----

  var INSTRUMENTS = {
    NIFTY: { symbol: 'NIFTY', name: 'NIFTY 50', exchange: 'NSE', fyersSymbol: 'NSE:NIFTY50-INDEX', basePrice: 24520, step: 50, lotSize: 75, expiryDay: 4 },
    BANKNIFTY: { symbol: 'BANKNIFTY', name: 'BANK NIFTY', exchange: 'NSE', fyersSymbol: 'NSE:NIFTYBANK-INDEX', basePrice: 51200, step: 100, lotSize: 15, expiryDay: 3 },
    FINNIFTY: { symbol: 'FINNIFTY', name: 'FIN NIFTY', exchange: 'NSE', fyersSymbol: 'NSE:FINNIFTY-INDEX', basePrice: 23850, step: 50, lotSize: 25, expiryDay: 2 },
    MIDCPNIFTY: { symbol: 'MIDCPNIFTY', name: 'MIDCPNIFTY', exchange: 'NSE', fyersSymbol: 'NSE:MIDCPNIFTY-INDEX', basePrice: 12850, step: 25, lotSize: 50, expiryDay: 1 },
    SENSEX: { symbol: 'SENSEX', name: 'BSE SENSEX', exchange: 'BSE', fyersSymbol: 'BSE:SENSEX-INDEX', basePrice: 80400, step: 100, lotSize: 10, expiryDay: 5 },
    BANKEX: { symbol: 'BANKEX', name: 'BSE BANKEX', exchange: 'BSE', fyersSymbol: 'BSE:BANKEX-INDEX', basePrice: 58600, step: 100, lotSize: 15, expiryDay: 1 }
  };

  var TIMEFRAME_MINUTES = {
    '1m': 1, '3m': 3, '5m': 5, '10m': 10, '15m': 15, '30m': 30, '45m': 45,
    '1h': 60, '2h': 120, '4h': 240, '1d': 1440, '1w': 10080,
    '1D': 1440, '1W': 10080
  };

  function aggregateCandles(candles, targetIntervalMinutes) {
    var raw = normCandles(candles);
    if (!raw.length || targetIntervalMinutes <= 1) return raw;
    var bucketMs = targetIntervalMinutes * 60 * 1000;
    var buckets = {};
    raw.forEach(function (c) {
      var bucketKey = Math.floor(c.t / bucketMs) * bucketMs;
      if (!buckets[bucketKey]) {
        buckets[bucketKey] = { t: bucketKey, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v };
      } else {
        var b = buckets[bucketKey];
        b.h = Math.max(b.h, c.h);
        b.l = Math.min(b.l, c.l);
        b.c = c.c;
        b.v += c.v;
      }
    });
    return Object.keys(buckets).sort(function (a, b) { return Number(a) - Number(b); })
      .map(function (k) { return buckets[k]; });
  }

  function generateCandles(symbol, timeframe, count) {
    var inst = INSTRUMENTS[symbol] || INSTRUMENTS.NIFTY;
    var intervalMin = TIMEFRAME_MINUTES[timeframe] || 15;
    var totalCandles = count || 60;
    var basePrice = inst.basePrice;
    var step = inst.step;
    var now = Date.now();
    var baseIntervalMin = intervalMin > 60 ? 60 : 1;
    var base1mCount = Math.max(Math.ceil(totalCandles * intervalMin / baseIntervalMin), 180);
    var startTime = now - (base1mCount * baseIntervalMin * 60 * 1000);

    var raw1m = [];
    var p = basePrice;
    var seed = symbol.split('').reduce(function (acc, char) { return acc + char.charCodeAt(0); }, 0);

    for (var i = 0; i < base1mCount; i++) {
      var angle = (i + seed) / 14;
      var intervalScale = Math.sqrt(baseIntervalMin);
      var drift = (Math.sin(angle) * (step * 0.12) + Math.cos((i * 3 + seed) / 25) * (step * 0.08)) * intervalScale;
      var open = p;
      var close = round2(p + drift);
      var range = Math.max(step * 0.15, Math.abs(open - close) * 1.5);
      var high = round2(Math.max(open, close) + Math.abs(Math.sin(angle * 2)) * range);
      var low = round2(Math.min(open, close) - Math.abs(Math.cos(angle * 2)) * range);
      var vol = Math.round(1500 + Math.abs(Math.sin(i / 10)) * 3200 + ((high - low) / step) * 2000);
      p = close;
      raw1m.push({ t: startTime + i * baseIntervalMin * 60 * 1000, o: open, h: high, l: low, c: close, v: vol });
    }

    if (intervalMin === 1) return raw1m.slice(-totalCandles);
    var agg = aggregateCandles(raw1m, intervalMin);
    return agg.slice(-totalCandles);
  }

  function calculateGreeks(spot, strike, daysToExpiry, ivPct, isCall, rRate) {
    var T = Math.max(daysToExpiry, 0.001) / 365;
    var r = (typeof rRate === 'number' && rRate > 0) ? rRate : 0.065;
    var vol = Math.max(0.01, (ivPct || 14) / 100);
    if (!(spot > 0 && strike > 0)) return null;

    var sqrtT = Math.sqrt(T);
    var d1 = (Math.log(spot / strike) + (r + (vol * vol) / 2) * T) / (vol * sqrtT);
    var d2 = d1 - vol * sqrtT;

    var nd1 = normPdf(d1);
    var delta = isCall ? normCdf(d1) : (normCdf(d1) - 1);
    var gamma = nd1 / (spot * vol * sqrtT);
    var vega = (spot * nd1 * sqrtT) / 100;

    var term1 = -(spot * nd1 * vol) / (2 * sqrtT);
    var thetaYear = isCall
      ? term1 - r * strike * Math.exp(-r * T) * normCdf(d2)
      : term1 + r * strike * Math.exp(-r * T) * normCdf(-d2);
    var thetaDay = round2(thetaYear / 365);

    var discount = Math.exp(-r * T);
    var bsPrice = isCall
      ? round2(spot * normCdf(d1) - strike * discount * normCdf(d2))
      : round2(strike * discount * normCdf(-d2) - spot * normCdf(-d1));
    var intrinsic = isCall ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
    var extrinsic = Math.max(0, bsPrice - intrinsic);

    return {
      delta: round2(delta),
      gamma: Math.round(gamma * 10000) / 10000,
      vega: round2(vega),
      thetaDay: thetaDay,
      theta1Hour: round2(thetaDay / 6.25),
      price: Math.max(0.05, bsPrice),
      intrinsic: round2(intrinsic),
      extrinsic: round2(extrinsic)
    };
  }

  function chartWindow(candles, zoom, panOffset) {
    var cs = Array.isArray(candles) ? candles : [];
    if (!cs.length) return { candles: [], startIndex: 0, panOffset: 0, visibleCount: 0 };
    var z = Number(zoom) || 1;
    var visibleCount = Math.max(20, Math.min(cs.length, Math.round(cs.length / z)));
    var maxPan = Math.max(0, cs.length - visibleCount);
    var pan = Math.max(0, Math.min(Number(panOffset) || 0, maxPan));
    var startIndex = Math.max(0, cs.length - visibleCount - Math.round(pan));
    return { candles: cs.slice(startIndex, startIndex + visibleCount), startIndex: startIndex,
      panOffset: pan, visibleCount: visibleCount };
  }

  function vixAnalytics(currentVix, prevCloseVix, historicalSamples) {
    var cur = round2(currentVix || 13.85);
    var prev = round2(prevCloseVix || 13.43);
    var change = round2(cur - prev);
    var changePct = prev > 0 ? round2((change / prev) * 100) : 0;
    var isSpike = Math.abs(changePct) >= 10 || cur >= 20;

    var history = Array.isArray(historicalSamples) && historicalSamples.length >= 5
      ? historicalSamples
      : [12.8, 13.1, 13.4, 12.9, 13.2, 13.5, 13.85];

    var sorted = history.slice().sort(function (a, b) { return a - b; });
    var min = sorted[0], max = sorted[sorted.length - 1];
    var rank = max > min ? round2(Math.max(0, Math.min(100, ((cur - min) / (max - min)) * 100))) : 50;
    var below = sorted.filter(function (x) { return x < cur; }).length;
    var percentile = round2(Math.max(0, Math.min(100, (below / sorted.length) * 100)));

    return {
      value: cur,
      change: change,
      changePct: changePct,
      isSpike: isSpike,
      status: cur > 18 ? 'ELEVATED' : cur < 12 ? 'COMPRESSED' : 'NORMAL',
      historicalMin: min,
      historicalMax: max,
      ivRank: rank,
      ivPercentile: percentile,
      history: history,
      note: 'India VIX gauges 30-day annualized volatility derived from out-of-the-money Nifty option prices.'
    };
  }

  var api = {
    INSTRUMENTS: INSTRUMENTS,
    TIMEFRAME_MINUTES: TIMEFRAME_MINUTES,
    normCandles: normCandles,
    aggregateCandles: aggregateCandles,
    generateCandles: generateCandles,
    ema: ema, atr: atr, rsi: rsi, vwap: vwap,
    classicPivots: classicPivots, swingLevels: swingLevels,
    demandSupplyZones: demandSupplyZones, fairValueGaps: fairValueGaps,
    oiSummary: oiSummary, thetaSummary: thetaSummary, bsThetaPerDay: bsThetaPerDay,
    calculateGreeks: calculateGreeks, vixAnalytics: vixAnalytics,
    analyze: analyze, marketWarnings: marketWarnings, chartWindow: chartWindow
  };
  root.TLMarket = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
