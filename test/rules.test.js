/*
 * Tests for the real content-script rules engine (lib/rules.js is loaded via
 * require, so these assertions run the shipped code path, not a re-implementation).
 *
 * Run: node --test test/
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const R = require('../lib/rules.js');

const MIN = R.MIN;
const DAY = R.DAY;

/** UTC epoch ms for a given IST wall-clock time. */
function ist(y, m, d, hh, mm) {
  return Date.UTC(y, m - 1, d, hh, mm) - R.IST_OFFSET_MIN * MIN;
}

const S = Object.assign({}, R.DEFAULT_SETTINGS, {
  maxTradesPerDay: 5,
  maxDailyLoss: 5000,
  profitTarget: 3000,
  maxRiskPerTrade: 1000,
  maxDailyRisk: 20000,
  maxConsecutiveLosses: 3
});

// ------------------------------------------------------------ IST math ----

test('istDate converts to the IST calendar day, not UTC', () => {
  // 23:30 UTC on Oct 12 is 05:00 IST on Oct 13
  assert.strictEqual(R.istDate(ist(2026, 10, 13, 5, 0)), '2026-10-13');
  assert.strictEqual(R.istDate(Date.UTC(2026, 9, 12, 23, 30)), '2026-10-13');
  assert.strictEqual(R.istDate(Date.UTC(2026, 9, 12, 18, 29)), '2026-10-12');
});

test('istMinutesOfDay reports IST wall-clock minutes', () => {
  assert.strictEqual(R.istMinutesOfDay(ist(2026, 10, 13, 9, 15)), 555);
  assert.strictEqual(R.istMinutesOfDay(ist(2026, 10, 13, 0, 0)), 0);
});

test('istWeekday is evaluated in IST', () => {
  // Fri 23:30 UTC == Sat 05:00 IST
  assert.strictEqual(R.istWeekday(Date.UTC(2026, 9, 9, 23, 30)), 6);
  assert.strictEqual(R.istWeekday(ist(2026, 10, 12, 10, 0)), 1); // Monday
});

// -------------------------------------------------------- session logic ----

test('sessionStart is today 09:15 IST once the market has opened', () => {
  assert.strictEqual(R.sessionStart(ist(2026, 10, 13, 14, 0), S), ist(2026, 10, 13, 9, 15));
});

test('before the open, the session belongs to the previous trading day', () => {
  // Tue 08:00 IST -> Monday 09:15
  assert.strictEqual(R.sessionStart(ist(2026, 10, 13, 8, 0), S), ist(2026, 10, 12, 9, 15));
  // Mon 08:00 IST -> Friday 09:15
  assert.strictEqual(R.sessionStart(ist(2026, 10, 12, 8, 0), S), ist(2026, 10, 9, 9, 15));
});

test('sessionStart skips exchange holidays', () => {
  // Fri 2 Oct 2026 is Gandhi Jayanti (closed), so the session rolls back to
  // Thu 1 Oct 09:15. A fill taken on Wed 30 Sep still belongs to 30 Sep.
  assert.strictEqual(R.sessionStart(ist(2026, 10, 2, 12, 0), S), ist(2026, 10, 1, 9, 15));
  // Sat 3 Oct rolls back over the weekend to the same open.
  assert.strictEqual(R.sessionStart(ist(2026, 10, 3, 12, 0), S), ist(2026, 10, 1, 9, 15));
});

test('sessionStart falls back to the built-in NSE calendar when holidays is empty', () => {
  const noHolidays = Object.assign({}, S, { holidays: [] });
  assert.strictEqual(R.sessionStart(ist(2026, 10, 2, 12, 0), noHolidays), ist(2026, 10, 1, 9, 15));
});

test('sessionStart never returns a closed day, at any hour', () => {
  // Regression: it used to return today's 09:15 on a holiday/weekend without
  // checking that today is actually a trading day, which made counters reset
  // on a closed day and stranded an active lock.
  const dayMs = R.DAY;
  const start = ist(2026, 1, 1, 0, 0);
  for (let i = 0; i < 400; i++) {
    for (const hour of [0, 3, 9, 12, 18, 23]) {
      const t = start + i * dayMs + hour * 60 * MIN;
      const s = R.sessionStart(t, S);
      assert.ok(s <= t, 'session start must not be in the future');
      assert.strictEqual(
        R.isClosedDay(s, S), false,
        R.istLabel(s) + ' (for now=' + R.istLabel(t) + ') is a closed day'
      );
      assert.strictEqual(R.istMinutesOfDay(s), 555, 'session always starts at market open');
    }
  }
});

