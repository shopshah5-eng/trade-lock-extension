'use strict';
const test = require('node:test');
const assert = require('node:assert');
const I = require('../lib/insights.js');

const MIN = 60000;
const T0 = Date.UTC(2026, 9, 16, 4, 0, 0);
const sess = (over) => Object.assign(
  { trades: 0, pnl: 0, riskUsed: 0, consecutiveLosses: 0, date: '2026-10-16' }, over || {});
const settings = { maxTradesPerDay: 5, maxConsecutiveLosses: 3 };

test('detects a revenge trade (re-entry within 5 min of a loss)', () => {
  const a = I.analyze([
    { at: T0, pnl: -500, risk: 500 },
    { at: T0 + 3 * MIN, pnl: -200, risk: 500 }
  ], sess({ trades: 2, consecutiveLosses: 2 }), settings);
  assert.strictEqual(a.patterns.revengeTrades, 1);
  assert.ok(a.signals.some((s) => s.code === 'revenge'));
  assert.ok(a.score <= 88);
});

test('a calm re-entry after 30 minutes is not revenge', () => {
  const a = I.analyze([
    { at: T0, pnl: -500, risk: 500 },
    { at: T0 + 30 * MIN, pnl: 300, risk: 500 }
  ], sess({ trades: 2 }), settings);
  assert.strictEqual(a.patterns.revengeTrades, 0);
});

test('detects risk escalation after a loss', () => {
  const a = I.analyze([
    { at: T0, pnl: -500, risk: 500 },
    { at: T0 + 20 * MIN, pnl: -900, risk: 1000 } // doubled after losing
  ], sess({ trades: 2 }), settings);
  assert.strictEqual(a.patterns.riskEscalations, 1);
  assert.ok(a.signals.some((s) => s.code === 'escalation'));
});

test('same-size trade after a loss is not escalation', () => {
  const a = I.analyze([
    { at: T0, pnl: -500, risk: 500 },
    { at: T0 + 20 * MIN, pnl: 100, risk: 550 }
  ], sess({ trades: 2 }), settings);
  assert.strictEqual(a.patterns.riskEscalations, 0);
});

test('detects burst trading (3 trades inside 10 minutes)', () => {
  const a = I.analyze([
    { at: T0, pnl: 100, risk: 300 },
    { at: T0 + 4 * MIN, pnl: 100, risk: 300 },
    { at: T0 + 8 * MIN, pnl: -100, risk: 300 }
  ], sess({ trades: 3 }), settings);
  assert.ok(a.patterns.burstWindows >= 1);
  assert.ok(a.signals.some((s) => s.code === 'burst'));
});

test('clean session scores high with an ok signal', () => {
  const a = I.analyze([
    { at: T0, pnl: 800, risk: 500 },
    { at: T0 + 45 * MIN, pnl: 600, risk: 500 }
  ], sess({ trades: 2, pnl: 1400 }), settings);
  assert.ok(a.score >= 85, 'score=' + a.score);
  assert.strictEqual(a.grade, 'Disciplined');
  assert.ok(a.signals.some((s) => s.code === 'clean'));
});

test('suggests fixing size when average loss beats average win', () => {
  const a = I.analyze([
    { at: T0, pnl: 300, risk: 500 },
    { at: T0 + 30 * MIN, pnl: -900, risk: 500 },
    { at: T0 + 60 * MIN, pnl: -800, risk: 500 }
  ], sess({ trades: 3 }), settings);
  assert.ok(a.suggestions.some((s) => /average loss/i.test(s)));
});

test('dailyReport is a readable summary with score and signals', () => {
  const text = I.dailyReport([
    { at: T0, pnl: -500, risk: 500 },
    { at: T0 + 2 * MIN, pnl: -100, risk: 500 }
  ], sess({ trades: 2, pnl: -600, riskUsed: 1000, consecutiveLosses: 2 }), settings);
  assert.match(text, /day report/);
  assert.match(text, /Discipline score:/);
  assert.match(text, /revenge/i);
});

test('empty log is safe', () => {
  const a = I.analyze([], sess(), settings);
  assert.strictEqual(a.score, 100);
  assert.deepStrictEqual(a.signals, []);
});
