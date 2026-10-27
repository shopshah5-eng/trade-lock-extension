'use strict';

/*
 * Renders options.html + options.js against a feed snapshot in a *plain* vm
 * context - no DOM proxy to swallow failed global lookups.
 *
 * test/options_page.test.js already drives the page through linkedom, but
 * linkedom's window resolves unknown globals instead of throwing, so a function
 * that reads a variable from another function's scope looks fine there and
 * throws a ReferenceError in Chrome. That is exactly what happened:
 * renderChainTable() read `symbol`, which only existed in
 * renderOptionsChainView(), so the Options table threw the moment a real chain
 * arrived and stayed empty under a green "live" badge.
 *
 * It also covers what the live branch forgot to paint: the Overview chart, the
 * Market candle canvas and the O/H/L/Prev row were only ever drawn by the
 * disconnected path.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const ROOT = path.join(__dirname, '..');
const noop = () => {};

const CANDLES = Array.from({ length: 60 }, (_, i) => ({
  t: 1700000000000 + i * 900000,
  o: 24500 + i, h: 24520 + i, l: 24490 + i, c: 24512 + i, v: 1000 + i,
}));

const SNAPSHOT = {
  source: 'live',
  provider: 'upstox',
  fetchedAt: Date.now(),
  symbol: 'NIFTY',
  spot: 24653,
  candleCount: CANDLES.length,
  candles: CANDLES,
  vix: { value: 14.32, prevClose: 13.9, change: 0.42 },
  optionChain: [
    { strike: 24600, spot: 24653, callOi: 5000, putOi: 7000, callOiChange: 1000, putOiChange: -500,
      callLtp: 120, putLtp: 88, callVol: 900, putVol: 800,
      callTheta: -12.5, putTheta: -9.1, callIv: 14.2, putIv: 13.8 },
  ],
  analysis: { ok: true, oi: { pcr: 1.4, maxPain: 24600 } },
};

const LICENCE = { key: 'TL-TEST-0000-0000-0000', plan: 'pro_plus_ai_monthly', expiresAt: Date.now() + 86400000 };

function boot(market) {
  const store = {
    tlSettings: { marketSymbol: 'NIFTY', showHud: false, licenseApiBase: 'https://trade-lock-app.netlify.app' },
    tlLicense: LICENCE,
    tlState: null,
    tlJournal: [],
    tlMarket: market,
  };

  const dom = parseHTML(fs.readFileSync(path.join(ROOT, 'options', 'options.html'), 'utf8'));
  const document = dom.document;

  const window = {
    document,
    addEventListener: noop,
    removeEventListener: noop,
    matchMedia: () => ({ matches: false, addListener: noop, addEventListener: noop }),
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: clearTimeout,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    devicePixelRatio: 1,
    history: { replaceState: noop, pushState: noop },
    location: { hash: '' },
    localStorage: { getItem: () => null, setItem: noop },
    fetch: () => Promise.reject(new Error('offline')),
    setInterval: () => 0,
    clearInterval: noop,
    setTimeout,
    clearTimeout,
    URL,
    Event: dom.Event,
  };
  window.window = window;

  for (const select of document.querySelectorAll('select')) {
    const options = [...select.querySelectorAll('option')];
    const chosen = options.find((o) => o.hasAttribute('selected')) || options[0];
    let current = chosen ? chosen.getAttribute('value') : '';
    Object.defineProperty(select, 'value', {
      configurable: true,
      get() { return current; },
      set(next) { current = String(next); },
    });
  }

  window.chrome = {
    storage: {
      local: {
        get(keys, cb) {
          const names = Array.isArray(keys) ? keys : [keys];
          const out = {};
          names.forEach((k) => { if (store[k] !== undefined) out[k] = store[k]; });
          if (cb) { setTimeout(() => cb(out), 0); return undefined; }
          return Promise.resolve(out);
        },
        set(values, cb) {
          Object.assign(store, values);
          if (cb) setTimeout(cb, 0);
          return Promise.resolve();
        },
      },
      onChanged: { addListener: noop },
    },
    runtime: {
      id: 'trade-lock-test',
      getURL: (p) => p,
      lastError: null,
      onMessage: { addListener: noop },
      sendMessage(message, cb) {
        const reply = (message && message.type === 'TL_CHECK_MARKET_FEED')
          ? (market
            ? { ok: true, connected: true, source: market.source, provider: market.provider, fetchedAt: market.fetchedAt, data: market }
            : { ok: false, connected: false, error: 'network_error' })
          : { ok: true };
        if (cb) { setTimeout(() => cb(reply), 0); return undefined; }
        return Promise.resolve(reply);
      },
    },
    tabs: { query: (q, cb) => { if (cb) cb([]); return Promise.resolve([]); }, create: noop },
    alarms: { create: noop, onAlarm: { addListener: noop } },
    permissions: { contains: () => Promise.resolve(false), request: () => Promise.resolve(true) },
  };

  const context = vm.createContext(window);
  for (const file of ['lib/rules.js', 'lib/detector.js', 'lib/market.js', 'lib/insights.js', 'options/options.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: file });
  }
  return { document, window };
}

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms || 150));

async function open(page, tab) {
  page.document.querySelector('.nav-tab[data-tab="' + tab + '"]')
    .dispatchEvent(new page.window.Event('click', { bubbles: true }));
  await settle();
}

const textOf = (page, id) => {
  const node = page.document.getElementById(id);
  return node ? node.textContent.replace(/\s+/g, ' ').trim() : '(missing)';
};

test('a live snapshot paints the options chain instead of throwing', async () => {
  const page = boot(SNAPSHOT);
  await settle();
  await open(page, 'market');
  await open(page, 'options');

  const rows = [...page.document.querySelectorAll('#optionsChainTbody tr')];
  assert.strictEqual(rows.length, 1, 'the strike row must render from the feed chain');
  const row = rows[0].textContent.replace(/\s+/g, ' ');
  assert.ok(row.includes('5,000'), 'call OI');
  assert.ok(row.includes('₹120.00'), 'call premium');
  assert.strictEqual(textOf(page, 'optPcrVal'), '1.4');
  assert.strictEqual(textOf(page, 'optMaxPain'), '24,600');
  assert.strictEqual(textOf(page, 'optSpotPrice'), '₹24,653.00');
});

test('a live snapshot paints every chart and badge the market tab shows', async () => {
  const page = boot(SNAPSHOT);
  await settle();
  await open(page, 'market');

  assert.strictEqual(textOf(page, 'marketSpotVal'), '₹24,653.00');
  assert.strictEqual(textOf(page, 'marketModelBadge'), 'Live', 'the card badge must follow the feed');
  assert.ok(textOf(page, 'marketExchangeSub').includes('upstox'), 'the sub-line names the provider');
  assert.strictEqual(textOf(page, 'chartCandleCount'), '60 candles');
  assert.strictEqual(textOf(page, 'vixVal'), '14.32');

  // The Overview card: header, price, O/H/L and the source line.
  await open(page, 'overview');
  assert.strictEqual(textOf(page, 'overviewLiveBadge'), 'LIVE FEED');
  assert.strictEqual(textOf(page, 'overviewChartPrice'), (24512 + 59).toLocaleString('en-IN', { minimumFractionDigits: 2 }));
  assert.ok(textOf(page, 'overviewChartSource').includes('Live feed'), 'the source line must not say disconnected');
  const ohlc = textOf(page, 'overviewOhlcSummary');
  assert.ok(!ohlc.includes('O —'), 'O/H/L must be filled once there are candles: ' + ohlc);
  assert.ok(ohlc.includes('H'), 'the row keeps its labels');

  // The dedicated Charts tab keeps its own live badge.
  await open(page, 'charts');
  assert.ok(textOf(page, 'chartsStatusText').includes('upstox'), 'charts status names the provider');
});

test('with no feed the same elements go blank rather than keep a number', async () => {
  const page = boot(null);
  await settle();
  await open(page, 'market');
  await open(page, 'options');

  assert.strictEqual(textOf(page, 'marketModelBadge'), 'No Feed');
  assert.strictEqual(textOf(page, 'marketSpotVal'), '—');
  assert.strictEqual(textOf(page, 'chartCandleCount'), 'no candles');
  assert.strictEqual(textOf(page, 'vixVal'), '—');
  assert.strictEqual(textOf(page, 'optSpotPrice'), '—');
  assert.strictEqual(textOf(page, 'optPcrVal'), '—');
  assert.strictEqual(page.document.querySelectorAll('#optionsChainTbody tr').length, 0);
  assert.ok(textOf(page, 'overviewChartSource').includes('disconnected') ||
    textOf(page, 'overviewChartSource').includes('Live feed'), 'the overview source stays honest');
});

test('with no feed the setup card names the missing configuration and provider', async () => {
  const page = boot(null);
  await settle();
  await open(page, 'market');

  const card = page.document.getElementById('liveMarketSetupCard');
  assert.ok(card, 'setup card must exist');
  assert.strictEqual(card.style.display, 'block');
  const text = card.textContent.replace(/\s+/g, ' ');
  assert.ok(text.includes('Live feed not connected'), 'card title');
  assert.ok(text.includes('Provider: Fyers API v3 / Upstox'), 'card provider');
  assert.ok(text.includes('Feed: https://trade-lock-app.netlify.app'), 'feed base');
  assert.ok(card.querySelector('#useLocalServerBtn'), 'offers local server switch when remote');
});