test('a custom holiday list overrides the built-in calendar', () => {
  const custom = Object.assign({}, S, { holidays: ['2026-10-13'] });
  assert.strictEqual(R.isHoliday(ist(2026, 10, 13, 12, 0), custom), true);
  assert.strictEqual(R.isHoliday(ist(2026, 10, 2, 12, 0), custom), false);
});

test('skipHolidays=false keeps the built-in list inert', () => {
  const off = Object.assign({}, S, { skipHolidays: false });
  assert.strictEqual(R.isHoliday(ist(2026, 10, 2, 12, 0), off), false);
  assert.strictEqual(R.sessionStart(ist(2026, 10, 2, 12, 0), off), ist(2026, 10, 2, 9, 15));
});

// -------------------------------------------------------- unlock timing ----

test('nextMarketOpen rolls to tomorrow after the open', () => {
  assert.strictEqual(R.nextMarketOpen(ist(2026, 10, 13, 11, 0), S), ist(2026, 10, 14, 9, 15));
});

test('nextMarketOpen is today when locked before the open', () => {
  assert.strictEqual(R.nextMarketOpen(ist(2026, 10, 13, 7, 0), S), ist(2026, 10, 13, 9, 15));
});

test('a Friday lock releases Monday morning', () => {
  assert.strictEqual(R.nextMarketOpen(ist(2026, 10, 9, 15, 0), S), ist(2026, 10, 12, 9, 15));
});

test('a pre-holiday lock releases on the next trading day', () => {
  // Thu 1 Oct 2026 -> Fri 2 Oct is a holiday, Sat/Sun weekend -> Mon 5 Oct
  assert.strictEqual(R.nextMarketOpen(ist(2026, 10, 1, 15, 0), S), ist(2026, 10, 5, 9, 15));
});

test('minLockMinutes prevents a lock that would expire in seconds', () => {
  const settings = Object.assign({}, S, { minLockMinutes: 60 });
  const at = ist(2026, 10, 13, 15, 20);            // next open is 17h55m away -> unaffected
  const state = R.defaultState(at);
  R.lockNow(state, settings, at);
  assert.strictEqual(state.lock.until, ist(2026, 10, 14, 9, 15));

  const lateFriday = ist(2026, 10, 9, 23, 30);     // next open is Monday 09:15
  const s2 = R.defaultState(lateFriday);
  R.lockNow(s2, settings, lateFriday);
  assert.strictEqual(s2.lock.until, ist(2026, 10, 12, 9, 15));

  // Now force the floor to matter: open 20 min after the lock time.
  const tight = Object.assign({}, S, { minLockMinutes: 60, marketOpenMin: 15 * 60 + 40 });
  const s3 = R.defaultState(at);
  R.lockNow(s3, tight, at);
  assert.strictEqual(s3.lock.until, at + 60 * MIN);
});

// ------------------------------------------------------------ counting ----

test('logTrade updates count, P&L, risk, streak and per-trade max', () => {
  const t0 = ist(2026, 10, 13, 10, 0);
  const st = R.syncSession(R.defaultState(t0), S, t0);

  R.logTrade(st, S, { pnl: 800, risk: 500 }, t0 + MIN);
  R.logTrade(st, S, { pnl: -1200, risk: 900 }, t0 + 2 * MIN);
  R.logTrade(st, S, { pnl: -300, risk: 1400 }, t0 + 3 * MIN);

  assert.strictEqual(st.session.trades, 3);
  assert.strictEqual(st.session.pnl, -700);
  assert.strictEqual(st.session.riskUsed, 2800);
  assert.strictEqual(st.session.maxTradeRisk, 1400);
  assert.strictEqual(st.session.consecutiveLosses, 2);
  assert.strictEqual(st.log.length, 3);
});

test('a winning trade resets the losing streak', () => {
  const t0 = ist(2026, 10, 13, 10, 0);
  const st = R.syncSession(R.defaultState(t0), S, t0);
  R.logTrade(st, S, { pnl: -100 }, t0);
  R.logTrade(st, S, { pnl: -100 }, t0);
  assert.strictEqual(st.session.consecutiveLosses, 2);
  R.logTrade(st, S, { pnl: 50 }, t0);
  assert.strictEqual(st.session.consecutiveLosses, 0);
});

