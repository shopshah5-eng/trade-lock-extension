'use strict';

/*
 * End-to-end render test for the options page.
 *
 * Loads the real options.html and the real options.js into linkedom with a
 * stubbed chrome.storage, then clicks through the tabs and asserts what the
 * user would actually see. This is the only test that exercises how the panels
 * fit together, and it is what caught three bugs the unit tests could not:
 *
 *   - the options tab returned before it ever painted the strike table
 *   - the market tab's PCR cards were wired to a field nothing produced
 *   - the feed badge kept its offline colours after a feed returned
 *
 * linkedom is a minimal DOM, so a handful of browser APIs are stubbed below.
 * Nothing here touches the network.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const ROOT = path.join(__dirname, '..');
const noop = () => {};

const LIVE_SNAPSHOT = {
  source: 'live',
  provider: 'upstox',
  fetchedAt: Date.now(),
  symbol: 'NIFTY',
  spot: 24653,
  candleCount: 2,
  candles: [
    { t: 1700000000000, o: 24500, h: 24520, l: 24490, c: 24512, v: 1000 },
    { t: 1700000900000, o: 24512, h: 24660, l: 24500, c: 24653, v: 1200 },
  ],
  vix: { value: 14.32, prevClose: 13.9, change: 0.42 },
  optionChain: [
    { strike: 24600, spot: 24653, callOi: 5000, putOi: 7000, callOiChange: 1000, putOiChange: -500,
      callLtp: 120, putLtp: 88, callVol: 900, putVol: 800,
      callTheta: -12.5, putTheta: -9.1, callIv: 14.2, putIv: 13.8 },
    // A strike where the provider sent only OI - the rest must not be invented.
    { strike: 24700, spot: null, callOi: 3000, putOi: null, callOiChange: null, putOiChange: null,
      callLtp: null, putLtp: null, callVol: null, putVol: null,
      callTheta: null, putTheta: null, callIv: null, putIv: null },
  ],
  analysis: { ok: true, oi: { pcr: 1.4, maxPain: 24600, totalCallOi: 8000, totalPutOi: 14000 } },
};

const PRO_LICENCE = { key: 'TL-TEST-0000-0000-0000', plan: 'pro_plus_ai_monthly', expiresAt: Date.now() + 86400000 };

/**
 * Boot the options page. Returns handles for assertions and a teardown.
 */
