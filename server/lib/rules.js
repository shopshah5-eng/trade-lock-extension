/*
 * Trade Lock — core rules engine.
 *
 * Every function here is pure (no DOM, no chrome.* APIs) so the exact logic
 * that ships in the extension can be unit tested in Node.
 *
 * Time model: a "session" is one trading day and starts at marketOpenMin
 * minutes after midnight IST. All timestamps are UTC epoch ms.
 *
 * Exposed as `globalThis.TLRules` for content scripts, and via
 * module.exports for `node --test`.
 */
(function (root) {
  'use strict';

  var MIN = 60 * 1000;
  var DAY = 24 * 60 * MIN;
  var IST_OFFSET_MIN = 330; // UTC+5:30

  var DEFAULT_SETTINGS = {
    // ---- limits (0 or null = rule disabled) ----
    maxTradesPerDay: 5,        // hard cap on number of trades
    maxDailyLoss: 5000,        // realised P&L <= -maxDailyLoss  -> lock
    profitTarget: 3000,        // realised P&L >= +profitTarget  -> lock
    maxRiskPerTrade: 0,     // risk on any single trade       -> lock (off: see riskPerUnit)
    maxDailyRisk: 0,       // cumulative risk used today     -> lock (off: see riskPerUnit)
    maxConsecutiveLosses: 3,   // losing streak                  -> lock

    // ---- daily plan (capital based) ----
    totalCapital: 0,           // e.g. 100000
    dailyRiskPercent: 0,       // e.g. 2  -> daily risk budget = ₹2,000 on ₹1L
    perTradeRiskPercent: 0,    // e.g. 0.5 -> planned risk/trade = ₹500 on ₹1L

    // ---- session ----
    marketOpenMin: 555,        // 09:15 IST
    marketCloseMin: 930,       // 15:30 IST
    weekendPlanningMode: true, // Allow unrestricted planning, charts, and journal on weekends/holidays
    minLockMinutes: 15,        // never lock for less than this
    skipWeekends: true,
    skipHolidays: true,
    holidays: [],              // ["2026-10-02", ...]

    // ---- detection ----
    autoDetect: true,
    detectIntervalMs: 3000,
    countAutoTrades: true,     // feed auto-detected fills into trade count / P&L
    countAutoRisk: true,       // feed open-position notional into risk used
    riskPerUnit: 0,            // 0 = estimate risk as qty * price (notional)

    // ---- tamper resistance & enforcement mode ----
    reloadOnTamper: true,
    blockSiteWhenLocked: false, // hard block: redirect the site to a lock page (Mode C)
    enforcementMode: 'warning', // 'warning' (Mode A) | 'order_restrict' (Mode B) | 'full_site' (Mode C) | 'chart_only' (Mode D)
    fullSiteAcknowledged: false, // Mode C requires explicit informed risk acknowledgment

    // ---- licensing ----
    // Free tier unless a valid Pro license is stored: manual logging
    // and the trade-count rule only (see effectiveSettings).
    licenseApiBase: 'https://trade-lock-app.netlify.app',

    // ---- market intelligence (Pro+) ----
    marketEnabled: true,
    marketSymbol: 'NIFTY',       // NIFTY | BANKNIFTY | FINNIFTY
    marketSource: 'demo',        // demo | live (Fyers via license server)
    blockedHosts: [
      'kite.zerodha.com', 'upstox.com', 'web.angelone.in', 'angelone.in',
      'web.dhan.co', 'dhan.co', 'trade.5paisa.com', 'www.5paisa.com',
      'trade.fyers.in', 'fyers.in',
      'groww.in', 'trade.groww.in',
      'web.sahi.com', 'sahi.com',
      'shoonya.finvasia.com', 'shoonya.com', 'finvasia.com',
      'kotakneo.com', 'trade.kotaksecurities.com', 'kotaksecurities.com',
      'paytmmoney.com', 'icicidirect.com', 'breeze.icicidirect.com',
      'hdfcsky.com', 'aliceblueonline.com', 'ant.aliceblueonline.com',
      'sharekhan.com', 'myespresso.com', 'motilaloswal.com'
    ]
  };

  var NSE_HOLIDAYS = {
    2025: ['2025-02-26', '2025-03-14', '2025-03-31', '2025-04-10', '2025-04-14',
           '2025-04-18', '2025-05-01', '2025-08-15', '2025-08-27', '2025-10-02',
           '2025-10-21', '2025-10-22', '2025-11-05', '2025-12-25'],
    2026: ['2026-01-26', '2026-03-03', '2026-03-26', '2026-03-31', '2026-04-03',
           '2026-04-14', '2026-05-01', '2026-05-28', '2026-06-26', '2026-09-14',
           '2026-10-02', '2026-10-20', '2026-11-10', '2026-11-24', '2026-12-25']
  };

  // ---------------------------------------------------------------- time ----

  function addMinutes(ms, minutes) { return ms + minutes * MIN; }

  /** Midnight IST of the IST calendar day containing `ms`, as a UTC epoch ms. */
  function istMidnightUTC(ms) {
    return Math.floor((ms + IST_OFFSET_MIN * MIN) / DAY) * DAY - IST_OFFSET_MIN * MIN;
  }

  function istDate(ms) {
    var shifted = new Date(ms + IST_OFFSET_MIN * MIN);
    var y = shifted.getUTCFullYear();
    var m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
    var d = String(shifted.getUTCDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  }

  function istWeekday(ms) { // 0=Sun .. 6=Sat, in IST
    return new Date(ms + IST_OFFSET_MIN * MIN).getUTCDay();
  }

  /** Minutes since IST midnight (0..1439). Shift by the offset *before* the
   *  modulo, otherwise IST midnight itself comes out as 1440. */
  function istMinutesOfDay(ms) {
    return Math.floor(((ms + IST_OFFSET_MIN * MIN) % DAY) / MIN);
  }

  /** UTC epoch ms of `hhmm` minutes after midnight IST on the IST date of `ms`. */
  function istAtMinutes(ms, hhmm) {
    return istMidnightUTC(ms) + hhmm * MIN;
  }

  function isHoliday(ms, settings) {
    if (!settings || settings.skipHolidays === false) return false;
    var list = (settings.holidays && settings.holidays.length)
      ? settings.holidays
      : (NSE_HOLIDAYS[istDate(ms).slice(0, 4)] || []);
    return list.indexOf(istDate(ms)) !== -1;
  }

  function isClosedDay(ms, settings) {
    var w = istWeekday(ms);
    if (settings && settings.skipWeekends !== false && (w === 0 || w === 6)) return true;
    return isHoliday(ms, settings);
  }

  function isTradingDay(ms, settings) { return !isClosedDay(ms, settings); }

  function isMarketOpenHours(ms, settings) {
    var s = settings || {};
    if (isClosedDay(ms, s)) return false;
    var mins = istMinutesOfDay(ms);
    var openMin = typeof s.marketOpenMin === 'number' ? s.marketOpenMin : DEFAULT_SETTINGS.marketOpenMin;
    var closeMin = typeof s.marketCloseMin === 'number' ? s.marketCloseMin : (DEFAULT_SETTINGS.marketCloseMin || 930);
    return mins >= openMin && mins < closeMin;
  }

  function isPlanningSession(ms, settings) {
    return !isMarketOpenHours(ms, settings);
  }

  function marketSessionInfo(ms, settings) {
    var s = settings || {};
    var t = ms || Date.now();
    var closed = isClosedDay(t, s);
    var inHours = isMarketOpenHours(t, s);
    var nextOpen = nextMarketOpen(t, s);
    var w = istWeekday(t);
    var isWeekend = (w === 0 || w === 6);
    var reason = inHours ? 'MARKET_OPEN' : (closed ? (isWeekend ? 'WEEKEND' : 'EXCHANGE_HOLIDAY') : 'POST_MARKET');
    return {
      isTradingDay: !closed,
      isMarketOpen: inHours,
      isOpen: inHours,
      isPlanningMode: !inHours,
      planningMode: !inHours,
      isWeekend: isWeekend,
      sessionType: reason,
      nextSessionOpen: nextOpen,
      nextSessionLabel: istLabel(nextOpen),
      message: !inHours
        ? ('📅 Planning Mode (' + (isWeekend ? 'Weekend' : 'Holiday') + ') — Markets closed until ' + istLabel(nextOpen) + '. Full access to Journal, Charts, Options and AI tools is open.')
        : 'Active Trading Session'
    };
  }

  /**
   * Next market open strictly after `from` (UTC epoch ms), skipping weekends
   * and holidays. Always returns a value >= from.
   */
  function nextMarketOpen(from, settings) {
    var s = settings || {};
    var openMin = typeof s.marketOpenMin === 'number' ? s.marketOpenMin : DEFAULT_SETTINGS.marketOpenMin;
    var candidate = istAtMinutes(from, openMin);
    if (candidate <= from) candidate += DAY;
    var guard = 0;
    while (isClosedDay(candidate, s) && guard < 400) { candidate += DAY; guard++; }
    return candidate;
  }

  /**
   * Start of the trading session that `now` belongs to. Always an actual
   * trading day: on a weekend or exchange holiday the session is still the
   * last real one, so counters do not silently reset on a closed day.
   */
  function sessionStart(now, settings) {
    var s = settings || {};
    var openMin = typeof s.marketOpenMin === 'number' ? s.marketOpenMin : DEFAULT_SETTINGS.marketOpenMin;
    var candidate = istAtMinutes(now, openMin);
    if (now < candidate) candidate -= DAY;
    var guard = 0;
    while (isClosedDay(candidate, s) && guard < 400) { candidate -= DAY; guard++; }
    return candidate;
  }

  // -------------------------------------------------------------- state ----

  function newSession(startMs) {
    return {
      start: startMs,
      date: istDate(startMs),
      trades: 0,          // manual + auto counted fills
      autoTrades: 0,      // of which auto-detected
      pnl: 0,             // realised P&L (₹)
      riskUsed: 0,        // cumulative risk committed today (₹)
      consecutiveLosses: 0,
      maxTradeRisk: 0,
      openTrades: 0,          // trades currently open (from positions/net fills)
      lastTradeAt: null
    };
  }

  function defaultState(now) {
    var t = now || Date.now();
    return {
      version: 2,
      status: 'NORMAL',
      statusTimestamp: t,
      statusReason: null,
      session: newSession(sessionStart(t, null)),
      lock: { active: false, reason: null, since: null, until: null, manual: false, mode: 'warning' },
      pendingLock: null,  // rule tripped but a trade is still open -> lock on exit
      enforcement: { status: 'IDLE', error: null, mode: 'warning' },
      detectorSeen: {},   // order signature -> true, so a fill is counted once
      log: [],
      journal: { version: 2, months: {} },
      tamperCount: 0,
      resetCount: 0,
      audit: []
    };
  }

  /** Rolls the counters over when the session date changes. Never returns null. */
  function syncSession(state, settings, now) {
    var t = now || Date.now();
    if (!state || typeof state !== 'object') return defaultState(t);
    if (!state.version) state.version = 2;
    if (!state.status) state.status = 'NORMAL';
    if (!state.session) state.session = newSession(sessionStart(t, settings));
    if (!state.lock) state.lock = defaultState(t).lock;
    if (!state.detectorSeen) state.detectorSeen = {};
    if (!('pendingLock' in state)) state.pendingLock = null;
    if (!('enforcement' in state)) state.enforcement = { status: 'IDLE', error: null, mode: 'warning' };
    if (!Array.isArray(state.log)) state.log = [];
    if (!Array.isArray(state.audit)) state.audit = [];
    if (!state.journal || typeof state.journal !== 'object' || !state.journal.months) {
      state.journal = { version: 2, months: {} };
    }
    var start = sessionStart(t, settings);
    if (state.session.start !== start) {
      if (state.session.date && state.log.length > 0) {
        archiveDayToJournal(state.journal, state.session.date, state.log, state.session);
      }
      state.session = newSession(start);
      state.detectorSeen = {};
      // Do NOT clear an active risk rule lock merely because date rolled over!
      // Only clear if the unlock condition (lock.until) has actually been reached.
      var until = Number(state.lock && state.lock.until);
      if (state.lock && state.lock.active && (isNaN(until) || until <= 0 || t < until)) {
        state.status = 'LOCKED';
        if (isNaN(until) || until <= 0) {
          state.lock.until = nextMarketOpen(t, settings);
        }
      } else {
        state.status = 'NORMAL';
        state.statusTimestamp = t;
        state.statusReason = null;
        if (state.lock && state.lock.active && t >= until) {
          state.lock = { active: false, reason: null, since: null, until: null, manual: false, mode: (settings && settings.enforcementMode) || 'warning' };
        }
      }
    }
    return state;
  }

  // --------------------------------------------------------- evaluation ----

  function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

  /** Daily risk budget in ₹ derived from the capital plan (0 = plan off). */
  function dailyRiskLimit(settings) {
    var s = settings || {};
    var cap = Number(s.totalCapital) || 0;
    var pct = Number(s.dailyRiskPercent) || 0;
    return cap > 0 && pct > 0 ? Math.round(cap * pct) / 100 : 0;
  }

  /** Planned risk for one trade in ₹ (capital % first, else the fixed limit). */
  function plannedRiskPerTrade(settings) {
    var s = settings || {};
    var cap = Number(s.totalCapital) || 0;
    var pct = Number(s.perTradeRiskPercent) || 0;
    if (cap > 0 && pct > 0) return Math.round(cap * pct) / 100;
    return Number(s.maxRiskPerTrade) || 0;
  }

  /** Returns the first violated rule, or null. */
  function evaluate(state, settings) {
    var s = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    var sess = state.session || newSession(Date.now());

    var num = function (v) { v = Number(v); return isFinite(v) ? v : 0; };
    var on = function (v) { return num(v) > 0; };

    if (on(s.maxTradesPerDay) && sess.trades >= s.maxTradesPerDay) {
      return {
        rule: 'maxTradesPerDay',
        title: 'Daily trade limit reached',
        detail: sess.trades + ' of ' + s.maxTradesPerDay + ' trades used today. Stop here — the screen stays locked until the next market open.'
      };
    }
    if (on(s.maxDailyLoss) && sess.pnl <= -s.maxDailyLoss) {
      return {
        rule: 'maxDailyLoss',
        title: 'Daily loss limit hit',
        detail: 'Realised P&L is ' + inr(sess.pnl) + ' against a limit of ' + inr(s.maxDailyLoss) + '.'
      };
    }
    if (on(s.profitTarget) && sess.pnl >= s.profitTarget) {
      return {
        rule: 'profitTarget',
        title: 'Profit target hit — take the win',
        detail: 'Realised P&L is ' + inr(sess.pnl) + ', at or above your ' + inr(s.profitTarget) + ' target.'
      };
    }
    if (on(s.maxConsecutiveLosses) && sess.consecutiveLosses >= s.maxConsecutiveLosses) {
      return {
        rule: 'maxConsecutiveLosses',
        title: 'Losing streak limit hit',
        detail: sess.consecutiveLosses + ' losses in a row (limit ' + s.maxConsecutiveLosses + ').'
      };
    }
    if (on(s.maxRiskPerTrade) && sess.maxTradeRisk >= s.maxRiskPerTrade) {
      return {
        rule: 'maxRiskPerTrade',
        title: 'Per-trade risk limit exceeded',
        detail: 'A single trade carried ' + inr(sess.maxTradeRisk) + ' of risk against a ' + inr(s.maxRiskPerTrade) + ' limit.'
      };
    }
    var capRisk = dailyRiskLimit(s);
    if (capRisk > 0 && sess.riskUsed >= capRisk) {
      return {
        rule: 'dailyCapitalRisk',
        title: 'Daily capital risk used up',
        detail: 'Risk used ' + inr(sess.riskUsed) + ' of ' + inr(capRisk) +
          ' (' + s.dailyRiskPercent + '% of ' + inr(s.totalCapital) + ' capital).'
      };
    }
    if (on(s.maxDailyRisk) && sess.riskUsed >= s.maxDailyRisk) {
      return {
        rule: 'maxDailyRisk',
        title: 'Daily risk budget used up',
        detail: inr(sess.riskUsed) + ' of risk committed today against a ' + inr(s.maxDailyRisk) + ' budget.'
      };
    }
    return null;
  }

  /**
   * Advances lock state. Idempotent: safe to call on every tick.
   * Returns { state, changed, violation }.
   */
  function tick(state, settings, now, opts) {
    var s = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    var t = now || Date.now();
    var changed = false;

    syncSession(state, s, t);

    if (state.lock.active) {
      var until = Number(state.lock.until);
      // Malformed, NaN, missing, or non-positive until timestamp must NEVER release the lock!
      if (isNaN(until) || until <= 0) {
        var repairedUntil = nextMarketOpen(t, s);
        var floor = t + Math.max(0, s.minLockMinutes) * MIN;
        if (repairedUntil < floor) repairedUntil = floor;
        state.lock.until = repairedUntil;
        until = repairedUntil;
        changed = true;
      }
      if (t >= until) {
        state.lock = { active: false, reason: null, since: null, until: null, manual: false, mode: s.enforcementMode || 'warning' };
        state.status = 'NORMAL';
        state.statusTimestamp = t;
        state.statusReason = null;
        changed = true;
      } else {
        state.status = 'LOCKED';
        state.statusTimestamp = state.lock.since || t;
        state.statusReason = state.lock.reason;
        // Keep the displayed reason fresh (manual locks keep their own label).
        if (!state.lock.manual) {
          var fresh = evaluate(state, s);
          if (fresh && fresh.rule !== state.lock.reason) { state.lock.reason = fresh.rule; changed = true; }
        }
      }
      return { state: state, changed: changed, violation: evaluate(state, s) };
    }

    var v = evaluate(state, s);
    if (v) {
      // Never freeze a running trade: if something is still open, remember the
      // pending lock and apply it the moment the last trade closes.
      var open = (opts && typeof opts.openTrades === 'number')
        ? opts.openTrades : (state.session.openTrades || 0);
      if (open > 0) {
        if (!state.pendingLock || state.pendingLock.rule !== v.rule) {
          state.pendingLock = { rule: v.rule, title: v.title, at: t, openTrades: open };
          changed = true;
        } else {
          state.pendingLock.openTrades = open;
        }
        state.status = 'REVIEW';
        state.statusTimestamp = t;
        state.statusReason = 'open_trades_deferral: ' + v.rule;
        return { state: state, changed: changed, violation: v, deferred: true };
      }
      if (state.pendingLock) { state.pendingLock = null; changed = true; }
      var until = nextMarketOpen(t, s);
      var floor = t + Math.max(0, s.minLockMinutes) * MIN;
      if (until < floor) until = floor;
      state.lock = {
        active: true,
        reason: v.rule,
        since: t,
        until: until,
        manual: false,
        mode: s.enforcementMode || 'warning'
      };
      state.status = 'LOCKED';
      state.statusTimestamp = t;
      state.statusReason = v.rule;
      changed = true;
    } else {
      var sess = state.session || {};
      var isWarning = false;
      var warnReason = null;
      if (s.maxTradesPerDay && sess.trades >= s.maxTradesPerDay * 0.8) {
        isWarning = true; warnReason = 'approaching_trade_limit';
      } else if (s.maxDailyLoss && sess.pnl <= -s.maxDailyLoss * 0.8) {
        isWarning = true; warnReason = 'approaching_loss_limit';
      } else if (s.maxConsecutiveLosses && sess.consecutiveLosses >= s.maxConsecutiveLosses - 1) {
        isWarning = true; warnReason = 'consecutive_loss_streak';
      }
      var newStatus = isWarning ? 'WARNING' : 'NORMAL';
      if (state.status !== newStatus && state.status !== 'RESET_PENDING') {
        state.status = newStatus;
        state.statusTimestamp = t;
        state.statusReason = warnReason;
        changed = true;
      }
    }
    return { state: state, changed: changed, violation: v, deferred: false };
  }

  /**
   * Records one closed trade. `pnl` is realised P&L in ₹ (negative = loss),
   * `risk` is the risk committed on that trade in ₹.
   */
  function logTrade(state, settings, entry, now) {
    var t = now || Date.now();
    syncSession(state, settings, t);
    var pnl = round2(entry.pnl);
    var risk = Math.max(0, round2(entry.risk));
    var sess = state.session;

    sess.trades += 1;
    sess.pnl = round2(sess.pnl + pnl);
    sess.riskUsed = round2(sess.riskUsed + risk);
    sess.maxTradeRisk = Math.max(sess.maxTradeRisk, risk);
    sess.lastTradeAt = t;
    if (pnl < 0) sess.consecutiveLosses += 1; else if (pnl > 0) sess.consecutiveLosses = 0;

    var trId = entry.id || ('tl_' + t + '_' + Math.random().toString(36).substr(2, 6));
    var ch = Number(entry.charges) || 0;
    var net = entry.netPnl !== undefined ? round2(entry.netPnl) : round2(pnl - ch);
    var trObj = {
      id: trId,
      at: t,
      symbol: entry.symbol || 'INDEX',
      side: entry.side || 'BUY',
      direction: entry.direction || (entry.side === 'SELL' ? 'SHORT' : 'LONG'),
      qty: Number(entry.qty) || 1,
      entry: Number(entry.entry) || 0,
      exit: Number(entry.exit) || 0,
      pnl: pnl,
      charges: ch,
      netPnl: net,
      risk: risk,
      setup: entry.setup || '',
      notes: entry.notes || '',
      adherence: entry.adherence || 'COMPLIANT',
      source: entry.source || 'manual',
      provenance: entry.provenance || (entry.source === 'auto' ? 'broker-imported' : 'manual')
    };

    state.log.push(trObj);
    if (state.log.length > 500) state.log = state.log.slice(-500);
    if (!state.journal) state.journal = { version: 2, months: {} };
    archiveDayToJournal(state.journal, state.session.date, state.log, state.session);
    return state;
  }

  function lockNow(state, settings, now, opts) {
    var s = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    var t = now || Date.now();
    syncSession(state, s, t);
    // CRITICAL SECURITY: Never allow manual lock to overwrite an active rule-triggered lock!
    if (state.lock && state.lock.active && !state.lock.manual) {
      return state;
    }
    var nextOpen = nextMarketOpen(t, s);
    var durationMin = (opts && typeof opts.durationMinutes === 'number' && opts.durationMinutes > 0)
      ? opts.durationMinutes : null;
    var until = durationMin ? (t + durationMin * MIN) : nextOpen;
    var floor = t + Math.max(0, s.minLockMinutes) * MIN;
    if (until < floor) until = floor;
    var closed = isClosedDay(t, s);
    var defaultReason = closed ? 'Manual focus lock (Weekend/Holiday)' : 'manual';
    var reason = (opts && (opts.reason || opts.weekendMode)) || defaultReason;
    state.lock = {
      active: true,
      reason: reason,
      since: t,
      until: until,
      manual: true,
      mode: s.enforcementMode || 'warning',
      nextSessionOpen: nextOpen,
      planningPermitted: true,
      weekendPlanningAllowed: true
    };
    state.status = 'LOCKED';
    state.statusTimestamp = t;
    state.statusReason = reason;
    return state;
  }

  function releaseLock(state) {
    state.lock = { active: false, reason: null, since: null, until: null, manual: false, mode: 'warning' };
    state.status = 'NORMAL';
    state.statusTimestamp = Date.now();
    state.statusReason = null;
    return state;
  }

  function undoLastTrade(state) {
    if (!state || !Array.isArray(state.log) || state.log.length === 0) return null;
    if (state.lock && state.lock.active && !state.lock.manual) {
      return { rejected: true, reason: 'RULE_LOCK_ACTIVE', message: 'Discipline lock is active. Trade counts and losses cannot be reversed while locked.' };
    }
    var last = state.log[state.log.length - 1];
    // Safeguard verified broker executions: cannot be erased via manual undo
    if (last && (last.source === 'auto' || last.provenance === 'broker-imported')) {
      return { rejected: true, reason: 'BROKER_EXECUTION_PROTECTED', message: 'Verified broker orders cannot be erased.' };
    }
    var e = state.log.pop();
    var s = state.session;
    s.trades = Math.max(0, s.trades - 1);
    s.pnl = round2(s.pnl - e.pnl);
    s.riskUsed = Math.max(0, round2(s.riskUsed - e.risk));
    if (e.pnl < 0) s.consecutiveLosses = Math.max(0, s.consecutiveLosses - 1);
    var maxRisk = 0;
    state.log.forEach(function (x) { if ((x.risk || 0) > maxRisk) maxRisk = x.risk; });
    s.maxTradeRisk = maxRisk;
    if (!state.journal) state.journal = { version: 2, months: {} };
    archiveDayToJournal(state.journal, state.session.date, state.log, state.session);
    return e;
  }

  function resetDailyStats(state, now) {
    if (!state) return state;
    var t = now || Date.now();
    if (state.session) {
      state.session.trades = 0;
      state.session.pnl = 0;
      state.session.riskUsed = 0;
      state.session.consecutiveLosses = 0;
    }
    state.audit = (state.audit || []).concat([{
      action: 'STATS_RESET',
      resetAt: t,
      lockWasActive: !!(state.lock && state.lock.active),
      lockReason: (state.lock && state.lock.reason) || null
    }]).slice(-50);
    return state;
  }

  function releaseManualLock(state, now) {
    if (!state || !state.lock || !state.lock.active) {
      return { success: false, reason: 'NO_ACTIVE_LOCK', message: 'No active lock to release.' };
    }
    if (!state.lock.manual) {
      return {
        success: false,
        reason: 'RULE_LOCK_PROTECTED',
        message: 'Rule-triggered locks (loss limit, max trades) cannot be released early. Active until ' +
                 (state.lock.until ? istLabel(state.lock.until) : 'next market open') + '.'
      };
    }
    var t = now || Date.now();
    state.lock = { active: false, reason: null, since: null, until: null, manual: false };
    state.status = 'NORMAL';
    state.statusReason = null;
    state.audit = (state.audit || []).concat([{
      action: 'MANUAL_LOCK_RELEASED',
      releasedAt: t
    }]).slice(-50);
    return { success: true, message: 'Focus lock released.' };
  }

  function emergencyOverrideLock(state, confirmationCode, reason, now) {
    if (!state || !state.lock || !state.lock.active) {
      return { success: false, reason: 'NO_ACTIVE_LOCK' };
    }
    if (String(confirmationCode || '').trim() !== 'I_ACCEPT_THE_RISK') {
      return {
        success: false,
        reason: 'INVALID_CONFIRMATION',
        message: 'Must provide exact confirmation phrase: I_ACCEPT_THE_RISK'
      };
    }
    if (!reason || String(reason).trim().length < 10) {
      return {
        success: false,
        reason: 'REASON_REQUIRED',
        message: 'A documented justification reason (minimum 10 characters) is required for emergency override.'
      };
    }
    var t = now || Date.now();
    var prevReason = state.lock.reason;
    var durationActive = t - (state.lock.since || t);
    state.lock = {
      active: false,
      reason: null,
      since: null,
      until: null,
      manual: false,
      emergencyOverridden: true,
      overriddenAt: t
    };
    state.status = 'NORMAL';
    state.statusReason = null;
    state.audit = (state.audit || []).concat([{
      action: 'EMERGENCY_LOCK_OVERRIDE',
      overriddenAt: t,
      previousLockReason: prevReason,
      durationActiveMs: durationActive,
      justification: String(reason).trim(),
      policy: 'ADMIN_EMERGENCY_EXCEPTION'
    }]).slice(-50);
    return { success: true, message: 'Emergency lock override applied and logged.' };
  }

  function resetDay(state, settings, now, opts) {
    var t = now || Date.now();
    opts = opts || {};
    var fresh = defaultState(t);
    fresh.session = newSession(sessionStart(t, settings));
    if (state) {
      var prevAudit = Array.isArray(state.audit) ? state.audit : [];
      var isRuleLockActive = !!(state.lock && state.lock.active && !state.lock.manual && state.lock.until > t);

      // When preserveActiveRuleLock is requested (standard in UI flows), rule-triggered locks remain active
      if (opts.preserveActiveRuleLock && isRuleLockActive && !opts.emergencyOverride) {
        fresh.lock = Object.assign({}, state.lock);
        fresh.status = 'LOCKED';
        fresh.statusReason = state.statusReason || state.lock.reason;
      }

      var resetEvent = {
        resetAt: t,
        previousDate: (state.session && state.session.date) || null,
        trades: (state.session && state.session.trades) || 0,
        pnl: (state.session && state.session.pnl) || 0,
        lockWasActive: !!(state.lock && state.lock.active),
        lockReason: (state.lock && state.lock.reason) || null,
        lockPreserved: !!(opts.preserveActiveRuleLock && isRuleLockActive && !opts.emergencyOverride),
        action: opts.emergencyOverride ? 'EMERGENCY_RESET' : 'SESSION_RESET'
      };
      fresh.audit = prevAudit.concat([resetEvent]).slice(-50);
      fresh.resetCount = (state.resetCount || 0) + 1;
      fresh.journal = state.journal ? JSON.parse(JSON.stringify(state.journal)) : { version: 2, months: {} };
      if (state.session && state.session.date && Array.isArray(state.log) && state.log.length > 0) {
        archiveDayToJournal(fresh.journal, state.session.date, state.log, state.session);
      }
      fresh.log = Array.isArray(state.log) ? state.log.slice() : [];
    }
    return fresh;
  }

  function calendarStatus(ms, settings) {
    var s = settings || {};
    if (s.holidays && s.holidays.length) {
      return { stale: false, source: 'custom', count: s.holidays.length };
    }
    var year = istDate(ms || Date.now()).slice(0, 4);
    var list = NSE_HOLIDAYS[year];
    if (!list || !list.length) {
      return {
        stale: true,
        source: 'builtin',
        year: year,
        message: 'Built-in NSE holiday calendar covered up to 2026. Custom holiday calendar recommended in Settings.'
      };
    }
    return { stale: false, source: 'builtin', year: year, count: list.length };
  }

  // ------------------------------------------------------- journal stats ----

  /**
   * Summarises today's logged trades (manual + auto-detected).
   * Pro feature in the UI, but kept here as a pure function for testing.
   */
  function summarizeLog(log) {
    var rows = Array.isArray(log) ? log : [];
    var out = {
      trades: rows.length, wins: 0, losses: 0, breakeven: 0,
      grossProfit: 0, grossLoss: 0, netPnl: 0, totalRisk: 0,
      winRate: 0, avgWin: 0, avgLoss: 0, largestWin: 0, largestLoss: 0,
      autoTrades: 0, manualTrades: 0
    };
    rows.forEach(function (e) {
      var pnl = Number(e.pnl) || 0;
      out.netPnl = round2(out.netPnl + pnl);
      out.totalRisk = round2(out.totalRisk + Math.max(0, Number(e.risk) || 0));
      if (e.source === 'auto') out.autoTrades++; else out.manualTrades++;
      if (pnl > 0) {
        out.wins++; out.grossProfit = round2(out.grossProfit + pnl);
        out.largestWin = Math.max(out.largestWin, pnl);
      } else if (pnl < 0) {
        out.losses++; out.grossLoss = round2(out.grossLoss + pnl);
        out.largestLoss = Math.min(out.largestLoss, pnl);
      } else out.breakeven++;
    });
    var decided = out.wins + out.losses;
    out.winRate = decided ? Math.round((out.wins / decided) * 1000) / 10 : 0;
    out.avgWin = out.wins ? round2(out.grossProfit / out.wins) : 0;
    out.avgLoss = out.losses ? round2(out.grossLoss / out.losses) : 0;
    out.grossProfit = round2(out.grossProfit);
    out.grossLoss = round2(out.grossLoss);
    return out;
  }

  // --------------------------------------------- monthly journal & export ----

  function formatCsvCell(v) {
    if (v == null) return '';
    var s = String(v);
    // Protect against spreadsheet formula injection (CSV injection)
    if (/^[=+\-@\t\r]/.test(s)) {
      s = "'" + s;
    }
    if (/[",\n\r]/.test(s)) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  function istMonthKey(ms) {
    return istDate(ms || Date.now()).slice(0, 7);
  }

  function calculateDaySummary(trades) {
    var rows = Array.isArray(trades) ? trades : [];
    var out = {
      trades: rows.length, totalTrades: rows.length, wins: 0, losses: 0, breakeven: 0,
      grossProfit: 0, grossLoss: 0, grossPnl: 0, netPnl: 0, totalRisk: 0, charges: 0,
      winRate: 0, avgWin: 0, avgLoss: 0, largestWin: 0, largestLoss: 0,
      profitFactor: 0, ruleViolations: 0, autoTrades: 0, manualTrades: 0,
      brokerVerifiedCount: 0, manualCount: 0
    };
    rows.forEach(function (e) {
      var pnl = Number(e.pnl) || 0;
      var ch = Number(e.charges) || 0;
      var net = e.netPnl !== undefined ? Number(e.netPnl) : (pnl - ch);
      out.netPnl = round2(out.netPnl + net);
      out.charges = round2(out.charges + ch);
      out.totalRisk = round2(out.totalRisk + Math.max(0, Number(e.risk) || 0));
      var isBroker = (e.provenance || '').indexOf('broker') !== -1 || e.source === 'auto';
      if (isBroker) {
        out.autoTrades++;
        out.brokerVerifiedCount++;
      } else {
        out.manualTrades++;
        out.manualCount++;
      }
      if (e.adherence === 'VIOLATION') out.ruleViolations++;
      if (net > 0) {
        out.wins++;
      } else if (net < 0) {
        out.losses++;
      } else {
        out.breakeven++;
      }
      if (pnl > 0) {
        out.grossProfit = round2(out.grossProfit + pnl);
        out.largestWin = Math.max(out.largestWin, pnl);
      } else if (pnl < 0) {
        out.grossLoss = round2(out.grossLoss + pnl);
        out.largestLoss = Math.min(out.largestLoss, pnl);
      }
    });
    out.grossPnl = round2(out.grossProfit + out.grossLoss);
    var decided = out.wins + out.losses;
    out.winRate = decided ? Math.round((out.wins / decided) * 1000) / 10 : 0;
    out.avgWin = out.wins ? round2(out.grossProfit / out.wins) : 0;
    out.avgLoss = out.losses ? round2(out.grossLoss / out.losses) : 0;
    out.profitFactor = out.grossLoss < 0 ? round2(out.grossProfit / Math.abs(out.grossLoss)) : (out.grossProfit > 0 ? 999 : 0);
    return out;
  }

  function calculateMonthSummary(daysObj) {
    var days = daysObj || {};
    var dates = Object.keys(days).sort();
    var out = {
      totalTrades: 0, wins: 0, losses: 0, breakeven: 0,
      winRate: 0, grossPnl: 0, netPnl: 0, charges: 0, totalRisk: 0,
      avgWin: 0, avgLoss: 0, profitFactor: 0, ruleViolations: 0,
      bestDay: null, worstDay: null, tradingDaysCount: dates.length
    };
    var grossWin = 0, grossLoss = 0;
    dates.forEach(function (dateStr) {
      var d = days[dateStr];
      var s = d.summary || calculateDaySummary(d.trades || []);
      out.totalTrades += s.trades || s.totalTrades || 0;
      out.wins += s.wins || 0;
      out.losses += s.losses || 0;
      out.breakeven += s.breakeven || 0;
      grossWin += (s.grossProfit || 0);
      grossLoss += (s.grossLoss || 0);
      out.netPnl = round2(out.netPnl + (s.netPnl || 0));
      out.charges = round2(out.charges + (s.charges || 0));
      out.totalRisk = round2(out.totalRisk + (s.totalRisk || 0));
      out.ruleViolations += (s.ruleViolations || 0);

      var dayNetPnl = round2(s.netPnl || 0);
      if (!out.bestDay || dayNetPnl > (out.bestDay.netPnl !== undefined ? out.bestDay.netPnl : out.bestDay.pnl)) {
        out.bestDay = { date: dateStr, pnl: dayNetPnl, netPnl: dayNetPnl };
      }
      if (!out.worstDay || dayNetPnl < (out.worstDay.netPnl !== undefined ? out.worstDay.netPnl : out.worstDay.pnl)) {
        out.worstDay = { date: dateStr, pnl: dayNetPnl, netPnl: dayNetPnl };
      }
    });

    out.grossPnl = round2(grossWin + grossLoss);
    var decided = out.wins + out.losses;
    out.winRate = decided ? Math.round((out.wins / decided) * 1000) / 10 : 0;
    out.avgWin = out.wins ? round2(grossWin / out.wins) : 0;
    out.avgLoss = out.losses ? round2(grossLoss / out.losses) : 0;
    out.profitFactor = grossLoss < 0 ? round2(grossWin / Math.abs(grossLoss)) : (grossWin > 0 ? 999 : 0);
    return out;
  }

  function archiveDayToJournal(journal, dateStr, trades, sessionInfo) {
    if (!journal || typeof journal !== 'object') journal = { months: {} };
    if (!journal.months) journal.months = {};
    var monthKey = String(dateStr || '').slice(0, 7) || istMonthKey();
    if (!journal.months[monthKey]) {
      journal.months[monthKey] = { monthKey: monthKey, summary: null, days: {} };
    }
    var monthRecord = journal.months[monthKey];
    if (!monthRecord.days) monthRecord.days = {};

    var existingDay = monthRecord.days[dateStr] || { date: dateStr, trades: [] };
    var merged = (existingDay.trades || []).slice();
    var seenIds = new Set(merged.map(function (x) { return x.id; }));
    (trades || []).forEach(function (tr) {
      if (!seenIds.has(tr.id)) {
        merged.push(tr);
        seenIds.add(tr.id);
      }
    });

    monthRecord.days[dateStr] = {
      date: dateStr,
      sessionId: (sessionInfo && sessionInfo.start) ? String(sessionInfo.start) : dateStr,
      summary: calculateDaySummary(merged),
      trades: merged
    };

    monthRecord.summary = calculateMonthSummary(monthRecord.days);
    return journal;
  }

  function exportJournalData(journal, opts) {
    opts = opts || {};
    var format = opts.format || 'csv';
    var scope = opts.scope || 'all';
    var j = journal || { months: {} };
    var months = j.months || {};

    var tradesToExport = [];
    var monthKeys = Object.keys(months).sort();

    monthKeys.forEach(function (mKey) {
      if (scope === 'month' && opts.month && mKey !== opts.month) return;
      var m = months[mKey];
      var days = m.days || {};
      Object.keys(days).sort().forEach(function (dKey) {
        if (scope === 'day' && opts.date && dKey !== opts.date) return;
        if (scope === 'custom') {
          if (opts.startDate && dKey < opts.startDate) return;
          if (opts.endDate && dKey > opts.endDate) return;
        }
        var d = days[dKey];
        (d.trades || []).forEach(function (tr) {
          tradesToExport.push(Object.assign({ tradingDate: dKey }, tr));
        });
      });
    });

    if (format === 'json') {
      var parsedData = {
        exportedAt: new Date().toISOString(),
        scope: scope,
        recordCount: tradesToExport.length,
        summary: calculateDaySummary(tradesToExport),
        trades: tradesToExport
      };
      var jsonContent = JSON.stringify(parsedData, null, 2);
      return {
        format: 'json',
        filename: 'trade-lock-journal-' + scope + '-' + (opts.date || opts.month || 'export') + '.json',
        content: jsonContent,
        text: jsonContent,
        data: parsedData,
        count: tradesToExport.length,
        recordCount: tradesToExport.length
      };
    }

    var headers = [
      'id', 'date', 'time_ist', 'symbol', 'instrument', 'side', 'direction',
      'quantity', 'entry_price', 'exit_price', 'gross_pnl', 'charges', 'net_pnl',
      'risk', 'setup', 'notes', 'rule_adherence', 'provenance', 'created_at'
    ];

    var rows = tradesToExport.map(function (t) {
      var atDate = t.at ? new Date(t.at) : new Date();
      var timeIst = atDate.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
      var side = t.side || (t.direction === 'SHORT' ? 'SELL' : 'BUY');
      var direction = t.direction || (side === 'SELL' ? 'SHORT' : 'LONG');
      var grossPnl = t.pnl !== undefined ? t.pnl : ((t.exit - t.entry) * (t.qty || 1) * (side === 'BUY' ? 1 : -1));
      var charges = t.charges || 0;
      var netPnl = t.netPnl !== undefined ? t.netPnl : (grossPnl - charges);

      return [
        formatCsvCell(t.id || ''),
        formatCsvCell(t.tradingDate || ''),
        formatCsvCell(timeIst),
        formatCsvCell(t.symbol || 'INDEX'),
        formatCsvCell(t.instrument || t.symbol || ''),
        formatCsvCell(side),
        formatCsvCell(direction),
        formatCsvCell(t.qty || 1),
        formatCsvCell(t.entry || 0),
        formatCsvCell(t.exit || 0),
        formatCsvCell(grossPnl),
        formatCsvCell(charges),
        formatCsvCell(netPnl),
        formatCsvCell(t.risk || 0),
        formatCsvCell(t.setup || ''),
        formatCsvCell(t.notes || ''),
        formatCsvCell(t.adherence || 'COMPLIANT'),
        formatCsvCell(t.provenance || (t.source === 'auto' ? 'broker-imported' : 'manual')),
        formatCsvCell(atDate.toISOString())
      ].join(',');
    });

    var csvContent = headers.join(',') + '\n' + rows.join('\n');
    return {
      format: 'csv',
      filename: 'trade-lock-journal-' + scope + '-' + (opts.date || opts.month || 'export') + '.csv',
      content: csvContent,
      text: csvContent,
      count: tradesToExport.length,
      recordCount: tradesToExport.length
    };
  }

  // ---------------------------------------------------------- licensing ----

  var PLAN_CATALOG = {
    free: { id: 'free', name: 'Free', amount: 0, pro: false },
    pro_monthly: { id: 'pro_monthly', name: 'Pro — Monthly', amount: 19900, pro: true },
    pro_yearly: { id: 'pro_yearly', name: 'Pro — Yearly', amount: 149900, pro: true },
    pro_plus_ai_monthly: { id: 'pro_plus_ai_monthly', name: 'Pro+ AI Markets — Monthly', amount: 39900, pro: true },
    pro_plus_ai_yearly: { id: 'pro_plus_ai_yearly', name: 'Pro+ AI Markets — Yearly', amount: 399900, pro: true },
    founder_lifetime: { id: 'founder_lifetime', name: 'Founder Lifetime', amount: 299900, pro: true }
  };

  var PRO_PLANS = [
    'pro_monthly',
    'pro_yearly',
    'pro_plus_ai',
    'pro_plus_ai_monthly',
    'pro_plus_ai_yearly',
    'lifetime',
    'founder_lifetime'
  ];

  function canonicalPlanId(id) {
    if (!id || id === 'free') return 'free';
    if (id === 'pro_plus_ai') return 'pro_plus_ai_monthly';
    if (id === 'lifetime') return 'founder_lifetime';
    return id;
  }

  function isPro(license, now) {
    if (!license || !license.key || license.active === false || license.revoked === true) return false;
    var canonicalId = canonicalPlanId(license.plan);
    var planMeta = PLAN_CATALOG[canonicalId];
    if (!planMeta || !planMeta.pro) return false;
    if (license.expiresAt && (now || Date.now()) > license.expiresAt) return false;
    return true;
  }

  /**
   * Applies the Free-tier gate when licensing is enforced. Free = manual
   * logging + the trade-count rule; every Pro rule and feature is zeroed so
   * evaluate() simply never trips on them. Returns settings unchanged when
   * licensing is off (the default) or a valid Pro key is present.
   */
  function effectiveSettings(settings, license, now) {
    var s = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    if (isPro(license, now)) return s;
    s.autoDetect = false;
    s.maxDailyLoss = 0;
    s.profitTarget = 0;
    s.maxConsecutiveLosses = 0;
    s.maxRiskPerTrade = 0;
    s.maxDailyRisk = 0;
    s.blockSiteWhenLocked = false;
    s.freeTier = true;
    return s;
  }

  // ------------------------------------------------------------ format ----

  function inr(n) {
    n = Number(n) || 0;
    var neg = n < 0;
    n = Math.abs(n);
    var s = (Math.round(n * 100) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (neg ? '\u2212\u20B9' : '\u20B9') + s;
  }

  function istLabel(ms, withDay) {
    var d = new Date(ms + IST_OFFSET_MIN * MIN);
    var days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var hh = String(d.getUTCHours()).padStart(2, '0');
    var mm = String(d.getUTCMinutes()).padStart(2, '0');
    var base = days[d.getUTCDay()] + ', ' + d.getUTCDate() + ' ' + months[d.getUTCMonth()] + ' \u00b7 ' + hh + ':' + mm + ' IST';
    return withDay ? base : base;
  }

  function countdown(untilMs, now) {
    var d = Math.max(0, (untilMs || 0) - (now || Date.now()));
    var h = Math.floor(d / 3600000);
    var m = Math.floor((d % 3600000) / 60000);
    var s = Math.floor((d % 60000) / 1000);
    var pad = function (x) { return String(x).padStart(2, '0'); };
    return (h > 0 ? h + 'h ' : '') + pad(m) + 'm ' + pad(s) + 's';
  }

  function progress(value, limit) {
    if (!(Number(limit) > 0)) return 0;
    return Math.min(1, Math.abs(Number(value) || 0) / limit);
  }

  // ----------------------------------------------------------- exports ----

  var api = {
    MIN: MIN, DAY: DAY, IST_OFFSET_MIN: IST_OFFSET_MIN,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    NSE_HOLIDAYS: NSE_HOLIDAYS,
    addMinutes: addMinutes,
    istMidnightUTC: istMidnightUTC,
    istDate: istDate,
    istWeekday: istWeekday,
    istMinutesOfDay: istMinutesOfDay,
    istAtMinutes: istAtMinutes,
    isHoliday: isHoliday,
    isClosedDay: isClosedDay,
    isTradingDay: isTradingDay,
    isMarketOpenHours: isMarketOpenHours,
    isPlanningSession: isPlanningSession,
    marketSessionInfo: marketSessionInfo,
    nextMarketOpen: nextMarketOpen,
    sessionStart: sessionStart,
    newSession: newSession,
    defaultState: defaultState,
    syncSession: syncSession,
    evaluate: evaluate,
    tick: tick,
    dailyRiskLimit: dailyRiskLimit,
    plannedRiskPerTrade: plannedRiskPerTrade,
    logTrade: logTrade,
    lockNow: lockNow,
    undoLastTrade: undoLastTrade,
    releaseManualLock: releaseManualLock,
    calendarStatus: calendarStatus,
    isPro: isPro,
    effectiveSettings: effectiveSettings,
    summarizeLog: summarizeLog,
    formatCsvCell: formatCsvCell,
    istMonthKey: istMonthKey,
    calculateDaySummary: calculateDaySummary,
    calculateMonthSummary: calculateMonthSummary,
    archiveDayToJournal: archiveDayToJournal,
    exportJournalData: exportJournalData,
    PRO_PLANS: PRO_PLANS,
    PLAN_CATALOG: PLAN_CATALOG,
    canonicalPlanId: canonicalPlanId,
    inr: inr,
    istLabel: istLabel,
    todayIST: function (t) { return istDate(t || Date.now()); },
    countdown: countdown,
    progress: progress,
    round2: round2
  };

  // Node.js test harness exports include administrative and testing utilities
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Object.assign({}, api, {
      releaseLock: releaseLock,
      resetDay: resetDay,
      resetDailyStats: resetDailyStats,
      emergencyOverrideLock: emergencyOverrideLock
    });
  }

  // Client browser global exposes ONLY safe operational API (zero reset/override bypasses)
  root.TLRules = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
