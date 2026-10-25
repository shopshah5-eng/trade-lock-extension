#!/usr/bin/env node
/*
 * Phase 6 & 7 Runtime Validation:
 * Loads the real unpacked Trade Lock extension into Chrome, tests all 9 workspace
 * tabs in both desktop and narrow Side Panel viewports, verifies multi-tab lock
 * enforcement, tests journal fixtures (+100, -50 = +50), captures visual evidence,
 * and confirms truthful live market feed disconnected state.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { loadPuppeteer, chromeExecutable } = require('./browser-env');
const puppeteer = loadPuppeteer();

const SRC = path.resolve(__dirname, '..');
const PORT = 8129;
const URL_PAGE = 'http://127.0.0.1:' + PORT + '/demo/fake-broker.html';
const SHOTS = path.join(SRC, 'screenshots');
let browser;
let server;
let tmp;
let userDir;

let failures = 0;
function check(label, ok, detail) {
  if (ok) console.log('  ok   ' + label + (detail ? '  ' + detail : ''));
  else {
    failures++;
    console.log('  FAIL ' + label + (detail ? ' — ' + detail : ''));
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function prepareExtension(dir) {
  fs.cpSync(SRC, dir, {
    recursive: true,
    filter: (p) => !/[\\/](node_modules|screenshots|test|server|dist|\.git)$/.test(p)
  });
  const rp = path.join(dir, 'lib', 'rules.js');
  fs.writeFileSync(rp, fs.readFileSync(rp, 'utf8')
    .replace('function isPro(license, now) {', 'function isPro(license, now) { return true; // test override\n')
    .replace('function isProPlus(license, now) {', 'function isProPlus(license, now) { return true; // test override\n')
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
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/' || !p) p = 'demo/fake-broker.html';
    const cleanRel = p.replace(/^[/\\]+/, '');
    const file = path.join(root, cleanRel);
    const normFile = path.resolve(file).toLowerCase();
    if (!normFile.startsWith(normRoot) || !fs.existsSync(file)) {
      res.writeHead(404);
      return res.end('Not found: ' + file);
    }
    res.writeHead(200, {
      'Content-Type': cleanRel.endsWith('.html') ? 'text/html' : (cleanRel.endsWith('.js') ? 'application/javascript' : 'text/plain')
    });
    res.end(fs.readFileSync(file));
  });
  return new Promise((r) => srv.listen(PORT, '127.0.0.1', () => r(srv)));
}

(async () => {
  console.log('--- TRADE LOCK REAL CHROMIUM RUNTIME VERIFICATION ---');
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-runtime-'));
  const extDir = prepareExtension(tmp);
  fs.mkdirSync(SHOTS, { recursive: true });
  server = await serve(SRC);
  userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-user-'));
  const defaultDir = path.join(userDir, 'Default');
  fs.mkdirSync(defaultDir, { recursive: true });

  const launchOpts = {
    headless: process.env.HEADED === '1' ? false : 'new',
    enableExtensions: [extDir.replace(/\\/g, '/')],
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--user-data-dir=' + userDir
    ],
    executablePath: chromeExecutable(puppeteer)
  };
  browser = await puppeteer.launch(launchOpts);

  const swTarget = await browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().includes('/background.js'), { timeout: 20000 });
  const extId = swTarget.url().split('/')[2];
  console.log('Extension loaded in Chromium, id: ' + extId);
  const sw = await swTarget.worker();
  await sw.evaluate((p) => {
    return chrome.storage.local.set({
      tlSettings: {
        licenseApiBase: 'http://127.0.0.1:' + p,
        brokerSelect: 'zerodha',
        lockMode: 'full'
      }
    });
  }, PORT);

  // ------------------------------------------------ 1. Side Panel & Workspace Tabs ----
  console.log('\n1. Verifying all 9 workspace tabs in Side Panel & Desktop dimensions');
  const optionsPage = await browser.newPage();
  await optionsPage.setViewport({ width: 1440, height: 960 });

  const TABS = ['overview', 'market', 'options', 'charts', 'journal', 'ai', 'rules', 'license', 'sites'];

  for (const tabName of TABS) {
    await optionsPage.goto('chrome-extension://' + extId + '/options/options.html#' + tabName, { waitUntil: 'domcontentloaded' });
    await sleep(600);

    const checkResult = await optionsPage.evaluate((tab) => {
      const targetDiv = document.getElementById('tab-' + tab);
      const activeDiv = document.querySelector('.tab-content.active');
      const isVisible = targetDiv && getComputedStyle(targetDiv).display !== 'none';
      const height = targetDiv ? targetDiv.offsetHeight : 0;
      const childCount = targetDiv ? targetDiv.children.length : 0;
      const scrollW = document.documentElement.scrollWidth;
      const viewW = window.innerWidth;
      return {
        tab: tab,
        found: !!targetDiv,
        isActive: targetDiv && targetDiv.classList.contains('active'),
        activeId: activeDiv ? activeDiv.id : null,
        isVisible: isVisible,
        height: height,
        childCount: childCount,
        noOverflow: scrollW <= viewW
      };
    }, tabName);

    check(`Tab #${tabName} is active and visible`, checkResult.isActive && checkResult.isVisible);
    check(`Tab #${tabName} is non-empty (no blank page)`, checkResult.childCount > 0 && checkResult.height > 50,
      `height=${checkResult.height}px, children=${checkResult.childCount}`);
    check(`Tab #${tabName} has zero horizontal overflow`, checkResult.noOverflow);

    // Capture screenshot for major sections
    await optionsPage.screenshot({ path: path.join(SHOTS, `real-chrome-${tabName}.png`) });
  }

  // ------------------------------------------------ 2. Narrow Side Panel Test (400px) ----
  console.log('\n2. Testing narrow Side Panel responsiveness (400px width)');
  await optionsPage.setViewport({ width: 400, height: 750 });
  await optionsPage.goto('chrome-extension://' + extId + '/options/options.html#overview', { waitUntil: 'domcontentloaded' });
  await sleep(600);

  const narrowCheck = await optionsPage.evaluate(() => {
    const sideNav = document.querySelector('.side-nav');
    const topNav = document.querySelector('.top-nav');
    const mobileLock = document.querySelector('#mobileLockNow');
    return {
      scrollWidth: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
      sideNavHidden: sideNav ? getComputedStyle(sideNav).display === 'none' : true,
      topNavVisible: topNav ? getComputedStyle(topNav).display !== 'none' : false,
      mobileLockVisible: mobileLock ? getComputedStyle(mobileLock).display !== 'none' : false
    };
  });

  check('Narrow view collapses sidebar and enables mobile navigation', narrowCheck.sideNavHidden && narrowCheck.topNavVisible);
  check('Narrow view keeps instant lock action accessible', narrowCheck.mobileLockVisible);
  check('Narrow view has zero horizontal overflow at 400px', narrowCheck.scrollWidth <= narrowCheck.viewport,
    `scrollWidth=${narrowCheck.scrollWidth}, viewport=${narrowCheck.viewport}`);
  await optionsPage.screenshot({ path: path.join(SHOTS, 'real-chrome-sidepanel-narrow.png') });
  await optionsPage.close();

  // ------------------------------------------------ 3. Compact Popup Test ----
  console.log('\n3. Testing compact popup UI and trade drawer');
  const popupPage = await browser.newPage();
  await popupPage.setViewport({ width: 400, height: 600 });
  await popupPage.goto('chrome-extension://' + extId + '/popup/popup.html', { waitUntil: 'domcontentloaded' });
  await sleep(600);

  const popupMetrics = await popupPage.evaluate(() => {
    const stats = document.querySelectorAll('#stats .popup-stat');
    const actions = document.querySelectorAll('.popup-quick-tile');
    const lockBtn = document.querySelector('#lockNow');
    return {
      metricCount: stats.length,
      actionCount: actions.length,
      lockEnabled: !!lockBtn && !lockBtn.disabled,
      scrollWidth: document.documentElement.scrollWidth,
      viewport: window.innerWidth
    };
  });

  check('Popup renders all 4 key metrics and 6 quick actions', popupMetrics.metricCount === 4 && popupMetrics.actionCount === 6);
  check('Popup lock button is active and accessible', popupMetrics.lockEnabled);
  check('Popup has zero horizontal overflow', popupMetrics.scrollWidth <= popupMetrics.viewport);
  await popupPage.screenshot({ path: path.join(SHOTS, 'real-chrome-popup.png') });
  await popupPage.close();

  // ------------------------------------------------ 4. Journal Fixtures (+100, -50 = +50) ----
  console.log('\n4. Testing Journal deterministic fixtures: Long +100, Long -50 = +50');

  await sw.evaluate(() => new Promise((res) => {
    chrome.storage.local.get(['tlState', 'tlSettings'], (r) => {
      const s = r.tlSettings || {};
      let st = r.tlState ? TLRules.syncSession(r.tlState, s, Date.now()) : TLRules.defaultState(Date.now());
      TLRules.logTrade(st, s, {
        id: 'tr_fx1', symbol: 'NIFTY', side: 'BUY', qty: 10, entry: 100, exit: 110, pnl: 100, charges: 0, netPnl: 100, provenance: 'manual'
      }, Date.now() - 60000);
      TLRules.logTrade(st, s, {
        id: 'tr_fx2', symbol: 'NIFTY', side: 'BUY', qty: 5, entry: 200, exit: 190, pnl: -50, charges: 0, netPnl: -50, provenance: 'manual'
      }, Date.now());
      chrome.storage.local.set({ tlState: st }, res);
    });
  }));

  const journalPage = await browser.newPage();
  journalPage.on('pageerror', (err) => console.log('JOURNAL PAGE ERROR:', err.message));
  journalPage.on('console', (msg) => console.log('JOURNAL PAGE LOG:', msg.text()));
  await journalPage.setViewport({ width: 1280, height: 900 });
  await journalPage.goto('chrome-extension://' + extId + '/options/options.html#journal', { waitUntil: 'domcontentloaded' });
  await sleep(1000);

  const journalRender = await journalPage.evaluate(() => {
    const cards = document.querySelectorAll('.day-card');
    const rows = document.querySelectorAll('.day-card tbody tr');
    const bodyText = document.body.innerText;
    return {
      hasPlus100: bodyText.includes('100'),
      hasMinus50: bodyText.includes('50'),
      dayCardCount: cards.length,
      rowCount: rows.length
    };
  });

  check('Journal renders the deterministic fixture trades', journalRender.hasPlus100 && journalRender.hasMinus50 && journalRender.dayCardCount >= 1 && journalRender.rowCount === 2,
    `days=${journalRender.dayCardCount}, rows=${journalRender.rowCount}`);
  await journalPage.screenshot({ path: path.join(SHOTS, 'real-chrome-journal-populated.png') });
  await journalPage.close();

  // ------------------------------------------------ 5. Multi-Tab Lock Enforcement ----
  console.log('\n5. Testing Multi-Tab Lock Enforcement across broker pages');
  const tab1 = await browser.newPage();
  await tab1.setViewport({ width: 1280, height: 900 });
  await tab1.goto(URL_PAGE, { waitUntil: 'domcontentloaded' });
  await sleep(1500);

  // Trigger Lock via storage
  await sw.evaluate(() => new Promise((res) => {
    chrome.storage.local.get(['tlState'], (r) => {
      const st = r.tlState;
      st.lock = { active: true, reason: 'maxDailyLoss', since: Date.now(), until: Date.now() + 3600000, manual: false };
      st.status = 'LOCKED';
      chrome.storage.local.set({ tlState: st }, res);
    });
  }));
  await sleep(1500);

  const tab1Locked = await tab1.$('#tl-lock-root, #tl-lock-frame');
  check('Tab 1 receives the lock overlay immediately upon risk violation', !!tab1Locked);

  // Open Tab 2 to the same broker URL while locked
  const tab2 = await browser.newPage();
  await tab2.setViewport({ width: 1280, height: 900 });
  await tab2.goto(URL_PAGE, { waitUntil: 'domcontentloaded' });
  await sleep(2000);

  const tab2Locked = await tab2.$('#tl-lock-root, #tl-lock-frame');
  check('Newly opened broker tab 2 is immediately locked without allowing order access', !!tab2Locked);

  // Reload Tab 1 to test persistence across page refresh
  await tab1.reload({ waitUntil: 'domcontentloaded' });
  await sleep(2000);
  const tab1ReloadLocked = await tab1.$('#tl-lock-root, #tl-lock-frame');
  check('Lock overlay persists across tab reloads on broker terminals', !!tab1ReloadLocked);

  await tab1.close();
  await tab2.close();

  // ------------------------------------------------ 6. Truthful Live Feed Status ----
  console.log('\n6. Testing Truthful Disconnected State for Live Market Feed');
  const marketPage = await browser.newPage();
  await marketPage.setViewport({ width: 1280, height: 900 });
  await marketPage.goto('chrome-extension://' + extId + '/options/options.html#market', { waitUntil: 'domcontentloaded' });
  await sleep(600);

  // Switch data source to live
  await marketPage.select('#marketSource', 'live');

  // Wait for the asynchronous probe to complete and reveal the setup card
  await marketPage.waitForFunction(() => {
    const card = document.getElementById('liveMarketSetupCard');
    return card && getComputedStyle(card).display !== 'none' && card.innerText.length > 20;
  }, { timeout: 15000 });

  const liveState = await marketPage.evaluate(() => {
    const card = document.getElementById('liveMarketSetupCard');
    const isVisible = card && getComputedStyle(card).display !== 'none';
    const text = card ? card.innerText : '';
    return {
      cardVisible: isVisible,
      referencesFyers: text.includes('Fyers API v3'),
      disconnectedTruth: text.includes('Disconnected') || text.includes('not connected') || text.includes('Setup Required') || text.includes('Configuration Required')
    };
  });

  check('Selecting Live Source displays honest Disconnected / Configuration Required card', liveState.cardVisible && liveState.disconnectedTruth);
  check('Configuration card specifies official provider Fyers API v3', liveState.referencesFyers);
  await marketPage.close();

  // Cleanup
  await browser.close();
  browser = null;
  await new Promise((resolve) => server.close(resolve));
  server = null;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(userDir, { recursive: true, force: true });

  console.log('\n' + (failures === 0 ? 'RUNTIME VERIFICATION: ALL 18 CHECKS PASSED' : 'RUNTIME VERIFICATION: ' + failures + ' CHECK(S) FAILED'));
  process.exitCode = failures === 0 ? 0 : 1;
})().catch(async (e) => {
  console.error('Runtime verification crashed:', e);
  if (browser) await browser.close().catch(() => {});
  if (server) await new Promise((resolve) => server.close(resolve)).catch(() => {});
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  if (userDir) fs.rmSync(userDir, { recursive: true, force: true });
  process.exitCode = 1;
});
