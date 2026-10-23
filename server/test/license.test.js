'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const L = require('../license');
const { PLANS, getPlan } = require('../plans');

test('license keys are well-formed and unique', () => {
  const a = L.generateLicenseKey(); const b = L.generateLicenseKey();
  assert.match(a, /^TL-[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/);
  assert.notStrictEqual(a, b);
});

test('hashKey is stable and case/space-insensitive', () => {
  const k = L.generateLicenseKey();
  assert.strictEqual(L.hashKey(k), L.hashKey('  ' + k.toLowerCase() + ' '));
  assert.strictEqual(L.hashKey(k).length, 64);
});

test('Razorpay payment signature verifies (order_id|payment_id HMAC)', () => {
  const secret = 'test_secret';
  const sig = crypto.createHmac('sha256', secret).update('order_123|pay_456').digest('hex');
  assert.strictEqual(L.verifyPaymentSignature('order_123', 'pay_456', sig, secret), true);
  assert.strictEqual(L.verifyPaymentSignature('order_123', 'pay_999', sig, secret), false);
  assert.strictEqual(L.verifyPaymentSignature('order_123', 'pay_456', sig, 'wrong'), false);
  assert.strictEqual(L.verifyPaymentSignature('order_123', 'pay_456', '', secret), false);
});

test('webhook signature verifies over the raw body', () => {
  const body = Buffer.from('{"event":"payment.captured"}');
  const sig = crypto.createHmac('sha256', 'whsec').update(body).digest('hex');
  assert.strictEqual(L.verifyWebhookSignature(body, sig, 'whsec'), true);
  assert.strictEqual(L.verifyWebhookSignature(Buffer.from('{}'), sig, 'whsec'), false);
});

test('expiry: monthly +30d, yearly +365d, lifetime never', () => {
  const t0 = 1_700_000_000_000;
  assert.strictEqual(L.expiryFor(30, t0), t0 + 30 * 86400e3);
  assert.strictEqual(L.expiryFor(365, t0), t0 + 365 * 86400e3);
  assert.strictEqual(L.expiryFor(null, t0), null);
});

test('licenseStatus handles active / expired / revoked / missing', () => {
  const now = Date.now();
  assert.strictEqual(L.licenseStatus(null, now).active, false);
  assert.strictEqual(L.licenseStatus({ plan: 'pro_yearly', expiresAt: now + 1000 }, now).active, true);
  assert.strictEqual(L.licenseStatus({ plan: 'lifetime', expiresAt: null }, now).active, true);
  assert.strictEqual(L.licenseStatus({ plan: 'pro_yearly', expiresAt: now - 1 }, now).reason, 'expired');
  assert.strictEqual(L.licenseStatus({ plan: 'pro_yearly', expiresAt: null, revoked: true }, now).reason, 'revoked');
});

test('plans are priced in paise for India', () => {
  assert.strictEqual(getPlan('pro_monthly').amount, 19900);
  assert.strictEqual(getPlan('pro_yearly').amount, 149900);
  assert.strictEqual(getPlan('lifetime').amount, 299900);
  assert.strictEqual(getPlan('nope'), null);
  for (const p of Object.values(PLANS)) assert.strictEqual(p.currency, 'INR');
});

// ------------------------------------------------ server integration tests ----

const http = require('node:http');
const server = require('../index');
const store = require('../store');

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, body: json });
      });
    });
    req.on('error', reject);
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

test('payment order creation and verification security abuse-cases', async (t) => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => server.close());

  // 1. Create order
  const createRes = await request({
    host: '127.0.0.1', port, path: '/api/create-order', method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { plan: 'pro_monthly', email: 'original.buyer@example.com' });

  assert.strictEqual(createRes.status, 200);
  const orderId = createRes.body.orderId;
  assert.ok(orderId);

  // 2. Abuse case: Unknown order ID
  const unknownRes = await request({
    host: '127.0.0.1', port, path: '/api/verify-payment', method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { orderId: 'order_INVALID_999', paymentId: 'pay_123', signature: 'sig_123' });
  assert.strictEqual(unknownRes.status, 400);
  assert.strictEqual(unknownRes.body.error, 'unknown_order');

  const paymentId = 'pay_test_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);

  // 3. Abuse case: Email substitution attempt during verification
  const emailSubRes = await request({
    host: '127.0.0.1', port, path: '/api/verify-payment', method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, {
    orderId,
    paymentId,
    signature: 'demo_sig',
    email: 'hacker.attacker@evil.com' // Attempting to divert license to different email
  });
  assert.strictEqual(emailSubRes.status, 400);
  assert.strictEqual(emailSubRes.body.error, 'email_mismatch');

  // 4. Abuse case: Plan substitution attempt during verification
  const planSubRes = await request({
    host: '127.0.0.1', port, path: '/api/verify-payment', method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, {
    orderId,
    paymentId,
    signature: 'demo_sig',
    plan: 'lifetime' // Attempting to upgrade monthly order to lifetime
  });
  assert.strictEqual(planSubRes.status, 400);
  assert.strictEqual(planSubRes.body.error, 'plan_mismatch');

  // 5. Legitimate verification: binds strictly to original.buyer@example.com
  const legitRes = await request({
    host: '127.0.0.1', port, path: '/api/verify-payment', method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, {
    orderId,
    paymentId,
    signature: 'demo_sig'
  });
  assert.strictEqual(legitRes.status, 200);
  assert.strictEqual(legitRes.body.ok, true);
  const firstKey = legitRes.body.licenseKey;
  assert.ok(firstKey);

  // Check stored license has the original email, NOT any substitute
  const licHash = L.hashKey(firstKey);
  const storedLic = store.licenses[licHash];
  assert.ok(storedLic);
  assert.strictEqual(storedLic.email, 'original.buyer@example.com');
  assert.strictEqual(storedLic.plan, 'pro_monthly');

  // 6. Abuse case: Repeated verification replay (idempotency check)
  const repeatRes = await request({
    host: '127.0.0.1', port, path: '/api/verify-payment', method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, {
    orderId,
    paymentId,
    signature: 'demo_sig'
  });
  assert.strictEqual(repeatRes.status, 200);
  assert.strictEqual(repeatRes.body.alreadyFulfilled, true);
  assert.strictEqual(repeatRes.body.licenseKey, firstKey, 'returns original key without minting duplicate');
});

