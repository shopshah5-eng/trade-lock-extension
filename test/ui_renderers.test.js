'use strict';

/*
 * Functional tests for the options-page renderers.
 *
 * These functions live inside the options.js IIFE and need a real DOM, which
 * this suite does not have. Rather than trusting a static "the string exists"
 * assertion, we extract the function source and execute it against a minimal
 * fake DOM. That catches the class of bug this project actually shipped: a
 * panel with markup but no writer, sitting on a hardcoded value forever.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'options', 'options.js'), 'utf8');

/** Extract a `function name(...) { ... }` block by brace matching. */
function extract(name) {
  const start = SRC.indexOf('  function ' + name + '(');
  assert.ok(start >= 0, `options.js must define ${name}`);
  const open = SRC.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < SRC.length; i += 1) {
    if (SRC[i] === '{') depth += 1;
    else if (SRC[i] === '}') {
      depth -= 1;
      if (depth === 0) return SRC.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

function extractVar(name) {
  const start = SRC.indexOf('  var ' + name + ' = ');
  assert.ok(start >= 0, `options.js must define ${name}`);
  const end = SRC.indexOf('\n  ];', start);
  return SRC.slice(start, end + 5);
}

const IDS = [
  'tickerNiftyPrice', 'tickerNiftyChg', 'tickerNiftySrc',
  'tickerBankPrice', 'tickerBankChg', 'tickerBankSrc',
  'tickerFinPrice', 'tickerFinChg', 'tickerFinSrc',
  'tickerSensexPrice', 'tickerSensexChg', 'tickerSensexSrc',
  'overviewLiveBadge', 'vixVal', 'vixChg', 'vixRank', 'vixSkew',
  'vixAlertStatus', 'vixRegimeBadge', 'brokerSupportTbody',
  'marketResult', 'marketPcrVal', 'marketPcrBias', 'marketMaxPainVal',
];

/** Fresh fake DOM plus the four renderers bound to it. */
function harness() {
  const nodes = {};
  for (const id of IDS) {
    // Mirror the real DOM: textContent and innerHTML are two views of the same
    // content, so a test can assert on either without depending on which one
    // the renderer happened to use.
    let html = '';
    nodes[id] = {
      id,
      className: '',
      title: '',
      style: { cssText: '' },
      get innerHTML() { return html; },
      set innerHTML(value) { html = String(value); },
      get textContent() { return html.replace(/<[^>]*>/g, ''); },
      set textContent(value) { html = String(value); },
    };
  }

  const sandbox = { TLDetect: require(path.join(ROOT, 'lib', 'detector.js')) };
  const code = [
    extractVar('TICKER_CELLS'),
    extract('renderOverviewFeedBadge'),
    extract('renderTickerStrip'),
    extract('renderVolatilityPanel'),
    extract('renderBrokerSupport'),
    extract('renderMarketOiCards'),
    extract('chainRowHtml'),
  ].join('\n');

  const factory = new Function(
    'el', 'escapeHtml', 'globalThis', 'isFinite', 'Number', 'Boolean', 'M', 'chartState',
    `${code}\nreturn { renderTickerStrip, renderVolatilityPanel, renderBrokerSupport, renderMarketOiCards, chainRowHtml };`
  );

  const fns = factory(
    (id) => nodes[id] || null,
    (s) => String(s),
    sandbox,
    isFinite,
    Number,
    Boolean,
    require(path.join(ROOT, 'lib', 'market.js')),
    { fullOptionRows: [] }
  );
  return Object.assign(fns, { nodes });
}

test('Ticker strip shows blanks, not invented prices, with no feed', () => {
  const ui = harness();
  ui.renderTickerStrip(null);

  for (const id of ['tickerNiftyPrice', 'tickerBankPrice', 'tickerFinPrice', 'tickerSensexPrice']) {
    assert.strictEqual(ui.nodes[id].textContent, '—', `${id} must be blank without a feed`);
  }
  for (const id of ['tickerNiftySrc', 'tickerBankSrc']) {
    assert.strictEqual(ui.nodes[id].textContent, 'NO FEED', `${id} must admit there is no feed`);
  }
  assert.ok(ui.nodes.overviewLiveBadge.innerHTML.includes('NO FEED'),
    'the dashboard badge must not claim LIVE without data');
  assert.ok(ui.nodes.overviewLiveBadge.style.cssText.includes('148,163,184'),
    'the offline badge must be grey, not the amber default');
});

test('Ticker strip renders broker-tab quotes and labels the source', () => {
  const ui = harness();
  ui.renderTickerStrip({
    source: 'broker',
    provider: 'Active Broker Tab (Zerodha Kite)',
    quotes: {
      NIFTY: { price: 24605.35, changePercent: 0.42 },
      BANKNIFTY: { price: 52130.5, changePercent: -0.31 },
    },
  });

  assert.strictEqual(ui.nodes.tickerNiftyPrice.textContent, '24,605.35');
  assert.strictEqual(ui.nodes.tickerNiftyChg.textContent, '+0.42%');
  assert.strictEqual(ui.nodes.tickerNiftySrc.textContent, 'BROKER');
  assert.strictEqual(ui.nodes.tickerBankPrice.textContent, '52,130.50');
  assert.strictEqual(ui.nodes.tickerBankChg.textContent, '-0.31%');
  // A symbol the broker tab did not report stays blank rather than borrowing
  // another index's price.
  assert.strictEqual(ui.nodes.tickerFinPrice.textContent, '—');
  assert.strictEqual(ui.nodes.tickerFinSrc.textContent, 'NO FEED');
  assert.ok(ui.nodes.overviewLiveBadge.innerHTML.includes('BROKER FEED'));
});

test('Feed badge returns to the offline state without stale styling', () => {
  const ui = harness();
  // Offline first, so the inline grey styles are set...
  ui.renderTickerStrip(null);
  assert.ok(ui.nodes.overviewLiveBadge.style.cssText.length > 0);
  // ...then a feed arrives: the inline styles must be cleared, not layered over.
  ui.renderTickerStrip({ source: 'live', spot: 24700, provider: 'Upstox', quotes: null });
  assert.strictEqual(ui.nodes.overviewLiveBadge.style.cssText, '',
    'a recovered feed must not keep the offline colours');
  assert.strictEqual(ui.nodes.overviewLiveBadge.className, 'demo-badge-green');
  assert.ok(ui.nodes.overviewLiveBadge.innerHTML.includes('LIVE FEED'));
  // And back again.
  ui.renderTickerStrip(null);
  assert.strictEqual(ui.nodes.overviewLiveBadge.className, 'demo-badge');
  assert.ok(ui.nodes.overviewLiveBadge.innerHTML.includes('NO FEED'));
});

test('Ticker strip uses the server spot for a live feed', () => {
  const ui = harness();
  ui.renderTickerStrip({ source: 'live', spot: 24700, provider: 'Upstox', quotes: null });

  assert.strictEqual(ui.nodes.tickerNiftyPrice.textContent, '24,700.00');
  assert.strictEqual(ui.nodes.tickerNiftySrc.textContent, 'LIVE');
  assert.ok(ui.nodes.overviewLiveBadge.innerHTML.includes('LIVE FEED'));
  // Only NIFTY is served by that endpoint; the rest must not be fabricated.
  assert.strictEqual(ui.nodes.tickerBankPrice.textContent, '—');
});

test('Volatility panel renders a real VIX and ATM IV skew', () => {
  const ui = harness();
  ui.renderVolatilityPanel(
    { value: 14.32, prevClose: 13.9, change: 0.42 },
    [{ strike: 24600, callIv: 14.2, putIv: 13.8 }, { strike: 24700, callIv: 12.1, putIv: 12.9 }],
    24700
  );

  assert.strictEqual(ui.nodes.vixVal.textContent, '14.32');
  assert.strictEqual(ui.nodes.vixChg.textContent, '+0.42 (+3.02%)');
  // The nearer strike is the ATM one, so its greeks are the ones shown.
  assert.strictEqual(ui.nodes.vixSkew.textContent, '12.10% / 12.90%');
  assert.ok(ui.nodes.vixRegimeBadge.textContent.includes('Calm'));
  assert.strictEqual(ui.nodes.vixAlertStatus.textContent, 'Normal');
  // IV rank needs a year of history we do not fetch, so it stays blank.
  assert.strictEqual(ui.nodes.vixRank.textContent, '—');
});

test('Volatility panel flags a VIX spike and clears with no feed', () => {
  const ui = harness();
  ui.renderVolatilityPanel({ value: 22.5, prevClose: 18.1, change: 4.4 }, [], null);
  assert.ok(ui.nodes.vixRegimeBadge.textContent.includes('High'));
  assert.ok(ui.nodes.vixAlertStatus.textContent.includes('Elevated'));
  assert.strictEqual(ui.nodes.vixSkew.textContent, '—', 'no chain must not produce an IV skew');

  ui.renderVolatilityPanel(null, [], null);
  assert.strictEqual(ui.nodes.vixVal.textContent, '—');
  assert.strictEqual(ui.nodes.vixAlertStatus.textContent, '—');
  assert.ok(ui.nodes.vixRegimeBadge.textContent.includes('no feed'));
});

test('Broker support matrix is generated from the adapters, not hand-written', () => {
  const ui = harness();
  ui.renderBrokerSupport();
  const html = ui.nodes.brokerSupportTbody.innerHTML;

  const rows = (html.match(/<tr>/g) || []).length;
  assert.ok(rows >= 8, `expected every supported broker, got ${rows}`);
  // The synthetic test broker is for the test suite only.
  assert.ok(!html.includes('Synthetic'), 'the synthetic test broker must never be shown to users');
  // Exactly the two adapters that are genuinely verified may claim so.
  assert.strictEqual((html.match(/>Verified</g) || []).length, 2,
    'only Zerodha Kite and Sahi are detection-verified');
  assert.ok(html.includes('Zerodha Kite'));
  assert.ok(html.includes('Sahi'));
  // No adapter has verified order-level restriction, so the last column of
  // every row must say so.
  const cells = html.split('</tr>').filter((r) => r.includes('<td'));
  for (const row of cells) {
    const tds = row.split('<td').slice(1);
    assert.strictEqual(tds.length, 3, 'each broker row has a name plus two statuses');
    assert.ok(!tds[2].includes('>Verified<'),
      'no broker may claim verified order restriction until it is tested');
  }
});

test('Every el() reference on the options page resolves to a real element', () => {
  const html = fs.readFileSync(path.join(ROOT, 'options', 'options.html'), 'utf8');
  // Ids are created in two ways: statically in the markup, or by an innerHTML
  // assignment in options.js. A reference that matches neither is dead code,
  // which is how the journal's "Add Trade Entry" button silently did nothing.
  const refs = [...SRC.matchAll(/el\('([A-Za-z0-9_]+)'\)/g)].map((m) => m[1]);
  const missing = [...new Set(refs)].filter((id) =>
    !html.includes(`id="${id}"`) && !SRC.includes(`id="${id}"`));

  assert.deepStrictEqual(missing, [],
    `these el() ids exist nowhere, so the code guarding them can never run: ${missing.join(', ')}`);
});

test('No shipped file calls a helper it does not define', () => {
  const { scan, FILES } = require('../scripts/check-undefined-calls.js');
  const findings = FILES.flatMap((file) => {
    try {
      return scan(file);
    } catch (error) {
      return [{ file, line: 0, name: 'PARSE ERROR: ' + error.message }];
    }
  });

  const rendered = findings.map((f) => `${f.file}:${f.line} ${f.name}()`);
  assert.deepStrictEqual(rendered, [],
    'these calls throw only on the path that reaches them:\n' + rendered.join('\n'));
});

test('The undefined-call checker actually detects a missing helper', () => {
  const acorn = require('acorn');
  const { declaredNames, BUILTINS } = require('../scripts/check-undefined-calls.js');

  // A miniature version of the real bug: call a helper, never define it.
  const ast = acorn.parse('function a() { showToast("x"); }', { ecmaVersion: 'latest' });
  const declared = declaredNames(ast);

  const calls = [];
  const walk = (node) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier') calls.push(node.callee.name);
    for (const key of Object.keys(node)) {
      if (['loc', 'start', 'end'].includes(key)) continue;
      const value = node[key];
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value.type === 'string') walk(value);
    }
  };
  walk(ast);

  assert.ok(calls.includes('showToast'), 'the call must be observed');
  assert.strictEqual(declared.has('showToast'), false, 'an undefined helper must not look declared');
  assert.strictEqual(BUILTINS.has('showToast'), false, 'and must not be excused as a built-in');
});

