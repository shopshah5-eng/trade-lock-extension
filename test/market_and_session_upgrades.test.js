// test/market_and_session_upgrades.test.js
// Automated verification for market analytics upgrades, Black-Scholes Greeks,
// weekend planning mode, broker capabilities, and Side Panel configuration.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const M = require(path.join(rootDir, 'lib/market.js'));
const R = require(path.join(rootDir, 'lib/rules.js'));

test('Instruments: all 6 Indian exchange indices are supported with correct lot and step size', () => {
  const instruments = M.INSTRUMENTS;
  assert.ok(instruments, 'INSTRUMENTS config must be defined');

  const requiredSymbols = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX'];
  requiredSymbols.forEach((sym) => {
    const inst = instruments[sym];
    assert.ok(inst, `Instrument ${sym} must be configured`);
    assert.ok(inst.name && inst.name.length > 0, `${sym} must have a descriptive name`);
    assert.ok(inst.exchange === 'NSE' || inst.exchange === 'BSE', `${sym} exchange must be NSE or BSE`);
    assert.ok(typeof inst.basePrice === 'number' && inst.basePrice > 0, `${sym} must have a positive basePrice`);
    assert.ok(typeof inst.step === 'number' && inst.step > 0, `${sym} must have a positive strike step`);
    assert.ok(typeof inst.lotSize === 'number' && inst.lotSize > 0, `${sym} must have a positive lotSize`);
  });

  assert.strictEqual(instruments.NIFTY.step, 50);
  assert.strictEqual(instruments.BANKNIFTY.step, 100);
  assert.strictEqual(instruments.SENSEX.exchange, 'BSE');
  assert.strictEqual(instruments.BANKEX.exchange, 'BSE');
});

test('Timeframes: all 12 timeframe intervals are mapped and aggregateCandles operates accurately', () => {
  const tfMap = M.TIMEFRAME_MINUTES;
  assert.ok(tfMap, 'TIMEFRAME_MINUTES must be defined');

  const requiredTfs = ['1m', '3m', '5m', '10m', '15m', '30m', '45m', '1h', '2h', '4h', '1D', '1W'];
  requiredTfs.forEach((tf) => {
    assert.ok(typeof tfMap[tf] === 'number' && tfMap[tf] > 0, `Timeframe ${tf} must map to positive minutes`);
  });

  // Test candle aggregation from 1m to 5m with aligned baseTime
  const minuteMs = 60000;
  const baseTime = Math.floor(1700000000000 / (5 * minuteMs)) * (5 * minuteMs);
  const raw1m = [
    { t: baseTime, o: 100, h: 105, l: 99, c: 104, v: 1000 },
    { t: baseTime + minuteMs, o: 104, h: 108, l: 103, c: 107, v: 1500 },
    { t: baseTime + minuteMs * 2, o: 107, h: 107, l: 101, c: 102, v: 2000 },
    { t: baseTime + minuteMs * 3, o: 102, h: 106, l: 100, c: 105, v: 1200 },
    { t: baseTime + minuteMs * 4, o: 105, h: 110, l: 104, c: 109, v: 1800 }
  ];

  const agg5m = M.aggregateCandles(raw1m, 5);
  assert.strictEqual(agg5m.length, 1, '5x 1m candles within the same 5m bucket must aggregate to 1 candle');
  assert.strictEqual(agg5m[0].o, 100, 'Aggregated open must be first open');
  assert.strictEqual(agg5m[0].h, 110, 'Aggregated high must be max high');
  assert.strictEqual(agg5m[0].l, 99, 'Aggregated low must be min low');
  assert.strictEqual(agg5m[0].c, 109, 'Aggregated close must be last close');
  assert.strictEqual(agg5m[0].v, 7500, 'Aggregated volume must sum all volumes');
});

