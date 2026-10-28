'use strict';
/*
 * Market feed orchestration.
 *
 * Candles, option-chain OI and India VIX are related, but they are not one
 * availability domain. A slow/failed chain must not hide valid candles, and a
 * failed chain must never be cached as a successful complete snapshot. The
 * extension can therefore show an explicit partial/stale state and retry the
 * next request instead of looking randomly disconnected.
 */
const upstox = require('./providers/upstox');

const CACHE_TTL_MS = Math.max(5000, Number(process.env.MARKET_CACHE_TTL_MS) || 45000);
const CACHE_MAX = Math.max(10, Number(process.env.MARKET_CACHE_MAX) || 200);
const STALE_TTL_MS = Math.max(5 * 60000, CACHE_TTL_MS * 4);
const RETRY_ATTEMPTS = 2; // retries after the first attempt; 400/401/etc. are not retried
const RETRY_BASE_MS = 120;

const cache = new Map();
const inFlight = new Map();
let cacheGeneration = 0;
let stats = { hits: 0, misses: 0, errors: 0, retries: 0, coalesced: 0, stale: 0 };

function cacheKey(provider, symbol, resolution, expiry) {
  return provider + '|' + String(symbol || '').toUpperCase() + '|' +
    String(resolution || '15') + '|' + String(expiry || 'current');
}

function cacheGet(key, now) {
  const hit = cache.get(key);
  if (!hit || hit.expires <= now) return null;
  return hit.value;
}