async function bootPage(store) {
  const dom = parseHTML(fs.readFileSync(path.join(ROOT, 'options', 'options.html'), 'utf8'));
  const window = dom.window;
  const document = dom.document;

  // Browser APIs linkedom does not implement, but options.js expects.
  window.addEventListener = window.addEventListener || noop;
  window.removeEventListener = window.removeEventListener || noop;
  window.matchMedia = () => ({ matches: false, addListener: noop, addEventListener: noop });
  window.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  window.cancelAnimationFrame = clearTimeout;
  window.getComputedStyle = () => ({ getPropertyValue: () => '' });
  window.devicePixelRatio = 1;
  window.history = window.history || { replaceState: noop, pushState: noop };
  window.location = window.location || {};
  if (!window.location.hash) window.location.hash = '';
  window.localStorage = { getItem: () => null, setItem: noop };
  window.fetch = () => Promise.reject(new Error('offline'));
  // options.js runs a clock loop; without this the test process never exits.
  window.setInterval = () => 0;
  window.clearInterval = noop;

  // A real <select> accepts any assignment; linkedom throws unless an option
  // matches. Emulate the browser so the page can be driven.
  for (const select of document.querySelectorAll('select')) {
    // A browser initialises .value from the selected option (or the first one),
    // not from the empty string.
    const options = [...select.querySelectorAll('option')];
    const chosen = options.find((o) => o.hasAttribute('selected')) || options[0];
    let current = chosen ? chosen.getAttribute('value') : '';
    Object.defineProperty(select, 'value', {
      configurable: true,
      get() { return current; },
      set(next) {
        const target = String(next);
        if (target !== '' && ![...select.querySelectorAll('option')].some((o) => o.value === target)) {
          const option = document.createElement('option');
          option.setAttribute('value', target);
          option.textContent = target;
          select.appendChild(option);
        }
        current = target;
      },
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
      getURL: (p) => 'chrome-extension://trade-lock-test/' + p,
      lastError: null,
      onMessage: { addListener: noop },
      sendMessage(message, cb) {
        // The service worker answering a market-feed check.
        const reply = (message && message.type === 'TL_CHECK_MARKET_FEED' && store.tlMarket)
          ? {
            ok: true, connected: true, source: store.tlMarket.source,
            provider: store.tlMarket.provider, fetchedAt: store.tlMarket.fetchedAt,
            data: store.tlMarket,
          }
          : { ok: true };
        if (cb) setTimeout(() => cb(reply), 0);
        return Promise.resolve(reply);
      },
    },
    tabs: { query: (q, cb) => { if (cb) cb([]); return Promise.resolve([]); }, create: noop },
    alarms: { create: noop, onAlarm: { addListener: noop } },
  };

  const errors = [];
  const context = vm.createContext(window);
  const files = ['lib/rules.js', 'lib/detector.js', 'lib/market.js', 'lib/insights.js', 'options/options.js'];
  for (const file of files) {
    try {
      vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: file });
    } catch (error) {
      throw new Error('options.js threw while loading: ' + error.message);
    }
  }

  window.addEventListener('error', (e) => errors.push(String(e && e.message)));

  const settle = () => new Promise((resolve) => setTimeout(resolve, 120));
  await settle();

  const page = {
    document,
    errors,
    text(id) {
      const node = document.getElementById(id);
      return node ? node.textContent.trim() : '(missing)';
    },
    async clickTab(name) {
      const tab = document.querySelector('.nav-tab[data-tab="' + name + '"]');
      assert.ok(tab, 'missing tab: ' + name);
      tab.dispatchEvent(new window.Event('click', { bubbles: true }));
      await settle();
    },
    chainRowTexts() {
      const tbody = document.getElementById('optionsChainTbody');
      if (!tbody) return [];
      return [...tbody.querySelectorAll('tr')].map((tr) => tr.textContent.replace(/\s+/g, ' ').trim());
    },
    brokerRows() {
      const tbody = document.getElementById('brokerSupportTbody');
      return tbody ? tbody.querySelectorAll('tr').length : 0;
    },
    setMarketSource(value) {
      const select = document.getElementById('marketSource');
      assert.ok(select, 'missing #marketSource');
      select.value = value;
    },
  };
  return page;
}

function baseStore(market) {
  return {
    tlSettings: { marketSource: 'live', marketSymbol: 'NIFTY', showHud: false },
    tlLicense: PRO_LICENCE,
    tlState: null,
    tlJournal: [],
    tlUserEmail: null,
    tlDailyFocus: null,
    tlProfile: null,
    tlMarket: market,
  };
}

test('With a live feed the options page renders the chain, PCR, ticker and VIX', async () => {
  const page = await bootPage(baseStore(LIVE_SNAPSHOT));
  page.setMarketSource('live');
  await page.clickTab('market');
  await page.clickTab('options');

  // The strike table, which the live branch used to skip entirely.
  const rows = page.chainRowTexts();
  assert.strictEqual(rows.length, 2, 'both strikes must render');
  assert.ok(rows[0].includes('5,000'), 'call OI');
  assert.ok(rows[0].includes('₹120.00'), 'call premium');
  assert.ok(rows[0].includes('13.80%'), 'put IV');
  assert.ok(!rows[0].includes('undefined'), 'no cell may print undefined');
  // The second strike sent only OI: everything else must be an em-dash.
  assert.ok(rows[1].includes('—'), 'missing greeks render as em-dashes');
  assert.ok(!rows[1].includes('₹0.00'), 'a missing premium must not look like 0');

  // Options-tab analytics.
  assert.strictEqual(page.text('optPcrVal'), '0.88', 'PCR from the live chain');
  assert.strictEqual(page.text('optPcrBias'), 'Neutral Range');
  assert.strictEqual(page.text('optMaxPain'), '24,600');

  // Market-tab analytics come from the analysis block when present.
  assert.strictEqual(page.text('marketPcrVal'), '1.40');
  assert.strictEqual(page.text('marketPcrBias'), 'Bullish Sentiment');
  assert.strictEqual(page.text('marketMaxPainVal'), '24,600');

  // Index strip and volatility panel.
  assert.strictEqual(page.text('tickerNiftyPrice'), '24,653.00');
  assert.strictEqual(page.text('tickerNiftySrc'), 'LIVE');
  assert.strictEqual(page.text('vixVal'), '14.32');
  assert.ok(page.text('vixRegimeBadge').includes('Calm'));

  // Broker matrix is generated, not hand-written.
  assert.strictEqual(page.brokerRows(), 8);

  assert.deepStrictEqual(page.errors, [], 'the page must load without throwing');
});