test('Greeks & Theta Analytics: Black-Scholes calculates distinct Call and Put Thetas and valid Greeks', () => {
  const S = 24500;  // Spot
  const K = 24500;  // ATM Strike
  const days = 7;   // 7 days to expiry
  const iv = 14;    // 14% IV
  const r = 0.065;  // 6.5% risk-free rate

  const callGreeks = M.calculateGreeks(S, K, days, iv, true, r);
  const putGreeks = M.calculateGreeks(S, K, days, iv, false, r);

  assert.ok(callGreeks, 'Call Greeks must be calculated');
  assert.ok(putGreeks, 'Put Greeks must be calculated');

  // Deltas
  assert.ok(callGreeks.delta > 0.45 && callGreeks.delta < 0.58, 'ATM Call Delta should be near 0.50');
  assert.ok(putGreeks.delta < -0.42 && putGreeks.delta > -0.55, 'ATM Put Delta should be near -0.50');
  assert.ok(Math.abs(callGreeks.delta - putGreeks.delta - 1.0) < 0.05, 'Call Delta - Put Delta should equal approx 1 (Put-Call Parity)');

  // Gammas and Vegas are identical for European vanilla calls & puts at same strike
  assert.ok(callGreeks.gamma > 0, 'Gamma must be strictly positive');
  assert.ok(callGreeks.vega > 0, 'Vega must be strictly positive');
  assert.strictEqual(callGreeks.gamma, putGreeks.gamma, 'Call and Put gamma must match at same strike');
  assert.strictEqual(callGreeks.vega, putGreeks.vega, 'Call and Put vega must match at same strike');

  // Theta: distinct call and put thetas due to interest drift
  assert.ok(callGreeks.thetaDay < 0, 'Call theta must be negative');
  assert.ok(putGreeks.thetaDay < 0, 'Put theta must be negative');
  assert.notStrictEqual(callGreeks.thetaDay, putGreeks.thetaDay, 'Call and Put theta must not be artificially identical');
  assert.strictEqual(callGreeks.theta1Hour, Math.round((callGreeks.thetaDay / 6.25) * 100) / 100, 'Hourly theta must be derived from 6.25 trading hours');
});

test('India VIX Analytics: computes regime, rank, percentile and flags volatility spikes', () => {
  assert.ok(typeof M.vixAnalytics === 'function', 'vixAnalytics function must exist');

  // Normal regime
  const normal = M.vixAnalytics(13.5, 13.2);
  assert.strictEqual(normal.status, 'NORMAL');
  assert.strictEqual(normal.isSpike, false);
  assert.ok(normal.ivRank > 0 && normal.ivRank <= 100, 'ivRank must be between 0 and 100');
  assert.ok(normal.ivPercentile !== undefined, 'ivPercentile must be calculated');

  // Spike alert (> 10% change)
  const spike = M.vixAnalytics(16.5, 14.0);
  assert.ok(spike.changePct >= 10, 'Change percent must reflect spike');
  assert.strictEqual(spike.isSpike, true, 'isSpike must be true for +17% spike');

  // Extreme panic regime (> 18)
  const extreme = M.vixAnalytics(26.0, 24.0);
  assert.strictEqual(extreme.status, 'ELEVATED');
  assert.strictEqual(extreme.ivRank, 100);
});

test('Weekend & Holiday Planning Mode: distinguishes planning sessions from active trading hours', () => {
  // Saturday at 11:00 AM IST (2026-10-24 is a Saturday)
  const satDate = new Date('2026-10-24T11:00:00+05:30').getTime();
  const settings = { skipWeekends: true, skipHolidays: true, holidays: '' };

  assert.strictEqual(R.isPlanningSession(satDate, settings), true, 'Saturday must be recognized as a planning session');
  assert.strictEqual(R.isMarketOpenHours(satDate, settings), false, 'Market must be closed on Saturday');

  const sessInfo = R.marketSessionInfo(satDate, settings);
  assert.strictEqual(sessInfo.isWeekend, true);
  assert.strictEqual(sessInfo.isOpen, false);
  assert.strictEqual(sessInfo.planningMode, true);
  assert.ok(sessInfo.message.includes('Planning Mode'), 'Session message must indicate planning mode on weekends');

  // Wednesday at 11:00 AM IST (2026-10-28 is a Wednesday)
  const wedDate = new Date('2026-10-28T11:00:00+05:30').getTime();
  assert.strictEqual(R.isPlanningSession(wedDate, settings), false, 'Wednesday morning during market hours is not a planning session');
  assert.strictEqual(R.isMarketOpenHours(wedDate, settings), true, 'Wednesday 11:00 AM must be open market hours');
});

