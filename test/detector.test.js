/*
 * Tests for the DOM detectors (lib/detector.js — the shipped content-script
 * file). The table fixtures below are shaped like the order book / positions
 * tables of Kite, Upstox, Angel One, Dhan and 5paisa: all of them are plain
 * <table> markup with a Quantity column and a Price column, which is exactly
 * the contract detectFromTables relies on.
 *
 * Run: node --test test/
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const D = require('../lib/detector.js');

// linkedom is only needed for the live-DOM tests. If it is missing (e.g. the
// extension was unzipped without running `npm install`), those tests are
// skipped instead of failing the suite — the pure-logic tests still run.
let linkedom = null;
for (const req of [
  () => require('linkedom'),
  () => require('../../node_modules/linkedom'),
  () => require(require('node:module').createRequire('/home/user/').resolve('linkedom'))
]) {
  try { linkedom = req(); break; } catch (e) { /* try the next path */ }
}

// ------------------------------------------------------------ parsing ----

test('parseQty handles plain, grouped and suffixed quantities', () => {
  assert.strictEqual(D.parseQty('75'), 75);
  assert.strictEqual(D.parseQty('1,200'), 1200);
  assert.strictEqual(D.parseQty('1.5K'), 1500);
  assert.strictEqual(D.parseQty('2k'), 2000);
  assert.strictEqual(D.parseQty('3M'), 3000000);
  assert.strictEqual(D.parseQty('-75'), -75);
  assert.strictEqual(D.parseQty('(75)'), -75);
  assert.strictEqual(D.parseQty('-'), 0);
  assert.strictEqual(D.parseQty(''), 0);
  assert.strictEqual(D.parseQty(undefined), 0);
});

test('parseNum handles currency, grouping and accounting negatives', () => {
  assert.strictEqual(D.parseNum('\u20B91,234.50'), 1234.5);
  assert.strictEqual(D.parseNum('-1,234.50'), -1234.5);
  assert.strictEqual(D.parseNum('(1,234.50)'), -1234.5);
  assert.strictEqual(D.parseNum('12,34,567.89'), 1234567.89);
  assert.strictEqual(D.parseNum('--'), 0);
  assert.strictEqual(D.parseNum('no numbers'), 0);
});

test('statusOf classifies rows from their text', () => {
  assert.strictEqual(D.statusOf(['RELIANCE', 'BUY', 'COMPLETE']), 'done');
  assert.strictEqual(D.statusOf(['TATASTEEL', 'SELL', 'EXECUTED']), 'done');
  assert.strictEqual(D.statusOf(['INFY', 'BUY', 'REJECTED']), 'rejected');
  assert.strictEqual(D.statusOf(['INFY', 'BUY', 'CANCELLED']), 'rejected');
  assert.strictEqual(D.statusOf(['INFY', 'BUY', 'TRIGGER PENDING']), 'rejected');
  assert.strictEqual(D.statusOf(['INFY', 'BUY', 'AFTER MARKET']), 'rejected');
  assert.strictEqual(D.statusOf(['INFY', '10', '250.10']), 'unknown');
});

test('bestColumn prefers an exact header over a substring hit', () => {
  const headers = ['Instrument', 'Gross qty', 'Net qty', 'Buy price', 'Sell price', 'Net'];
  assert.strictEqual(D.bestColumn(headers, D.NETQTY_KEYS), 2);   // "Net qty", not "Net"
  assert.strictEqual(D.bestColumn(headers, D.QTY_KEYS), 1);      // "Gross qty" via word match
  assert.strictEqual(D.bestColumn(headers, D.PRICE_KEYS), 3);
  assert.strictEqual(D.bestColumn(headers, ['does not exist']), -1);
});

test('bestColumn matches case-insensitively and tolerates ₹ and spacing', () => {
  assert.strictEqual(D.bestColumn(['  AVG PRICE ', 'QTY'], D.PRICE_KEYS), 0);
  assert.strictEqual(D.bestColumn(['\u20B9 P&L', 'Qty'], D.PNL_KEYS), 0);
});

