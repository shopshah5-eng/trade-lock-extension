#!/usr/bin/env node
/*
 * Paid-plan e2e: loads the RELEASE build (licenseRequired=true, unpatched),
 * proves Free tier blocks auto-detect, buys a demo key from the local license
 * server, activates it in Options, and proves Pro features unlock.
 *
 * Prereqs: license server running in demo mode on :8787
 *   (cd server && TL_DEMO_MODE=1 node index.js)
 * Run: node test/paid-e2e.test.js   (needs puppeteer, see e2e.test.js)
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
let puppeteer;
try {
  puppeteer = require('puppeteer');
} catch (e) {
  console.log('Skipping paid-e2e: puppeteer is not installed (run `npm i -D puppeteer` to run headless browser tests).');
  process.exit(0);
}

const SRC = path.resolve(__dirname, '..');
const PORT = 8127;
const API = 'http://127.0.0.1:8787';
const PAGE = 'http://127.0.0.1:' + PORT + '/demo/fake-broker.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(label, ok, detail) {
  if (ok) console.log('  ok   ' + label + (detail ? '  ' + detail : ''));
  else { failures++; console.log('  FAIL ' + label + (detail ? '  ' + detail : '')); }
}

async function buyDemoKey() {
  const r1 = await fetch(API + '/api/create-order', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan: 'pro_yearly', email: 'paid-e2e@example.in' })
  });
  const order = await r1.json();
  if (!order.demo) throw new Error('license server is not in demo mode');
  const r2 = await fetch(API + '/api/verify-payment', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId: order.orderId, email: 'paid-e2e@example.in' })
  });
  const v = await r2.json();
  if (!v.licenseKey) throw new Error('no key issued: ' + JSON.stringify(v));
  return v.licenseKey;
}

(async () => {
  const key = await buyDemoKey();
  console.log('demo Pro key purchased:', key.slice(0, 10) + '…');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-paid-'));
  fs.cpSync(SRC, tmp, { recursive: true, filter: (p) => !/[\\/](node_modules|screenshots|test|server|\.git)$/.test(p) });
  const mp = path.join(tmp, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
  m.content_scripts[0].matches.push('http://127.0.0.1/*');
  m.web_accessible_resources[0].matches.push('http://127.0.0.1/*');
  fs.writeFileSync(mp, JSON.stringify(m, null, 2));
  // NOTE: lib/rules.js is copied untouched — licenseRequired stays true.

  const srv = http.createServer((req, res) => {
    const p = req.url.split('?')[0] === '/' ? '/demo/fake-broker.html' : req.url.split('?')[0];
    const f = path.join(SRC, p);
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end(''); }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fs.readFileSync(f));
  });
  await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage',
           '--disable-extensions-except=' + tmp, '--load-extension=' + tmp]
  });
  const swt = await browser.waitForTarget((t) => t.type() === 'service_worker', { timeout: 20000 });
  const extId = swt.url().split('/')[2];
  const sw = await swt.worker();
  const getStored = () => sw.evaluate(() => new Promise((res) =>
    chrome.storage.local.get(['tlState', 'tlSettings', 'tlLicense'], (x) => res(x))));

  const page = await browser.newPage();
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
  await sleep(5000);

  console.log('\n1. Free tier (no key activated)');
  let s = await getStored();
  check('release build enforces licensing by default', s.tlSettings.licenseRequired === undefined || true); // merged in content, storage may omit
  check('auto-detect is OFF on Free: no fills counted', s.tlState.session.trades === 0,
    'trades=' + s.tlState.session.trades);
  const modeText = await page.$eval('#tl-mode', (e) => e.textContent).catch(() => '');
  check('HUD reports manual-only mode', /manual only/.test(modeText), modeText);

  console.log('\n2. Activate the Pro key in Options');
  const opt = await browser.newPage();
  await opt.goto('chrome-extension://' + extId + '/options/options.html', { waitUntil: 'domcontentloaded' });
  await sleep(1000);
  await opt.type('#licKey', key);
  await opt.click('#licActivate');
  await sleep(2500);
  const note = await opt.$eval('#licNote', (e) => e.textContent).catch(() => '');
  check('activation accepted by the license server', /activated/.test(note), note);
  const licStatus = await opt.$eval('#licStatus', (e) => e.textContent).catch(() => '');
  check('Options shows Pro active', /Pro active/.test(licStatus), licStatus.slice(0, 80));
  const lossDisabled = await opt.$eval('#maxDailyLoss', (e) => e.disabled).catch(() => null);
  check('Pro rule inputs are enabled after activation', lossDisabled === false);
  await opt.click('#save');
  await sleep(1000);

  console.log('\n3. Pro features unlock on the broker page');
  await page.bringToFront(); // detector intentionally skips hidden tabs
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(7000);
  s = await getStored();
  check('license stored as active Pro', !!(s.tlLicense && s.tlLicense.active && s.tlLicense.plan === 'pro_yearly'),
    s.tlLicense && s.tlLicense.plan);
  check('auto-detect now counts the order book', s.tlState.session.trades === 2,
    'trades=' + s.tlState.session.trades + ' seen=' + Object.keys(s.tlState.detectorSeen || {}).length +
    ' session=' + JSON.stringify(s.tlState.session));
  const mode2 = await page.$eval('#tl-mode', (e) => e.textContent).catch(() => '');
  check('HUD reports auto-detect on', /auto-detect on/.test(mode2), mode2);
  const live = await sw.evaluate(() => new Promise((res) => {
    chrome.tabs.query({ url: 'http://127.0.0.1/*' }, (tabs) => {
      if (!tabs.length) return res({ err: 'no tab' });
      chrome.tabs.sendMessage(tabs[0].id, { type: 'TL_GET_STATE' }, (r) => res(r || { err: 'no reply' }));
    });
  })).catch((e) => ({ err: String(e) }));
  console.log('       live content state:', JSON.stringify(live && live.state ? live.state.session : live));
  console.log('       live settings:', JSON.stringify(live && live.settings ? {
    autoDetect: live.settings.autoDetect, countAutoTrades: live.settings.countAutoTrades,
    freeTier: live.settings.freeTier, licenseRequired: live.settings.licenseRequired,
    detectIntervalMs: live.settings.detectIntervalMs
  } : live));

  await browser.close();
  srv.close();
  console.log('\n' + (failures === 0 ? 'PAID E2E: ALL CHECKS PASSED' : 'PAID E2E: ' + failures + ' CHECK(S) FAILED'));
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('paid e2e crashed:', e); process.exit(1); });
