'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const TLRules = require('../lib/rules.js');

function createBackground(initial = {}) {
  const data = {
    tlSettings: Object.assign({ blockedHosts: ['kite.zerodha.com'] }, initial.settings || {}),
    tlState: initial.state || null,
    tlLicense: initial.license || null,
  };
  let listener;
  let storageListener;
  const dnrUpdates = [];
  const scriptExecutions = [];
  const tabMessages = [];
  const local = {
    get(keys, callback) {
      const names = Array.isArray(keys) ? keys : [keys];
      const result = {};
      names.forEach(k => { if (data[k] !== undefined) result[k] = data[k]; });
      if (callback) { queueMicrotask(() => callback(result)); return undefined; }
      return Promise.resolve(result);
    },
    set(values, callback) {
      Object.assign(data, values);
      if (callback) { queueMicrotask(callback); return undefined; }
      return Promise.resolve();
    },
  };
  const chrome = {
    storage: { local, onChanged: { addListener(fn) { storageListener = fn; } } },
    runtime: {
      id: 'trade-lock-test', onMessage: { addListener(fn) { listener = fn; } },
      onInstalled: { addListener() {} }, onStartup: { addListener() {} },
      getURL: p => 'chrome-extension://trade-lock-test/' + p,
    },
    alarms: {
      clear: () => Promise.resolve(true), create: () => Promise.resolve(),
      onAlarm: { addListener() {} },
    },
    action: {
      setBadgeBackgroundColor() {}, setBadgeText() {}, setBadgeImage() {},
    },
    tabs: {
      query(_q, cb) { if (cb) cb([]); return Promise.resolve([]); },
      get: () => Promise.resolve(null),
      sendMessage(tabId, message) { tabMessages.push({ tabId, message }); return Promise.resolve({ ok: true }); },
      onUpdated: { addListener() {} }, onActivated: { addListener() {} },
    },
    scripting: {
      executeScript(details) { scriptExecutions.push(details); return Promise.resolve([{}]); },
    },
    declarativeNetRequest: {
      updateDynamicRules(update) { dnrUpdates.push(update); return Promise.resolve(); },
    },
  };
  const context = {
    chrome, TLRules, TLDetect: require('../lib/detector.js'), console, URL, Date, Math, Promise, JSON, Number, String, Boolean,
    setInterval() { return 1; }, clearInterval() {}, setTimeout,
    importScripts() {}, fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(require.resolve('../background.js'), 'utf8'), context, { filename: 'background.js' });

  async function send(message, sender = { id: 'trade-lock-test', url: 'chrome-extension://trade-lock-test/popup/popup.html' }) {
    assert.strictEqual(typeof listener, 'function');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('message timed out: ' + message.type)), 2000);
      listener(message, sender, response => {
        clearTimeout(timer);
        resolve(response);
      });
    });
  }
  function emitStateChange(oldValue, newValue) {
    data.tlState = newValue;
    assert.strictEqual(typeof storageListener, 'function');
    storageListener({ tlState: { oldValue, newValue } }, 'local');
  }
  return { data, dnrUpdates, scriptExecutions, tabMessages, send, emitStateChange, flush: () => new Promise(r => setTimeout(r, 10)) };
}

function lockedState(manual = false) {
  return {
    version: 1,
    session: { start: Date.now(), date: '2026-10-24', trades: 1, autoTrades: 0, pnl: -100,
      riskUsed: 100, consecutiveLosses: 1, maxTradeRisk: 100, openTrades: 0 },
    lock: { active: true, reason: manual ? 'manual' : 'maxDailyLoss', since: Date.now(),
      until: Date.now() + 3600000, manual },
    status: 'LOCKED', log: [], detectorSeen: {},
  };
}

test('real background TL_LOCK_NOW cannot convert a rule lock and TL_RELEASE_MANUAL cannot release it', async () => {
  const bg = createBackground({ state: lockedState(false) });
  const before = JSON.stringify(bg.data.tlState.lock);
  const lockResult = await bg.send({ type: 'TL_LOCK_NOW' });
  assert.strictEqual(lockResult.ok, false);
  assert.strictEqual(lockResult.error, 'RULE_LOCK_PROTECTED');
  assert.strictEqual(JSON.stringify(bg.data.tlState.lock), before);

  const release = await bg.send({ type: 'TL_RELEASE_MANUAL', confirmed: true });
  assert.strictEqual(release.success, false);
  assert.strictEqual(release.error, 'RULE_LOCK_PROTECTED');
  assert.strictEqual(bg.data.tlState.lock.active, true);
  assert.strictEqual(bg.data.tlState.lock.manual, false);
});

test('real background still permits a confirmed manual focus-lock release', async () => {
  const bg = createBackground({ state: lockedState(true) });
  const release = await bg.send({ type: 'TL_RELEASE_MANUAL', confirmed: true });
  assert.strictEqual(release.success, true);
  assert.strictEqual(bg.data.tlState.lock.active, false);
});

test('real background DNR rules require full-site mode plus explicit acknowledgement', async () => {
  const bg = createBackground({
    state: lockedState(false),
    settings: { enforcementMode: 'full_site', fullSiteAcknowledged: true, blockSiteWhenLocked: false },
    license: { key: 'TL-TEST-PRO', plan: 'pro_monthly', active: true },
  });
  await bg.flush();
  const active = bg.dnrUpdates.at(-1);
  assert.strictEqual(active.addRules.length, 1);
  assert.strictEqual(active.addRules[0].action.redirect.extensionPath, '/content/lock.html');
  assert.deepStrictEqual(Array.from(active.addRules[0].condition.requestDomains), ['kite.zerodha.com']);
  assert.deepStrictEqual(Array.from(active.addRules[0].condition.resourceTypes), ['main_frame']);

  bg.data.tlSettings.fullSiteAcknowledged = false;
  bg.data.tlSettings.blockSiteWhenLocked = true; // legacy flag must not bypass consent
  await bg.send({ type: 'TL_SETTINGS_SAVED' });
  const disabled = bg.dnrUpdates.at(-1);
  assert.strictEqual(disabled.addRules.length, 0);
});


