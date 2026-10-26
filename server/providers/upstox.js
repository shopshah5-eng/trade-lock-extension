'use strict';
/*
 * Upstox market-data adapter (server-side only — tokens never reach the extension).
 *
 * Why this exists next to the Fyers adapter: the Fyers API v3 access token dies
 * every day at 06:30 IST, which makes a paid product impossible to keep online
 * without a human pasting a token every morning. Upstox issues an *Analytics
 * Token* — free, read-only, generated once from the Developer Apps page, valid
 * for a full year, no OAuth redirect — which covers exactly what this app
 * needs: historical/intraday candles, market quotes and the option chain.
 *
 * Docs:
 *   https://upstox.com/developer/api-documentation/analytics-token/
 *   https://upstox.com/developer/api-documentation/v3/get-historical-candle-data/
 *   https://upstox.com/developer/api-documentation/v3/get-intra-day-candle-data/
 *   https://upstox.com/developer/api-documentation/get-pc-option-chain/
 *
 * Auth: `Authorization: Bearer <analytics-token>`. Read-only: GET only.
 *
 * Known provider quirk: index instruments (NSE_INDEX|Nifty 50) are rejected by
 * some v3 historical routes even though the docs say otherwise, so every call
 * falls back to the v2 route and re-aggregates from 1-minute candles.
 */

const DEFAULT_BASE = process.env.UPSTOX_BASE || 'https://api.upstox.com';

/** App symbol -> Upstox instrument key. Anything containing "|" passes through. */
const INSTRUMENT_KEYS = {
  NIFTY: 'NSE_INDEX|Nifty 50',
  BANKNIFTY: 'NSE_INDEX|Nifty Bank',
  FINNIFTY: 'NSE_INDEX|Nifty Fin Service',
  MIDCPNIFTY: 'NSE_INDEX|NIFTY MID SELECT',
  SENSEX: 'BSE_INDEX|SENSEX',
  BANKEX: 'BSE_INDEX|BANKEX',
  INDIAVIX: 'NSE_INDEX|India VIX',
};

/*
 * Symbols arrive in several dialects: the app's own ('NIFTY'), Upstox keys
 * ('NSE_INDEX|Nifty 50'), and Fyers wire symbols ('NSE:BANKNIFTY-INDEX').
 *
 * This used to fall back to NIFTY for anything unrecognised, which meant
 * asking for Bank Nifty returned Nifty 50 candles labelled as Bank Nifty -
 * confidently wrong data, worse than an error. Unknown symbols now return null
 * and the caller reports unknown_symbol.
 */
function instrumentKeyFor(symbol) {
  const raw = String(symbol || 'NIFTY').trim();
  if (raw.includes('|')) return raw;

  const exchange = /^BSE:/i.test(raw) ? 'BSE' : 'NSE';
  const bare = raw
    .toUpperCase()
    .replace(/^(NSE|BSE):/, '')
    .replace(/-INDEX$/, '')
    .replace(/[\s_-]/g, '');

  // Fyers writes NIFTY 50 as NIFTY50-INDEX; the app calls it NIFTY.
  const aliases = {
    NIFTY50: 'NIFTY', NIFTYBANK: 'BANKNIFTY', NIFTYFINANCE: 'FINNIFTY',
    NIFTYFINSERVICE: 'FINNIFTY', NIFTYMIDSELECT: 'MIDCPNIFTY',
  };
  const name = aliases[bare] || bare;
  if (INSTRUMENT_KEYS[name]) {
    // A BSE prefix only makes sense for the BSE-only indices.
    if (exchange === 'BSE' && name !== 'SENSEX' && name !== 'BANKEX') return null;
    return INSTRUMENT_KEYS[name];
  }
  return null;
}

/** Same as instrumentKeyFor, but throws a labelled error for unknown symbols. */
function requireInstrumentKey(symbol) {
  const key = instrumentKeyFor(symbol);
  if (!key) {
    const error = new Error('unknown_symbol: ' + String(symbol) + ' is not a supported index');
    error.code = 'unknown_symbol';
    throw error;
  }
  return key;
}

/**
 * Normalise the app's resolution strings ('15', '15m', '1D', 'D') into an
 * Upstox {unit, interval} pair plus the candle length in minutes.
 */