test('Lock Now Behavior: supports duration options and does not trap user on weekend', () => {
  const satDate = new Date('2026-10-24T11:00:00+05:30').getTime();
  const state = R.defaultState(satDate);
  const settings = { skipWeekends: true, skipHolidays: true, holidays: '', weekendPlanningMode: true };

  // Manual self-lock with explicit duration
  R.lockNow(state, settings, satDate, { durationMinutes: 60 });
  assert.strictEqual(state.lock.active, true);
  assert.strictEqual(state.lock.until, satDate + 60 * 60 * 1000, 'lockNow with 60m duration must end after 60 minutes');

  // Manual self-lock with explicit weekendMode
  const state2 = R.defaultState(satDate);
  R.lockNow(state2, settings, satDate, { weekendMode: 'weekend_rest' });
  assert.strictEqual(state2.lock.active, true);
  assert.strictEqual(state2.lock.reason, 'weekend_rest');
  assert.strictEqual(state2.lock.weekendPlanningAllowed, true, 'Weekend rest lock must keep planning mode allowed');
});

test('Chrome Side Panel Integration: manifest declares side_panel and minimum version 116', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'manifest.json'), 'utf8'));

  assert.ok(manifest.permissions.includes('sidePanel'), 'manifest must include sidePanel permission');
  assert.strictEqual(manifest.side_panel.default_path, 'options/options.html', 'side_panel.default_path must point to options/options.html');
  assert.ok(parseInt(manifest.minimum_chrome_version, 10) >= 116, 'minimum_chrome_version must be at least 116 for sidePanel.open()');

  // Popup implementation must have direct chrome.sidePanel.open user gesture call
  const popupJs = fs.readFileSync(path.join(rootDir, 'popup/popup.js'), 'utf8');
  assert.ok(popupJs.includes('chrome.sidePanel.open'), 'popup.js must call chrome.sidePanel.open');
  assert.ok(popupJs.includes('openWorkspace'), 'popup.js must implement openWorkspace');
});

test('Broker Capability Audit: Honest labeling is maintained across UI', () => {
  const optionsHtml = fs.readFileSync(path.join(rootDir, 'options/options.html'), 'utf8');

  // Sahi Web must strictly be labeled Monitoring Only
  assert.ok(optionsHtml.includes('Sahi Web — MONITORING ONLY') || optionsHtml.includes('Monitoring Only'), 'Sahi must be labeled Monitoring Only');
  assert.strictEqual(optionsHtml.includes('Sahi Web — Full Order Blocking'), false, 'Sahi must never claim Full Order Blocking without broker-specific engine');

  // License server section hides localhost from ordinary users in a details element
  assert.ok(optionsHtml.includes('<details') && optionsHtml.includes('Developer Server Override'), 'options.html must contain expandable dev override details');
  assert.ok(optionsHtml.includes('trade-lock-app.netlify.app'), 'options.html must reference production Netlify endpoint');
  assert.ok(optionsHtml.includes('id="licApi"'), 'options.html must have licApi input field');
});

test('Section A: All 9 Workspace Tabs exist in HTML and map to autonomous render handlers in options.js', () => {
  const optionsHtml = fs.readFileSync(path.join(rootDir, 'options/options.html'), 'utf8');
  const optionsJs = fs.readFileSync(path.join(rootDir, 'options/options.js'), 'utf8');

  const requiredTabs = ['overview', 'market', 'options', 'charts', 'journal', 'ai', 'rules', 'license', 'sites'];

  requiredTabs.forEach((tabId) => {
    // Each tab section must exist in HTML
    assert.ok(optionsHtml.includes(`id="tab-${tabId}"`), `options.html must define section #tab-${tabId}`);
    // Each tab navigation button must exist in HTML
    assert.ok(optionsHtml.includes(`data-tab="${tabId}"`), `options.html must define nav button data-tab="${tabId}"`);
    // switchTab must specifically branch for each tabId
    assert.ok(optionsJs.includes(`clean === '${tabId}'`), `options.js switchTab must branch for clean === '${tabId}'`);
  });

  // Check that dedicated render routines are declared
  assert.ok(optionsJs.includes('function renderRiskRulesView'), 'options.js must define renderRiskRulesView');
  assert.ok(optionsJs.includes('function renderAiCoachView'), 'options.js must define renderAiCoachView');
  assert.ok(optionsJs.includes('function renderSitesView'), 'options.js must define renderSitesView');
  assert.ok(optionsJs.includes('function renderDedicatedChartsView'), 'options.js must define renderDedicatedChartsView');
  assert.ok(optionsJs.includes('function drawDedicatedSvgChart'), 'options.js must define drawDedicatedSvgChart');
  assert.ok(optionsJs.includes('jEmptyAddTradeBtn'), 'options.js must wire jEmptyAddTradeBtn for empty journal state');
});

