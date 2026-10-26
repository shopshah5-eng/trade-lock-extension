'use strict';
/*
 * Market feed orchestration.
 *
 * Two jobs:
 *  1. Pick a data provider. Upstox (1-year read-only Analytics Token) is
 *     preferred because it never needs a daily ritual; Fyers remains supported
 *     for anyone already set up, but its token expires every day at 06:30 IST.
 *  2. Cache aggressively. Every paid user hits /api/market/live, and the
 *     provider quota belongs to ONE account, so a shared cache is what keeps
 *     N customers from becoming N upstream calls per minute.
 */
const upstox = require('./providers/upstox');

const CACHE_TTL_MS = Math.max(5000, Number(process.env.MARKET_CACHE_TTL_MS) || 45000);
const CACHE_MAX = Math.max(10, Number(process.env.MARKET_CACHE_MAX) || 200);

const cache = new Map();
let stats = { hits: 0, misses: 0, errors: 0 };

function cacheKey(provider, symbol, resolution) {
  return provider + '|' + String(symbol || '').toUpperCase() + '|' + String(resolution || '15');
}

function cacheGet(key, now) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expires <= now) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value, ttl) {
  if (cache.size >= CACHE_MAX) {
    // Cheap eviction: drop the oldest insertion.
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, { value, expires: Date.now() + ttl });
}

function clearCache() {
  cache.clear();
}

/**
 * Resolve which provider to use.
 * @returns {{id:string, configured:boolean, reason:string, tokenNote:string}|null}
 */
function resolveProvider(env) {
  const e = env || process.env;
  if (e.UPSTOX_ANALYTICS_TOKEN) {
    return {
      id: 'upstox',
      configured: true,
      reason: 'analytics_token',
      tokenNote: 'Upstox Analytics Token (read-only, valid ~1 year)',
    };
  }
  if (e.FYERS_APP_ID && e.FYERS_ACCESS_TOKEN) {
    return {
      id: 'fyers',
      configured: true,
      reason: 'access_token',
      tokenNote: 'Fyers access token (expires daily at 06:30 IST)',
    };
  }
  return {
    id: null,
    configured: false,
    reason: 'no_credentials',
    tokenNote: 'Set UPSTOX_ANALYTICS_TOKEN (recommended) or FYERS_APP_ID + FYERS_ACCESS_TOKEN',
  };
}

function defaultExpiryFor() {
  return 'current_week';
}

/**
 * Fetch candles + option chain from the active provider.
 * Never returns fabricated data: on failure the caller gets { ok:false }.
 */
async function fetchMarket({
  provider, symbol, resolution, fetchImpl, expiry,
}) {
  const p = provider || resolveProvider();
  if (!p || !p.configured) {
    return { ok: false, error: 'market_feed_not_configured', provider: p ? p.id : null,
      detail: p ? p.tokenNote : undefined };
  }

  const key = cacheKey(p.id + ':' + (process.env.FYERS_ACCESS_TOKEN || '').slice(-6), symbol, resolution);
  const now = Date.now();
  const cached = cacheGet(key, now);
  if (cached) {
    stats.hits += 1;
    return Object.assign({}, cached, { cached: true });
  }
  stats.misses += 1;

  try {
    let candles = [];
    let chain = null;

    if (p.id === 'upstox') {
      const client = upstox.createClient({ accessToken: process.env.UPSTOX_ANALYTICS_TOKEN }, fetchImpl);
      const [hist, intra] = await Promise.all([
        client.history({ instrumentKey: symbol, resolution }),
        client.intraday({ instrumentKey: symbol, resolution }).catch(() => []),
      ]);
      // Merge, de-duplicating the boundary candle both endpoints can return.
      const byTime = new Map();
      for (const c of hist.concat(intra)) byTime.set(c.t, c);
      candles = Array.from(byTime.values()).sort((a, b) => a.t - b.t);
      chain = await client.optionChain({ instrumentKey: symbol, expiry: expiry || defaultExpiryFor() })
        .catch(() => null);
    } else {
      const fyers = require('./fyers');
      const client = fyers.createClient(
        { appId: process.env.FYERS_APP_ID, accessToken: process.env.FYERS_ACCESS_TOKEN },
        fetchImpl
      );
      const fyersSymbol = mapToFyersSymbol(symbol);
      const to = Math.floor(Date.now() / 1000);
      const hist = await client.history({
        symbol: fyersSymbol, resolution: String(resolution || '15'),
        rangeFrom: String(to - 10 * 86400), rangeTo: String(to),
      });
      candles = fyers.normalizeHistory(hist);
      try {
        chain = fyers.normalizeOptionChain(await client.optionChain({ symbol: fyersSymbol, strikeCount: 12 }));
      } catch (e) { chain = null; }
    }

    if (!candles.length) {
      return { ok: false, error: 'no_candles_returned', provider: p.id,
        detail: 'The provider returned zero candles for ' + symbol + '. Check the symbol and market hours.' };
    }

    const value = { ok: true, provider: p.id, symbol, resolution, candles, optionChain: chain,
      fetchedAt: Date.now() };
    cacheSet(key, value, CACHE_TTL_MS);
    return value;
  } catch (e) {
    stats.errors += 1;
    const status = e.status || 0;
    const expired = status === 401 || status === 403;
    return {
      ok: false,
      error: expired ? 'provider_token_expired' : 'provider_error',
      provider: p.id,
      status,
      message: e.message,
      detail: expired
        ? (p.id === 'fyers'
          ? 'The Fyers access token expires daily at 06:30 IST. Generate a new one and update FYERS_ACCESS_TOKEN.'
          : 'The Upstox Analytics Token was rejected. Generate a new one from Developer Apps -> Analytics.')
        : undefined,
    };
  }
}

/** App symbols -> Fyers wire symbols. */
function mapToFyersSymbol(symbol) {
  const s = String(symbol || 'NIFTY').trim();
  if (s.includes(':')) return s;
  const map = {
    NIFTY: 'NSE:NIFTY50-INDEX',
    BANKNIFTY: 'NSE:NIFTYBANK-INDEX',
    FINNIFTY: 'NSE:FINNIFTY-INDEX',
    MIDCPNIFTY: 'NSE:NIFTYMIDSELECT-INDEX',
    SENSEX: 'BSE:SENSEX-INDEX',
    BANKEX: 'BSE:BANKEX-INDEX',
  };
  return map[s.toUpperCase()] || s;
}

function cacheStats() {
  return { entries: cache.size, ttlMs: CACHE_TTL_MS, ...stats };
}

module.exports = { resolveProvider, fetchMarket, clearCache, cacheStats, mapToFyersSymbol, CACHE_TTL_MS };
