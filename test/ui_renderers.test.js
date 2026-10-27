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
  'overviewLiveBadge', 'vixVal', 'vixChg', 'vixRank', 'vixSkew',
  'vixAlertStatus', 'vixRegimeBadge',
  'marketResult', 'marketPcrVal', 'marketPcrBias', 'marketMaxPainVal',
];

/** Fresh fake DOM plus the renderers bound to it. */
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

  const code = [
    extract('renderOverviewFeedBadge'),
    extract('renderVolatilityPanel'),
    extract('renderMarketOiCards'),
    extract('chainRowHtml'),
  ].join('\n');

  const factory = new Function(
    'el', 'escapeHtml', 'isFinite', 'Number', 'Boolean', 'M', 'chartState',
    `${code}\nreturn { renderOverviewFeedBadge, renderVolatilityPanel, renderMarketOiCards, chainRowHtml };`
  );

  const fns = factory(
    (id) => nodes[id] || null,
    (s) => String(s),
    isFinite,
    Number,
    Boolean,
    require(path.join(ROOT, 'lib', 'market.js')),
    { fullOptionRows: [] }
  );
  return Object.assign(fns, { nodes });
}

test('The feed badge never claims LIVE without data', () => {
  const ui = harness();
  ui.renderOverviewFeedBadge(null);

  assert.ok(ui.nodes.overviewLiveBadge.innerHTML.includes('NO FEED'),
    'the badge must not claim LIVE without data');
  assert.ok(ui.nodes.overviewLiveBadge.style.cssText.includes('148,163,184'),
    'the offline badge must be grey, not the amber default');
});

test('A recovered feed clears the offline styling instead of layering over it', () => {
  const ui = harness();
  // Offline first, so the inline grey styles are set...
  ui.renderOverviewFeedBadge(null);
  assert.ok(ui.nodes.overviewLiveBadge.style.cssText.length > 0);
  // ...then a feed arrives: the inline styles must be cleared, not layered over.
  ui.renderOverviewFeedBadge({ source: 'live', spot: 24700, provider: 'Upstox' });
  assert.strictEqual(ui.nodes.overviewLiveBadge.style.cssText, '',
    'a recovered feed must not keep the offline colours');
  assert.strictEqual(ui.nodes.overviewLiveBadge.className, 'demo-badge-green');
  assert.ok(ui.nodes.overviewLiveBadge.innerHTML.includes('LIVE FEED'));
  // And back again.
  ui.renderOverviewFeedBadge(null);
  assert.strictEqual(ui.nodes.overviewLiveBadge.className, 'demo-badge');
  assert.ok(ui.nodes.overviewLiveBadge.innerHTML.includes('NO FEED'));
});

test('A snapshot from the removed broker tap is not reported as a live feed', () => {
  // tlMarket used to carry source:'broker' quotes scraped from a browser tab.
  // That path is gone; a snapshot that still claims it must read as no feed.
  const ui = harness();
  ui.renderOverviewFeedBadge({ source: 'broker', quotes: { NIFTY: { price: 24600 } } });
  assert.ok(ui.nodes.overviewLiveBadge.innerHTML.includes('NO FEED'));
  assert.strictEqual(ui.nodes.overviewLiveBadge.className, 'demo-badge');
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
