#!/usr/bin/env node
/*
 * Paid-plan E2E: loads an unpatched extension build, proves Free tier blocks
 * auto-detect, issues a demo Pro key from an isolated local license server,
 * activates it in Options, and proves paid features unlock.
 *
 * Run: npm ci && CHROME_PATH=/path/to/chrome npm run test:paid-e2e
 * No real payment, email, Supabase, or market provider is contacted.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { loadPuppeteer, chromeExecutable } = require('./browser-env');
const puppeteer = loadPuppeteer();

const SRC = path.resolve(__dirname, '..');
const PORT = 8127;
const PAGE = 'http://127.0.0.1:' + PORT + '/demo/fake-broker.html';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let API;
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
    ciAnnotation('Paid E2E: ' + message);
  }
}

async function buyDemoKey() {
  const r1 = await fetch(API + '/api/create-order', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan: 'pro_yearly', email: 'paid-e2e@example.in' })
  });
  const order = await r1.json();
  if (!r1.ok || !order.demo) throw new Error('isolated license server is not in demo mode: ' + JSON.stringify(order));
  const r2 = await fetch(API + '/api/verify-payment', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId: order.orderId, paymentId: 'pay_demo_paid_e2e', email: 'paid-e2e@example.in' })
  });
  const v = await r2.json();
  if (!r2.ok || !v.licenseKey) throw new Error('no key issued: ' + JSON.stringify(v));
  return v.licenseKey;
}

function serveFixture() {
  const srv = http.createServer((req, res) => {
    const pathname = decodeURIComponent(req.url.split('?')[0]);
    const relative = (pathname === '/' ? '/demo/fake-broker.html' : pathname).replace(/^\/+/, '');
    const file = path.resolve(SRC, relative);
    if (!file.startsWith(SRC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404); return res.end('');
    }
    res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html' : 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(PORT, '127.0.0.1', () => resolve(srv));
  });
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-paid-'));
  const dataFile = path.join(os.tmpdir(), `tl-paid-license-${process.pid}-${Date.now()}.json`);
  let browser;
  let fixtureServer;
  let licenseServer;
  try {
    process.env.TL_DEMO_MODE = '1';
    process.env.NODE_ENV = 'test';
    process.env.TL_DATA_FILE = dataFile;
    process.env.RAZORPAY_KEY_ID = '';
    process.env.RAZORPAY_KEY_SECRET = '';
    process.env.RESEND_API_KEY = '';
    process.env.SUPABASE_URL = '';
    process.env.SUPABASE_SERVICE_KEY = '';
    process.env.SUPABASE_KEY = '';
    licenseServer = require('../server/index');
    await new Promise((resolve, reject) => {
      licenseServer.once('error', reject);
      licenseServer.listen(0, '127.0.0.1', resolve);
    });
    API = 'http://127.0.0.1:' + licenseServer.address().port;
    const key = await buyDemoKey();
    console.log('Demo Pro key issued:', key.slice(0, 10) + '…');

    fs.cpSync(SRC, tmp, { recursive: true,
      filter: p => !/[\\/](node_modules|screenshots|test|server|\.git)$/.test(p) });
    const mp = path.join(tmp, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(mp, 'utf8'));
    manifest.content_scripts[0].matches.push('http://127.0.0.1/*');
    manifest.web_accessible_resources[0].matches.push('http://127.0.0.1/*');
    manifest.host_permissions.push('http://127.0.0.1/*');
    fs.writeFileSync(mp, JSON.stringify(manifest, null, 2));

    const rp = path.join(tmp, 'lib', 'rules.js');
    fs.writeFileSync(rp, fs.readFileSync(rp, 'utf8')
      .replace("'kite.zerodha.com',", "'127.0.0.1', 'localhost', 'kite.zerodha.com',"));

    const bp = path.join(tmp, 'background.js');
    fs.writeFileSync(bp, fs.readFileSync(bp, 'utf8')
      .replace("'kite.zerodha.com',", "'127.0.0.1', 'localhost', 'kite.zerodha.com',"));
    // Rules and license enforcement remain completely unpatched.

    fixtureServer = await serveFixture();
    browser = await puppeteer.launch({
      headless: process.env.HEADED === '1' ? false : 'new',
      executablePath: chromeExecutable(puppeteer),
      enableExtensions: [tmp],
      args: ['--no-sandbox', '--disable-dev-shm-usage']
    });
    const swt = await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().includes('/background.js'), { timeout: 20000 });
    const extId = swt.url().split('/')[2];
    const sw = await swt.worker();
    const getStored = () => sw.evaluate(() => new Promise(resolve =>
      chrome.storage.local.get(['tlState', 'tlSettings', 'tlLicense'], value => resolve(value))));
    await sleep(1500);
    await sw.evaluate(() => new Promise(resolve => {
      chrome.storage.local.get('tlSettings', res => {
        chrome.storage.local.set({ tlSettings: Object.assign({}, res.tlSettings || {}, { showHud: true }) }, resolve);
      });
    }));

    const page = await browser.newPage();
    await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(3000);

    console.log('\n1. Free tier (no key activated)');
    let stored = await getStored();
    check('auto-detect is OFF on Free: no fills counted', stored.tlState.session.trades === 0,
      'trades=' + stored.tlState.session.trades);
    const modeText = await page.$eval('#tl-mode', e => e.textContent).catch(() => '');
    check('HUD reports manual-only mode', /manual only/.test(modeText), modeText);

    console.log('\n2. Activate the Pro key in Options against the isolated API');
    const options = await browser.newPage();
    await options.setViewport({ width: 1280, height: 900 });
    await options.goto('chrome-extension://' + extId + '/options/options.html#license', { waitUntil: 'domcontentloaded' });
    await options.waitForSelector('#licActivate', { visible: true, timeout: 10000 });
    await options.type('#licKey', key);
    await options.$eval('#licApi', (element, api) => { element.value = api; }, API);
    await options.click('#licActivate');
    await sleep(2500);
    const note = await options.$eval('#licNote', e => e.textContent).catch(() => '');
    check('activation accepted by the license server', /activated/.test(note), note);
    const licenseStatus = await options.$eval('#licStatus', e => e.textContent).catch(() => '');
    check('Options shows an active Pro plan', /Active (Prepaid Plan|Subscription)/i.test(licenseStatus) && /Pro/i.test(licenseStatus), licenseStatus.slice(0, 100));
    const lossDisabled = await options.$eval('#maxDailyLoss', e => e.disabled).catch(() => null);
    check('Pro rule inputs are enabled after activation', lossDisabled === false);
    await options.click('#mainTabs .tab-btn[data-tab="rules"]');
    await options.waitForSelector('#save', { visible: true, timeout: 10000 });
    await options.$eval('#showHud', el => { el.checked = true; }).catch(() => {});
    await options.click('#save');
    await sleep(1000);

    console.log('\n3. Pro features unlock on the broker page');
    await page.bringToFront();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(7000);
    stored = await getStored();
    check('license stored as active Pro', !!(stored.tlLicense && stored.tlLicense.active && stored.tlLicense.plan === 'pro_yearly'),
      stored.tlLicense && stored.tlLicense.plan);
    check('auto-detect now counts the order book', stored.tlState.session.trades === 2,
      'trades=' + stored.tlState.session.trades + ' seen=' + Object.keys(stored.tlState.detectorSeen || {}).length);
    const paidMode = await page.$eval('#tl-mode', e => e.textContent).catch(() => '');
    check('HUD reports auto-detect on', /auto-detect on/.test(paidMode), paidMode);

    console.log('\n' + (failures === 0 ? 'PAID E2E: ALL CHECKS PASSED' : 'PAID E2E: ' + failures + ' CHECK(S) FAILED'));
    if (failures) process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    if (fixtureServer) await new Promise(resolve => fixtureServer.close(resolve));
    if (licenseServer) await new Promise(resolve => licenseServer.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(dataFile, { force: true });
    fs.rmSync(dataFile + '.tmp', { force: true });
  }
})().catch(error => {
  console.error('paid e2e crashed:', error);
  ciAnnotation('Paid E2E crashed: ' + (error && error.stack ? error.stack : error));
  process.exitCode = 1;
});
