'use strict';
/*
 * Generate 5 Chrome Web Store Screenshots at EXACTLY 1280 x 800.
 * Chrome Web Store requires: 1280 x 800 or 640 x 400 (JPEG or 24-bit PNG, no alpha).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { loadPuppeteer, chromeExecutable } = require('../test/browser-env');
const puppeteer = loadPuppeteer();

const ROOT = path.resolve(__dirname, '..');
const SHOTS_DIR = path.join(ROOT, 'screenshots');
const PORT = 8131;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function prepareExtension(dir) {
  fs.cpSync(ROOT, dir, {
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

async function main() {
  console.log('[cws-screenshots] Cleaning screenshots folder...');
  if (fs.existsSync(SHOTS_DIR)) {
    for (const f of fs.readdirSync(SHOTS_DIR)) {
      try { fs.unlinkSync(path.join(SHOTS_DIR, f)); } catch (e) {}
    }
  } else {
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-cws-shots-'));
  const extDir = prepareExtension(tmp);
  const server = await serve(ROOT);
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-cws-user-'));
  const defaultDir = path.join(userDir, 'Default');
  fs.mkdirSync(defaultDir, { recursive: true });

  const launchOpts = {
    headless: 'new',
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

  const browser = await puppeteer.launch(launchOpts);

  try {
    const swTarget = await browser.waitForTarget(
      (t) => t.type() === 'service_worker' && t.url().includes('/background.js'), { timeout: 20000 });
    const sw = await swTarget.worker();
    const extId = swTarget.url().split('/')[2];
    console.log('[cws-screenshots] Extension loaded, id:', extId);

    // Populate state in storage
    await sw.evaluate(() => new Promise((res) => {
      chrome.storage.local.get(['tlState', 'tlSettings'], (r) => {
        const s = r.tlSettings || {};
        let st = r.tlState ? TLRules.syncSession(r.tlState, s, Date.now()) : TLRules.defaultState(Date.now());
        st.session.trades = 3;
        st.session.pnl = 4250;
        st.session.riskUsed = 1500;
        TLRules.logTrade(st, s, {
          id: 'tr_1', symbol: 'NIFTY 25000 CE', side: 'BUY', qty: 75, entry: 110, exit: 145, pnl: 2625, charges: 55, netPnl: 2570, provenance: 'manual'
        }, Date.now() - 3600000);
        TLRules.logTrade(st, s, {
          id: 'tr_2', symbol: 'BANKNIFTY 51500 PE', side: 'BUY', qty: 30, entry: 180, exit: 240, pnl: 1800, charges: 50, netPnl: 1750, provenance: 'manual'
        }, Date.now() - 1800000);
        TLRules.logTrade(st, s, {
          id: 'tr_3', symbol: 'FINNIFTY 23500 CE', side: 'BUY', qty: 40, entry: 95, exit: 90, pnl: -200, charges: 45, netPnl: -245, provenance: 'manual'
        }, Date.now() - 600000);

        const mockQuotes = {
          NIFTY: { symbol: 'NIFTY', name: 'NIFTY 50', price: 24855.40, change: 125.80, changePercent: 0.51, fetchedAt: Date.now(), source: 'broker' },
          BANKNIFTY: { symbol: 'BANKNIFTY', name: 'BANK NIFTY', price: 51240.20, change: 310.50, changePercent: 0.61, fetchedAt: Date.now(), source: 'broker' },
          FINNIFTY: { symbol: 'FINNIFTY', name: 'FIN NIFTY', price: 23415.75, change: 45.20, changePercent: 0.19, fetchedAt: Date.now(), source: 'broker' },
          SENSEX: { symbol: 'SENSEX', name: 'BSE SENSEX', price: 81520.10, change: 412.30, changePercent: 0.51, fetchedAt: Date.now(), source: 'broker' }
        };
        chrome.storage.local.set({
          tlState: st,
          tlBrokerMarket: {
            quotes: mockQuotes,
            brokerName: 'Zerodha Kite',
            brokerUrl: 'https://kite.zerodha.com',
            lastUpdated: Date.now()
          },
          tlMarket: {
            fetchedAt: Date.now(),
            source: 'broker',
            symbol: 'NIFTY',
            provider: 'Active Broker Tab (Zerodha Kite)',
            quotes: mockQuotes,
            price: 24855.40,
            change: 125.80,
            changePercent: 0.51
          }
        }, res);
      });
    }));

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });

    // -------------------------------------------------------------------------
    // Image 1: 1_lock_screen.png (The MAIN lock screen requested by user)
    // -------------------------------------------------------------------------
    console.log('[cws-screenshots] Capturing 1_lock_screen.png (1280x800)...');
    await page.goto(`http://127.0.0.1:${PORT}/demo/fake-broker.html`, { waitUntil: 'domcontentloaded' });
    await sleep(1000);

    // Trigger discipline lock
    await sw.evaluate(() => new Promise((res) => {
      chrome.storage.local.get(['tlState'], (r) => {
        const st = r.tlState;
        st.lock = { active: true, reason: 'maxDailyLoss', since: Date.now(), until: Date.now() + 14 * 3600 * 1000, manual: false };
        st.status = 'LOCKED';
        chrome.storage.local.set({ tlState: st }, res);
      });
    }));
    await sleep(1500);
    await page.screenshot({ path: path.join(SHOTS_DIR, '1_lock_screen.png'), clip: { x: 0, y: 0, width: 1280, height: 800 } });

    // Release lock for dashboard views
    await sw.evaluate(() => new Promise((res) => {
      chrome.storage.local.get(['tlState'], (r) => {
        const st = r.tlState;
        st.lock = { active: false, reason: null, since: null, until: null, manual: false };
        st.status = 'NORMAL';
        chrome.storage.local.set({ tlState: st }, res);
      });
    }));
    await sleep(500);

    // -------------------------------------------------------------------------
    // Image 2: 2_trading_journal.png
    // -------------------------------------------------------------------------
    console.log('[cws-screenshots] Capturing 2_trading_journal.png (1280x800)...');
    await page.goto(`chrome-extension://${extId}/options/options.html#journal`, { waitUntil: 'domcontentloaded' });
    await sleep(1200);
    await page.screenshot({ path: path.join(SHOTS_DIR, '2_trading_journal.png'), clip: { x: 0, y: 0, width: 1280, height: 800 } });

    // -------------------------------------------------------------------------
    // Image 3: 3_overview_dashboard.png
    // -------------------------------------------------------------------------
    console.log('[cws-screenshots] Capturing 3_overview_dashboard.png (1280x800)...');
    await page.goto(`chrome-extension://${extId}/options/options.html#overview`, { waitUntil: 'domcontentloaded' });
    await sleep(1000);
    await page.screenshot({ path: path.join(SHOTS_DIR, '3_overview_dashboard.png'), clip: { x: 0, y: 0, width: 1280, height: 800 } });

    // -------------------------------------------------------------------------
    // Image 4: 4_live_market_quotes.png
    // -------------------------------------------------------------------------
    console.log('[cws-screenshots] Capturing 4_live_market_quotes.png (1280x800)...');
    await page.goto(`chrome-extension://${extId}/options/options.html#market`, { waitUntil: 'domcontentloaded' });
    await sleep(1000);
    await page.evaluate(() => {
      const btn = document.getElementById('marketBtn');
      if (btn) btn.click();
    });
    await sleep(1000);
    await page.screenshot({ path: path.join(SHOTS_DIR, '4_live_market_quotes.png'), clip: { x: 0, y: 0, width: 1280, height: 800 } });

    // -------------------------------------------------------------------------
    // Image 5: 5_rules_and_discipline.png
    // -------------------------------------------------------------------------
    console.log('[cws-screenshots] Capturing 5_rules_and_discipline.png (1280x800)...');
    await page.goto(`chrome-extension://${extId}/options/options.html#rules`, { waitUntil: 'domcontentloaded' });
    await sleep(1000);
    await page.screenshot({ path: path.join(SHOTS_DIR, '5_rules_and_discipline.png'), clip: { x: 0, y: 0, width: 1280, height: 800 } });

    await page.close();
    console.log('[cws-screenshots] SUCCESS! Exactly 5 screenshots created at 1280 x 800.');
  } finally {
    await browser.close();
    server.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (e) {}
  }
}

main().catch(err => {
  console.error('[cws-screenshots] Error:', err);
  process.exit(1);
});
