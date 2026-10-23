/*
 * Trade Lock — Coach insights engine ("AI benefits", local edition).
 *
 * Pure functions over today's trade log. No network, no LLM, nothing leaves
 * the device: it detects the behavioural patterns that actually blow up
 * accounts — revenge trading, risk escalation after losses, burst trading —
 * and turns them into a discipline score, warnings and suggestions.
 *
 * (A server-side LLM summary can be layered on later; the interface here —
 * log in, structured insights out — is designed for that.)
 *
 * Exposed as globalThis.TLInsights; also require()-able for tests.
 */
(function (root) {
  'use strict';

  var REVENGE_WINDOW_MS = 5 * 60 * 1000;   // trade within 5 min of a loss
  var BURST_WINDOW_MS = 10 * 60 * 1000;    // 3+ trades inside 10 minutes
  var BURST_COUNT = 3;
  var ESCALATION_RATIO = 1.5;              // risk up >=50% vs previous trade

  function round1(n) { return Math.round(n * 10) / 10; }

  /**
   * @param {Array} log       [{at, pnl, risk, source, symbol}]
   * @param {Object} session  today's counters
   * @param {Object} settings rules/plan (maxTradesPerDay, daily risk limit ₹…)
   * @returns {{score:number, grade:string, signals:Array, suggestions:Array, patterns:Object}}
   */
  function analyze(log, session, settings) {
    var rows = (Array.isArray(log) ? log.slice() : []).sort(function (a, b) { return (a.at || 0) - (b.at || 0); });
    var s = settings || {};
    var signals = [];
    var patterns = { revengeTrades: 0, riskEscalations: 0, burstWindows: 0, tradesAfterLoss: 0, longestGapMin: 0 };

    // ---- pattern detection over consecutive trades ----
    for (var i = 1; i < rows.length; i++) {
      var prev = rows[i - 1], cur = rows[i];
      var gap = (cur.at || 0) - (prev.at || 0);
      if (gap > patterns.longestGapMin * 60000) patterns.longestGapMin = Math.round(gap / 60000);

      if (prev.pnl < 0) {
        patterns.tradesAfterLoss++;
        if (gap <= REVENGE_WINDOW_MS && gap >= 0) {
          patterns.revengeTrades++;
        }
        if (prev.risk > 0 && cur.risk >= prev.risk * ESCALATION_RATIO) {
          patterns.riskEscalations++;
        }
      }
    }
    // burst windows: any BURST_COUNT trades inside BURST_WINDOW_MS
    for (var j = 0; j + BURST_COUNT - 1 < rows.length; j++) {
      if ((rows[j + BURST_COUNT - 1].at || 0) - (rows[j].at || 0) <= BURST_WINDOW_MS) patterns.burstWindows++;
    }

    // ---- signals (what the user sees) ----
    if (patterns.revengeTrades > 0) {
      signals.push({ level: 'danger', code: 'revenge',
        text: patterns.revengeTrades + ' revenge trade' + (patterns.revengeTrades > 1 ? 's' : '') +
          ' detected — you re-entered within 5 minutes of a loss.' });
    }
    if (patterns.riskEscalations > 0) {
      signals.push({ level: 'danger', code: 'escalation',
        text: 'Risk jumped 50%+ after a loss ' + patterns.riskEscalations + ' time' +
          (patterns.riskEscalations > 1 ? 's' : '') + '. That is how small losses become big days.' });
    }
    if (patterns.burstWindows > 0) {
      signals.push({ level: 'warn', code: 'burst',
        text: 'Burst trading: ' + BURST_COUNT + '+ trades inside 10 minutes. Speed is usually emotion, not edge.' });
    }
    if (session && session.consecutiveLosses >= 2) {
      signals.push({ level: 'warn', code: 'streak',
        text: session.consecutiveLosses + ' losses in a row right now. Your plan says stop at ' +
          (s.maxConsecutiveLosses || 3) + '.' });
    }
    if (s.maxTradesPerDay > 0 && session && session.trades >= Math.ceil(s.maxTradesPerDay * 0.8) && session.trades < s.maxTradesPerDay) {
      signals.push({ level: 'warn', code: 'pace',
        text: 'You have used ' + session.trades + ' of ' + s.maxTradesPerDay + ' trades. Make the remaining ones count.' });
    }
    if (!signals.length && rows.length) {
      signals.push({ level: 'ok', code: 'clean', text: 'Clean session so far — no tilt patterns detected. Keep it boring.' });
    }

    // ---- discipline score 0..100 ----
    var score = 100;
    score -= patterns.revengeTrades * 12;
    score -= patterns.riskEscalations * 15;
    score -= patterns.burstWindows * 8;
    if (session && s.maxTradesPerDay > 0 && session.trades > s.maxTradesPerDay) score -= 10;
    if (session && session.consecutiveLosses >= 3) score -= 10;
    score = Math.max(0, Math.min(100, score));
    var grade = score >= 85 ? 'Disciplined' : score >= 65 ? 'Mostly in control' : score >= 40 ? 'Tilting' : 'Full tilt — stop';

    // ---- suggestions (for tomorrow / settings) ----
    var suggestions = [];
    var wins = rows.filter(function (r) { return r.pnl > 0; });
    var losses = rows.filter(function (r) { return r.pnl < 0; });
    var avgWin = wins.length ? wins.reduce(function (a, r) { return a + r.pnl; }, 0) / wins.length : 0;
    var avgLoss = losses.length ? Math.abs(losses.reduce(function (a, r) { return a + r.pnl; }, 0) / losses.length) : 0;
    if (losses.length >= 2 && avgLoss > avgWin && avgWin > 0) {
      suggestions.push('Your average loss (' + inr(avgLoss) + ') is bigger than your average win (' + inr(avgWin) +
        '). Consider a hard stop or smaller size — the math cannot work otherwise.');
    }
    if (patterns.revengeTrades >= 2) {
      suggestions.push('Revenge entries are your leak. Try a rule: after any loss, no trade for 15 minutes (the lock can enforce a shorter day instead).');
    }
    if (rows.length >= 4 && losses.length / rows.length > 0.6) {
      suggestions.push('Loss rate is ' + Math.round(losses.length / rows.length * 100) + '% today. Days like this usually mean the setup is not there — fewer, better trades tomorrow.');
    }
    if (patterns.riskEscalations > 0) {
      suggestions.push('Fix your risk per trade in the plan and let the extension default to it — never decide size right after a loss.');
    }
    if (!suggestions.length && rows.length) {
      suggestions.push('Nothing structural to fix today. Review the log once, then leave the plan exactly as it is tomorrow.');
    }

    return { score: score, grade: grade, signals: signals, suggestions: suggestions, patterns: patterns };
  }

  function inr(n) {
    n = Number(n) || 0;
    var neg = n < 0;
    var str = Math.abs(Math.round(n)).toLocaleString('en-IN');
    return (neg ? '−₹' : '₹') + str;
  }

  /** One-line end-of-day report (copy/paste into a journal or WhatsApp). */
  function dailyReport(log, session, settings) {
    var a = analyze(log, session, settings);
    var lines = [];
    lines.push('Trade Lock — day report (' + (session && session.date || '') + ')');
    lines.push('Trades: ' + (session ? session.trades : 0) + ' · P&L: ' + inr(session ? session.pnl : 0) +
      ' · Risk used: ' + inr(session ? session.riskUsed : 0));
    lines.push('Discipline score: ' + a.score + '/100 (' + a.grade + ')');
    a.signals.forEach(function (sg) { lines.push('• ' + sg.text); });
    a.suggestions.forEach(function (sg) { lines.push('→ ' + sg); });
    return lines.join('\n');
  }

  var api = { analyze: analyze, dailyReport: dailyReport,
              REVENGE_WINDOW_MS: REVENGE_WINDOW_MS, BURST_WINDOW_MS: BURST_WINDOW_MS };
  root.TLInsights = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
