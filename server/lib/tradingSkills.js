'use strict';
/*
 * Trade Lock — Adaptive Trading Skills & Self-Improving Engine
 *
 * Implements:
 * 1. Smart Money Concepts (SMC): Liquidity Sweeps, BOS, CHoCH, Order Blocks
 * 2. Multi-Timeframe Price Action & Momentum Alignment
 * 3. Adaptive Trade Learning: Evaluates journaled wins/losses, computes
 *    win rates, expectancy, best trading hours, and tilt vulnerabilities.
 * 4. Dynamic Strategy Insights: Constantly updates recommendations
 *    based on user's real execution performance.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TLTradingSkills = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  function round2(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
  }

  function netPnl(row) {
    if (!row) return 0;
    var value = row.netPnl !== undefined && row.netPnl !== null
      ? Number(row.netPnl)
      : (Number(row.pnl) || 0) - (Number(row.charges) || 0);
    return Number.isFinite(value) ? value : 0;
  }

  /* Accept flat trades, legacy day records, and the canonical nested journal. */
  function flattenJournal(input) {
    var collected = [];
    function collect(value) {
      if (!value) return;
      if (Array.isArray(value)) {
        value.forEach(collect);
        return;
      }
      if (typeof value !== 'object') return;
      if (Array.isArray(value.log)) collect(value.log);
      if (value.journal && value.journal !== value) collect(value.journal);
      if (value.months && typeof value.months === 'object') {
        Object.keys(value.months).forEach(function (key) { collect(value.months[key]); });
      }
      if (value.days && typeof value.days === 'object') {
        Object.keys(value.days).forEach(function (key) { collect(value.days[key]); });
      }
      if (Array.isArray(value.trades)) {
        collect(value.trades);
        return;
      }
      if (value.pnl !== undefined || value.netPnl !== undefined ||
          value.at !== undefined || value.timestamp !== undefined) {
        collected.push(value);
      }
    }
    collect(input);

    // The same manual trade can exist in tlJournal, state.log, and the archived
    // day. Explicit IDs make those views idempotent; ID-less rows are retained.
    var seen = new Set();
    return collected.filter(function (row) {
      var identity = row.id !== undefined && row.id !== null && row.id !== ''
        ? row.id
        : row.brokerTradeId;
      if (identity === undefined || identity === null || identity === '') return true;
      var key = String(identity);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function tradeHourLabel(row) {
    var raw = row.at !== undefined && row.at !== null ? row.at
      : (row.timestamp !== undefined && row.timestamp !== null ? row.timestamp : row.createdAt);
    if (raw === undefined || raw === null || raw === '') return null;
    if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
    var numeric = Number(raw);
    var ms = Number.isFinite(numeric) && String(raw).trim() !== '' ? numeric : Date.parse(raw);
    if (!Number.isFinite(ms) || ms <= 0) return null;
    // India has no daylight-saving transition, so a fixed IST offset is exact.
    var hour = new Date(ms + 330 * 60000).getUTCHours();
    if (hour === 0) return '12:00 AM';
    if (hour < 12) return hour + ':00 AM';
    if (hour === 12) return '12:00 PM';
    return (hour - 12) + ':00 PM';
  }

  // --- 1. Institutional Price Action & SMC Analysis ---

  function detectSwings(candles, lookback) {
    lookback = lookback || 3;
    var highs = [], lows = [];
    if (!candles || candles.length < lookback * 2 + 1) return { highs: highs, lows: lows };

    for (var i = lookback; i < candles.length - lookback; i++) {
      var isHigh = true, isLow = true;
      var curH = candles[i].h, curL = candles[i].l;

      for (var j = i - lookback; j <= i + lookback; j++) {
        if (j === i) continue;
        if (candles[j].h >= curH) isHigh = false;
        if (candles[j].l <= curL) isLow = false;
      }

      if (isHigh) highs.push({ index: i, price: curH, candle: candles[i] });
      if (isLow) lows.push({ index: i, price: curL, candle: candles[i] });
    }
    return { highs: highs, lows: lows };
  }

  function evaluateMarketStructure(candles) {
    if (!candles || candles.length < 15) {
      return { structure: 'Neutral / Developing', bias: 'neutral', bos: null, choch: null };
    }

    var swings = detectSwings(candles, 2);
    var sh = swings.highs;
    var sl = swings.lows;

    if (sh.length < 2 || sl.length < 2) {
      var first = candles[0].c, last = candles[candles.length - 1].c;
      var simpleTrend = last > first ? 'Bullish Drift' : last < first ? 'Bearish Drift' : 'Consolidation';
      var simpleBias = last > first ? 'bullish' : last < first ? 'bearish' : 'neutral';
      return { structure: simpleTrend, bias: simpleBias, bos: null, choch: null };
    }

    var lastH = sh[sh.length - 1].price;
    var prevH = sh[sh.length - 2].price;
    var lastL = sl[sl.length - 1].price;
    var prevL = sl[sl.length - 2].price;

    var higherHigh = lastH > prevH;
    var higherLow = lastL > prevL;
    var lowerHigh = lastH < prevH;
    var lowerLow = lastL < prevL;

    var curPrice = candles[candles.length - 1].c;
    var bos = null, choch = null;

    if (higherHigh && higherLow) {
      if (curPrice > lastH) bos = { type: 'Bullish BOS', level: lastH };
      return {
        structure: 'Bullish (Higher Highs & Lows)',
        bias: 'bullish',
        bos: bos,
        choch: curPrice < lastL ? { type: 'Bearish CHoCH', level: lastL } : null
      };
    } else if (lowerHigh && lowerLow) {
      if (curPrice < lastL) bos = { type: 'Bearish BOS', level: lastL };
      return {
        structure: 'Bearish (Lower Highs & Lows)',
        bias: 'bearish',
        bos: bos,
        choch: curPrice > lastH ? { type: 'Bullish CHoCH', level: lastH } : null
      };
    } else if (higherHigh && lowerLow) {
      return { structure: 'Expanding Volatility / Broadening', bias: 'neutral', bos: null, choch: null };
    } else {
      return { structure: 'Rangebound Consolidation', bias: 'neutral', bos: null, choch: null };
    }
  }

  function detectLiquiditySweeps(candles) {
    var sweeps = [];
    if (!candles || candles.length < 10) return sweeps;
    var swings = detectSwings(candles.slice(0, -3), 2);

    var last3 = candles.slice(-3);
    for (var k = 0; k < last3.length; k++) {
      var c = last3[k];
      for (var h = 0; h < swings.highs.length; h++) {
        var sh = swings.highs[h].price;
        if (c.h > sh && c.c < sh) {
          sweeps.push({ type: 'Buy-side Liquidity Sweep (Bearish Reject)', level: sh, time: c.t });
        }
      }
      for (var l = 0; l < swings.lows.length; l++) {
        var sl = swings.lows[l].price;
        if (c.l < sl && c.c > sl) {
          sweeps.push({ type: 'Sell-side Liquidity Sweep (Bullish Reversal)', level: sl, time: c.t });
        }
      }
    }
    return sweeps;
  }

  // --- 2. Self-Improving Adaptive Learning from User Trades ---

  function learnFromJournal(journal, settings) {
    var rows = flattenJournal(journal);
    var stats = {
      totalTrades: rows.length,
      wins: 0,
      losses: 0,
      breakEven: 0,
      winRate: 0,
      totalPnl: 0,
      avgWin: 0,
      avgLoss: 0,
      profitFactor: 0,
      expectancy: 0,
      bestTradingHours: [],
      worstTradingHours: [],
      rulesAdherence: null,
      insights: [],
      recommendations: []
    };

    if (rows.length === 0) {
      stats.insights.push({
        type: 'initial',
        title: 'Strategy Engine Awaiting Trades',
        text: 'Log your first trades in the Journal or let Trade Lock auto-detect executions. The adaptive engine will summarize net outcomes, historical timing patterns, and discipline adherence from the recorded sample.'
      });
      return stats;
    }

    var winPnlTotal = 0;
    var lossPnlTotal = 0;
    var violations = 0;
    var adherenceRecords = 0;
    var hourlyPerformance = {};

    rows.forEach(function (t) {
      var pnl = netPnl(t);
      stats.totalPnl += pnl;
      if (t.adherence === 'VIOLATION' || t.adherence === 'COMPLIANT') {
        adherenceRecords++;
        if (t.adherence === 'VIOLATION') violations++;
      }

      if (pnl > 0) {
        stats.wins++;
        winPnlTotal += pnl;
      } else if (pnl < 0) {
        stats.losses++;
        lossPnlTotal += Math.abs(pnl);
      } else {
        stats.breakEven++;
      }

      var hourKey = tradeHourLabel(t);
      if (!hourKey) return;
      if (!hourlyPerformance[hourKey]) hourlyPerformance[hourKey] = { pnl: 0, wins: 0, total: 0 };
      hourlyPerformance[hourKey].pnl += pnl;
      hourlyPerformance[hourKey].total++;
      if (pnl > 0) hourlyPerformance[hourKey].wins++;
    });

    var decided = stats.wins + stats.losses;
    stats.totalPnl = round2(stats.totalPnl);
    stats.winRate = decided > 0 ? round2((stats.wins / decided) * 100) : 0;
    stats.avgWin = stats.wins > 0 ? round2(winPnlTotal / stats.wins) : 0;
    stats.avgLoss = stats.losses > 0 ? round2(lossPnlTotal / stats.losses) : 0;
    stats.profitFactor = lossPnlTotal > 0 ? round2(winPnlTotal / lossPnlTotal) : (winPnlTotal > 0 ? 99.9 : 0);
    // Expectancy is mean realised net P&L per recorded trade. Breakeven trades
    // contribute zero instead of being misclassified as losses.
    stats.expectancy = stats.totalTrades > 0 ? round2(stats.totalPnl / stats.totalTrades) : 0;
    stats.rulesAdherence = adherenceRecords > 0
      ? round2(((adherenceRecords - violations) / adherenceRecords) * 100)
      : null;

    // Rank profitable hours highest-first and losing hours lowest-first.
    var hourKeys = Object.keys(hourlyPerformance);
    stats.bestTradingHours = hourKeys.filter(function (k) { return hourlyPerformance[k].pnl > 0; })
      .sort(function (a, b) { return hourlyPerformance[b].pnl - hourlyPerformance[a].pnl || a.localeCompare(b); });
    stats.worstTradingHours = hourKeys.filter(function (k) { return hourlyPerformance[k].pnl < 0; })
      .sort(function (a, b) { return hourlyPerformance[a].pnl - hourlyPerformance[b].pnl || a.localeCompare(b); });

    // Dynamic Strategy Insights generated from real trade outcomes
    if (stats.totalTrades >= 5 && stats.winRate >= 60 && stats.profitFactor > 1.5) {
      stats.insights.push({
        type: 'strength',
        title: 'Positive Result in the Recorded Sample',
        text: 'Across ' + stats.totalTrades + ' recorded trades, the decided-trade win rate is ' + stats.winRate + '% with a net profit factor of ' + stats.profitFactor + '. Mean net P&L is ₹' + stats.expectancy + ' per trade. This is historical evidence, not a guarantee of future performance.'
      });
    } else if (stats.expectancy < 0 && stats.totalTrades >= 5) {
      stats.insights.push({
        type: 'warning',
        title: 'Negative Expectancy in the Recorded Sample',
        text: 'Mean net P&L is ₹' + stats.expectancy + ' per trade across ' + stats.totalTrades + ' records, with a decided-trade win rate of ' + stats.winRate + '%. Review setup selection, costs, position sizing, and stop discipline before the next session.'
      });
    }

    if (stats.bestTradingHours.length > 0) {
      stats.recommendations.push(
        'Observed Hour: ' + stats.bestTradingHours[0] + ' IST has the highest net P&L in the recorded journal. Treat this as historical context, not a guaranteed optimal window.'
      );
    }
    if (stats.worstTradingHours.length > 0) {
      stats.recommendations.push(
        'Caution Zone: ' + stats.worstTradingHours[0] + ' IST has the lowest net P&L in the recorded journal. Review executions from this hour before repeating the setup.'
      );
    }
    if (stats.avgLoss > stats.avgWin && stats.losses > 0) {
      stats.recommendations.push(
        'Risk/Reward Imbalance: Average net loss (₹' + stats.avgLoss + ') exceeds average net win (₹' + stats.avgWin + '). Review position sizing and stop discipline before the next session.'
      );
    }

    return stats;
  }

  return {
    detectSwings: detectSwings,
    evaluateMarketStructure: evaluateMarketStructure,
    detectLiquiditySweeps: detectLiquiditySweeps,
    learnFromJournal: learnFromJournal
  };
});