test('undoLastTrade reverses the counters exactly', () => {
  const t0 = ist(2026, 10, 13, 10, 0);
  const st = R.syncSession(R.defaultState(t0), S, t0);
  R.logTrade(st, S, { pnl: -1200, risk: 900 }, t0);
  R.logTrade(st, S, { pnl: 300, risk: 400 }, t0 + MIN);
  const before = { trades: st.session.trades, pnl: st.session.pnl, risk: st.session.riskUsed };
  const undone = R.undoLastTrade(st);
  assert.strictEqual(undone.pnl, 300);
  assert.strictEqual(st.session.trades, before.trades - 1);
  assert.strictEqual(st.session.pnl, before.pnl - 300);
  assert.strictEqual(st.session.riskUsed, before.risk - 400);
});

test('undoLastTrade refuses to erase verified broker-imported trades', () => {
  const t0 = ist(2026, 10, 13, 10, 0);
  const st = R.syncSession(R.defaultState(t0), S, t0);
  R.logTrade(st, S, { pnl: -2500, risk: 1000, source: 'auto', provenance: 'broker-imported' }, t0);
  const tradeCount = st.session.trades;
  const res = R.undoLastTrade(st);
  assert.ok(res && res.rejected, 'Must reject undo on verified broker trade');
  assert.strictEqual(res.reason, 'BROKER_EXECUTION_PROTECTED');
  assert.strictEqual(st.session.trades, tradeCount, 'Trade count must not decrease');
  assert.strictEqual(st.log.length, 1, 'Log must retain verified broker trade');
});

test('counters roll over at the next market open', () => {
  const t0 = ist(2026, 10, 13, 10, 0);
  const st = R.syncSession(R.defaultState(t0), S, t0);
  R.logTrade(st, S, { pnl: -6000, risk: 500 }, t0);
  assert.strictEqual(st.session.trades, 1);
  assert.ok(st.lock.active === false);            // tick not run yet

  R.tick(st, S, t0);                              // maxDailyLoss trips
  assert.strictEqual(st.lock.active, true);
  assert.strictEqual(st.lock.reason, 'maxDailyLoss');

  const nextDay = ist(2026, 10, 14, 9, 16);
  R.tick(st, S, nextDay);
  assert.strictEqual(st.lock.active, false);
  assert.strictEqual(st.session.trades, 0);
  assert.strictEqual(st.session.pnl, 0);
  assert.strictEqual(st.session.date, '2026-10-14');
  assert.deepStrictEqual(st.detectorSeen, {});
});

// ------------------------------------------------------------- rules ----

function atLimit(mutator) {
  const t0 = ist(2026, 10, 13, 10, 0);
  const st = R.syncSession(R.defaultState(t0), S, t0);
  mutator(st.session);
  return { st, t0, v: R.evaluate(st, S) };
}

test('trade-count limit trips at exactly maxTradesPerDay', () => {
  const { v } = atLimit((s) => { s.trades = 5; });
  assert.strictEqual(v.rule, 'maxTradesPerDay');
  const under = atLimit((s) => { s.trades = 4; });
  assert.strictEqual(under.v, null);
});

test('loss limit trips when realised P&L reaches -maxDailyLoss', () => {
  assert.strictEqual(atLimit((s) => { s.pnl = -5000; }).v.rule, 'maxDailyLoss');
  assert.strictEqual(atLimit((s) => { s.pnl = -4999.99; }).v, null);
});

test('profit target trips on the way up', () => {
  assert.strictEqual(atLimit((s) => { s.pnl = 3000; }).v.rule, 'profitTarget');
  assert.strictEqual(atLimit((s) => { s.pnl = 2999; }).v, null);
});

test('consecutive-loss limit trips', () => {
  assert.strictEqual(atLimit((s) => { s.consecutiveLosses = 3; }).v.rule, 'maxConsecutiveLosses');
});

test('per-trade risk limit trips on the largest single trade', () => {
  assert.strictEqual(atLimit((s) => { s.maxTradeRisk = 1000; }).v.rule, 'maxRiskPerTrade');
  assert.strictEqual(atLimit((s) => { s.maxTradeRisk = 999; }).v, null);
});

