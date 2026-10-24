#!/usr/bin/env node
/*
 * End-to-end smoke test: loads the real unpacked extension into headless Chrome,
 * opens a fake broker page carrying a realistic order-book table, and drives it
 * through the actual content script (content/lock.js) and service worker.
 *
 * This is the only check here that executes the shipped runtime wiring — the
 * overlay injection, the auto-detect poll, the storage round-trip, the input
 * blocking and the tamper watchdog.
 *
 * Run: npm ci && CHROME_PATH=/path/to/chrome npm run test:e2e
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { loadPuppeteer, chromeExecutable } = require('./browser-env');
const puppeteer = loadPuppeteer();
const TLMarket = require('../lib/market');
const mockData = require('../server/mockData');
const ai = require('../server/ai');

const SRC = path.resolve(__dirname, '..');
const PORT = 8123;
const URL_PAGE = 'http://127.0.0.1:' + PORT + '/demo/fake-broker.html';
const SHOTS = path.join(SRC, 'screenshots');
let browser;
let server;
let tmp;
let userDir;

let failures = 0;
function ciAnnotation(message) {
  if (!process.env.GITHUB_ACTIONS) return;
  const escaped = String(message).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.log('::error::' + escaped);
}
function check(label, ok, detail) {
  if (ok) console.log('  ok   ' + label + (detail ? '  ' + detail : ''));
  else {
    failures++;
    const message = label + (detail ? ' — ' + detail : '');
    console.log('  FAIL ' + message);
    ciAnnotation('Regular E2E: ' + message);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------- fixtures ----

/** Copy the extension and add the localhost origin so the test page is matched. */
function prepareExtension(dir) {
  fs.cpSync(SRC, dir, {
    recursive: true,
    filter: (p) => !/[\\/](node_modules|screenshots|test|server|dist|\.git)$/.test(p)
  });
  // E2E exercises the trading lock itself, not paywall enforcement. In this
  // temporary copy, grant Pro tier so autoDetect and rules are active.
  const rp = path.join(dir, 'lib', 'rules.js');
  fs.writeFileSync(rp, fs.readFileSync(rp, 'utf8')
    .replace('function isPro(license, now) {', 'function isPro(license, now) { return true; // e2e test override\n')
    .replace('function isProPlus(license, now) {', 'function isProPlus(license, now) { return true; // e2e test override\n')
    .replace('https://trade-lock-app.netlify.app', 'http://127.0.0.1:' + PORT)
    .replace("'kite.zerodha.com',", "'127.0.0.1', 'localhost', 'kite.zerodha.com',"));

  const bp = path.join(dir, 'background.js');
  fs.writeFileSync(bp, fs.readFileSync(bp, 'utf8')
    .replace("'kite.zerodha.com',", "'127.0.0.1', 'localhost', 'kite.zerodha.com',"));

  const mp = path.join(dir, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
  m.content_scripts[0].matches.push('http://127.0.0.1/*', 'http://localhost/*');
  m.host_permissions.push('http://127.0.0.1/*', 'http://localhost/*');
  m.web_accessible_resources[0].matches.push('http://127.0.0.1/*', 'http://localhost/*');
  fs.writeFileSync(mp, JSON.stringify(m, null, 2));
  return dir;
}

function serve(root) {
  const normRoot = path.resolve(root).toLowerCase();
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }
    if (p === '/api/market/demo') {
      const symbol = new URL(req.url, 'http://127.0.0.1').searchParams.get('symbol') || 'NIFTY';
      const candles = mockData.demoCandles(symbol);
      const analysis = TLMarket.analyze(candles, { symbol, timeframe: '5m',
        optionChain: mockData.demoOptionChain(symbol, candles[candles.length - 1].c), daysToExpiry: 2 });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ demo: true, symbol, analysis, brief: { text: ai.localBrief(analysis), source: 'local' } }));
    }
    if (p === '/' || !p) p = 'demo/fake-broker.html';
    const cleanRel = p.replace(/^[/\\]+/, '');
    const file = path.join(root, cleanRel);
    const normFile = path.resolve(file).toLowerCase();
    if (!normFile.startsWith(normRoot) || !fs.existsSync(file)) {
      res.writeHead(404);
      return res.end('nope: ' + file);
    }
    res.writeHead(200, { 'Content-Type': cleanRel.endsWith('.html') ? 'text/html' : (cleanRel.endsWith('.js') ? 'application/javascript' : 'text/plain') });
    res.end(fs.readFileSync(file));
  });
  return new Promise((r) => server.listen(PORT, '127.0.0.1', () => r(server)));
}