test('rowSig is stable for the same fill and differs on any field change', () => {
  const a = { symbol: 'RELIANCE', side: 'BUY', qty: 75, price: 250.1, time: '10:15:02' };
  assert.strictEqual(D.rowSig(a), D.rowSig(Object.assign({}, a)));
  assert.notStrictEqual(D.rowSig(a), D.rowSig(Object.assign({}, a, { qty: 76 })));
  assert.notStrictEqual(D.rowSig(a), D.rowSig(Object.assign({}, a, { time: '10:15:03' })));
});

// ------------------------------------------------- order book fixtures ----

const KITE_ORDERBOOK = `
<div id="orders">
  <table class="kite-table">
    <thead>
      <tr>
        <th>Time</th><th>Instrument</th><th>Type</th><th>Quantity</th>
        <th>Price</th><th>Status</th>
      </tr>
    </thead>
    <tbody>
      <tr><td>09:31:12</td><td>RELIANCE</td><td>BUY</td><td>75</td><td>2,450.10</td><td>COMPLETE</td></tr>
      <tr><td>10:02:44</td><td>TATASTEEL</td><td>SELL</td><td>500</td><td>145.25</td><td>COMPLETE</td></tr>
      <tr><td>10:15:09</td><td>INFY</td><td>BUY</td><td>100</td><td>1,812.00</td><td>REJECTED</td></tr>
      <tr><td>10:44:31</td><td>NIFTY 25000 CE</td><td>BUY</td><td>1.5K</td><td>120.50</td><td>COMPLETE</td></tr>
    </tbody>
  </table>
</div>`;

const ANGEL_POSITIONS = `
<table>
  <thead>
    <tr>
      <th>Trading Symbol</th><th>Buy Qty</th><th>Sell Qty</th><th>Net Qty</th>
      <th>LTP</th><th>Net P&amp;L</th>
    </tr>
  </thead>
  <tbody>
    <tr><td>SBIN</td><td>200</td><td>0</td><td>200</td><td>812.35</td><td>(1,240.00)</td></tr>
    <tr><td>HDFCBANK</td><td>0</td><td>150</td><td>-150</td><td>1,690.00</td><td>3,510.50</td></tr>
  </tbody>
</table>`;

test('detectFromTables reads completed fills and skips rejected ones', () => {
  const { orders, positions } = D.detectFromTables([{
    headers: ['Time', 'Instrument', 'Type', 'Quantity', 'Price', 'Status'],
    rows: [
      ['09:31:12', 'RELIANCE', 'BUY', '75', '2,450.10', 'COMPLETE'],
      ['10:02:44', 'TATASTEEL', 'SELL', '500', '145.25', 'COMPLETE'],
      ['10:15:09', 'INFY', 'BUY', '100', '1,812.00', 'REJECTED'],
      ['10:44:31', 'NIFTY 25000 CE', 'BUY', '1.5K', '120.50', 'COMPLETE']
    ]
  }]);

  assert.strictEqual(orders.length, 3);
  assert.strictEqual(positions.length, 0);
  assert.deepStrictEqual(orders.map((o) => o.symbol), ['RELIANCE', 'TATASTEEL', 'NIFTY 25000 CE']);
  assert.strictEqual(orders[0].qty, 75);
  assert.strictEqual(orders[0].price, 2450.1);
  assert.strictEqual(orders[0].risk, 75 * 2450.1);
  assert.strictEqual(orders[2].qty, 1500);
});

test('a Net qty column with no status word is read as a position', () => {
  const { orders, positions } = D.detectFromTables([{
    headers: ['Trading Symbol', 'Buy Qty', 'Sell Qty', 'Net Qty', 'LTP', 'Net P&L'],
    rows: [
      ['SBIN', '200', '0', '200', '812.35', '(1,240.00)'],
      ['HDFCBANK', '0', '150', '-150', '1,690.00', '3,510.50']
    ]
  }]);

  assert.strictEqual(orders.length, 0);
  assert.strictEqual(positions.length, 2);
  assert.strictEqual(positions[0].qty, 200);
  assert.strictEqual(positions[0].pnl, -1240);
  assert.strictEqual(positions[1].qty, -150);
  assert.strictEqual(positions[1].risk, 150 * 1690);   // risk is unsigned
});

