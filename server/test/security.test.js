'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const dataFile = path.join(os.tmpdir(), `trade-lock-security-${process.pid}-${Date.now()}.json`);
process.env.TL_DATA_FILE = dataFile;
process.env.RAZORPAY_KEY_ID = 'rzp_test_mock';
process.env.RAZORPAY_KEY_SECRET = 'mock_key_secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'mock_webhook_secret';
process.env.RESEND_API_KEY = 'mock_resend_key';
process.env.GEMINI_API_KEY = 'mock_gemini_key';
delete process.env.TL_DEMO_MODE;
delete process.env.NETLIFY;
delete process.env.VERCEL;
delete process.env.AWS_LAMBDA_FUNCTION_NAME;
process.env.SUPABASE_URL = '';
process.env.SUPABASE_SERVICE_KEY = '';
process.env.SUPABASE_KEY = '';
process.env.FYERS_APP_ID = '';
process.env.FYERS_ACCESS_TOKEN = '';

const originalFetch = global.fetch;
let orderSequence = 0;
const providerCalls = [];
global.fetch = async (url, options = {}) => {
  providerCalls.push(String(url));
  if (String(url) === 'https://api.razorpay.com/v1/orders') {
    const payload = JSON.parse(options.body);
    return { ok: true, status: 200, json: async () => ({
      id: `order_mock_${++orderSequence}`, amount: payload.amount, currency: payload.currency,
    }) };
  }
  if (String(url) === 'https://api.resend.com/emails') {
    return { ok: true, status: 200, json: async () => ({ id: 'email_mock_1' }) };
  }
  throw new Error('Unexpected outbound provider call: ' + url);
};

function request(port, method, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const raw = body === undefined ? null : (Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, method, path: route,
      headers: { ...(raw ? { 'Content-Type': 'application/json' } : {}), ...headers } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) {}
        resolve({ status: res.statusCode, body: json, text, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (raw) req.write(raw);
    req.end();
  });
}

let server;
let store;
let port;
async function start() {
  server = require('../index.js');
  store = require('../store.js');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
}
async function stop() {
  if (server) await new Promise(resolve => server.close(resolve));
  server = null;
}
async function coldReload() {
  await stop();
  for (const name of ['../index.js', '../store.js']) delete require.cache[require.resolve(name)];
  await start();
}
function signature(orderId, paymentId) {
  return crypto.createHmac('sha256', 'mock_key_secret').update(orderId + '|' + paymentId).digest('hex');
}
async function create(plan, email) {
  const res = await request(port, 'POST', '/api/create-order', { plan, email });
  assert.strictEqual(res.status, 200, res.text);
  return res.body;
}
const L = require('../license.js');
const { getPlan } = require('../plans.js');
/** Seed a license directly, simulating a key issued before a plan was withdrawn. */
function seedLicense(planId, email) {
  const plan = getPlan(planId);
  const key = L.generateLicenseKey();
  store.licenses[L.hashKey(key)] = {
    hash: L.hashKey(key), hint: L.keyHint(key), email: String(email).toLowerCase(),
    plan: plan.id, createdAt: Date.now(), expiresAt: L.expiryFor(plan.durationDays),
    paymentId: 'pay_seeded_' + plan.id, orderId: 'order_seeded_' + plan.id,
    devices: [], revoked: false,
  };
  store.saveSync();
  return key;
}
async function verify(orderId, paymentId, email) {
  return request(port, 'POST', '/api/verify-payment', {
    orderId, paymentId, email, signature: signature(orderId, paymentId),
  });
}