test('Market-tab PCR and max pain are computed from the live chain', () => {
  const ui = harness();
  const market = require(path.join(ROOT, 'lib', 'market.js'));
  // The exact chain shape the Upstox normalizer produces.
  const oi = market.oiSummary([
    { strike: 24600, callOi: 5000, putOi: 7000 },
    { strike: 24700, callOi: 3000, putOi: 9000 },
  ]);
  ui.renderMarketOiCards(oi);

  // put 16000 / call 8000 = 2.00
  assert.strictEqual(ui.nodes.marketPcrVal.textContent, '2.00');
  assert.strictEqual(ui.nodes.marketPcrBias.textContent, 'Bullish Sentiment');
  assert.strictEqual(ui.nodes.marketMaxPainVal.textContent, '24,700');
});

test('Market-tab PCR maps each OI bias band honestly', () => {
  const ui = harness();
  ui.renderMarketOiCards({ pcr: 0.5, maxPain: 24000 });
  assert.strictEqual(ui.nodes.marketPcrBias.textContent, 'Bearish Sentiment');
  ui.renderMarketOiCards({ pcr: 1.0, maxPain: 24000 });
  assert.strictEqual(ui.nodes.marketPcrBias.textContent, 'Neutral Range');
});

test('Market-tab PCR admits when there is no chain', () => {
  const ui = harness();
  ui.renderMarketOiCards(null);

  assert.strictEqual(ui.nodes.marketPcrVal.textContent, '—');
  assert.strictEqual(ui.nodes.marketPcrBias.textContent, 'No option chain');
  assert.strictEqual(ui.nodes.marketMaxPainVal.textContent, '—');
});