test('a table without a quantity column is ignored', () => {
  const { orders, positions } = D.detectFromTables([{
    headers: ['Watchlist', 'LTP', 'Change'],
    rows: [['NIFTY 50', '24,912.5', '+0.42%']]
  }]);
  assert.strictEqual(orders.length, 0);
  assert.strictEqual(positions.length, 0);
});

test('empty and blank rows are skipped', () => {
  const { orders } = D.detectFromTables([{
    headers: ['Instrument', 'Quantity', 'Price', 'Status'],
    rows: [[], ['', '', '', ''], ['RELIANCE', '75', '2,450.10', 'COMPLETE']]
  }]);
  assert.strictEqual(orders.length, 1);
});

test('riskPerUnit overrides the notional estimate', () => {
  const { orders } = D.detectFromTables([{
    headers: ['Instrument', 'Quantity', 'Price', 'Status'],
    rows: [['NIFTY FUT', '75', '24,900', 'COMPLETE']]
  }], { riskPerUnit: 12 });
  assert.strictEqual(orders[0].risk, 900);
});

test('netOpenSymbols knows which trades are still running', () => {
  const fills = [
    { symbol: 'RELIANCE', side: 'BUY', qty: 75 },
    { symbol: 'SBIN', side: 'BUY', qty: 100 },
    { symbol: 'SBIN', side: 'SELL', qty: 100 } // closed
  ];
  assert.strictEqual(D.netOpenSymbols(fills), 1, 'only RELIANCE still open');
  assert.strictEqual(D.netOpenSymbols([]), 0);
  assert.strictEqual(D.netOpenSymbols([{ symbol: 'X', side: 'SELL', qty: 50 }]), 1, 'short still open');
  assert.strictEqual(D.netOpenSymbols([
    { symbol: 'X', side: 'SELL', qty: 50 }, { symbol: 'X', side: 'BUY', qty: 50 }
  ]), 0, 'short covered = closed');
});

// ---------------------------------------------- live DOM scan (linkedom) ----

const withDom = linkedom ? test : test.skip;

withDom('headersAndRows extracts thead and tbody from real table markup', () => {
  const { document } = linkedom.parseHTML(KITE_ORDERBOOK);
  const table = document.querySelector('table');
  const { headers, rows } = D.headersAndRows(table);
  assert.deepStrictEqual(headers, ['Time', 'Instrument', 'Type', 'Quantity', 'Price', 'Status']);
  assert.strictEqual(rows.length, 4);
  assert.deepStrictEqual(rows[0], ['09:31:12', 'RELIANCE', 'BUY', '75', '2,450.10', 'COMPLETE']);
});

withDom('scan() finds fills and positions across a whole page', () => {
  const { document } = linkedom.parseHTML(
    '<html><body>' + KITE_ORDERBOOK + ANGEL_POSITIONS +
    '<table><thead><tr><th>Watchlist</th><th>LTP</th></tr></thead>' +
    '<tbody><tr><td>NIFTY 50</td><td>24,912.5</td></tr></tbody></table>' +
    '</body></html>'
  );

  const { orders, positions } = D.scan(document, {});
  assert.strictEqual(orders.length, 3, 'three COMPLETE rows, the REJECTED one ignored');
  assert.strictEqual(positions.length, 2, 'two open positions from the Net qty table');
});

withDom('scan() de-duplicates via rowSig the way lock.js does', () => {
  const { document } = linkedom.parseHTML(KITE_ORDERBOOK);
  const seen = {};
  let counted = 0;

  function pass() {
    D.scan(document, {}).orders.forEach((o) => {
      const sig = D.rowSig(o);
      if (seen[sig]) return;
      seen[sig] = true;
      counted += 1;
    });
  }
  pass(); pass(); pass();
  assert.strictEqual(counted, 3, 'three scans of the same order book still count each fill once');
});