test('daily risk budget trips on cumulative risk', () => {
  assert.strictEqual(atLimit((s) => { s.riskUsed = 20000; }).v.rule, 'maxDailyRisk');
});

test('a zero limit disables that rule', () => {
  const off = Object.assign({}, S, {
    maxTradesPerDay: 0, maxDailyLoss: 0, profitTarget: 0,
    maxRiskPerTrade: 0, maxDailyRisk: 0, maxConsecutiveLosses: 0
  });
  const t0 = ist(2026, 10, 13, 10, 0);
  const st = R.syncSession(R.defaultState(t0), off, t0);
  st.session.trades = 999;
  st.session.pnl = -999999;
  st.session.riskUsed = 999999;
  st.session.consecutiveLosses = 99;
  assert.strictEqual(R.evaluate(st, off), null);
});

test('trade count wins over the other rules when several trip at once', () => {
  const t0 = ist(2026, 10, 13, 10, 0);
  const st = R.syncSession(R.defaultState(t0), S, t0);
  st.session.trades = 5;
  st.session.pnl = -9000;
  assert.strictEqual(R.tick(st, S, t0).violation.rule, 'maxTradesPerDay');
});

// --------------------------------------------------------------- tick ----

test('tick locks, then releases exactly at market open', () => {
  const t0 = ist(2026, 10, 13, 10, 0);
  const st = R.syncSession(R.defaultState(t0), S, t0);
  for (let i = 0; i < 5; i++) R.logTrade(st, S, { pnl: 10, risk: 100 }, t0 + i * MIN);

  const r1 = R.tick(st, S, t0 + 5 * MIN);
  assert.strictEqual(r1.changed, true);
  assert.strictEqual(st.lock.active, true);
  assert.strictEqual(st.lock.reason, 'maxTradesPerDay');
  assert.strictEqual(st.lock.until, ist(2026, 10, 14, 9, 15));

  // Still locked one millisecond before the open, released at it.
  assert.strictEqual(R.tick(st, S, st.lock.until - 1).state.lock.active, true);
  assert.strictEqual(R.tick(st, S, st.lock.until).state.lock.active, false);
});

test('tick is idempotent while locked', () => {
  const t0 = ist(2026, 10, 13, 10, 0);
  const st = R.syncSession(R.defaultState(t0), S, t0);
  st.session.trades = 5;
  R.tick(st, S, t0);
  const until = st.lock.until;
  for (let i = 0; i < 10; i++) R.tick(st, S, t0 + i * MIN);
  assert.strictEqual(st.lock.until, until);
  assert.strictEqual(st.lock.active, true);
});

test('a manual lock keeps its own label and survives a counter reset', () => {
  const t0 = ist(2026, 10, 13, 10, 0);
  const st = R.syncSession(R.defaultState(t0), S, t0);
  R.lockNow(st, S, t0);
  assert.strictEqual(st.lock.manual, true);
  assert.strictEqual(st.lock.reason, 'manual');
  R.tick(st, S, t0 + MIN);
  assert.strictEqual(st.lock.reason, 'manual');
  assert.strictEqual(st.lock.active, true);
});

test('releaseLock clears an active lock immediately', () => {
  const t0 = ist(2026, 10, 13, 10, 0);
  const st = R.syncSession(R.defaultState(t0), S, t0);
  R.lockNow(st, S, t0);
  R.releaseLock(st);
  assert.strictEqual(st.lock.active, false);
  assert.strictEqual(st.lock.until, null);
});

test('resetDay clears counters and the lock', () => {
  const t0 = ist(2026, 10, 13, 10, 0);
  const st = R.syncSession(R.defaultState(t0), S, t0);
  R.logTrade(st, S, { pnl: -9000, risk: 500 }, t0);
  R.tick(st, S, t0);
  const fresh = R.resetDay(st, S, t0);
  assert.strictEqual(fresh.session.trades, 0);
  assert.strictEqual(fresh.session.pnl, 0);
  assert.strictEqual(fresh.lock.active, false);
});

test('syncSession tolerates a missing or corrupt state object', () => {
  const t0 = ist(2026, 10, 13, 10, 0);
  const a = R.syncSession(null, S, t0);
  assert.strictEqual(a.session.trades, 0);
  const b = R.syncSession({ session: null, lock: null, log: 'nope' }, S, t0);
  assert.strictEqual(typeof b.session.trades, 'number');
  assert.ok(Array.isArray(b.log));
  assert.ok(b.lock && b.lock.active === false);
});