test('Section B: Side Panel API Parameter Invariants and Switching Architecture', () => {
  const popupJs = fs.readFileSync(path.join(rootDir, 'popup/popup.js'), 'utf8');
  const bgJs = fs.readFileSync(path.join(rootDir, 'background.js'), 'utf8');

  // chrome.sidePanel.open must take { windowId }
  assert.ok(popupJs.includes('chrome.sidePanel.open(opts)'), 'popup.js must pass opts to chrome.sidePanel.open');
  assert.ok(popupJs.includes('{ windowId: activeWindowId }'), 'popup.js must build opts with windowId');

  // chrome.sidePanel.setOptions must NOT pass windowId (API violation)
  assert.ok(popupJs.includes("path: 'options/options.html#' + tabKey"), 'popup.js setOptions must specify path');
  assert.strictEqual(popupJs.includes("chrome.sidePanel.setOptions({ windowId"), false, 'setOptions must not pass windowId');

  // Background must handle TL_OPEN_SIDE_PANEL with windowId validation
  assert.ok(bgJs.includes("msg.type === 'TL_OPEN_SIDE_PANEL'"), 'background.js must handle TL_OPEN_SIDE_PANEL');
  assert.ok(bgJs.includes('chrome.sidePanel.open({ windowId: win.id })'), 'background.js must open side panel with windowId');
});

test('Section C: Truthful Live Market Feed vs Disconnected Setup State', () => {
  const bgJs = fs.readFileSync(path.join(rootDir, 'background.js'), 'utf8');
  const optionsHtml = fs.readFileSync(path.join(rootDir, 'options/options.html'), 'utf8');
  const optionsJs = fs.readFileSync(path.join(rootDir, 'options/options.js'), 'utf8');

  // Background must implement TL_CHECK_MARKET_FEED with Fyers endpoint probing and timeout
  assert.ok(bgJs.includes("msg.type === 'TL_CHECK_MARKET_FEED'"), 'background.js must implement TL_CHECK_MARKET_FEED handler');
  assert.ok(bgJs.includes('/api/market/live?symbol='), 'background.js must probe /api/market/live');
  // The provider is dynamic now (Upstox or Fyers), so it must be echoed from the
  // server response rather than hardcoded.
  assert.ok(bgJs.includes('provider: result.body.provider'), 'background.js must echo the server provider');
  assert.strictEqual(bgJs.includes("provider: 'Fyers API v3'"), false, 'provider must not be hardcoded');

  // options.html must contain setup cards for market and options
  assert.ok(optionsHtml.includes('id="liveMarketSetupCard"'), 'options.html must contain liveMarketSetupCard');
  assert.ok(optionsHtml.includes('id="liveOptionsSetupCard"'), 'options.html must contain liveOptionsSetupCard');

  // options.js must display setup cards when feed is disconnected without alert popup
  assert.ok(optionsJs.includes('live-setup-card'), 'options.js must use live-setup-card');
  assert.ok(optionsJs.includes('Fyers API v3'), 'options.js must reference Fyers API v3 provider truthfully');
  assert.strictEqual(optionsJs.includes("alert('Live exchange WebSocket feed is not connected"), false, 'options.js must NOT show disruptive alert');
});

test('Section D: Responsive CSS for Side Panel (width <= 480px)', () => {
  const css = fs.readFileSync(path.join(rootDir, 'options/dashboard.css'), 'utf8');

  // Must include narrow side panel breakpoint
  assert.ok(css.includes('@media (max-width: 480px)'), 'dashboard.css must include @media (max-width: 480px) rule for Chrome Side Panel');
  assert.ok(css.includes('grid-template-columns: 1fr'), 'dashboard.css must collapse multi-column grids to 1fr');
  assert.ok(css.includes('overflow-x: auto'), 'dashboard.css must provide horizontal scrolling for tables');
  assert.ok(css.includes('.live-setup-card'), 'dashboard.css must define live-setup-card styles');
});