withDom('scan() ignores tables too large to be an order book', () => {
  let big = '<table><thead><tr><th>Instrument</th><th>Quantity</th><th>Price</th><th>Status</th></tr></thead><tbody>';
  for (let i = 0; i < 8000; i++) {
    big += '<tr><td>SYMBOL' + i + ' LONG NAME</td><td>75</td><td>100.00</td><td>COMPLETE</td></tr>';
  }
  big += '</tbody></table>';
  const { document } = linkedom.parseHTML(big);
  assert.ok(document.querySelector('table').textContent.length > 200000);
  assert.strictEqual(D.scan(document, {}).orders.length, 0);
});

test('isVerifiedOrderRestrictionBroker only trusts fully restriction-tested adapters', () => {
  assert.strictEqual(D.isVerifiedOrderRestrictionBroker('fake-broker.local'), true);
  assert.strictEqual(D.isVerifiedOrderRestrictionBroker('subdomain.fake-broker.local'), true);
  assert.strictEqual(D.isVerifiedOrderRestrictionBroker('kite.zerodha.com'), false);
  assert.strictEqual(D.isVerifiedOrderRestrictionBroker('web.dhan.co'), false);

  assert.strictEqual(D.isVerifiedOrderRestrictionBroker('unverified-broker.com'), false);
  assert.strictEqual(D.isVerifiedOrderRestrictionBroker('arbitrary-trading.in'), false);
  assert.strictEqual(D.isVerifiedOrderRestrictionBroker(''), false);
  assert.strictEqual(D.isVerifiedOrderRestrictionBroker(null), false);
});

test('statusOf distinguishes OPEN pending orders from executed COMPLETE fills', () => {
  assert.strictEqual(D.statusOf(['INFY', 'BUY', 'OPEN']), 'pending');
  assert.strictEqual(D.statusOf(['TCS', 'SELL', 'MODIFY']), 'pending');
  assert.strictEqual(D.statusOf(['SBIN', 'BUY', 'REQUESTED']), 'pending');
  assert.strictEqual(D.statusOf(['RELIANCE', 'BUY', 'PARTIAL']), 'partial');
  assert.strictEqual(D.statusOf(['RELIANCE', 'BUY', 'COMPLETE']), 'done');
  assert.strictEqual(D.statusOf(['RELIANCE', 'BUY', 'EXECUTED']), 'done');
});

test('detectFromTables separates pending orders from completed fills', () => {
  const { orders, pending, positions } = D.detectFromTables([{
    headers: ['Time', 'Instrument', 'Type', 'Quantity', 'Price', 'Status'],
    rows: [
      ['09:31:12', 'RELIANCE', 'BUY', '75', '2,450.10', 'COMPLETE'],
      ['10:02:44', 'INFY', 'BUY', '100', '1,812.00', 'OPEN'],
      ['10:15:00', 'TATASTEEL', 'SELL', '500', '145.25', 'TRIGGER PENDING'],
      ['10:30:00', 'SBIN', 'BUY', '200', '810.00', 'PARTIALLY FILLED']
    ]
  }]);

  assert.strictEqual(orders.length, 1, 'Only COMPLETE row counted in executed orders');
  assert.strictEqual(orders[0].symbol, 'RELIANCE');
  assert.strictEqual(pending.length, 2, 'OPEN and PARTIAL rows placed in pending array');
  assert.strictEqual(pending[0].symbol, 'INFY');
  assert.strictEqual(positions.length, 0);
});

test('getBrokerAdapterProfile returns granular verification status and truthful limits', () => {
  const kite = D.getBrokerAdapterProfile('kite.zerodha.com');
  assert.strictEqual(kite.domainRecognized, true);
  assert.strictEqual(kite.detectionStatus, 'DETECTION_VERIFIED');
  assert.strictEqual(kite.restrictionStatus, 'RESTRICTION_UNAVAILABLE');
  assert.strictEqual(kite.newOrderRestrictionTested, false);

  const fakeBroker = D.getBrokerAdapterProfile('fake-broker.local');
  assert.strictEqual(fakeBroker.domainRecognized, true);
  assert.strictEqual(fakeBroker.restrictionStatus, 'RESTRICTION_TESTED');
  assert.strictEqual(fakeBroker.newOrderRestrictionTested, true);

  const unsupported = D.getBrokerAdapterProfile('unknown-site.org');
  assert.strictEqual(unsupported.domainRecognized, false);
  assert.strictEqual(unsupported.detectionStatus, 'UNSUPPORTED');
});