// ------------------------------------------------------------ helpers ----

test('inr formats with the Indian digit grouping and a minus sign for losses', () => {
  assert.strictEqual(R.inr(1234567.5), '\u20B912,34,567.50');
  assert.strictEqual(R.inr(-2500), '\u2212\u20B92,500.00');
  assert.strictEqual(R.inr(0), '\u20B90.00');
});

test('countdown renders h/m/s and never goes negative', () => {
  const now = ist(2026, 10, 13, 10, 0, 0);
  assert.strictEqual(R.countdown(now + (2 * 3600 + 5 * 60 + 9) * 1000, now), '2h 05m 09s');
  assert.strictEqual(R.countdown(now - 5000, now), '00m 00s');
});

test('progress clamps to [0,1] and is 0 when the limit is off', () => {
  assert.strictEqual(R.progress(2, 5), 0.4);
  assert.strictEqual(R.progress(9, 5), 1);
  assert.strictEqual(R.progress(9, 0), 0);
});

test('capital plan derives daily risk budget and per-trade risk', () => {
  const s = { totalCapital: 100000, dailyRiskPercent: 2, perTradeRiskPercent: 0.5 };
  assert.strictEqual(R.dailyRiskLimit(s), 2000);
  assert.strictEqual(R.plannedRiskPerTrade(s), 500);
  assert.strictEqual(R.dailyRiskLimit({ totalCapital: 0, dailyRiskPercent: 2 }), 0);
  assert.strictEqual(R.plannedRiskPerTrade({ maxRiskPerTrade: 750 }), 750);
});

test('capital risk rule locks when used risk reaches % of capital', () => {
  const plan = Object.assign({}, S, { totalCapital: 100000, dailyRiskPercent: 1 }); // ₹1,000 budget
  const t0 = ist(2026, 10, 13, 10, 0);
  const st = R.syncSession(R.defaultState(t0), plan, t0);
  R.logTrade(st, plan, { pnl: -300, risk: 600 }, t0);
  assert.strictEqual(R.evaluate(st, plan), null);
  R.logTrade(st, plan, { pnl: -200, risk: 500 }, t0 + MIN);
  assert.strictEqual(R.evaluate(st, plan).rule, 'dailyCapitalRisk');
});

test('a tripped rule does NOT lock while a trade is still open', () => {
  const t0 = ist(2026, 10, 13, 10, 0);
  const st = R.syncSession(R.defaultState(t0), S, t0);
  st.session.trades = 5; // limit tripped
  const r1 = R.tick(st, S, t0, { openTrades: 1 });
  assert.strictEqual(r1.deferred, true);
  assert.strictEqual(st.lock.active, false, 'screen must stay usable mid-trade');
  assert.strictEqual(st.pendingLock.rule, 'maxTradesPerDay');

  // Trade closes -> next tick locks immediately
  const r2 = R.tick(st, S, t0 + MIN, { openTrades: 0 });
  assert.strictEqual(r2.deferred, false);
  assert.strictEqual(st.lock.active, true);
  assert.strictEqual(st.lock.reason, 'maxTradesPerDay');
  assert.strictEqual(st.pendingLock, null);
});

test('session openTrades field also defers the lock', () => {
  const t0 = ist(2026, 10, 13, 10, 0);
  const st = R.syncSession(R.defaultState(t0), S, t0);
  st.session.trades = 5;
  st.session.openTrades = 2;
  assert.strictEqual(R.tick(st, S, t0).deferred, true);
  st.session.openTrades = 0;
  R.tick(st, S, t0);
  assert.strictEqual(st.lock.active, true);
});

test('maxDailyLoss does NOT lock while a trade is running; locks only when exited', () => {
  const t0 = ist(2026, 10, 13, 10, 0);
  const st = R.syncSession(R.defaultState(t0), S, t0);
  st.session.trades = 1;
  st.session.pnl = -5000; // maxDailyLoss limit reached (-5000)

  // 1. Running trade (openTrades = 1): screen MUST stay unlocked so trader can square off
  const r1 = R.tick(st, S, t0, { openTrades: 1 });
  assert.strictEqual(r1.deferred, true, 'must defer while trade is open');
  assert.strictEqual(st.lock.active, false, 'screen remains active');
  assert.strictEqual(st.pendingLock.rule, 'maxDailyLoss');

  // 2. Trade exits (openTrades = 0): next tick locks immediately
  const r2 = R.tick(st, S, t0 + MIN, { openTrades: 0 });
  assert.strictEqual(r2.deferred, false);
  assert.strictEqual(st.lock.active, true, 'locks after trade exits');
  assert.strictEqual(st.lock.reason, 'maxDailyLoss');
  assert.strictEqual(st.pendingLock, null);
});

