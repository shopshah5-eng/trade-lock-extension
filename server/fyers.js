'use strict';
/*
 * Fyers API v3 adapter (server-side only — secrets never reach the extension).
 *
 * Auth: OAuth2-style. Build the login URL, user approves on Fyers, your
 * redirect receives ?auth_code=..., exchange it with appIdHash =
 * sha256(app_id + ":" + secret). Data calls use header
 * Authorization: "<appId>:<accessToken>".
 *
 * Docs: https://fyers.in/api-docs/v3  (Data API: history / quotes / options-chain)
 */
const crypto = require('node:crypto');

const AUTH_BASE = process.env.FYERS_AUTH_BASE || 'https://api-t1.fyers.in/api/v3';
const DATA_BASE = process.env.FYERS_DATA_BASE || 'https://api-t1.fyers.in/data';

function appIdHash(appId, secret) {
  return crypto.createHash('sha256').update(appId + ':' + secret).digest('hex');
}

function buildAuthUrl(appId, redirectUri, state) {
  const q = new URLSearchParams({
    client_id: appId, redirect_uri: redirectUri,
    response_type: 'code', state: state || 'trade-lock'
  });
  return AUTH_BASE + '/generate-authcode?' + q.toString();
}

function getVariants(str) {
  if (!str) return [];
  const set = new Set([str]);
  if (str.includes('O')) set.add(str.replace(/O/g, '0'));
  if (str.includes('0')) set.add(str.replace(/0/g, 'O'));
  return Array.from(set);
}

async function exchangeAuthCode({ appId, secret, authCode }, fetchImpl) {
  const f = fetchImpl || fetch;
  const appVariants = getVariants(String(appId || '').trim());
  const secVariants = getVariants(String(secret || '').trim());
  let lastError = null;

  for (const a of appVariants) {
    for (const s of secVariants) {
      const hash = appIdHash(a, s);
      const payload = JSON.stringify({ grant_type: 'authorization_code', appIdHash: hash, code: authCode });

      try {
        const r = await f(AUTH_BASE + '/validate-authcode', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: payload
        });
        const data = await r.json().catch(() => null);
        if (r.ok && data && data.access_token) return data;
        if (data) lastError = data;
      } catch (e) {
        lastError = { error: e.message };
      }

      try {
        const r2 = await f(AUTH_BASE + '/token', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: payload
        });
        const d2 = await r2.json().catch(() => null);
        if (r2.ok && d2 && d2.access_token) return d2;
        if (d2) lastError = d2;
      } catch (e) {}
    }
  }

  throw new Error('Fyers token exchange failed: ' + JSON.stringify(lastError || 'unknown').slice(0, 200));
}

function createClient({ appId, accessToken }, fetchImpl) {
  const f = fetchImpl || fetch;
  async function call(path, params) {
    const url = DATA_BASE + path + '?' + new URLSearchParams(params).toString();
    const r = await f(url, { headers: { Authorization: appId + ':' + accessToken } });
    const data = await r.json();
    if (!r.ok || data.s === 'error') throw new Error('Fyers ' + path + ': ' + JSON.stringify(data).slice(0, 200));
    return data;
  }
  return {
    quotes: (symbols) => call('/quotes', { symbols: Array.isArray(symbols) ? symbols.join(',') : symbols }),
    history: ({ symbol, resolution, rangeFrom, rangeTo, dateFormat }) =>
      call('/history', { symbol, resolution: resolution || '15', date_format: dateFormat == null ? '0' : dateFormat,
                         range_from: rangeFrom, range_to: rangeTo, cont_flag: '1' }),
    optionChain: ({ symbol, strikeCount, greeks }) =>
      call('/options-chain-v3', { symbol, strikecount: strikeCount || 10 }).catch(() =>
        call('/options-chain', { symbol, strikecount: strikeCount || 10, timestamp: '', greeks: greeks ? '1' : '' })
      )
  };
}

/** Fyers history wire candles [[epoch,o,h,l,c,v],...] -> engine candles. */
function normalizeHistory(data) {
  const rows = (data && data.candles) || [];
  return rows.map((c) => ({ t: c[0] * 1000, o: c[1], h: c[2], l: c[3], c: c[4], v: c[5] }));
}

/** Fyers option-chain payload -> [{strike, callOi, putOi, ...}] */
function normalizeOptionChain(data) {
  const list = (data && data.data && (data.data.optionsChain || data.data.option_chain)) || [];
  const byStrike = {};
  for (const row of list) {
    const strike = row.strike_price;
    if (!strike) continue;
    const e = byStrike[strike] || (byStrike[strike] = { strike, callOi: 0, putOi: 0, callOiChange: 0, putOiChange: 0,
      callLtp: 0, putLtp: 0, callTheta: 0, putTheta: 0, callIv: 0, putIv: 0 });
    const g = row.greeks || {};
    const ltp = row.ltp != null ? row.ltp : (row.fp || 0);
    const theta = row.theta != null ? row.theta : (g.theta || 0);
    const iv = row.iv != null ? row.iv : (g.iv || 0);
    if (row.option_type === 'CE') { e.callOi = row.oi || 0; e.callOiChange = row.oich || 0; e.callLtp = ltp; e.callTheta = theta; e.callIv = iv; }
    if (row.option_type === 'PE') { e.putOi = row.oi || 0; e.putOiChange = row.oich || 0; e.putLtp = ltp; e.putTheta = theta; e.putIv = iv; }
  }
  return Object.values(byStrike).sort((a, b) => a.strike - b.strike);
}

module.exports = { buildAuthUrl, exchangeAuthCode, createClient, normalizeHistory, normalizeOptionChain, appIdHash, AUTH_BASE, DATA_BASE };