test('getEnforcementLabel provides truthful Mode A-D labels', () => {
  const modeA = D.getEnforcementLabel('kite.zerodha.com', 'warning');
  assert.match(modeA.badgeText, /FULL-SCREEN DISCIPLINE LOCK/);
  assert.match(modeA.desc, /blocks mouse and keyboard/);
  assert.match(modeA.desc, /does not intercept orders at the broker/);

  const modeBTested = D.getEnforcementLabel('fake-broker.local', 'order_restrict');
  assert.match(modeBTested.badgeText, /RESTRICTION VERIFIED/);

  const modeBUnverified = D.getEnforcementLabel('kite.zerodha.com', 'order_restrict');
  assert.match(modeBUnverified.badgeText, /ENFORCEMENT TEST REQUIRED/);

  const modeC = D.getEnforcementLabel('kite.zerodha.com', 'full_site');
  assert.match(modeC.badgeText, /FULL TRADING-SITE RESTRICTION/);
  assert.match(modeC.desc, /Access to open positions may be blocked/);
});


test('resolveOpenTrades distinguishes an authoritative empty positions table from an absent table', () => {
  if (!linkedom) return;
  const empty = linkedom.parseHTML('<table><thead><tr><th>Symbol</th><th>Net qty</th></tr></thead><tbody></tbody></table>').document;
  const foundEmpty = D.scan(empty, {});
  assert.strictEqual(foundEmpty.positionsTablePresent, true);
  assert.strictEqual(D.resolveOpenTrades(foundEmpty), 0);

  const noTable = linkedom.parseHTML('<div>No positions widget is present on this route</div>').document;
  assert.strictEqual(D.resolveOpenTrades(D.scan(noTable, {})), null);
});

test('resolveOpenTrades ignores zero-quantity rows and counts nonzero positions', () => {
  if (!linkedom) return;
  const dom = linkedom.parseHTML('<table><thead><tr><th>Symbol</th><th>Net qty</th></tr></thead><tbody>' +
    '<tr><td>NIFTY</td><td>0</td></tr><tr><td>BANKNIFTY</td><td>-15</td></tr></tbody></table>').document;
  const found = D.scan(dom, {});
  assert.strictEqual(found.positions.length, 2);
  assert.strictEqual(D.resolveOpenTrades(found), 1);
});


test('chart-only policy recognizes chart hosts and paths, not order terminals', () => {
  assert.strictEqual(D.isChartingPage('kitecharts.com', '/'), true);
  assert.strictEqual(D.isChartingPage('charts.kitecharts.com', '/'), true);
  assert.strictEqual(D.isChartingPage('kite.zerodha.com', '/chart/123'), true);
  assert.strictEqual(D.isChartingPage('kite.zerodha.com', '/orders'), false);
  assert.strictEqual(D.isChartingPage('web.dhan.co', '/dashboard'), false);
});

test('enforcement copy matches full-screen behavior and honest Mode B fallback', () => {
  const modeA = D.getEnforcementLabel('kite.zerodha.com', 'warning');
  assert.match(modeA.desc, /blocks mouse and keyboard/);
  assert.doesNotMatch(modeA.desc, /remains interactive|orders are not blocked/i);
  const fallback = D.getEnforcementLabel('kite.zerodha.com', 'order_restrict');
  assert.match(fallback.desc, /Full-screen lock fallback/);
  assert.doesNotMatch(fallback.desc, /Warning Mode|Warning overlay/);
});


test('OPEN/CLOSED status text cannot hide nonzero Net qty position evidence', () => {
  const found = D.detectFromTables([{
    headers: ['Symbol', 'Net qty', 'Status'],
    rows: [['NIFTY', '15', 'OPEN'], ['BANKNIFTY', '0', 'CLOSED']],
  }]);
  assert.strictEqual(found.orders.length, 0);
  assert.strictEqual(found.pending.length, 0);
  assert.strictEqual(found.positions.length, 2);
  assert.strictEqual(D.resolveOpenTrades(found), 1);
});


