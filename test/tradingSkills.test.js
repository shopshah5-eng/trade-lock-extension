'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Skills = require('../lib/tradingSkills.js');
const ServerSkills = require('../server/lib/tradingSkills.js');

function atIst(hour, minute) {
  return Date.parse(`2026-10-13T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+05:30`);
}

test('adaptive journal learning flattens and deduplicates canonical and legacy records using net P&L and IST', () => {
  const netLoss = {
    id: 'trade-net-loss', at: atIst(9, 15), pnl: 100, charges: 150, netPnl: null,
    adherence: 'COMPLIANT',
  };
  const netWin = {
    id: 'trade-net-win', at: atIst(10, 15), pnl: 200, charges: 50, netPnl: 150,
    adherence: 'VIOLATION',
  };
  const breakEven = {
    id: 'trade-flat', at: atIst(11, 15), pnl: 0, charges: 0, netPnl: 0,
    adherence: 'COMPLIANT',
  };
  const state = {
    log: [breakEven],
    journal: {
      months: {
        '2026-10': {
          days: {
            '2026-10-13': { date: '2026-10-13', trades: [netLoss, netWin, breakEven] },
          },
        },
      },
    },
  };
  const legacy = [{ date: '2026-10-13', trades: [netLoss, netWin] }, netLoss];
  const stats = Skills.learnFromJournal([state, legacy]);

  assert.strictEqual(stats.totalTrades, 3, 'the same trade in three views counts once');
  assert.strictEqual(stats.wins, 1, 'gross +100 with ₹150 charges is a net loss');
  assert.strictEqual(stats.losses, 1);
  assert.strictEqual(stats.breakEven, 1);
  assert.strictEqual(stats.winRate, 50, 'breakeven is excluded from decided-trade win rate');
  assert.strictEqual(stats.totalPnl, 100);
  assert.strictEqual(stats.avgWin, 150);
  assert.strictEqual(stats.avgLoss, 50);
  assert.strictEqual(stats.profitFactor, 3);
  assert.strictEqual(stats.expectancy, 33.33, 'breakeven contributes zero to mean net P&L per trade');
  assert.strictEqual(stats.rulesAdherence, 66.67);
  assert.deepStrictEqual(stats.bestTradingHours, ['10:00 AM']);
  assert.deepStrictEqual(stats.worstTradingHours, ['9:00 AM']);
  assert.ok(stats.recommendations.every((text) => text.includes('IST')));
  assert.deepStrictEqual(ServerSkills.learnFromJournal([state, legacy]), stats);
});

test('adaptive hour ranking puts the largest net loss first and never invents missing times', () => {
  const stats = Skills.learnFromJournal([
    { id: 'small-loss', at: atIst(9, 30), netPnl: -50 },
    { id: 'large-loss', at: atIst(10, 30), netPnl: -500 },
    { id: 'medium-loss', at: atIst(11, 30), netPnl: -100 },
    { id: 'midnight-win', at: atIst(0, 15), netPnl: 25 },
    { id: 'date-only', date: '2026-10-13', netPnl: -1000 },
    { id: 'no-time', pnl: -1000 },
  ]);
  assert.deepStrictEqual(stats.worstTradingHours.slice(0, 3), ['10:00 AM', '11:00 AM', '9:00 AM']);
  assert.deepStrictEqual(stats.bestTradingHours, ['12:00 AM']);
  assert.strictEqual(stats.totalTrades, 6);
  assert.strictEqual(stats.rulesAdherence, null, 'missing adherence evidence is not 100% adherence');
  assert.ok(!stats.worstTradingHours.includes('NaN:00 PM'));
});

test('flat market structure remains neutral instead of becoming bearish', () => {
  const candles = Array.from({ length: 15 }, () => ({ h: 10, l: 9, c: 10 }));
  const result = Skills.evaluateMarketStructure(candles);
  assert.strictEqual(result.structure, 'Consolidation');
  assert.strictEqual(result.bias, 'neutral');
});

test('empty adaptive statistics make no adherence or performance claims', () => {
  const stats = Skills.learnFromJournal(null);
  assert.strictEqual(stats.totalTrades, 0);
  assert.strictEqual(stats.rulesAdherence, null);
  assert.strictEqual(stats.expectancy, 0);
  assert.deepStrictEqual(stats.bestTradingHours, []);
  assert.match(stats.insights[0].text, /historical timing patterns/i);
});