test('mocked live checkout, entitlements, cold starts and webhook recovery remain consistent', async t => {
  t.after(async () => {
    await stop();
    global.fetch = originalFetch;
    for (const suffix of ['', '.tmp']) fs.rmSync(dataFile + suffix, { force: true });
  });
  await start();

  const plans = await request(port, 'GET', '/api/plans');
  assert.strictEqual(plans.status, 200);
  assert.deepStrictEqual(plans.body.plans.map(p => p.id).sort(), [
    'founder_lifetime', 'pro_monthly', 'pro_plus_ai_monthly', 'pro_plus_ai_yearly', 'pro_yearly',
  ]);
  assert.ok(plans.body.plans.every(p => p.id !== 'free' && p.billingModel));
  assert.strictEqual((await request(port, 'POST', '/api/create-order', { plan: 'free', email: 'free@example.com' })).status, 400);

  // Pro+ is purchasable again, and its key must carry Pro+ entitlements.
  const plusOrder = await create('pro_plus_ai', 'plus@example.com');
  assert.strictEqual(plusOrder.plan, 'pro_plus_ai_monthly');
  const plusPayment = 'pay_plus_1';
  const plusVerify = await verify(plusOrder.orderId, plusPayment, 'plus@example.com');
  assert.strictEqual(plusVerify.status, 200, plusVerify.text);
  assert.strictEqual(plusVerify.body.plan, 'pro_plus_ai_monthly');
  const plusKey = plusVerify.body.licenseKey;
  for (let i = 0; i < 5; i++) {
    const res = await request(port, 'POST', '/api/validate', { key: plusKey, deviceId: 'plus-device-' + i });
    assert.strictEqual(res.body.active, true, res.text);
    assert.strictEqual(res.body.maxDevices, 5);
    assert.strictEqual(res.body.proPlus, true);
  }
  const sixth = await request(port, 'POST', '/api/validate', { key: plusKey, deviceId: 'plus-device-6' });
  assert.strictEqual(sixth.body.active, false);
  assert.strictEqual(sixth.body.reason, 'device_limit');
  assert.strictEqual(sixth.body.maxDevices, 5);

  const proOrder = await create('pro_monthly', 'pro@example.com');
  assert.strictEqual(orderSequence, 2, 'one Razorpay order per purchase');

  const bad = await request(port, 'POST', '/api/verify-payment', {
    orderId: proOrder.orderId, paymentId: 'pay_pro_1', signature: 'forged', email: 'pro@example.com',
  });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(bad.body.error, 'signature_mismatch');

  const proVerify = await verify(proOrder.orderId, 'pay_pro_1', 'pro@example.com');
  assert.strictEqual(proVerify.status, 200, proVerify.text);
  assert.strictEqual(proVerify.body.emailSent, true);
  assert.strictEqual(proVerify.body.plan, 'pro_monthly');
  const proKey = proVerify.body.licenseKey;
  assert.ok(proKey);

  const proReplay = await verify(proOrder.orderId, 'pay_pro_1', 'pro@example.com');
  assert.strictEqual(proReplay.status, 200);
  assert.strictEqual(proReplay.body.licenseKey, proKey);
  assert.strictEqual(proReplay.body.alreadyFulfilled, true);
  for (let i = 0; i < 3; i++) {
    const res = await request(port, 'POST', '/api/validate', { key: proKey, deviceId: 'pro-device-' + i });
    assert.strictEqual(res.body.active, true, res.text);
    assert.strictEqual(res.body.maxDevices, 3);
    assert.strictEqual(res.body.proPlus, false);
  }
  const fourth = await request(port, 'POST', '/api/validate', { key: proKey, deviceId: 'pro-device-4' });
  assert.strictEqual(fourth.body.reason, 'device_limit');
  assert.strictEqual(fourth.body.maxDevices, 3);

  assert.strictEqual((await request(port, 'GET', '/api/market/live?symbol=NIFTY')).status, 403);
  assert.strictEqual((await request(port, 'GET', '/api/market/live?symbol=NIFTY', undefined,
    { Authorization: 'Bearer ' + proKey })).status, 403);
  const plusMarket = await request(port, 'GET', '/api/market/live?symbol=NIFTY', undefined,
    { Authorization: 'Bearer ' + plusKey });
  assert.strictEqual(plusMarket.status, 503); // entitlement passed; no market credential is configured
  assert.strictEqual(plusMarket.body.error, 'market_feed_not_configured');

  const demo = await request(port, 'GET', '/api/market/demo?symbol=NIFTY');
  assert.strictEqual(demo.status, 200);
  assert.strictEqual(demo.body.brief.source, 'local');
  assert.ok(!providerCalls.some(u => /generativelanguage|openrouter/.test(u)), 'public demo must not invoke paid AI');

  const recovery = await request(port, 'POST', '/api/restore-subscription', { email: 'plus@example.com' });
  assert.strictEqual(recovery.status, 200);
  assert.strictEqual(recovery.body.recovery, 'support_required');
  assert.strictEqual(recovery.body.licenseKey, null);
  assert.ok(!('hint' in recovery.body) && !('plan' in recovery.body) && !('found' in recovery.body));

  // Reload all payment state from disk. Plain keys are deliberately not persisted.
  await coldReload();
  const coldReplay = await verify(proOrder.orderId, 'pay_pro_1', 'pro@example.com');
  assert.strictEqual(coldReplay.status, 200, coldReplay.text);
  assert.strictEqual(coldReplay.body.licenseKey, null);
  assert.strictEqual(coldReplay.body.alreadyFulfilled, true);
  assert.strictEqual(Object.keys(store.licenses).length, 2);

  // Create an order, cold-reload before the browser verifies, then fulfill by webhook.
  const webhookOrder = await create('pro_yearly', 'webhook@example.com');
  await coldReload();
  const webhookPayment = 'pay_webhook_cold';
  const event = {
    id: 'evt_cold_1', event: 'payment.captured',
    payload: { payment: { entity: { id: webhookPayment, order_id: webhookOrder.orderId } } },
  };
  const raw = JSON.stringify(event);
  const webhookSignature = crypto.createHmac('sha256', 'mock_webhook_secret').update(raw).digest('hex');
  const fulfilled = await request(port, 'POST', '/api/webhook', raw, { 'x-razorpay-signature': webhookSignature });
  assert.strictEqual(fulfilled.status, 200, fulfilled.text);
  const webhookLicenses = Object.values(store.licenses).filter(l => l.paymentId === webhookPayment);
  assert.strictEqual(webhookLicenses.length, 1);
  assert.strictEqual(webhookLicenses[0].email, 'webhook@example.com');
  assert.ok(webhookLicenses[0].emailSentAt);
  assert.ok(store.processedWebhooks.evt_cold_1);

  const duplicate = await request(port, 'POST', '/api/webhook', raw, { 'x-razorpay-signature': webhookSignature });
  assert.strictEqual(duplicate.status, 200);
  assert.strictEqual(duplicate.body.duplicate, true);
  assert.strictEqual(Object.values(store.licenses).filter(l => l.paymentId === webhookPayment).length, 1);

  await coldReload();
  const afterRestart = await request(port, 'POST', '/api/webhook', raw, { 'x-razorpay-signature': webhookSignature });
  assert.strictEqual(afterRestart.status, 200);
  assert.strictEqual(afterRestart.body.duplicate, true);
  assert.strictEqual(Object.values(store.licenses).filter(l => l.paymentId === webhookPayment).length, 1);
});