test('real background content recovery never creates a new manual lock', async () => {
  const bg = createBackground({ state: null });
  const result = await bg.send({ type: 'TL_ENSURE_LOCKED', tabId: 41 });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(bg.data.tlState, null);
  assert.strictEqual(bg.scriptExecutions.length, 1);
  const recovery = bg.tabMessages.find(entry => entry.tabId === 41);
  assert.strictEqual(recovery.message.type, 'TL_ENFORCE_LOCK');
  assert.strictEqual(recovery.message.state, null);
  assert.strictEqual(bg.tabMessages.some(entry => entry.message.type === 'TL_LOCK_NOW'), false);
});


test('real background restores an unexpired lock erased by a stale storage writer', async () => {
  const original = lockedState(false);
  const bg = createBackground({ state: original });
  const stale = JSON.parse(JSON.stringify(original));
  stale.session.trades = 9;
  stale.lock = { active: false, reason: null, since: null, until: null, manual: false };
  stale.status = 'NORMAL';
  bg.emitStateChange(original, stale);
  await bg.flush();
  assert.strictEqual(bg.data.tlState.lock.active, true);
  assert.strictEqual(bg.data.tlState.lock.reason, 'maxDailyLoss');
  assert.strictEqual(bg.data.tlState.session.trades, 9, 'newer counters can be retained while restoring the lock');
});

test('real background permits its audited manual release but rejects stale relocking', async () => {
  const original = lockedState(true);
  const bg = createBackground({ state: original });
  const result = await bg.send({ type: 'TL_RELEASE_MANUAL', confirmed: true });
  assert.strictEqual(result.success, true);
  const released = bg.data.tlState;
  bg.emitStateChange(original, released);
  await bg.flush();
  assert.strictEqual(bg.data.tlState.lock.active, false, 'audited background release remains valid');

  const stale = JSON.parse(JSON.stringify(original));
  bg.emitStateChange(released, stale);
  await bg.flush();
  assert.strictEqual(bg.data.tlState.lock.active, false, 'stale pre-release tab cannot resurrect the focus lock');
});


test('real background synchronizes DNR after a direct storage lock transition', async () => {
  const unlocked = lockedState(false);
  unlocked.lock = { active: false, reason: null, since: null, until: null, manual: false };
  const bg = createBackground({
    state: unlocked,
    settings: { enforcementMode: 'full_site', fullSiteAcknowledged: true },
    license: { key: 'TL-TEST-PRO', plan: 'pro_monthly', active: true },
  });
  await bg.flush();
  assert.strictEqual(bg.dnrUpdates.at(-1).addRules.length, 0);
  const locked = lockedState(false);
  bg.emitStateChange(unlocked, locked);
  await bg.flush();
  assert.strictEqual(bg.dnrUpdates.at(-1).addRules.length, 1);
});

test('real background accepts and sanitizes TL_BROKER_MARKET_TICK from broker tabs', async () => {
  const bg = createBackground();
  const tickResult = await bg.send({
    type: 'TL_BROKER_MARKET_TICK',
    url: 'https://kite.zerodha.com/dashboard',
    quotes: {
      NIFTY: { price: 24850.55, change: 120.25, changePercent: 0.49 },
      BANKNIFTY: { price: 51230.10, change: -85.50, changePercent: -0.17 },
      MALICIOUS: { price: 999999999 } // not in allowed symbols list
    }
  });

  assert.strictEqual(tickResult.ok, true);
  assert.strictEqual(tickResult.brokerName, 'Zerodha Kite');
  assert.ok(tickResult.quotes.NIFTY);
  assert.strictEqual(tickResult.quotes.NIFTY.price, 24850.55);
  assert.ok(!tickResult.quotes.MALICIOUS);

  // Check stored in background data
  await bg.flush();
  assert.ok(bg.data.tlBrokerMarket);
  assert.strictEqual(bg.data.tlBrokerMarket.brokerName, 'Zerodha Kite');
  assert.strictEqual(bg.data.tlBrokerMarket.quotes.NIFTY.price, 24850.55);
});

test('real background serves broker market quotes through TL_CHECK_MARKET_FEED', async () => {
  const bg = createBackground();
  // Before any tick
  const beforeTick = await bg.send({ type: 'TL_CHECK_MARKET_FEED', source: 'broker', symbol: 'NIFTY' });
  assert.strictEqual(beforeTick.ok, false);
  assert.strictEqual(beforeTick.error, 'no_broker_tab');

  // After tick
  await bg.send({
    type: 'TL_BROKER_MARKET_TICK',
    url: 'https://web.dhan.co/market',
    quotes: { NIFTY: { price: 24900.0, change: 50.0, changePercent: 0.2 } }
  });
  await bg.flush();

  const afterTick = await bg.send({ type: 'TL_CHECK_MARKET_FEED', source: 'broker', symbol: 'NIFTY' });
  assert.strictEqual(afterTick.ok, true);
  assert.strictEqual(afterTick.connected, true);
  assert.strictEqual(afterTick.source, 'broker');
  assert.match(afterTick.provider, /Dhan/);
  assert.strictEqual(afterTick.quotes.NIFTY.price, 24900);
});