test('summarizeLog computes Pro journal analytics', () => {
  const a = R.summarizeLog([
    { pnl: 1000, risk: 500, source: 'auto' },
    { pnl: -400, risk: 500, source: 'manual' },
    { pnl: 600, risk: 300, source: 'manual' },
    { pnl: 0, risk: 0, source: 'manual' }
  ]);
  assert.strictEqual(a.trades, 4);
  assert.strictEqual(a.wins, 2);
  assert.strictEqual(a.losses, 1);
  assert.strictEqual(a.winRate, 66.7);
  assert.strictEqual(a.grossProfit, 1600);
  assert.strictEqual(a.grossLoss, -400);
  assert.strictEqual(a.netPnl, 1200);
  assert.strictEqual(a.avgWin, 800);
  assert.strictEqual(a.avgLoss, -400);
  assert.strictEqual(a.largestWin, 1000);
  assert.strictEqual(a.largestLoss, -400);
  assert.strictEqual(a.totalRisk, 1300);
  assert.strictEqual(a.autoTrades, 1);
  assert.strictEqual(a.manualTrades, 3);
  assert.deepStrictEqual(R.summarizeLog(null).trades, 0);
});

test('isPro recognises valid, expired and bogus licenses', () => {
  const now = Date.now();
  assert.strictEqual(R.isPro({ key: 'TL-X', plan: 'pro_yearly', expiresAt: now + 1000 }, now), true);
  assert.strictEqual(R.isPro({ key: 'TL-X', plan: 'lifetime', expiresAt: null }, now), true);
  assert.strictEqual(R.isPro({ key: 'TL-X', plan: 'pro_yearly', expiresAt: now - 1 }, now), false);
  assert.strictEqual(R.isPro({ key: 'TL-X', plan: 'pro_yearly', active: false, expiresAt: now + 1000 }, now), false);
  assert.strictEqual(R.isPro({ key: 'TL-X', plan: 'pro_yearly', revoked: true, expiresAt: now + 1000 }, now), false);
  assert.strictEqual(R.isPro({ key: 'TL-X', plan: 'unknown_super_pro', expiresAt: now + 1000 }, now), false);
  assert.strictEqual(R.isPro({ plan: 'free' }, now), false);
  assert.strictEqual(R.isPro(null, now), false);
});

test('effectiveSettings gates Pro features when no valid license is present', () => {
  const now = Date.now();
  const base = Object.assign({}, S, { autoDetect: true, blockSiteWhenLocked: true });
  const free = R.effectiveSettings(base, null, now);
  assert.strictEqual(free.freeTier, true);
  assert.strictEqual(free.autoDetect, false);
  assert.strictEqual(free.maxDailyLoss, 0);
  assert.strictEqual(free.profitTarget, 0);
  assert.strictEqual(free.maxConsecutiveLosses, 0);
  assert.strictEqual(free.blockSiteWhenLocked, false);
  assert.strictEqual(free.maxTradesPerDay, 5, 'trade-count rule stays free');

  const pro = R.effectiveSettings(base, { key: 'K', plan: 'pro_monthly', expiresAt: now + 1000 }, now);
  assert.strictEqual(pro.autoDetect, true);
  assert.strictEqual(pro.maxDailyLoss, 5000);

  const bypassAttempt = R.effectiveSettings(Object.assign({}, base, { licenseRequired: false }), null, now);
  assert.strictEqual(bypassAttempt.freeTier, true, 'client cannot bypass licensing without valid license');
  assert.strictEqual(bypassAttempt.autoDetect, false);
});

test('istLabel names the weekday and IST time', () => {
  assert.strictEqual(R.istLabel(ist(2026, 10, 14, 9, 15)), 'Wed, 14 Oct \u00b7 09:15 IST');
});