test('Chain rows render from the fields the provider actually produces', () => {
  const ui = harness();
  // A row exactly as server/providers/upstox.js emits it.
  const row = {
    strike: 24600, spot: 24653,
    callOi: 5000, putOi: 7000, callOiChange: 1000, putOiChange: -500,
    callLtp: 120, putLtp: 88, callVol: 900, putVol: 800,
    callTheta: -12.5, putTheta: -9.1, callIv: 14.2, putIv: 13.8,
  };
  const html = ui.chainRowHtml(row, 24653, 100);

  assert.strictEqual((html.match(/<td/g) || []).length, 13, 'a row has 13 cells');
  assert.ok(!html.includes('undefined'), 'no cell may fall back to undefined');
  assert.ok(!html.includes('NaN'), 'no cell may print NaN');
  assert.ok(html.includes('5,000'), 'call OI is shown');
  assert.ok(html.includes('+1,000'), 'a positive OI change keeps its sign');
  assert.ok(html.includes('-500'), 'a negative OI change keeps its sign');
  assert.ok(html.includes('₹120.00'), 'call premium comes from callLtp');
  assert.ok(html.includes('14.20%'), 'call IV is formatted');
  assert.ok(html.includes('₹-12.5'), 'theta is shown');
  // strike 24600 sits right on spot 24653 with step 100, so it is the ATM row.
  assert.ok(html.includes('ATM'));
});

test('Chain rows show em-dashes for greeks the feed did not send', () => {
  const ui = harness();
  const row = { strike: 24700, callOi: 3000, putOi: null, callOiChange: null,
    putOiChange: null, callLtp: null, putLtp: null, callVol: null, putVol: null,
    callTheta: null, putTheta: null, callIv: null, putIv: null };
  const html = ui.chainRowHtml(row, 24653, 100);

  assert.ok(!html.includes('undefined'));
  assert.ok(!html.includes('₹0.00'), 'a missing premium must not look like a real 0');
  assert.ok(!html.includes('0.00%'), 'a missing IV must not look like a real 0');
  // Only the strike and the call OI are real; the other 11 cells are unknown.
  assert.strictEqual((html.match(/—/g) || []).length, 11);
  assert.ok(html.includes('3,000'), 'the OI we did receive is still shown');
});