function parseResolution(resolution) {
  const raw = String(resolution == null ? '15' : resolution).trim().toUpperCase();
  if (raw === 'D' || raw === '1D' || raw === 'DAY' || raw === 'DAYS') {
    return { unit: 'days', interval: '1', minutes: 1440 };
  }
  const m = raw.match(/^(\d+)\s*M?$/);
  const n = m ? Number(m[1]) : 15;
  if (!Number.isFinite(n) || n <= 0) return { unit: 'minutes', interval: '15', minutes: 15 };
  if (n % 60 === 0 && n >= 60 && n <= 300) return { unit: 'hours', interval: String(n / 60), minutes: n };
  return { unit: 'minutes', interval: String(Math.min(n, 300)), minutes: Math.min(n, 300) };
}

/** YYYY-MM-DD in IST — Upstox dates are exchange-local and every user here is IST. */
function istDate(d) {
  const dt = d instanceof Date ? d : new Date(d);
  const shifted = new Date(dt.getTime() + 5.5 * 3600 * 1000);
  return shifted.toISOString().slice(0, 10);
}

/** Upstox candles are [timestamp, o, h, l, c, v, oi] (timestamp is ISO for v3). */
function normalizeCandles(payload) {
  const rows = (payload && payload.data && payload.data.candles) || [];
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((c) => Array.isArray(c) && c[0] != null && c[1] != null && c[2] != null &&
      c[3] != null && c[4] != null)
    .map((c) => {
      const t = typeof c[0] === 'number' ? c[0] * 1000 : new Date(c[0]).getTime();
      return { t, o: Number(c[1]), h: Number(c[2]), l: Number(c[3]), c: Number(c[4]), v: Number(c[5]) || 0 };
    })
    // Number(null) is 0, so null prices must be rejected before coercion.
    .filter((c) => Number.isFinite(c.t) && Number.isFinite(c.o) && Number.isFinite(c.h) &&
      Number.isFinite(c.l) && Number.isFinite(c.c) && c.t > 0)
    .sort((a, b) => a.t - b.t);
}

/**
 * Resample candles into `minutes`-wide buckets. Used when only 1-minute data is
 * available (the v2 fallback for index instruments).
 */
function aggregate(candles, minutes) {
  const width = Math.max(1, Number(minutes) || 1) * 60000;
  const out = [];
  for (const c of candles || []) {
    const bucket = Math.floor(c.t / width) * width;
    const last = out[out.length - 1];
    if (last && last.t === bucket) {
      last.h = Math.max(last.h, c.h);
      last.l = Math.min(last.l, c.l);
      last.c = c.c;
      last.v += c.v;
    } else {
      out.push({ t: bucket, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v });
    }
  }
  return out;
}

/** Upstox option chain -> the engine's [{strike, callOi, putOi, ...}] shape. */
function normalizeOptionChain(payload) {
  const rows = (payload && payload.data) || [];
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r) => r && Number(r.strike_price) > 0)
    .map((r) => {
      const call = r.call_options || {};
      const put = r.put_options || {};
      const cm = call.market_data || {};
      const pm = put.market_data || {};
      const cg = call.option_greeks || {};
      const pg = put.option_greeks || {};
      // `Number(x) || 0` turns a missing greek into a real-looking zero, which
      // the UI then prints as "₹0.00 / d". Absent values stay null so the table
      // can show an em-dash instead of inventing a number.
      const num = (v) => { const x = Number(v); return Number.isFinite(x) ? x : null; };
      const coi = num(cm.oi);
      const poi = num(pm.oi);
      const prevCoi = num(cm.prev_oi);
      const prevPoi = num(pm.prev_oi);
      return {
        strike: Number(r.strike_price),
        spot: num(r.underlying_spot_price),
        callOi: coi,
        putOi: poi,
        callOiChange: (coi != null && prevCoi != null) ? coi - prevCoi : null,
        putOiChange: (poi != null && prevPoi != null) ? poi - prevPoi : null,
        callLtp: num(cm.ltp),
        putLtp: num(pm.ltp),
        callVol: num(cm.volume),
        putVol: num(pm.volume),
        callTheta: num(cg.theta),
        putTheta: num(pg.theta),
        callIv: num(cg.iv),
        putIv: num(pg.iv),
      };
    })
    .sort((a, b) => a.strike - b.strike);
}