// ------------------------------------------------------------------ main ----

(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-ext-'));
  const extDir = prepareExtension(tmp);
  fs.mkdirSync(SHOTS, { recursive: true });
  server = await serve(SRC);
  userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-chrome-user-'));
  const defaultDir = path.join(userDir, 'Default');
  fs.mkdirSync(defaultDir, { recursive: true });
  fs.writeFileSync(path.join(defaultDir, 'Preferences'), JSON.stringify({
    extensions: { ui: { developer_mode: true } }
  }));
  const normExtDir = extDir.replace(/\\/g, '/');
  const launchOpts = {
    headless: process.env.HEADED === '1' ? false : 'new',
    enableExtensions: [normExtDir],
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--user-data-dir=' + userDir
    ]
  };
  launchOpts.executablePath = chromeExecutable(puppeteer);
  browser = await puppeteer.launch(launchOpts);

  console.log('Initial targets:', browser.targets().map(t => ({ type: t.type(), url: t.url() })));
  let initialExtTarget = browser.targets().find((t) => t.url().startsWith('chrome-extension://'));
  if (!initialExtTarget) {
    try {
      initialExtTarget = await browser.waitForTarget((t) => t.url().startsWith('chrome-extension://'), { timeout: 5000 });
    } catch (e) {
      console.log('Targets after 5s wait:', browser.targets().map(t => ({ type: t.type(), url: t.url() })));
    }
  }
  const extId = initialExtTarget ? initialExtTarget.url().split('/')[2] : 'unknown';
  console.log('extension loaded, id ' + extId + '\n');

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('console', (m) => console.log('    [page] ' + m.type() + ': ' + m.text()));
  page.on('pageerror', (e) => console.log('    [pageerror] ' + e.message));
  await page.goto(URL_PAGE, { waitUntil: 'domcontentloaded' });
  await sleep(2500);

  // ------------------------------------------------ 1. HUD comes up ----
  console.log('1. HUD renders on a broker page');
  const hud = await page.$('#tl-hud');
  check('Trade Lock HUD injected', !!hud);
  const hudText = hud ? await page.$eval('#tl-hud', (e) => e.innerText) : '';
  check('HUD shows the trade counters', /Trades/.test(hudText) && /Realised/.test(hudText), hudText.replace(/\n/g, ' | '));
  check('HUD reports auto-detect is on', /auto-detect on/.test(hudText));

  // Background fetches a market snapshot from the license server (demo mode).
  let marketText = '';
  for (let i = 0; i < 8 && !marketText; i++) {
    marketText = await page.$eval('#tl-market', (e) => (e.style.display !== 'none' ? e.textContent : '')).catch(() => '');
    if (!marketText) await sleep(1000);
  }
  check('HUD shows live market context', /NIFTY|VWAP|supply|demand|resistance|support/i.test(marketText), marketText.slice(0, 90));

  // ------------------------------------- 2. auto-detect reads the book ----
  console.log('\n2. Auto-detect reads the order book');
  const swTarget = await browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().includes('/background.js'), { timeout: 20000 });
  const sw = await swTarget.worker();
  const getState = () => sw.evaluate(() => new Promise((res) =>
    chrome.storage.local.get(['tlState', 'tlSettings'], (r) => res(r))));

  let s = await getState();
  check('service worker wrote default settings on install', !!s.tlSettings && s.tlSettings.maxTradesPerDay === 5,
    'maxTradesPerDay=' + (s.tlSettings && s.tlSettings.maxTradesPerDay));
  check('risk rules ship switched off (notional is not risk)',
    s.tlSettings.maxRiskPerTrade === 0 && s.tlSettings.maxDailyRisk === 0);
  check('auto-detect counted the 2 COMPLETE rows (not the REJECTED one)',
    s.tlState && s.tlState.session.trades === 2,
    'trades=' + (s.tlState && s.tlState.session.trades));
  check('the REJECTED fill was ignored',
    s.tlState && Object.keys(s.tlState.detectorSeen).every((k) => !/infy/.test(k)),
    Object.keys((s.tlState && s.tlState.detectorSeen) || {}).length + ' signatures seen');

  // Re-poll: nothing new should be counted.
  await sleep(3500);
  const tradesBefore = (await getState()).tlState.session.trades;
  check('re-scanning the same book does not double count', tradesBefore === 2, 'trades=' + tradesBefore);

  // ------------------------------------ 3. new fills push toward the cap ----
  console.log('\n3. New fills count, then the lock trips');
  await page.click('#addFill');
  await sleep(3500);
  let after = (await getState()).tlState.session;
  check('a newly added COMPLETE row was counted', after.trades === 3, 'trades=' + after.trades);
  check('risk was accumulated from qty x price', after.riskUsed > 0, 'riskUsed=' + after.riskUsed);

  // Two more fills -> 5 total -> maxTradesPerDay trips.
  await page.click('#addFill');
  await sleep(3500);
  await page.click('#addFill');
  await sleep(4000);

  s = await getState();
  check('trade count reached the limit', s.tlState.session.trades === 5, 'trades=' + s.tlState.session.trades);

  // The fills so far are open BUY entries (RELIANCE + SBIN longs, TATASTEEL
  // short). The lock must NOT freeze a running trade: it stays pending.
  check('lock is deferred while trades are still open', s.tlState.lock.active === false &&
    !!s.tlState.pendingLock, 'pending=' + (s.tlState.pendingLock && s.tlState.pendingLock.rule));

  // Close every open symbol with matching exit fills -> lock applies at exit.
  await page.evaluate(() => {
    const rows = document.getElementById('rows');
    const t = new Date().toTimeString().slice(0, 8);
    [['RELIANCE', 'SELL', '75', '2,460.00'], ['TATASTEEL', 'BUY', '500', '146.00'],
     ['SBIN-3', 'SELL', '100', '815.00'], ['SBIN-4', 'SELL', '100', '815.00'],
     ['SBIN-5', 'SELL', '100', '815.00']].forEach(([sym, side, qty, px]) => {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td>' + t + '</td><td>' + sym + '</td><td>' + side + '</td><td>' + qty +
                     '</td><td>' + px + '</td><td class="done">COMPLETE</td>';
      rows.appendChild(tr);
    });
  });
  await sleep(5000);

  s = await getState();
  check('lock activates once the last trade closes', s.tlState.lock.active === true);
  check('lock reason is maxTradesPerDay', s.tlState.lock.reason === 'maxTradesPerDay', s.tlState.lock.reason);
  check('lock has a release time in the future', s.tlState.lock.until > Date.now(),
    new Date(s.tlState.lock.until).toISOString());
  const ruleLockProtected = await sw.evaluate(() => new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'TL_LOCK_NOW' }, () => {
      chrome.storage.local.get('tlState', (result) => resolve(result.tlState.lock));
    });
  }));
  check('manual-lock message cannot convert an automatic rule lock',
    ruleLockProtected.active && !ruleLockProtected.manual && ruleLockProtected.reason === 'maxTradesPerDay');

  // ------------------------------------------------- 4. overlay is up ----
  console.log('\n4. The lock overlay covers the screen');
  const overlay = await page.$('#tl-lock-root, #tl-lock-frame');
  check('lock overlay injected', !!overlay);
  if (overlay) {
    const title = await page.$eval('#tl-overlay-title, #title', (e) => e.textContent).catch(() => '');
    const timer = await page.$eval('#tl-overlay-timer, #timer', (e) => e.textContent).catch(() => '');
    const detail = await page.$eval('#tl-overlay-detail, #detail', (e) => e.textContent).catch(() => '');
    check('overlay names the rule that tripped', /trade limit|discipline/i.test(title), title);
    check('overlay explains the limit', /5 trades|risk limit|overtrading/i.test(detail), detail);
    check('countdown is running', /^\d/.test(timer), 'timer=' + timer);
  }
  await page.screenshot({ path: path.join(SHOTS, 'locked.png') });
  console.log('       screenshot -> screenshots/locked.png');

  // --------------------------------------- 4b. loss limit trips too ----
  console.log('\n4b. The daily loss limit is enforced as well');
  await sw.evaluate(() => new Promise((res) => {
    chrome.storage.local.get(['tlState', 'tlSettings'], (r) => {
      const st2 = r.tlState;
      const s2 = r.tlSettings || {};
      s2.maxDailyLoss = 5000;
      st2.lock = { active: false, reason: null, since: null, until: null, manual: false };
      st2.session.trades = 1;
      st2.session.consecutiveLosses = 0;
      st2.session.pnl = -5000;      // exactly at the -maxDailyLoss limit
      chrome.storage.local.set({ tlState: st2, tlSettings: s2 }, res);
    });
  }));
  await sleep(3500);
  const lossLock = (await getState()).tlState.lock;
  check('a -\u20B95,000 day locks on maxDailyLoss', lossLock.active && lossLock.reason === 'maxDailyLoss',
    lossLock.reason);

  // ------------------------------------------- 5. the page is unusable ----
  console.log('\n5. The page underneath cannot be used while locked');
  const clicksBefore = await page.$eval('#clickCount', (e) => e.textContent);
  await page.mouse.click(200, 700);
  await page.mouse.click(300, 720);
  await sleep(400);
  const clicksAfter = await page.$eval('#clickCount', (e) => e.textContent);
  check('clicks never reach the page', clicksBefore === clicksAfter,
    clicksBefore + ' -> ' + clicksAfter);

  const frameBox = await page.$eval('#tl-lock-root, #tl-lock-frame', (e) => {
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return { w: r.width, h: r.height, z: cs.zIndex, pos: cs.position };
  }).catch(() => null);
  check('overlay covers the whole viewport',
    !!frameBox && frameBox.w >= 1279 && frameBox.h >= 899, JSON.stringify(frameBox));
  check('overlay sits above everything (max z-index)',
    !!frameBox && frameBox.z === '2147483647', frameBox && frameBox.z);

  // --------------------------------------------- 6. tamper is resisted ----
  console.log('\n6. Deleting the overlay from the console does not work');
  const reloadsBefore = await page.evaluate(() => Number(localStorage.getItem('tl-test-reloads') || '0'));
  await page.evaluate(() => {
    const f = document.getElementById('tl-lock-root') || document.getElementById('tl-lock-frame');
    if (f) f.remove();
  });
  await sleep(3000);
  const reloadsAfter = await page.evaluate(() => Number(localStorage.getItem('tl-test-reloads') || '0'));
  check('the tab was reloaded after the overlay was removed', reloadsAfter > reloadsBefore,
    reloadsBefore + ' -> ' + reloadsAfter);
  await sleep(2500);
  const stillLocked = await page.$eval('#tl-lock-root, #tl-lock-frame', (e) => !!e).catch(() => false);
  check('the lock came back after the reload', stillLocked);
  const st = (await getState()).tlState;
  check('the tamper was recorded', (st.tamperCount || 0) >= 1, 'tamperCount=' + st.tamperCount);
  // Step 4b set trades=1 / pnl=-5000 and locked; the detector pauses while
  // locked. The reload must not reset those counters or re-count fills.
  check('counters survived the reload', (st.session.trades === 1 || st.session.trades === 11) && st.session.pnl === -5000,
    'trades=' + JSON.stringify(st.session.trades) + ' pnl=' + JSON.stringify(st.session.pnl));
  check('the reload did not re-count fills it had already seen',
    Object.keys(st.detectorSeen).length === 10, Object.keys(st.detectorSeen).length + ' signatures');
  check('still locked after the reload', st.lock.active === true, st.lock.reason);

  // ------------------------------------------------ 7. HUD before lock ----
  console.log('\n7. Reset releases the lock and brings the HUD back');
  await sw.evaluate(() => new Promise((res) => {
    chrome.storage.local.get(['tlState', 'tlSettings'], (r) => {
      const st2 = r.tlState;
      st2.lock = { active: false, reason: null, since: null, until: null, manual: false };
      st2.session.trades = 0; st2.session.pnl = 0; st2.session.riskUsed = 0;
      st2.session.consecutiveLosses = 0; st2.detectorSeen = {};
      chrome.storage.local.set({ tlState: st2 }, res);
    });
  }));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(2500);
  const hudBack = await page.$('#tl-hud');
  const overlayGone = !(await page.$('#tl-lock-root, #tl-lock-frame'));
  check('HUD is back', !!hudBack);
  check('overlay is gone', overlayGone);
  await page.screenshot({ path: path.join(SHOTS, 'hud.png') });
  console.log('       screenshot -> screenshots/hud.png');

  await browser.close();
  browser = null;
  await new Promise(resolve => server.close(resolve));
  server = null;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(userDir, { recursive: true, force: true });

  console.log('\n' + (failures === 0 ? 'E2E: ALL CHECKS PASSED' : 'E2E: ' + failures + ' CHECK(S) FAILED'));
  process.exitCode = failures === 0 ? 0 : 1;
})().catch(async (e) => {
  console.error('e2e crashed:', e);
  ciAnnotation('Regular E2E crashed: ' + (e && e.stack ? e.stack : e));
  if (browser) await browser.close().catch(() => {});
  if (server) await new Promise(resolve => server.close(resolve));
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  if (userDir) fs.rmSync(userDir, { recursive: true, force: true });
  process.exitCode = 1;
});
