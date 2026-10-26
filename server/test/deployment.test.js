'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataFile = path.join(os.tmpdir(), `trade-lock-deployment-${process.pid}-${Date.now()}.json`);
process.env.TL_DEMO_MODE = '1';
process.env.NODE_ENV = 'test';
process.env.VERCEL = '1';
process.env.TL_DATA_FILE = dataFile;
process.env.RAZORPAY_KEY_ID = '';
process.env.RAZORPAY_KEY_SECRET = '';
process.env.SUPABASE_URL = '';
process.env.SUPABASE_SERVICE_KEY = '';
process.env.SUPABASE_KEY = '';

const handler = require('../api/index');

test('Vercel adapter is callable, disables body parsing, and serves the real app', async t => {
  assert.strictEqual(typeof handler, 'function');
  assert.strictEqual(handler.config.api.bodyParser, false);
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dataFile, { force: true });
    fs.rmSync(dataFile + '.tmp', { force: true });
  });
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/health');
  assert.strictEqual(response.status, 200);
  const body = await response.json();
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.demoMode, true);
  assert.strictEqual(body.paymentPersistenceReady, true);
});

test('Deployment: server/lib copies never drift from the canonical lib/', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..', '..');
  // Netlify builds with base="server", so functions cannot require ../lib.
  // server/lib is a mirrored copy and must stay byte-identical.
  for (const file of ['rules.js', 'market.js', 'license.js', 'insights.js', 'detector.js']) {
    const canonical = fs.readFileSync(path.join(root, 'lib', file), 'utf8');
    const mirrored = fs.readFileSync(path.join(root, 'server', 'lib', file), 'utf8');
    assert.strictEqual(mirrored, canonical, `server/lib/${file} has drifted from lib/${file}`);
  }
});