function createClient({ accessToken }, fetchImpl, base) {
  const f = fetchImpl || fetch;
  const root = String(base || DEFAULT_BASE).replace(/\/+$/, '');

  async function get(path, params) {
    let url = root + path;
    if (params) {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) if (v != null && v !== '') q.set(k, String(v));
      const qs = q.toString();
      if (qs) url += '?' + qs;
    }
    const r = await f(url, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: 'Bearer ' + accessToken },
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      const err = new Error(
        (data && (data.errors && data.errors[0] && data.errors[0].message)) || 'upstox_http_' + r.status
      );
      err.status = r.status;
      err.code = (data && data.errors && data.errors[0] && data.errors[0].errorCode) || null;
      err.body = data;
      throw err;
    }
    return data;
  }

  return {
    /** Historical candles, newest last. Returns [] rather than throwing when empty. */
    async history({ instrumentKey, resolution, fromDate, toDate }) {
      const key = encodeURIComponent(requireInstrumentKey(instrumentKey));
      const { unit, interval } = parseResolution(resolution);
      const to = toDate || istDate(new Date());
      const from = fromDate || istDate(new Date(Date.now() - 10 * 86400000));
      try {
        return normalizeCandles(await get(`/v3/historical-candle/${key}/${unit}/${interval}/${to}/${from}`));
      } catch (e) {
        // Index instruments can 400 on v3. Rebuild the same view from v2 1-minute data.
        if (e.status !== 400 && e.status !== 404 && e.status !== 422) throw e;
        const raw = normalizeCandles(await get(`/v2/historical-candle/${key}/1minute/${to}/${from}`));
        return aggregate(raw, parseResolution(resolution).minutes);
      }
    },

    /** Current trading day's candles. */
    async intraday({ instrumentKey, resolution }) {
      const key = encodeURIComponent(requireInstrumentKey(instrumentKey));
      const { unit, interval, minutes } = parseResolution(resolution);
      try {
        return normalizeCandles(await get(`/v3/historical-candle/intraday/${key}/${unit}/${interval}`));
      } catch (e) {
        if (e.status !== 400 && e.status !== 404 && e.status !== 422) throw e;
        const raw = normalizeCandles(await get(`/v2/historical-candle/intraday/${key}/1minute`));
        return aggregate(raw, minutes);
      }
    },

    /** Put/call chain for one expiry. Falls back to the nearest weekly expiry keyword. */
    async optionChain({ instrumentKey, expiry }) {
      const key = requireInstrumentKey(instrumentKey);
      const data = await get('/v2/option/chain', {
        instrument_key: key,
        expiry_date: expiry || 'current_week',
      });
      return normalizeOptionChain(data);
    },

    /** Last price + previous close for one instrument (used for India VIX). */
    async quote({ instrumentKey }) {
      const data = await get('/v2/market-quote/quotes', { instrument_key: requireInstrumentKey(instrumentKey) });
      const rows = (data && data.data) || {};
      const first = Object.values(rows)[0];
      if (!first) return null;
      const last = Number(first.last_price);
      const prev = Number(first.close_price);
      if (!Number.isFinite(last)) return null;
      return {
        value: last,
        prevClose: Number.isFinite(prev) ? prev : null,
        change: Number(first.net_change) || (Number.isFinite(prev) ? last - prev : null),
      };
    },

    /** Last traded price — also used as a cheap token liveness check. */
    async ltp({ instrumentKey }) {
      const data = await get('/v2/market-quote/ltp', { instrument_key: requireInstrumentKey(instrumentKey) });
      const rows = (data && data.data) || {};
      const first = Object.values(rows)[0];
      return first ? Number(first.last_price) || null : null;
    },
  };
}

/**
 * Validate an Analytics Token without touching order APIs.
 * Returns { ok, status, error } so callers can show a precise message.
 */
async function verifyToken(accessToken, fetchImpl, base) {
  if (!accessToken) return { ok: false, status: 0, error: 'missing_token' };
  try {
    const client = createClient({ accessToken }, fetchImpl, base);
    await client.ltp({ instrumentKey: 'NIFTY' });
    return { ok: true, status: 200, error: null };
  } catch (e) {
    const status = e.status || 0;
    return {
      ok: false,
      status,
      error: status === 401 || status === 403 ? 'token_rejected' : (e.message || 'token_check_failed'),
    };
  }
}

module.exports = {
  INSTRUMENT_KEYS,
  instrumentKeyFor,
  requireInstrumentKey,
  parseResolution,
  normalizeCandles,
  normalizeOptionChain,
  aggregate,
  createClient,
  verifyToken,
  istDate,
  DEFAULT_BASE,
};