test('With no feed every panel says so instead of showing a number', async () => {
  const page = await bootPage(baseStore(null));
  page.setMarketSource('live');
  await page.clickTab('market');
  await page.clickTab('options');

  assert.strictEqual(page.text('tickerNiftyPrice'), '—');
  assert.strictEqual(page.text('tickerNiftySrc'), 'NO FEED');
  assert.strictEqual(page.text('vixVal'), '—');
  assert.ok(page.text('vixRegimeBadge').includes('no feed'));
  assert.strictEqual(page.text('marketPcrVal'), '—');
  assert.strictEqual(page.text('optPcrVal'), '—');

  const rows = page.chainRowTexts();
  assert.strictEqual(rows.length, 1, 'the empty chain shows one explanatory row');
  assert.ok(rows[0].includes('Disconnected'));

  assert.deepStrictEqual(page.errors, []);
});

test('The free tier sees the capital plan disabled and told why', async () => {
  const store = baseStore(null);
  store.tlLicense = null;
  const page = await bootPage(store);

  for (const id of ['totalCapital', 'dailyRiskPercent', 'perTradeRiskPercent', 'maxDailyLoss']) {
    const node = page.document.getElementById(id);
    assert.strictEqual(node.disabled, true, `${id} must be disabled on Free`);
  }
  assert.ok(page.text('planSummary').length > 0, 'the plan summary must still render');
});

test('Every tab in the desktop sidebar is reachable from the mobile nav', () => {
  // The markup carries two navigations: the icon sidebar (>=640px) and the
  // compact top nav (<640px). Only one is displayed at a time, so a tab that
  // exists in one and not the other is unreachable at that width. "Sites" was
  // desktop-only until it was added to the compact nav.
  const html = fs.readFileSync(path.join(ROOT, 'options', 'options.html'), 'utf8');
  const tabs = (block) => new Set([...block.matchAll(/data-tab="([a-z]+)"/g)].map((m) => m[1]));

  const aside = html.slice(html.indexOf('<aside'), html.indexOf('</aside>'));
  const compactStart = html.indexOf('compact-top-nav');
  const compact = html.slice(compactStart, html.indexOf('TAB: OVERVIEW', compactStart));

  const sidebar = tabs(aside);
  const mobile = tabs(compact);
  assert.ok(sidebar.size >= 9, 'the sidebar nav must list every tab');
  assert.deepStrictEqual([...mobile].sort(), [...sidebar].sort(),
    'mobile and desktop navs must offer the same tabs');

  const panes = new Set([...html.matchAll(/id="tab-([a-z]+)"/g)].map((m) => m[1]));
  for (const tab of sidebar) {
    assert.ok(panes.has(tab), `nav tab "${tab}" must have a matching #tab-${tab} pane`);
  }
  for (const pane of panes) {
    assert.ok(sidebar.has(pane), `#tab-${pane} is unreachable: no nav button for it`);
  }
});