test('calendarStatus detects stale exchange calendars and custom calendars', () => {
  const in2026 = ist(2026, 10, 14, 9, 15);
  const status2026 = R.calendarStatus(in2026, {});
  assert.strictEqual(status2026.stale, false);
  assert.strictEqual(status2026.source, 'builtin');
  assert.strictEqual(status2026.year, '2026');

  const in2027 = ist(2027, 2, 10, 9, 15);
  const status2027 = R.calendarStatus(in2027, {});
  assert.strictEqual(status2027.stale, true);
  assert.strictEqual(status2027.source, 'builtin');
  assert.match(status2027.message, /Built-in NSE holiday calendar covered up to 2026/);

  const customStatus = R.calendarStatus(in2027, { holidays: ['2027-01-26', '2027-03-23'] });
  assert.strictEqual(customStatus.stale, false);
  assert.strictEqual(customStatus.source, 'custom');
  assert.strictEqual(customStatus.count, 2);
});

test('resetDay preserves audit trail and increments resetCount', () => {
  const t0 = ist(2026, 10, 14, 10, 0);
  const s0 = R.defaultState(t0);
  s0.session.trades = 3;
  s0.session.pnl = -4500;
  s0.lock = { active: true, reason: 'loss_limit', since: t0 - 1000, until: t0 + 10000 };

  const resetState = R.resetDay(s0, S, t0 + 2000);
  assert.strictEqual(resetState.session.trades, 0);
  assert.strictEqual(resetState.session.pnl, 0);
  assert.strictEqual(resetState.lock.active, false);
  assert.strictEqual(resetState.resetCount, 1);
  assert.strictEqual(resetState.audit.length, 1);
  assert.strictEqual(resetState.audit[0].trades, 3);
  assert.strictEqual(resetState.audit[0].pnl, -4500);
  assert.strictEqual(resetState.audit[0].lockWasActive, true);
  assert.strictEqual(resetState.audit[0].lockReason, 'loss_limit');
});

test('safe lock mode is default in settings', () => {
  assert.strictEqual(R.DEFAULT_SETTINGS.blockSiteWhenLocked, false, 'hard block is off by default for safety');
  assert.strictEqual(R.DEFAULT_SETTINGS.enforcementMode, 'warning', 'Mode A (Warning Overlay) is the default for trading safety');
  assert.strictEqual(R.DEFAULT_SETTINGS.fullSiteAcknowledged, false, 'Full site restriction must not be active without acknowledgment');
  assert.strictEqual(R.DEFAULT_SETTINGS.maxTradesPerDay, 5);
});

test('state status machine advances from NORMAL to WARNING to REVIEW to LOCKED', () => {
  const t0 = ist(2026, 10, 14, 10, 0);
  const s0 = R.defaultState(t0);
  assert.strictEqual(s0.status, 'NORMAL');

  // Approaching limits triggers WARNING status
  s0.session.trades = 4; // 4 of 5 (80%)
  const tickWarn = R.tick(s0, { maxTradesPerDay: 5 }, t0 + 1000);
  assert.strictEqual(tickWarn.state.status, 'WARNING');

  // Violation with open trade triggers REVIEW status (pendingLock)
  s0.session.trades = 5;
  const tickReview = R.tick(s0, { maxTradesPerDay: 5 }, t0 + 2000, { openTrades: 1 });
  assert.strictEqual(tickReview.state.status, 'REVIEW');
  assert.strictEqual(tickReview.deferred, true);
  assert.strictEqual(tickReview.state.lock.active, false);

  // Once open trades close, transitions to LOCKED
  const tickLocked = R.tick(tickReview.state, { maxTradesPerDay: 5 }, t0 + 3000, { openTrades: 0 });
  assert.strictEqual(tickLocked.state.status, 'LOCKED');
  assert.strictEqual(tickLocked.state.lock.active, true);
  assert.strictEqual(tickLocked.state.lock.mode, 'warning');
});

test('resetDailyStats resets counters without clearing active lock or deleting log', () => {
  const t0 = ist(2026, 10, 14, 10, 0);
  const s0 = R.defaultState(t0);
  s0.session.trades = 4;
  s0.session.pnl = -3000;
  s0.lock = { active: true, reason: 'Loss limit hit', since: t0 - 500, until: t0 + 10000, manual: false };
  s0.log = [{ symbol: 'SBIN', pnl: -3000, risk: 500 }];

  const res = R.resetDailyStats(s0, t0);
  assert.strictEqual(res.session.trades, 0);
  assert.strictEqual(res.session.pnl, 0);
  assert.strictEqual(res.lock.active, true, 'Active rule lock must remain intact');
  assert.strictEqual(res.log.length, 1, 'Trade log journal must be preserved');
  assert.strictEqual(res.audit[0].action, 'STATS_RESET');
});

