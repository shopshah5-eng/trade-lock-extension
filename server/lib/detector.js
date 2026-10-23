/*
 * Trade Lock — DOM detectors.
 *
 * Two kinds of signal are read off the broker's own page:
 *   1. Order book rows  -> a fill: +1 trade, its P&L, and the risk it carried.
 *   2. Positions rows   -> the risk currently committed (open exposure).
 *
 * It is deliberately generic: instead of hard-coded per-broker selectors it
 * finds any table with a Quantity column plus a Price column and classifies
 * rows by their status text (COMPLETE / OPEN / REJECTED / PENDING ...).
 * That is what lets one build work on Kite, Upstox, Angel One, Dhan, 5paisa
 * and most other order-book tables.
 *
 * `parseQty`, `parseNum`, `statusOf`, `rowSig`, `detectFromTables` and
 * `bestColumn` are pure and unit tested in test/detector.test.js.
 * `scan()` is the thin DOM wrapper used by the content script.
 */
(function (root) {
  'use strict';

  var REJECT_WORDS = ['reject', 'cancel', 'expired', 'modified', 'after market', 'amo', 'pending', 'open pending', 'trigger pending', 'after order'];
  var DONE_WORDS = ['complete', 'executed', 'filled', 'traded', 'closed', 'open'];

  var QTY_KEYS = ['quantity', 'qty', 'filled qty', 'filled quantity', 'traded qty', 'executed qty', 'order qty'];
  var PRICE_KEYS = ['price', 'avg price', 'avg. price', 'average price', 'ltp', 'rate'];
  var PNL_KEYS = ['p&l', 'pnl', 'p / l', 'net p&l', 'profit', 'profit/loss', 'realised', 'realized', 'net'];
  var NETQTY_KEYS = ['net qty', 'net quantity', 'net', 'position qty'];
  var SYM_KEYS = ['instrument', 'symbol', 'tradingsymbol', 'trading symbol', 'scrip', 'stock', 'name', 'instrument name'];
  var SIDE_KEYS = ['type', 'side', 'buy/sell', 'transaction type', 'b/s'];
  var TIME_KEYS = ['time', 'order time', 'timestamp', 'exchange timestamp'];

  /** "1,234" -> 1234, "(1,234.50)" -> -1234.5, "\u20B912" -> 12, "-" -> 0 */
  function parseNum(text) {
    if (typeof text !== 'string') return 0;
    var t = text.replace(/\u00a0/g, ' ').trim();
    if (!t || t === '-' || t === '--' || t === '—') return 0;
    var neg = /^\(.*\)$/.test(t) || /^-/.test(t);
    var m = t.replace(/[^0-9.]/g, '');
    if (!m) return 0;
    var parts = m.split('.');
    if (parts.length > 2) m = parts[0] + '.' + parts.slice(1).join('');
    var v = parseFloat(m);
    if (!isFinite(v)) return 0;
    return neg ? -v : v;
  }

  /** Quantity in units: "1.5K" -> 1500, "2k" -> 2000, "1,200" -> 1200 */
  function parseQty(text) {
    if (typeof text !== 'string') return 0;
    var t = text.replace(/\u00a0/g, ' ').trim().toUpperCase();
    if (!t || t === '-' || t === '--') return 0;
    var neg = /^-/.test(t) || /^\(.*\)$/.test(t);
    var mult = 1;
    var sm = t.match(/([0-9][0-9,.]*)\s*(K|M|L|TH|CR)?/);
    if (!sm) return 0;
    var base = parseFloat(sm[1].replace(/,/g, ''));
    if (!isFinite(base)) return 0;
    switch (sm[2]) {
      case 'K': case 'TH': mult = 1e3; break;
      case 'M': mult = 1e6; break;
      case 'L': mult = 1e5; break;
      case 'CR': mult = 1e7; break;
      default: mult = 1;
    }
    var v = base * mult;
    return neg ? -v : v;
  }

  /** Classify a row from the lowercase text of its cells. */
  function statusOf(cellsText) {
    var t = ' ' + String(cellsText || '').toLowerCase() + ' ';
    for (var i = 0; i < REJECT_WORDS.length; i++) {
      if (t.indexOf(REJECT_WORDS[i]) !== -1) return 'rejected';
    }
    for (var j = 0; j < DONE_WORDS.length; j++) {
      if (t.indexOf(DONE_WORDS[j]) !== -1) return 'done';
    }
    return 'unknown';
  }

  function norm(h) {
    return String(h || '').toLowerCase().replace(/[\u20b9()]/g, '').replace(/\s+/g, ' ').trim();
  }

  /**
   * Pick the column that best matches `keys`.
   * exact match > full-word match > substring match. Returns -1 if none.
   */
  function bestColumn(headers, keys) {
    var hs = (headers || []).map(norm);
    for (var i = 0; i < hs.length; i++) {
      for (var k = 0; k < keys.length; k++) if (hs[i] === keys[k]) return i;
    }
    for (var a = 0; a < hs.length; a++) {
      var words = (' ' + hs[a] + ' ').split(/\s+/);
      for (var k2 = 0; k2 < keys.length; k2++) {
        if (words.indexOf(keys[k2]) !== -1) return a;
      }
    }
    for (var b = 0; b < hs.length; b++) {
      for (var k3 = 0; k3 < keys.length; k3++) {
        if (hs[b] && hs[b].indexOf(keys[k3]) !== -1) return b;
      }
    }
    return -1;
  }

  function cell(row, i) { return (i >= 0 && i < row.length) ? String(row[i] || '') : ''; }

  /** Stable-ish signature so the same fill is only ever counted once. */
  function rowSig(o) {
    return [o.symbol, o.side, o.qty, o.price, o.time].join('|').toLowerCase();
  }

  /**
   * Turn {headers, rows} tables into orders and positions.
   * `opts.riskPerUnit` > 0 means risk = qty * riskPerUnit, else qty * price.
   */
  function detectFromTables(tables, opts) {
    opts = opts || {};
    var orders = [];
    var positions = [];

    (tables || []).forEach(function (t) {
      var headers = t.headers || [];
      if (!headers.length) return;

      var qi = bestColumn(headers, QTY_KEYS);
      var pi = bestColumn(headers, PRICE_KEYS);
      if (qi === -1) return; // not a quantity table

      var neti = bestColumn(headers, NETQTY_KEYS);
      var pnli = bestColumn(headers, PNL_KEYS);
      var symi = bestColumn(headers, SYM_KEYS);
      var sidei = bestColumn(headers, SIDE_KEYS);
      var timei = bestColumn(headers, TIME_KEYS);

      (t.rows || []).forEach(function (row) {
        if (!row || !row.length) return;
        var text = row.join(' ');
        var st = statusOf(text);
        if (st === 'rejected') return;

        var qty = neti !== -1 ? parseQty(cell(row, neti)) : parseQty(cell(row, qi));
        if (!qty) return;
        var price = pi !== -1 ? parseNum(cell(row, pi)) : 0;
        var pnl = pnli !== -1 ? parseNum(cell(row, pnli)) : 0;
        var risk = opts.riskPerUnit > 0 ? Math.abs(qty) * opts.riskPerUnit : Math.abs(qty) * Math.abs(price);

        var rec = {
          symbol: (cell(row, symi)).trim(),
          side: (cell(row, sidei)).trim(),
          qty: qty,
          price: price,
          pnl: pnl,
          risk: risk,
          time: (cell(row, timei)).trim(),
          status: st
        };

        if (neti !== -1 && st !== 'done') {
          positions.push(rec);          // positions table: has "Net qty", no status word
        } else if (st === 'done') {
          orders.push(rec);             // order book: status says the fill happened
        } else {
          // No status text at all: treat a "Net qty" column as positions.
          if (neti !== -1) positions.push(rec);
        }
      });
    });

    return { orders: orders, positions: positions };
  }


  /**
   * How many symbols still have a net open quantity across today's fills.
   * BUY adds, SELL subtracts; a symbol back at zero is closed. This is how we
   * know a trade is still running even when no positions table is on screen.
   */
  function netOpenSymbols(orders) {
    var net = {};
    (orders || []).forEach(function (o) {
      var sym = String(o.symbol || '').trim().toLowerCase();
      if (!sym) return;
      var side = String(o.side || '').toLowerCase();
      var sign = /(sell|short)/.test(side) ? -1 : 1;
      net[sym] = (net[sym] || 0) + sign * (Number(o.qty) || 0);
    });
    return Object.keys(net).filter(function (k) { return Math.abs(net[k]) > 0; }).length;
  }

  // ------------------------------------------------------- DOM wrapper ----

  function headersAndRows(table) {
    var headers = [];
    var rows = [];
    var theadRows = table.querySelectorAll(':scope > thead > tr');
    theadRows.forEach(function (tr) {
      var hs = [];
      tr.querySelectorAll('th,td').forEach(function (c) { hs.push((c.textContent || '').trim()); });
      if (hs.join('').length) headers = hs;
    });
    if (!headers.length) {
      var firstTh = table.querySelectorAll('tr th');
      if (firstTh.length) {
        var hs2 = [];
        firstTh.forEach(function (c) { hs2.push((c.textContent || '').trim()); });
        headers = hs2;
      }
    }
    var bodyRows = table.querySelectorAll('tbody > tr');
    if (!bodyRows.length) bodyRows = table.querySelectorAll('tr');
    bodyRows.forEach(function (tr) {
      var cells = [];
      var any = tr.querySelectorAll('td');
      if (!any.length) return;
      any.forEach(function (c) { cells.push((c.textContent || '').replace(/\s+/g, ' ').trim()); });
      if (cells.join('').length) rows.push(cells);
    });
    return { headers: headers, rows: rows };
  }

  /** Live DOM scan. Cheap enough for a 3s poll; skips oversized tables. */
  function scan(doc, opts) {
    var tables = [];
    var els = (doc || document).querySelectorAll('table');
    for (var i = 0; i < els.length && i < 60; i++) {
      if ((els[i].textContent || '').length > 200000) continue;
      var hr = headersAndRows(els[i]);
      if (hr.headers.length) tables.push(hr);
    }
    return detectFromTables(tables, opts);
  }

  var api = {
    REJECT_WORDS: REJECT_WORDS,
    DONE_WORDS: DONE_WORDS,
    QTY_KEYS: QTY_KEYS,
    PRICE_KEYS: PRICE_KEYS,
    PNL_KEYS: PNL_KEYS,
    NETQTY_KEYS: NETQTY_KEYS,
    parseNum: parseNum,
    parseQty: parseQty,
    statusOf: statusOf,
    norm: norm,
    bestColumn: bestColumn,
    rowSig: rowSig,
    netOpenSymbols: netOpenSymbols,
    detectFromTables: detectFromTables,
    headersAndRows: headersAndRows,
    scan: scan
  };

  root.TLDetect = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