test('Every element id the page looks up exists somewhere it can be found', async () => {
  // options.js reaches for ids through el(). A missing id is not an error -
  // the guard silently does nothing - so a broken control looks like a dead
  // feature. Ids created inside innerHTML count, so the check walks the live
  // document after every tab has rendered.
  const page = await bootPage(baseStore(null));
  for (const tab of ['overview', 'market', 'options', 'charts', 'journal', 'ai', 'rules', 'license', 'sites']) {
    await page.clickTab(tab);
  }

  const js = fs.readFileSync(path.join(ROOT, 'options', 'options.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'options', 'options.html'), 'utf8');
  const wanted = [...new Set([...js.matchAll(/\bel\(\s*'([A-Za-z0-9_-]+)'/g)].map((m) => m[1]))]
    .filter((id) => id !== 'tab-');

  // Some ids are created inside innerHTML on error branches that this store
  // does not reach, so the script's own markup counts as a definition.
  const defined = (id) => Boolean(page.document.getElementById(id))
    || html.includes(`id="${id}"`)
    || js.includes(`id="${id}"`);

  const missing = wanted.filter((id) => !defined(id));
  assert.deepStrictEqual(missing, [], `these ids are looked up but never exist: ${missing.join(', ')}`);
});

test('Charts draws the candles already in the snapshot, without visiting Market first', async () => {
  // chartState.candles used to be filled only by the Market tab, so opening
  // Charts first showed a green "live feed" badge over an empty panel. The
  // charts renderer now draws from the snapshot it just verified.
  const page = await bootPage(baseStore(LIVE_SNAPSHOT));
  await page.clickTab('charts');

  const svg = page.document.getElementById('dedicatedChartsSvg');
  assert.ok(svg, 'missing #dedicatedChartsSvg');
  assert.ok(svg.innerHTML.length > 500, 'the chart must actually be drawn');
  assert.ok(/<rect|<path|<line|<polyline/i.test(svg.innerHTML), 'candles produce shapes, not just labels');
  assert.ok(!/No market candle data|disconnected/i.test(svg.innerHTML),
    'a real snapshot must not render the empty-chart message');

  const notice = page.document.getElementById('chartsOfflineNotice');
  assert.strictEqual(notice.style.display, 'none', 'the offline notice must stay hidden');
  assert.deepStrictEqual(page.errors, []);
});

test('Charts refuses a snapshot that belongs to another index', async () => {
  // The background refreshes one configured symbol on a timer. Drawing that
  // snapshot under a different heading would silently mislabel the chart.
  const foreign = Object.assign({}, LIVE_SNAPSHOT, { symbol: 'BANKNIFTY' });
  const page = await bootPage(baseStore(foreign));
  await page.clickTab('charts');

  const notice = page.document.getElementById('chartsOfflineNotice');
  assert.strictEqual(notice.style.display, 'block', 'a foreign snapshot must not be drawn');
  const text = notice.textContent.replace(/\s+/g, ' ');
  assert.match(text, /BANKNIFTY/, 'the notice must name the index it is holding');
  assert.match(text, /fabricate/i, 'and repeat that nothing is invented');

  const svg = page.document.getElementById('dedicatedChartsSvg');
  assert.strictEqual(svg.style.display, 'none', 'no chart is shown for the wrong index');
  assert.deepStrictEqual(page.errors, []);
});

test('The options table refuses a chain that belongs to another index', async () => {
  // Same rule as the chart: a plausible-looking strike ladder for the wrong
  // instrument is worse than an empty table, because someone will trade it.
  const foreign = Object.assign({}, LIVE_SNAPSHOT, { symbol: 'BANKNIFTY' });
  const page = await bootPage(baseStore(foreign));
  page.setMarketSource('live');
  await page.clickTab('options');

  const rows = page.chainRowTexts();
  assert.strictEqual(rows.length, 1, 'only the explanatory row may render');
  assert.ok(!rows[0].includes('24,600'), 'no strike from the other index may appear');

  const notice = page.document.getElementById('optionsChainEmptyNotice');
  assert.strictEqual(notice.style.display, 'block');
  assert.match(notice.textContent.replace(/\s+/g, ' '), /BANKNIFTY/);
  assert.deepStrictEqual(page.errors, []);
});