function cacheGetStale(key, now) {
  const hit = cache.get(key);
  if (!hit || hit.staleExpires <= now) {
    if (hit && hit.staleExpires <= now) cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value, ttl = CACHE_TTL_MS) {
  if (cache.size >= CACHE_MAX && !cache.has(key)) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  const now = Date.now();
  cache.set(key, { value, expires: now + ttl, staleExpires: now + STALE_TTL_MS });
}

function clearCache() {
  cache.clear();
  cacheGeneration += 1;
  // Do not cancel requests already being served to another caller. Their
  // generation check below stops them repopulating a cache that was just
  // cleared (for example after a credential rotation).
  inFlight.clear();
}

function resolveProvider(env) {
  const e = env || process.env;
  if (e.UPSTOX_ANALYTICS_TOKEN) {
    return {
      id: 'upstox', configured: true, reason: 'analytics_token',
      tokenNote: 'Upstox Analytics Token (read-only, valid ~1 year)',
    };
  }
  if (e.FYERS_APP_ID && e.FYERS_ACCESS_TOKEN) {
    return {
      id: 'fyers', configured: true, reason: 'access_token',
      tokenNote: 'Fyers access token (expires daily at 06:30 IST)',
    };
  }
  return {
    id: null, configured: false, reason: 'no_credentials',
    tokenNote: 'Set UPSTOX_ANALYTICS_TOKEN (recommended) or FYERS_APP_ID + FYERS_ACCESS_TOKEN',
  };
}

function defaultExpiryFor() { return 'current'; }

function normalizeExpiry(value) {
  const raw = String(value || defaultExpiryFor()).trim().toLowerCase();
  const alias = { current_week: 'current', next_week: 'next' }[raw];
  const normalized = alias || raw;
  if (['current', 'next', 'monthly'].includes(normalized)) return normalized;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return null;
  const parsed = new Date(normalized + 'T00:00:00Z');
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === normalized
    ? normalized : null;
}

function isRetryable(error) {
  if (!error) return true;
  if (error.code === 'unknown_symbol') return false;
  const status = Number(error.status || 0);
  if ([400, 401, 403, 404, 409, 422].includes(status)) return false;
  return status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
}

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function withRetry(operation) {
  let lastError;
  for (let attempt = 0; attempt <= RETRY_ATTEMPTS; attempt += 1) {
    try { return await operation(); } catch (error) {
      lastError = error;
      if (attempt >= RETRY_ATTEMPTS || !isRetryable(error)) throw error;
      stats.retries += 1;
      await wait(RETRY_BASE_MS * (attempt + 1));
    }
  }
  throw lastError;
}

function settled(promise) {
  return promise.then((value) => ({ value })).catch((error) => ({ error }));
}

function publicError(error) {
  return {
    code: error && error.code ? String(error.code).slice(0, 80) : null,
    status: Number(error && error.status) || 0,
    message: String((error && error.message) || 'provider request failed').slice(0, 180),
  };
}

function warning(name, error) {
  return { component: name, ...publicError(error) };
}

function requireChain(rows) {
  if (Array.isArray(rows) && rows.length) return rows;
  const error = new Error('The provider returned no option-chain strikes');
  error.code = 'empty_option_chain';
  error.status = 503;
  throw error;
}

function requireVix(quote) {
  if (quote && Number.isFinite(Number(quote.value))) return quote;
  const error = new Error('The provider returned no India VIX quote');
  error.code = 'empty_vix_quote';
  error.status = 503;
  throw error;
}

/**
 * Fetch candles + option chain from the active provider.
 * `ok:true` can be degraded, but every partial/stale condition is explicit.
 */
async function fetchMarket({ provider, symbol, resolution, fetchImpl, expiry }) {
  const p = provider || resolveProvider();
  if (!p || !p.configured) {
    return { ok: false, error: 'market_feed_not_configured', provider: p ? p.id : null,
      detail: p ? p.tokenNote : undefined };
  }

  const requestedExpiry = normalizeExpiry(expiry);
  if (!requestedExpiry) {
    return { ok: false, error: 'invalid_expiry', provider: p.id, status: 400,
      detail: 'Expiry must be current, next, monthly, or a real YYYY-MM-DD date.' };
  }
  const token = p.id === 'upstox' ? process.env.UPSTOX_ANALYTICS_TOKEN : process.env.FYERS_ACCESS_TOKEN;
  const key = cacheKey(p.id + ':' + String(token || '').slice(-6), symbol, resolution, requestedExpiry);
  const now = Date.now();
  const cached = cacheGet(key, now);
  if (cached) {
    stats.hits += 1;
    return Object.assign({}, cached, { cached: true });
  }
  const pending = inFlight.get(key);
  if (pending) {
    stats.coalesced += 1;
    const value = await pending;
    return Object.assign({}, value, { coalesced: true });
  }

  stats.misses += 1;
  const promise = fetchFresh({ p, symbol, resolution, fetchImpl, expiry: requestedExpiry, key,
    generation: cacheGeneration });
  inFlight.set(key, promise);
  try { return await promise; } finally {
    if (inFlight.get(key) === promise) inFlight.delete(key);
  }
}

async function fetchFresh({ p, symbol, resolution, fetchImpl, expiry, key, generation }) {
  try {
    let candles = [];
    let chain = null;
    let vix = null;
    const warnings = [];
    let chainError = null;
    let vixError = null;

    if (p.id === 'upstox') {
      const client = upstox.createClient({ accessToken: process.env.UPSTOX_ANALYTICS_TOKEN }, fetchImpl);
      // These requests are independent. Running them concurrently avoids the
      // old history -> chain -> VIX serial latency that exceeded popup timeouts.
      const historyPromise = withRetry(() => client.history({ instrumentKey: symbol, resolution }));
      const intradayPromise = settled(withRetry(() => client.intraday({ instrumentKey: symbol, resolution })));
      const chainPromise = settled(withRetry(async () =>
        requireChain(await client.optionChain({ instrumentKey: symbol, expiry }))));
      const vixPromise = settled(withRetry(async () =>
        requireVix(await client.quote({ instrumentKey: 'INDIAVIX' }))));
      const [hist, intra, chainResult, vixResult] = await Promise.all([
        historyPromise, intradayPromise, chainPromise, vixPromise,
      ]);
      if (intra.error) warnings.push(warning('intraday', intra.error));
      const byTime = new Map();
      for (const c of hist.concat(intra.value || [])) byTime.set(c.t, c);
      candles = Array.from(byTime.values()).sort((a, b) => a.t - b.t);
      if (chainResult.error) chainError = chainResult.error;
      else chain = chainResult.value;
      if (vixResult.error) vixError = vixResult.error;
      else vix = vixResult.value;
    } else {
      const fyers = require('./fyers');
      const client = fyers.createClient(
        { appId: process.env.FYERS_APP_ID, accessToken: process.env.FYERS_ACCESS_TOKEN }, fetchImpl
      );
      const fyersSymbol = mapToFyersSymbol(symbol);
      if (!fyersSymbol) {
        const error = new Error('unknown_symbol: ' + String(symbol) + ' is not a supported index');
        error.code = 'unknown_symbol';
        throw error;
      }
      const to = Math.floor(Date.now() / 1000);
      const [hist, chainResult] = await Promise.all([
        withRetry(() => client.history({
          symbol: fyersSymbol, resolution: String(resolution || '15'),
          rangeFrom: String(to - 10 * 86400), rangeTo: String(to),
        })),
        settled(withRetry(async () => requireChain(fyers.normalizeOptionChain(
          await client.optionChain({ symbol: fyersSymbol, strikeCount: 12, expiry }))))),
      ]);
      candles = fyers.normalizeHistory(hist);
      if (chainResult.error) chainError = chainResult.error;
      else chain = chainResult.value;
    }

    if (!candles.length) {
      const error = new Error('The provider returned zero candles for ' + symbol);
      error.code = 'no_candles_returned';
      throw error;
    }

    // If a previously good chain exists, retain it only with an explicit stale
    // marker. Otherwise return candles with chain=null and do not cache this
    // incomplete response as a healthy snapshot.
    const previous = generation === cacheGeneration ? cacheGetStale(key, Date.now()) : null;
    let optionChainStatus = 'live';
    if (chainError) {
      warnings.push(warning('optionChain', chainError));
      if (previous && Array.isArray(previous.optionChain)) {
        chain = previous.optionChain;
        optionChainStatus = 'stale';
      } else {
        chain = null;
        optionChainStatus = 'unavailable';
      }
    }
    if (vixError) warnings.push(warning('vix', vixError));

    const value = {
      ok: true, provider: p.id, symbol, resolution, expiry, candles,
      optionChain: chain, optionChainStatus, spot: Number(candles[candles.length - 1].c),
      vix, vixStatus: vixError ? 'unavailable' : 'live', fetchedAt: Date.now(),
      degraded: warnings.length > 0, warnings, stale: false,
    };
    // An OI failure must be retried on the next request, not hidden for 45s.
    if (!chainError && generation === cacheGeneration) cacheSet(key, value);
    return value;
  } catch (e) {
    stats.errors += 1;
    const status = e.status || 0;
    const expired = status === 401 || status === 403;
    const previous = generation === cacheGeneration ? cacheGetStale(key, Date.now()) : null;
    // Stale-if-error is useful for a transient outage, never for an invalid
    // symbol or rejected credential. It is always labelled, never silent.
    if (previous && !expired && e.code !== 'unknown_symbol' && e.code !== 'no_candles_returned') {
      stats.stale += 1;
      return Object.assign({}, previous, {
        ok: true, cached: true, stale: true, degraded: true,
        warnings: (previous.warnings || []).concat([warning('provider', e)]),
        fetchedAt: previous.fetchedAt,
      });
    }
    if (e.code === 'unknown_symbol') {
      return {
        ok: false, error: 'unknown_symbol', provider: p.id, status: 400, message: e.message,
        detail: 'Supported indices: ' + Object.keys(upstox.INSTRUMENT_KEYS).join(', '),
      };
    }
    if (e.code === 'no_candles_returned') {
      return { ok: false, error: 'no_candles_returned', provider: p.id,
        detail: e.message + '. Check the symbol and market hours.' };
    }
    return {
      ok: false, error: expired ? 'provider_token_expired' : 'provider_error', provider: p.id, status,
      message: e.message,
      detail: expired
        ? (p.id === 'fyers'
          ? 'The Fyers access token expires daily at 06:30 IST. Generate a new one and update FYERS_ACCESS_TOKEN.'
          : 'The Upstox Analytics Token was rejected. Generate a new one from Developer Apps -> Analytics.')
        : undefined,
    };
  }
}

const FYERS_SYMBOLS = {
  NIFTY: 'NSE:NIFTY50-INDEX', BANKNIFTY: 'NSE:NIFTYBANK-INDEX',
  FINNIFTY: 'NSE:FINNIFTY-INDEX', MIDCPNIFTY: 'NSE:NIFTYMIDSELECT-INDEX',
  SENSEX: 'BSE:SENSEX-INDEX', BANKEX: 'BSE:BANKEX-INDEX', INDIAVIX: 'NSE:INDIAVIX-INDEX',
};

function mapToFyersSymbol(symbol) {
  const s = String(symbol || 'NIFTY').trim();
  if (s.includes(':')) return s;
  return FYERS_SYMBOLS[s.toUpperCase()] || null;
}

function cacheStats() { return { entries: cache.size, ttlMs: CACHE_TTL_MS, ...stats }; }

module.exports = { resolveProvider, fetchMarket, clearCache, cacheStats, mapToFyersSymbol, CACHE_TTL_MS };