test('releaseManualLock releases focus locks but rejects rule-triggered financial locks', () => {
  const t0 = ist(2026, 10, 14, 10, 0);
  const sRule = R.defaultState(t0);
  sRule.lock = { active: true, reason: 'Daily loss limit reached', until: t0 + 20000, manual: false };

  const rejectRuleRelease = R.releaseManualLock(sRule, t0);
  assert.strictEqual(rejectRuleRelease.success, false);
  assert.strictEqual(rejectRuleRelease.reason, 'RULE_LOCK_PROTECTED');
  assert.strictEqual(sRule.lock.active, true, 'Rule lock must NOT be released');

  const sManual = R.defaultState(t0);
  sManual.lock = { active: true, reason: 'Manual lock triggered', until: t0 + 20000, manual: true };
  const acceptManualRelease = R.releaseManualLock(sManual, t0);
  assert.strictEqual(acceptManualRelease.success, true);
  assert.strictEqual(sManual.lock.active, false, 'Manual focus lock is successfully released');
});

test('emergencyOverrideLock requires exact confirmation phrase and records audit reason', () => {
  const t0 = ist(2026, 10, 14, 10, 0);
  const s = R.defaultState(t0);
  s.lock = { active: true, reason: 'Max trades hit', until: t0 + 20000, manual: false };

  // Fails with wrong code
  const failedCode = R.emergencyOverrideLock(s, 'WRONG_CODE', 'Valid reason explaining position exit', t0);
  assert.strictEqual(failedCode.success, false);
  assert.strictEqual(failedCode.reason, 'INVALID_CONFIRMATION');
  assert.strictEqual(s.lock.active, true);

  // Fails with empty or short reason (less than 10 chars)
  const failedReasonShort = R.emergencyOverrideLock(s, 'I_ACCEPT_THE_RISK', 'short', t0);
  assert.strictEqual(failedReasonShort.success, false);
  assert.strictEqual(failedReasonShort.reason, 'REASON_REQUIRED');
  assert.strictEqual(s.lock.active, true);

  const failedReason9 = R.emergencyOverrideLock(s, 'I_ACCEPT_THE_RISK', '123456789', t0);
  assert.strictEqual(failedReason9.success, false);
  assert.strictEqual(failedReason9.reason, 'REASON_REQUIRED');
  assert.strictEqual(s.lock.active, true);

  // Succeeds with exact confirmation code and documented reason (>= 10 chars)
  const okOverride = R.emergencyOverrideLock(s, 'I_ACCEPT_THE_RISK', 'Need to adjust hedge position', t0);
  assert.strictEqual(okOverride.success, true);
  assert.strictEqual(s.lock.active, false);
  assert.strictEqual(s.lock.emergencyOverridden, true);
  assert.strictEqual(s.audit.length, 1);
  assert.strictEqual(s.audit[0].action, 'EMERGENCY_LOCK_OVERRIDE');
  assert.strictEqual(s.audit[0].policy, 'ADMIN_EMERGENCY_EXCEPTION');
  assert.strictEqual(s.audit[0].justification, 'Need to adjust hedge position');
});

test('resetDay with preserveActiveRuleLock preserves active rule lock unless emergencyOverride is provided', () => {
  const t0 = ist(2026, 10, 14, 10, 0);
  const s = R.defaultState(t0);
  s.session.trades = 5;
  s.lock = { active: true, reason: 'Max trades cap', until: t0 + 3600000, manual: false };

  // UI daily reset flow with preserveActiveRuleLock
  const preserved = R.resetDay(s, S, t0, { preserveActiveRuleLock: true });
  assert.strictEqual(preserved.session.trades, 0);
  assert.strictEqual(preserved.lock.active, true, 'Active rule lock must be preserved');
  assert.strictEqual(preserved.lock.reason, 'Max trades cap');

  // Emergency override reset
  const cleared = R.resetDay(s, S, t0, { preserveActiveRuleLock: true, emergencyOverride: true });
  assert.strictEqual(cleared.lock.active, false, 'Emergency override clears rule lock');
});

