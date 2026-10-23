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
    var start = sessionStart(t, settings);
    if (state.session.start !== start) {
      state.session = newSession(start);
      state.detectorSeen = {};
      state.status = 'NORMAL';
      state.statusTimestamp = t;
      state.statusReason = null;
      // A rule lock always expires at market open, so it clears with the rollover.
      if (state.lock.active && !state.lock.manual) {
        state.lock = { active: false, reason: null, since: null, until: null, manual: false, mode: (settings && settings.enforcementMode) || 'warning' };
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
      if (t >= state.lock.until) {
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
      var deferExpired = state.pendingLock && (t - state.pendingLock.at > 3 * 60 * 1000);
      if (open > 0 && !deferExpired) {
        if (!state.pendingLock || state.pendingLock.rule !== v.rule) {
          state.pendingLock = { rule: v.rule, title: v.title, at: t, openTrades: open };
          changed = true;
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

    state.log.push({
      at: t, symbol: entry.symbol || '', side: entry.side || '', qty: Number(entry.qty) || 0,
      pnl: pnl, risk: risk, source: entry.source || 'manual'
    });
    if (state.log.length > 500) state.log = state.log.slice(-500);
    return state;
  }

  function lockNow(state, settings, now) {
    var s = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    var t = now || Date.now();
    syncSession(state, s, t);
    var until = nextMarketOpen(t, s);
    var floor = t + Math.max(0, s.minLockMinutes) * MIN;
    if (until < floor) until = floor;
    state.lock = { active: true, reason: 'manual', since: t, until: until, manual: true, mode: s.enforcementMode || 'warning' };
    state.status = 'LOCKED';
    state.statusTimestamp = t;
    state.statusReason = 'manual';
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
    var e = state.log.pop();
    if (!e) return null;
    var s = state.session;
    s.trades = Math.max(0, s.trades - 1);
    s.pnl = round2(s.pnl - e.pnl);
    s.riskUsed = Math.max(0, round2(s.riskUsed - e.risk));
    if (e.pnl < 0) s.consecutiveLosses = Math.max(0, s.consecutiveLosses - 1);
    return e;
  }

  function resetDay(state, settings, now) {
    var t = now || Date.now();
    var fresh = defaultState(t);
    fresh.session = newSession(sessionStart(t, settings));
    if (state) {
      var prevAudit = Array.isArray(state.audit) ? state.audit : [];
      var resetEvent = {
        resetAt: t,
        previousDate: (state.session && state.session.date) || null,
        trades: (state.session && state.session.trades) || 0,
        pnl: (state.session && state.session.pnl) || 0,
        lockWasActive: !!(state.lock && state.lock.active),
        lockReason: (state.lock && state.lock.reason) || null
      };
      fresh.audit = prevAudit.concat([resetEvent]).slice(-50);
      fresh.resetCount = (state.resetCount || 0) + 1;
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

  // ---------------------------------------------------------- licensing ----

  var PRO_PLANS = ['pro_monthly', 'pro_yearly', 'pro_plus_ai', 'lifetime'];

  function isPro(license, now) {
    if (!license || !license.key || license.active === false) return false;
    if (PRO_PLANS.indexOf(license.plan) === -1) return false;
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
    releaseLock: releaseLock,
    undoLastTrade: undoLastTrade,
    resetDay: resetDay,
    calendarStatus: calendarStatus,
    isPro: isPro,
    effectiveSettings: effectiveSettings,
    summarizeLog: summarizeLog,
    PRO_PLANS: PRO_PLANS,
    inr: inr,
    istLabel: istLabel,
    countdown: countdown,
    progress: progress,
    round2: round2
  };

  root.TLRules = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
