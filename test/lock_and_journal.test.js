/*
 * Tests for Trade Lock upgrade:
 * 1. Full-screen lock enforcement & top-banner removal
 * 2. Reset-day bypass elimination & active risk-lock protection
 * 3. Monthly trading journal with daily records, idempotent rollover, and formula-safe export
 * 4. Sahi broker recognition and honest capability status
 * 5. Paid plans catalog and price consistency
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const R = require('../lib/rules.js');
const detector = require('../lib/detector.js');
const serverPlans = require('../server/plans.js');

const rootDir = path.resolve(__dirname, '..');

// -------------------------------------------------- 1. Full-Screen Lock ----

test('Lock Screen: content/lock.js contains opaque full-screen overlay and removes top banner', () => {
  const lockJs = fs.readFileSync(path.join(rootDir, 'content/lock.js'), 'utf8');

  // Verify top banner mode and controls are completely removed
  assert.strictEqual(lockJs.includes('isChartMode'), false, 'isChartMode variable must be removed');
  assert.strictEqual(lockJs.includes('#tl-btn-chartmode'), false, 'Switch to chart mode button must be removed');
  assert.strictEqual(lockJs.includes('#tl-btn-fullmode'), false, 'Switch to full mode button must be removed');
  assert.strictEqual(lockJs.includes('tl-banner-root'), false, 'Top banner root container must be removed');

  // Verify opaque full screen styling
  assert.ok(lockJs.includes('rgba(7, 9, 15, 0.98)') || lockJs.includes('#07090f'), 'Lock screen must have opaque dark background');
  assert.ok(lockJs.includes('tl-overlay-title'), 'Lock screen must have title element');
  assert.ok(lockJs.includes('tl-overlay-timer'), 'Lock screen must have live countdown element');
  assert.ok(lockJs.includes('Asia/Kolkata'), 'Lock screen must format unlock time in Asia/Kolkata timezone');
  assert.ok(lockJs.includes('Broker table') && lockJs.includes('Manual log'), 'Lock screen must label DOM imports without claiming broker verification');
  assert.strictEqual(lockJs.includes('Broker-verified'), false, 'Generic DOM imports must not be labelled broker-verified');
  assert.ok(lockJs.includes('chartOnlyExcluded') && lockJs.includes('isChartingPage'), 'Chart-only mode must not overlay order-entry terminals');
  assert.ok(lockJs.includes('lockButton.disabled = lockActive'), 'HUD lock button must re-enable after a confirmed manual release');
});

// --------------------------------------- 2. Reset-Day Bypass Elimination ----

test('Reset Day Bypass: Reset Day button is completely removed from all production surfaces', () => {
  const popupHtml = fs.readFileSync(path.join(rootDir, 'popup/popup.html'), 'utf8');
  const popupJs = fs.readFileSync(path.join(rootDir, 'popup/popup.js'), 'utf8');
  const optionsHtml = fs.readFileSync(path.join(rootDir, 'options/options.html'), 'utf8');
  const lockJs = fs.readFileSync(path.join(rootDir, 'content/lock.js'), 'utf8');

  // Verify #resetDay button is removed from popup
  assert.strictEqual(popupHtml.includes('id="resetDay"'), false, 'resetDay button must be removed from popup.html');
  assert.strictEqual(popupHtml.includes('Reset day'), false, 'Reset day label must be removed from popup.html');

  // Verify popup.js does not bind or trigger resetDay
  assert.strictEqual(popupJs.includes('els.resetDay'), false, 'popup.js must not reference els.resetDay');
  assert.strictEqual(popupJs.includes('TL_RESET'), false, 'popup.js must not send TL_RESET messages');

  // Verify #resetDay button is removed from options/dashboard
  assert.strictEqual(optionsHtml.includes('id="resetDay"'), false, 'resetDay button must be removed from options.html');

  // Verify lock.js HUD does not have reset button
  assert.strictEqual(lockJs.includes('id="tl-reset"'), false, 'tl-reset must be removed from content HUD');

  // Verify TL_RESET message handler in content/lock.js explicitly rejects manual bypass
  assert.ok(lockJs.includes('RESET_BYPASS_DISABLED'), 'TL_RESET handler must reject bypass attempt');
});

test('Session Rollover: active risk rule lock is preserved across calendar date boundary', () => {
  const settings = Object.assign({}, R.DEFAULT_SETTINGS, {
    maxTradesPerDay: 3,
    maxDailyLoss: 5000
  });

  const state = R.defaultState(Date.now());
  state.session.date = '2026-10-22';
  state.session.trades = 4;
  state.lock = {
    active: true,
    reason: 'maxTradesPerDay',
    since: Date.now() - 3600000,
    until: Date.now() + 7200000, // 2 hours into the future
    manual: false
  };

  // Rollover to next date 2026-10-23
  const nextSessionDate = '2026-10-23';
  const synced = R.syncSession(state, settings, Date.now());

  // Active risk lock must NOT be cleared just because date rolled over
  assert.strictEqual(synced.lock.active, true, 'Active risk rule lock must persist after session rollover');
  assert.strictEqual(synced.lock.reason, 'maxTradesPerDay', 'Lock reason must be preserved');
  assert.strictEqual(synced.lock.until > Date.now(), true, 'Lock until timestamp must be preserved');
});

// --------------------------- 3. Monthly Trading Journal & Daily Records ----

test('Monthly Journal: Day summaries calculate wins, losses, win rate, gross and net P&L correctly', () => {
  const trades = [
    { id: 't1', symbol: 'NIFTY 24500 CE', side: 'BUY', qty: 75, entry: 100, exit: 120, pnl: 1500, charges: 50, netPnl: 1450, provenance: 'manual' },
    { id: 't2', symbol: 'BANKNIFTY 51000 PE', side: 'BUY', qty: 30, entry: 200, exit: 180, pnl: -600, charges: 50, netPnl: -650, provenance: 'broker' },
    { id: 't3', symbol: 'NIFTY 24600 CE', side: 'SELL', qty: 75, entry: 80, exit: 80, pnl: 0, charges: 40, netPnl: -40, provenance: 'broker' }
  ];

  const summary = R.calculateDaySummary(trades);
  assert.strictEqual(summary.totalTrades, 3);
  assert.strictEqual(summary.wins, 1);
  assert.strictEqual(summary.losses, 2); // net loss including charges
  assert.strictEqual(summary.winRate, 33.3);
  assert.strictEqual(summary.grossPnl, 900);
  assert.strictEqual(summary.charges, 140);
  assert.strictEqual(summary.netPnl, 760);
  assert.strictEqual(summary.brokerVerifiedCount, 2);
  assert.strictEqual(summary.manualCount, 1);
});

test('Monthly Journal: Month summary aggregates days and determines best/worst days', () => {
  const days = {
    '2026-10-01': {
      date: '2026-10-01',
      trades: [
        { id: '1', pnl: 2000, charges: 100, netPnl: 1900 },
        { id: '2', pnl: 1000, charges: 50, netPnl: 950 }
      ]
    },
    '2026-10-05': {
      date: '2026-10-05',
      trades: [
        { id: '3', pnl: -3000, charges: 80, netPnl: -3080 }
      ]
    },
    '2026-10-23': {
      date: '2026-10-23',
      trades: [
        { id: '4', pnl: 500, charges: 40, netPnl: 460 }
      ]
    }
  };

  const mSummary = R.calculateMonthSummary(days);
  assert.strictEqual(mSummary.totalTrades, 4);
  assert.strictEqual(mSummary.wins, 3);
  assert.strictEqual(mSummary.losses, 1);
  assert.strictEqual(mSummary.winRate, 75);
  assert.strictEqual(mSummary.grossPnl, 500);
  assert.strictEqual(mSummary.charges, 270);
  assert.strictEqual(mSummary.netPnl, 230);
  assert.strictEqual(mSummary.bestDay.date, '2026-10-01');
  assert.strictEqual(mSummary.bestDay.netPnl, 2850);
  assert.strictEqual(mSummary.worstDay.date, '2026-10-05');
  assert.strictEqual(mSummary.worstDay.netPnl, -3080);
});

test('Monthly Journal: archiveDayToJournal is idempotent and preserves history across months', () => {
  const journal = { version: 2, months: {} };
  const trades = [
    { id: 'tr_101', symbol: 'NIFTY', side: 'BUY', qty: 50, entry: 100, exit: 120, pnl: 1000, charges: 40, netPnl: 960 }
  ];

  // First archive
  R.archiveDayToJournal(journal, '2026-10-15', trades, { trades: 1, pnl: 960 });
  assert.ok(journal.months['2026-10']);
  assert.strictEqual(journal.months['2026-10'].days['2026-10-15'].trades.length, 1);

  // Second archive of same day (must update, not duplicate)
  R.archiveDayToJournal(journal, '2026-10-15', trades, { trades: 1, pnl: 960 });
  assert.strictEqual(journal.months['2026-10'].days['2026-10-15'].trades.length, 1);

  // Archive a subsequent month (e.g. November)
  const novTrades = [
    { id: 'tr_201', symbol: 'BANKNIFTY', side: 'BUY', qty: 30, entry: 200, exit: 250, pnl: 1500, charges: 50, netPnl: 1450 }
  ];
  R.archiveDayToJournal(journal, '2026-11-02', novTrades, { trades: 1, pnl: 1450 });

  // Both months must coexist without data loss
  assert.ok(journal.months['2026-10'], 'October data must persist');
  assert.ok(journal.months['2026-11'], 'November data must be created');
  assert.strictEqual(journal.months['2026-10'].days['2026-10-15'].trades.length, 1);
  assert.strictEqual(journal.months['2026-11'].days['2026-11-02'].trades.length, 1);
});

test('Export Security: formatCsvCell prevents formula injection attack in spreadsheet applications', () => {
  // Cells starting with =, +, -, @, \t, \r must be prefixed with a single quote '
  assert.strictEqual(R.formatCsvCell('=SUM(A1:A10)'), "'=SUM(A1:A10)");
  assert.strictEqual(R.formatCsvCell('+1+2'), "'+1+2");
  assert.strictEqual(R.formatCsvCell('-100'), "'-100");
  assert.strictEqual(R.formatCsvCell('@HYPERLINK("http://evil.com")'), `"'@HYPERLINK(""http://evil.com"")"`);

  // Regular cells
  assert.strictEqual(R.formatCsvCell('NIFTY 24500 CE'), 'NIFTY 24500 CE');
  assert.strictEqual(R.formatCsvCell(120.5), '120.5');
  assert.strictEqual(R.formatCsvCell('Trade with, comma'), '"Trade with, comma"');
});

test('Export Scopes: exportJournalData exports day, month, all, and custom range correctly in CSV and JSON', () => {
  const journal = {
    version: 2,
    months: {
      '2026-10': {
        month: '2026-10',
        days: {
          '2026-10-01': { date: '2026-10-01', trades: [{ id: 'a1', at: 1790800000000, symbol: 'NIFTY', side: 'BUY', pnl: 500, charges: 40, netPnl: 460 }] },
          '2026-10-15': { date: '2026-10-15', trades: [{ id: 'a2', at: 1792000000000, symbol: 'BANKNIFTY', side: 'SELL', pnl: -300, charges: 40, netPnl: -340 }] }
        }
      },
      '2026-11': {
        month: '2026-11',
        days: {
          '2026-11-03': { date: '2026-11-03', trades: [{ id: 'b1', at: 1793600000000, symbol: 'FINNIFTY', side: 'BUY', pnl: 800, charges: 40, netPnl: 760 }] }
        }
      }
    }
  };

  // 1. Month Scope
  const monthCsv = R.exportJournalData(journal, { scope: 'month', month: '2026-10', format: 'csv' });
  assert.strictEqual(monthCsv.recordCount, 2);
  assert.ok(monthCsv.text.includes('NIFTY'));
  assert.ok(monthCsv.text.includes('BANKNIFTY'));
  assert.strictEqual(monthCsv.text.includes('FINNIFTY'), false);

  // 2. Day Scope
  const dayJson = R.exportJournalData(journal, { scope: 'day', date: '2026-10-01', format: 'json' });
  assert.strictEqual(dayJson.recordCount, 1);
  assert.strictEqual(dayJson.data.trades[0].id, 'a1');

  // 3. All History Scope
  const allCsv = R.exportJournalData(journal, { scope: 'all', format: 'csv' });
  assert.strictEqual(allCsv.recordCount, 3);
  assert.ok(allCsv.text.includes('NIFTY') && allCsv.text.includes('BANKNIFTY') && allCsv.text.includes('FINNIFTY'));

  // 4. Custom Date Range Scope
  const customJson = R.exportJournalData(journal, {
    scope: 'custom',
    startDate: '2026-10-10',
    endDate: '2026-11-01',
    format: 'json'
  });
  assert.strictEqual(customJson.recordCount, 1);
  assert.strictEqual(customJson.data.trades[0].id, 'a2');
});

// ---------------------------------------- 4. Sahi Broker Support ----

test('Sahi Broker Support: web.sahi.com is recognized with honest capability status', () => {
  const profile = detector.getBrokerAdapterProfile('web.sahi.com');
  assert.ok(profile, 'Profile for web.sahi.com must exist');
  assert.strictEqual(profile.name, 'Sahi Web');
  assert.strictEqual(profile.domainRecognized, true);
  assert.strictEqual(profile.detectionStatus, 'DETECTION_VERIFIED');
  assert.strictEqual(profile.restrictionStatus, 'RESTRICTION_UNAVAILABLE');
  assert.strictEqual(profile.newOrderRestrictionImplemented, false);

  // Test scan / adapter status
  const status = detector.adapterStatus('web.sahi.com');
  assert.strictEqual(status.domainRecognized, true);
  assert.strictEqual(status.detectionStatus, 'DETECTION_VERIFIED');
  assert.strictEqual(status.restrictionStatus, 'RESTRICTION_UNAVAILABLE');
});

// ---------------------------------------- 5. Paid Plans Catalog ----

test('Paid Plans Catalog: Client and server plan catalogs match proposed pricing', () => {
  const expectedPlans = [
    { id: 'free', amount: 0 },
    { id: 'pro_monthly', amount: 19900 },
    { id: 'pro_yearly', amount: 149900 },
    { id: 'pro_plus_ai_monthly', amount: 39900 },
    { id: 'pro_plus_ai_yearly', amount: 399900 },
    { id: 'founder_lifetime', amount: 299900 }
  ];

  // Verify server plans catalog
  expectedPlans.forEach(p => {
    const sPlan = serverPlans.PLANS[p.id];
    assert.ok(sPlan, `Server plan ${p.id} must exist`);
    assert.strictEqual(sPlan.amount, p.amount, `Price for ${p.id} must be ${p.amount} paise`);
  });

  // Verify options/options.html contains Upgrade / Plans entry points
  const optionsHtml = fs.readFileSync(path.join(rootDir, 'options/options.html'), 'utf8');
  assert.ok(optionsHtml.includes('Pro 30-Day'), 'Options must present 30-day prepaid Pro');
  assert.ok(optionsHtml.includes('365 days'), 'Options must present 365-day prepaid access');
  assert.ok(optionsHtml.includes('Pro+ AI 30-Day'), 'Options must present 30-day prepaid Pro+');
  assert.ok(optionsHtml.includes('no auto-renewal'), 'Options must disclose prepaid non-renewing access');
  assert.strictEqual(optionsHtml.includes('Recurring subscriptions can be managed or cancelled'), false);
  assert.ok(optionsHtml.includes('Founder Lifetime'), 'Options must present Founder Lifetime');
  assert.ok(optionsHtml.includes('Plan Comparison Matrix'), 'Options must include full plan comparison table');
});

// ---------------------------------------- 6. Plan Entitlement Validation ----

test('Plan Entitlement: isPro() recognises all canonical plans, aliases, and rejects free/expired/invalid', () => {
  const now = Date.now();
  const future = now + 30 * 24 * 3600 * 1000;
  const past = now - 1000;

  // Canonical paid plans
  assert.strictEqual(R.isPro({ key: 'TL-TEST-1', plan: 'pro_monthly', expiresAt: future }, now), true, 'pro_monthly must be Pro');
  assert.strictEqual(R.isPro({ key: 'TL-TEST-2', plan: 'pro_yearly', expiresAt: future }, now), true, 'pro_yearly must be Pro');
  assert.strictEqual(R.isPro({ key: 'TL-TEST-3', plan: 'pro_plus_ai_monthly', expiresAt: future }, now), true, 'pro_plus_ai_monthly must be Pro');
  assert.strictEqual(R.isPro({ key: 'TL-TEST-4', plan: 'pro_plus_ai_yearly', expiresAt: future }, now), true, 'pro_plus_ai_yearly must be Pro');
  assert.strictEqual(R.isPro({ key: 'TL-TEST-5', plan: 'founder_lifetime', expiresAt: null }, now), true, 'founder_lifetime must be Pro');

  // Legacy aliases
  assert.strictEqual(R.isPro({ key: 'TL-TEST-6', plan: 'pro_plus_ai', expiresAt: future }, now), true, 'pro_plus_ai alias must be Pro');
  assert.strictEqual(R.isPro({ key: 'TL-TEST-7', plan: 'lifetime', expiresAt: null }, now), true, 'lifetime alias must be Pro');

  // Free plan is never Pro
  assert.strictEqual(R.isPro({ key: 'TL-FREE-1', plan: 'free' }, now), false, 'free plan must not be Pro');

  // Expired licenses
  assert.strictEqual(R.isPro({ key: 'TL-EXP-1', plan: 'pro_monthly', expiresAt: past }, now), false, 'Expired pro_monthly must not be Pro');
  assert.strictEqual(R.isPro({ key: 'TL-EXP-2', plan: 'pro_plus_ai_monthly', expiresAt: past }, now), false, 'Expired pro_plus_ai_monthly must not be Pro');

  // Invalid / inactive / bogus licenses
  assert.strictEqual(R.isPro(null, now), false, 'null license must not be Pro');
  assert.strictEqual(R.isPro({ key: '' }, now), false, 'missing key must not be Pro');
  assert.strictEqual(R.isPro({ key: 'TL-123', active: false, plan: 'founder_lifetime' }, now), false, 'inactive license must not be Pro');
  assert.strictEqual(R.isPro({ key: 'TL-123', plan: 'nonexistent_plan' }, now), false, 'unknown plan must not be Pro');
  assert.strictEqual(R.isPro({ key: 'TL-REV-1', plan: 'pro_monthly', revoked: true, expiresAt: future }, now), false, 'revoked license must not be Pro');

  // canonicalPlanId normalization
  assert.strictEqual(R.canonicalPlanId('pro_plus_ai'), 'pro_plus_ai_monthly');
  assert.strictEqual(R.canonicalPlanId('lifetime'), 'founder_lifetime');
  assert.strictEqual(R.canonicalPlanId('pro_monthly'), 'pro_monthly');
  assert.strictEqual(R.canonicalPlanId('free'), 'free');
  assert.strictEqual(R.canonicalPlanId(null), 'free');
});

// ---------------------------------------- 7. Message Spoofing & Reset Protection ----

test('Message Spoofing: TL_RESET and TL_RESET_STATS handlers strictly reject manual reset bypasses', () => {
  const lockJs = fs.readFileSync(path.join(rootDir, 'content/lock.js'), 'utf8');

  // TL_RESET must reject with RESET_BYPASS_DISABLED
  assert.ok(lockJs.includes("if (msg.type === 'TL_RESET')"), 'Must contain TL_RESET handler');
  assert.ok(lockJs.includes("error: 'RESET_BYPASS_DISABLED'"), 'TL_RESET must return RESET_BYPASS_DISABLED');

  // TL_RESET_STATS must reject with RESET_BYPASS_DISABLED
  assert.ok(lockJs.includes("if (msg.type === 'TL_RESET_STATS')"), 'Must contain TL_RESET_STATS handler');

  // Background must not handle reset messages
  const bgJs = fs.readFileSync(path.join(rootDir, 'background.js'), 'utf8');
  assert.strictEqual(bgJs.includes("msg.type === 'TL_RESET'"), false, 'background.js must never process TL_RESET');
  assert.strictEqual(bgJs.includes("msg.type === 'TL_RESET_STATS'"), false, 'background.js must never process TL_RESET_STATS');
});

test('Lock Release Authorization: TL_RELEASED validates storage state, TL_RELEASE_MANUAL protects rule locks, and emergency override enforces justification', () => {
  const lockJs = fs.readFileSync(path.join(rootDir, 'content/lock.js'), 'utf8');

  // TL_RELEASED must verify storage state and unlock timestamp before releasing
  assert.ok(lockJs.includes("msg.type === 'TL_RELEASED'"), 'Must contain TL_RELEASED handler');
  assert.ok(lockJs.includes("chrome.storage.local.get(['tlState']"), 'TL_RELEASED must verify authoritative stored state');
  assert.ok(lockJs.includes("LOCK_STILL_ACTIVE"), 'TL_RELEASED must reject early unexpired unlock attempts');

  // TL_RELEASE_MANUAL must protect rule-triggered locks
  assert.ok(lockJs.includes("msg.type === 'TL_RELEASE_MANUAL'"), 'Must contain TL_RELEASE_MANUAL handler');
  assert.ok(lockJs.includes("RULE_LOCK_PROTECTED"), 'TL_RELEASE_MANUAL must reject rule-triggered locks');

  // TL_EMERGENCY_OVERRIDE must disallow override via runtime messages
  assert.ok(lockJs.includes("msg.type === 'TL_EMERGENCY_OVERRIDE'"), 'Must contain TL_EMERGENCY_OVERRIDE handler');
  assert.ok(lockJs.includes("OVERRIDE_VIA_MESSAGE_DISALLOWED"), 'TL_EMERGENCY_OVERRIDE must disallow message bypass');
});

// ---------------------------------------- 8. Active Risk Lock Rollover Preservation ----

test('Rollover Preservation: syncSession preserves active rule lock across date rollover until market open', () => {
  const S = Object.assign({}, R.DEFAULT_SETTINGS, {
    maxDailyLoss: 5000,
    enforcementMode: 'warning'
  });

  // Day 1: Tuesday at 14:30 IST — trader hits daily loss limit and triggers rule lock
  const tDay1 = new Date(Date.UTC(2026, 9, 13, 9, 0)).getTime(); // 14:30 IST
  const state = R.syncSession(R.defaultState(tDay1), S, tDay1);
  R.logTrade(state, S, { pnl: -6000, risk: 1000 }, tDay1);
  const evaluated = R.tick(state, S, tDay1);
  assert.strictEqual(evaluated.state.lock.active, true, 'Lock must be active on Day 1');
  assert.strictEqual(evaluated.state.status, 'LOCKED', 'Status must be LOCKED on Day 1');
  const unlockTime = evaluated.state.lock.until;

  // Day 2 morning: 08:30 IST (before market open at 09:15 IST)
  // Calendar date has changed, but unlock time has NOT been reached yet
  const tDay2Morning = new Date(Date.UTC(2026, 9, 14, 3, 0)).getTime(); // 08:30 IST
  assert.ok(tDay2Morning < unlockTime, '08:30 IST is before market open unlock time');

  const rolledState = R.syncSession(evaluated.state, S, tDay2Morning);
  assert.strictEqual(rolledState.lock.active, true, 'Active risk lock MUST be preserved across date rollover');
  assert.strictEqual(rolledState.status, 'LOCKED', 'Status MUST remain LOCKED before market open');
  assert.strictEqual(rolledState.session.trades, 1, 'Previous session counters intact before 09:15 open');

  // Day 2 market open: 09:16 IST (after 09:15 market open)
  const tDay2Open = unlockTime + 1000;
  const unlockedState = R.syncSession(rolledState, S, tDay2Open);
  assert.strictEqual(unlockedState.lock.active, false, 'Lock must release once market open is reached');
  assert.strictEqual(unlockedState.status, 'NORMAL', 'Status must return to NORMAL after market open');
  assert.strictEqual(unlockedState.session.trades, 0, 'Counters must be freshly initialized for new session at market open');
});

// ---------------------------------------- 9. AI Grounding & Lock Separation ----

test('AI Grounding: options.js refuses unverified live market figures and prominently labels demo data', () => {
  const optionsJs = fs.readFileSync(path.join(rootDir, 'options/options.js'), 'utf8');
  const optionsHtml = fs.readFileSync(path.join(rootDir, 'options/options.html'), 'utf8');

  // Must not contain hardcoded fake market text
  assert.strictEqual(optionsJs.includes('NIFTY Put-Call Ratio (PCR): 1.08'), false, 'Hardcoded 1.08 PCR must be eliminated');
  assert.strictEqual(optionsJs.includes('Call Wall (Resistance): 24,700'), false, 'Hardcoded 24,700 wall must be eliminated');
  assert.strictEqual(optionsJs.includes('Nearest Resistance: 24,620'), false, 'Hardcoded 24,620 resistance must be eliminated');

  // Must refuse unverified live market feeds and declare live data unavailable
  assert.ok(optionsJs.includes('LIVE MARKET DATA UNAVAILABLE'), 'Must refuse unverified live market requests');
  assert.ok(optionsJs.includes('SIMULATED DEMO DATA — NOT LIVE MARKET FEED'), 'Must prominently label demo data when requested');
  assert.ok(optionsJs.includes('Authoritative trading locks are executed strictly by the rules engine and cannot be altered by AI'), 'Must declare risk engine separation');

  // Options tab in options.html must display prominent simulated demo data warning
  assert.ok(optionsHtml.includes('SIMULATED DEMO DATA — NOT LIVE MARKET FEED'), 'Options tab must show prominent warning callout');
});

// ---------------------------------------- 10. Lock UX & Sahi Capability Consistency ----

test('Lock UX & Sahi Consistency: Mode A is described as full-screen discipline lock and Sahi is Monitoring Only', () => {
  const optionsHtml = fs.readFileSync(path.join(rootDir, 'options/options.html'), 'utf8');
  const popupJs = fs.readFileSync(path.join(rootDir, 'popup/popup.js'), 'utf8');
  const backgroundJs = fs.readFileSync(path.join(rootDir, 'background.js'), 'utf8');

  // Mode A must be full-screen discipline lock, not banner alert only
  assert.ok(optionsHtml.includes('Mode A: Full-Screen Discipline Lock'), 'Mode A must be labeled Full-Screen Discipline Lock');
  assert.strictEqual(optionsHtml.includes('Banner alert only, broker page remains interactive'), false, 'Obsolete banner alert wording must be removed');

  // Popup must display Full-Screen Discipline Lock Active when locked in Mode A
  assert.ok(popupJs.includes('Full-Screen Discipline Lock Active'), 'Popup must reflect full-screen discipline lock');

  // Background must never process reset messages
  assert.strictEqual(backgroundJs.includes("msg.type === 'TL_RESET'"), false, 'background.js must never process reset messages');

  // Sahi must be labeled Monitoring Only
  assert.ok(optionsHtml.includes('Monitoring Only'), 'Sahi badge must be Monitoring Only');
});

// ---------------------------------------- 11. Centralized Lock Authorization & Bypass Prevention ----

test('Centralized Lock Authorization: background owns transitions, popup cannot bypass, and malformed until is repaired', () => {
  const bgJs = fs.readFileSync(path.join(rootDir, 'background.js'), 'utf8');
  const popupJs = fs.readFileSync(path.join(rootDir, 'popup/popup.js'), 'utf8');
  const lockJs = fs.readFileSync(path.join(rootDir, 'content/lock.js'), 'utf8');

  // 1. Background releaseIfDue hardens against NaN or missing until timestamps
  assert.ok(bgJs.includes('isNaN(until) || until <= 0'), 'releaseIfDue must check for NaN or non-positive until');
  assert.ok(bgJs.includes('Active lock has invalid until timestamp. Repairing until market open.'), 'releaseIfDue must repair invalid until and preserve lock');
  assert.ok(bgJs.includes('now < until'), 'releaseIfDue must ensure now >= until before releasing');

  // 2. Background authoritatively owns TL_RELEASE_MANUAL and rejects rule-triggered locks
  assert.ok(bgJs.includes("msg.type === 'TL_RELEASE_MANUAL'"), 'background.js must handle TL_RELEASE_MANUAL authoritatively');
  assert.ok(bgJs.includes('RULE_LOCK_PROTECTED'), 'background.js must reject manual release for rule locks');

  // 3. Popup Undo cannot clear active locks or call releaseLock
  assert.strictEqual(popupJs.includes('R.releaseLock('), false, 'popup.js must never call R.releaseLock');
  assert.strictEqual(popupJs.includes('releaseLock(state)'), false, 'popup.js must never call releaseLock(state)');
  assert.ok(popupJs.includes('Discipline lock is active. Trade counts and losses cannot be reversed while locked.'), 'popup.js must disallow undo during active rule lock');

// 4. Content script verifies background storage before adopting release
  assert.ok(lockJs.includes('The background service worker is the sole authoritative owner of lock release.'), 'content/lock.js must document centralized authority');
  assert.ok(lockJs.includes('LOCK_STILL_ACTIVE'), 'content/lock.js must reject release notification when background lock is active');
});

// ---------------------------------------- 12. Build 10 Lock Release Hardening & Fail-Closed State Recovery ----

test('Build 10 Hardening: content/lock.js fails closed on missing/corrupt storage during TL_RELEASED', () => {
  const lockJs = fs.readFileSync(path.join(rootDir, 'content/lock.js'), 'utf8');

  // Must not have fallback that clears local lock state when tlState is missing
  assert.strictEqual(
    lockJs.includes("state.lock = { active: false, reason: null, since: null, until: null, manual: false"),
    false,
    'content/lock.js must never clear local lock when storage is missing'
  );

  // Must treat missing or unreadable authoritative state as recovery condition
  assert.ok(lockJs.includes('STORAGE_STATE_MISSING_OR_CORRUPT'), 'Must return STORAGE_STATE_MISSING_OR_CORRUPT');
  assert.ok(lockJs.includes('TL_CHECK_RELEASE'), 'Must request state recovery via TL_CHECK_RELEASE');
  assert.ok(lockJs.includes("!stored || !stored.lock || typeof stored.lock.active !== 'boolean'"), 'Must validate stored state format strictly');
});

test('Build 10 Hardening: background.js serializes transitions and enforces sender validation + confirmation for TL_RELEASE_MANUAL', () => {
  const bgJs = fs.readFileSync(path.join(rootDir, 'background.js'), 'utf8');

  // Must serialize operations via opQueue
  assert.ok(bgJs.includes('enqueueOp'), 'background.js must serialize state transitions through enqueueOp');
  assert.ok(bgJs.includes('opQueue'), 'background.js must maintain opQueue');

  // Must validate sender
  assert.ok(bgJs.includes('UNAUTHORIZED_SENDER'), 'Must reject unauthorized sender for manual release');
  assert.ok(bgJs.includes('sender.id !== chrome.runtime.id'), 'Must check sender extension id');

  // Must require explicit user confirmation
  assert.ok(bgJs.includes('CONFIRMATION_REQUIRED'), 'Must require explicit confirmation for manual release');
  assert.ok(bgJs.includes('!msg.confirmed'), 'Must check msg.confirmed flag');

  // Must notify tabs only AFTER storage set succeeds
  assert.ok(bgJs.indexOf("notifyTabs('TL_RELEASED'") > bgJs.indexOf('chrome.storage.local.set'), 'Must notify tabs only after storage write completes');
});

test('Build 10 Hardening: popup.js provides explicit user confirmation and gates manual release', () => {
  const popupJs = fs.readFileSync(path.join(rootDir, 'popup/popup.js'), 'utf8');

  assert.ok(popupJs.includes('Release focus lock'), 'Popup must offer release focus lock for manual locks');
  assert.ok(popupJs.includes('Rule lock active'), 'Popup must label rule lock active');
  assert.ok(popupJs.includes('TL_RELEASE_MANUAL'), 'Popup must send TL_RELEASE_MANUAL');
  assert.ok(popupJs.includes('confirmed: true'), 'Popup must pass confirmed: true upon user confirmation');
});

// ---------------------------------------- 13. Build 11: Side Panel, Live Data, Lock Safety & Exports ----

test('Build 11: Manifest and Background support Chrome Side Panel API (Chrome 114+)', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'manifest.json'), 'utf8'));
  const bgJs = fs.readFileSync(path.join(rootDir, 'background.js'), 'utf8');
  const popupHtml = fs.readFileSync(path.join(rootDir, 'popup/popup.html'), 'utf8');
  const popupJs = fs.readFileSync(path.join(rootDir, 'popup/popup.js'), 'utf8');

  assert.ok(manifest.permissions.includes('sidePanel'), 'manifest.json must include sidePanel permission');
  assert.ok(manifest.side_panel && manifest.side_panel.default_path === 'options/options.html', 'manifest.json must declare side_panel default_path');
  assert.ok(parseInt(manifest.minimum_chrome_version, 10) >= 114, 'manifest minimum_chrome_version must be >= 114 for Side Panel');

  assert.ok(bgJs.includes("msg.type === 'TL_OPEN_SIDE_PANEL'"), 'background.js must handle TL_OPEN_SIDE_PANEL');
  assert.ok(popupHtml.includes('id="openSidePanelBtn"'), 'popup.html must have openSidePanelBtn');
  assert.ok(popupJs.includes('openSidePanelBtn'), 'popup.js must wire openSidePanelBtn');
});

test('Build 11: Market & OI is honestly labeled as Simulated Demo Data without false real-time claims', () => {
  const optionsHtml = fs.readFileSync(path.join(rootDir, 'options/options.html'), 'utf8');
  const optionsJs = fs.readFileSync(path.join(rootDir, 'options/options.js'), 'utf8');

  // Must include prominent demo data warning in market section
  assert.ok(optionsHtml.includes('SIMULATED DEMO DATA — NOT LIVE MARKET FEED'), 'options.html must clearly display simulated demo data warning');
  assert.strictEqual(optionsHtml.includes('Real-time open interest distribution'), false, 'options.html must NOT claim real-time open interest distribution for deterministic model');

  // options.js must clarify deterministic demo data
  assert.ok(optionsJs.includes('Deterministic Model (Simulated Demo Data)'), 'options.js must label market note as deterministic demo');
  assert.ok(optionsJs.includes('Live exchange WebSocket feed is not connected'), 'options.js must warn when unconnected live source is selected');
});

test('Build 11: Preview lock cannot overwrite or cancel an active real trading lock', () => {
  const optionsJs = fs.readFileSync(path.join(rootDir, 'options/options.js'), 'utf8');

  assert.ok(optionsJs.includes("state.lock && state.lock.active && state.lock.reason !== 'preview'"), 'Preview lock must check for existing active trading lock');
  assert.ok(optionsJs.includes('Cannot preview lock while an authoritative active trading lock is in effect'), 'Preview lock must reject when real lock is active');
});

test('Build 11: Free users have uninhibited access to export their own trade logs to CSV', () => {
  const optionsJs = fs.readFileSync(path.join(rootDir, 'options/options.js'), 'utf8');

  // Must NOT disable exportLogBtn for free users in applyPlanGating
  assert.strictEqual(optionsJs.includes("el('exportLogBtn').disabled = plan.free"), false, 'applyPlanGating must not disable exportLogBtn for free users');

  // Must NOT have a paywall alert blocking exportLogBtn click
  assert.strictEqual(optionsJs.includes("if (plan.free) { alert('Trade log export is a Pro feature"), false, 'exportLogBtn must not show paywall alert for free users');
});

test('Build 11: AI Coach discipline audit reports insufficient data on 0 trades instead of 100/100', () => {
  const optionsJs = fs.readFileSync(path.join(rootDir, 'options/options.js'), 'utf8');

  assert.ok(optionsJs.includes('!currentState.session.trades'), 'AI coach must check if session trades is 0');
  assert.ok(optionsJs.includes('Insufficient trade data for discipline audit (0 trades recorded today)'), 'AI coach must report insufficient trade data on 0 trades');
});

// ---------------------------------------- 14. Release Candidate: Verified Defect Fixes ----

test('Build 11 RC: Everyday shortcuts route through Side Panel and activate requested section', () => {
  const popupJs = fs.readFileSync(path.join(rootDir, 'popup/popup.js'), 'utf8');
  const bgJs = fs.readFileSync(path.join(rootDir, 'background.js'), 'utf8');
  const optionsJs = fs.readFileSync(path.join(rootDir, 'options/options.js'), 'utf8');

  // Popup shortcuts must call openWorkspace
  assert.ok(popupJs.includes("openWorkspace('market')"), 'qaCharts must route to openWorkspace market');
  assert.ok(popupJs.includes("openWorkspace('options')"), 'qaOptions must route to openWorkspace options');
  assert.ok(popupJs.includes("openWorkspace('ai')"), 'qaAi must route to openWorkspace ai');
  assert.ok(popupJs.includes("openWorkspace('journal')"), 'qaJournal must route to openWorkspace journal');
  assert.ok(popupJs.includes("openWorkspace('rules')"), 'qaRules must route to openWorkspace rules');

  // Background must set tlActiveTab and broadcast TL_SWITCH_TAB
  assert.ok(bgJs.includes('tlActiveTab: requestedTab'), 'background.js must save requested tab to tlActiveTab');
  assert.ok(bgJs.includes("type: 'TL_SWITCH_TAB'"), 'background.js must broadcast TL_SWITCH_TAB to active panel');

  // options.js must listen for TL_SWITCH_TAB and read tlActiveTab
  assert.ok(optionsJs.includes("msg.type === 'TL_SWITCH_TAB'"), 'options.js must listen for TL_SWITCH_TAB');
  assert.ok(optionsJs.includes("res.tlActiveTab"), 'options.js must check stored tlActiveTab on load');
});

test('Build 11 RC: Expiry selection dynamically scales calculations and timestamp specifies Demo Render Time', () => {
  const optionsJs = fs.readFileSync(path.join(rootDir, 'options/options.js'), 'utf8');
  const optionsHtml = fs.readFileSync(path.join(rootDir, 'options/options.html'), 'utf8');

  // Expiry selection must affect DTE, theta and premiums
  assert.ok(optionsJs.includes("var expiry = el('marketExpiry') ? el('marketExpiry').value : 'current'"), 'marketExpiry must be read');
  assert.ok(optionsJs.includes("var expiry = el('optionsExpiry') ? el('optionsExpiry').value : 'current'"), 'optionsExpiry must be read');
  assert.ok(optionsJs.includes("expiry === 'monthly' ? 23 : (expiry === 'next' ? 9 : 2)"), 'DTE must scale with selected expiry');
  assert.ok(optionsJs.includes('dteFactor'), 'Option prices must scale with dteFactor');

  // Timestamp must clearly state Demo Render Time
  assert.ok(optionsJs.includes("'Demo Render Time: ' + timeStr"), 'options.js must label timestamp as Demo Render Time');
  assert.ok(optionsHtml.includes('Demo Render Time:'), 'options.html must display Demo Render Time');
});

test('Build 11 RC: exportLogBtn label does not claim Pro and emergencyOverride is not exposed in production', () => {
  const optionsHtml = fs.readFileSync(path.join(rootDir, 'options/options.html'), 'utf8');
  const bgJs = fs.readFileSync(path.join(rootDir, 'background.js'), 'utf8');

  // exportLogBtn label must not say Pro
  assert.strictEqual(optionsHtml.includes('Export trade log (CSV) — Pro'), false, 'exportLogBtn label must not claim Pro');
  assert.ok(optionsHtml.includes('<button id="exportLogBtn">Export trade log (CSV)</button>'), 'exportLogBtn must be plain un-gated button');

  // emergencyOverrideLock must not be exposed as a message handler in background.js
  assert.strictEqual(bgJs.includes('emergencyOverrideLock'), false, 'background.js must not expose emergencyOverrideLock');
});






test('Journal Accessibility: delete controls have names and broker side text is escaped', () => {
  const optionsJs = fs.readFileSync(path.join(rootDir, 'options', 'options.js'), 'utf8');
  assert.ok(optionsJs.includes('aria-label="Delete '), 'Icon-only journal deletion needs an accessible name');
  assert.ok(optionsJs.includes('title="Delete trade"'));
  assert.ok(optionsJs.includes("escapeHtml(t.side || 'BUY')"), 'Broker-provided side labels must not become HTML');
  const optionsHtml = fs.readFileSync(path.join(rootDir, 'options', 'options.html'), 'utf8');
  assert.ok(optionsHtml.includes('id="marketCandleCanvas" tabindex="0"'));
  assert.ok(optionsHtml.includes('aria-label="Zoom in"') && optionsHtml.includes('aria-label="Zoom out"'));
  assert.ok(optionsJs.includes("canvas.addEventListener('keydown'"), 'Chart pan/zoom must be keyboard operable');
});


test('Popup Entitlements: license-derived Pro/Pro+ values initialize before badge and quick actions', () => {
  const popupJs = fs.readFileSync(path.join(rootDir, 'popup', 'popup.js'), 'utf8');
  const renderAt = popupJs.indexOf('function render()');
  const proAt = popupJs.indexOf('var pro = R.isPro(view.license', renderAt);
  const plusAt = popupJs.indexOf('var proPlus = R.isProPlus', renderAt);
  const badgeAt = popupJs.indexOf('if (els.planBadge)', renderAt);
  assert.ok(proAt > renderAt && plusAt > proAt && badgeAt > plusAt, 'Entitlements must be assigned before they are rendered');
  assert.ok(popupJs.includes('if (!pro) {'), 'Free badge must come from license state, not a missing freeTier default');
});


test('Popup Mode B copy follows real adapter verification and fallback status', () => {
  const html = fs.readFileSync(path.join(rootDir, 'popup/popup.html'), 'utf8');
  const js = fs.readFileSync(path.join(rootDir, 'popup/popup.js'), 'utf8');
  assert.ok(html.includes('../lib/detector.js'), 'popup must load the shared adapter registry');
  assert.ok(js.includes('detector.isVerifiedOrderRestrictionBroker(view.hostname)'));
  assert.ok(js.includes('detector.getEnforcementLabel(view.hostname, mode)'));
  assert.ok(js.includes('Full-Screen Lock Fallback Active'));
  assert.strictEqual(js.includes("els.bannerTitle.textContent = 'Order Restriction Active';"), false,
    'unconditional verified-order status must not return');
});
