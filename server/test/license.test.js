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

test('Razorpay subscription signature verifies both (payment_id|sub_id) and (sub_id|payment_id)', () => {
  const secret = 'test_sub_secret';
  const sig1 = crypto.createHmac('sha256', secret).update('pay_sub_1|sub_abc_123').digest('hex');
  const sig2 = crypto.createHmac('sha256', secret).update('sub_abc_123|pay_sub_1').digest('hex');
  assert.strictEqual(L.verifySubscriptionSignature('pay_sub_1', 'sub_abc_123', sig1, secret), true);
  assert.strictEqual(L.verifySubscriptionSignature('pay_sub_1', 'sub_abc_123', sig2, secret), true);
  assert.strictEqual(L.verifySubscriptionSignature('pay_wrong', 'sub_abc_123', sig1, secret), false);
  assert.strictEqual(L.verifySubscriptionSignature('pay_sub_1', 'sub_abc_123', 'bad_sig', secret), false);
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
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const testDataFile = path.join(os.tmpdir(), `trade-lock-license-${process.pid}-${Date.now()}.json`);
process.env.TL_DEMO_MODE = '1';
process.env.NODE_ENV = 'test';
process.env.TL_DATA_FILE = testDataFile;
process.env.RAZORPAY_KEY_ID = '';
process.env.RAZORPAY_KEY_SECRET = '';
process.env.RAZORPAY_WEBHOOK_SECRET = 'mock_webhook_secret';
process.env.RESEND_API_KEY = '';
process.env.SUPABASE_URL = '';
process.env.SUPABASE_SERVICE_KEY = '';
process.env.SUPABASE_KEY = '';
process.on('exit', () => {
  fs.rmSync(testDataFile, { force: true });
  fs.rmSync(testDataFile + '.tmp', { force: true });
});
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

  const keySecret = process.env.RAZORPAY_KEY_SECRET || 'secret';
  const validSig = crypto.createHmac('sha256', keySecret).update(orderId + '|' + paymentId).digest('hex');

  // 2b. Abuse case: Bad signature rejection when live key configured
  if (process.env.RAZORPAY_KEY_SECRET) {
    const badSigRes = await request({
      host: '127.0.0.1', port, path: '/api/verify-payment', method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      orderId,
      paymentId,
      signature: 'bad_forged_sig'
    });
    assert.strictEqual(badSigRes.status, 400);
    assert.strictEqual(badSigRes.body.error, 'signature_mismatch');
  }

  // 3. Abuse case: Email substitution attempt during verification
  const emailSubRes = await request({
    host: '127.0.0.1', port, path: '/api/verify-payment', method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, {
    orderId,
    paymentId,
    signature: validSig,
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
    signature: validSig,
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
    signature: validSig
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
    signature: validSig
  });
  assert.strictEqual(repeatRes.status, 200);
  assert.strictEqual(repeatRes.body.alreadyFulfilled, true);
  assert.strictEqual(repeatRes.body.licenseKey, firstKey, 'returns original key without minting duplicate');
});

test('store persists processed webhook event IDs to prevent duplicate fulfillment after restart', () => {
  const eventId = 'evt_test_dedup_' + Date.now();
  store.processedWebhooks[eventId] = { receivedAt: Date.now(), event: 'payment.captured' };
  store.saveSync();

  // Reload store from disk to simulate complete process restart
  store.reload();
  assert.ok(store.processedWebhooks[eventId], 'Webhook event ID persisted across store reload');
  assert.strictEqual(store.processedWebhooks[eventId].event, 'payment.captured');
});

test('recurring subscription lifecycle: creation, verification, renewal webhook, past-due, and cancellation', async (t) => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => server.close());

  // 1. Create order for recurring pro_monthly
  const createRes = await request({
    host: '127.0.0.1', port, path: '/api/create-order', method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { plan: 'pro_monthly', email: 'sub.subscriber@example.com' });

  assert.strictEqual(createRes.status, 200);
  assert.strictEqual(createRes.body.recurring, true);
  const subId = createRes.body.subscriptionId;
  assert.ok(subId);
  assert.strictEqual(createRes.body.orderId, subId);

  // 2. Verify payment for subscription
  const paymentId = 'pay_sub_test_' + Date.now();
  const verifyRes = await request({
    host: '127.0.0.1', port, path: '/api/verify-payment', method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, {
    subscriptionId: subId,
    orderId: subId,
    paymentId,
    signature: 'demo',
    email: 'sub.subscriber@example.com',
    plan: 'pro_monthly'
  });

  assert.strictEqual(verifyRes.status, 200, verifyRes.text);
  assert.strictEqual(verifyRes.body.ok, true);
  assert.strictEqual(verifyRes.body.billingStatus, 'active');
  assert.strictEqual(verifyRes.body.billingModel, 'recurring');
  assert.strictEqual(verifyRes.body.subscriptionId, subId);
  const licenseKey = verifyRes.body.licenseKey;
  assert.ok(licenseKey);

  // 3. Validate endpoint returns subscription state
  const valRes = await request({
    host: '127.0.0.1', port, path: '/api/validate', method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { key: licenseKey, deviceId: 'dev-sub-1' });

  assert.strictEqual(valRes.status, 200);
  assert.strictEqual(valRes.body.active, true);
  assert.strictEqual(valRes.body.billingStatus, 'active');
  assert.strictEqual(valRes.body.subscriptionId, subId);
  assert.strictEqual(valRes.body.cancelAtPeriodEnd, false);
  const initialExpiry = valRes.body.expiresAt;

  // 4. Renewal webhook (subscription.charged): updates expiry without new key
  const renewPayment = 'pay_renew_' + Date.now();
  const futureEnd = Math.floor(Date.now() / 1000) + 60 * 86400;
  const chargedEvt = {
    id: 'evt_charged_' + Date.now(),
    event: 'subscription.charged',
    payload: {
      subscription: { entity: { id: subId, current_end: futureEnd } },
      payment: { entity: { id: renewPayment, subscription_id: subId, email: 'sub.subscriber@example.com' } }
    }
  };
  const rawCharged = JSON.stringify(chargedEvt);
  const chargedSig = crypto.createHmac('sha256', 'mock_webhook_secret').update(rawCharged).digest('hex');
  const chargedRes = await request({
    host: '127.0.0.1', port, path: '/api/webhook', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': chargedSig }
  }, rawCharged);

  assert.strictEqual(chargedRes.status, 200);
  const storedLic = store.licenses[L.hashKey(licenseKey)];
  assert.strictEqual(storedLic.expiresAt, futureEnd * 1000, 'Renewal updated period end to future end');
  assert.strictEqual(storedLic.billingStatus, 'active');

  // 5. Past-due webhook (subscription.pending): flags billingStatus
  const pendingEvt = {
    id: 'evt_pending_' + Date.now(),
    event: 'subscription.pending',
    payload: {
      subscription: { entity: { id: subId } },
      payment: { entity: { id: 'pay_fail_1', subscription_id: subId, error_description: 'card_declined' } }
    }
  };
  const rawPending = JSON.stringify(pendingEvt);
  const pendingSig = crypto.createHmac('sha256', 'mock_webhook_secret').update(rawPending).digest('hex');
  const pendingRes = await request({
    host: '127.0.0.1', port, path: '/api/webhook', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': pendingSig }
  }, rawPending);

  assert.strictEqual(pendingRes.status, 200);
  assert.strictEqual(storedLic.billingStatus, 'past_due');
  assert.strictEqual(storedLic.failureReason, 'card_declined');

  // 6. Cancellation endpoint: marks cancelAtPeriodEnd while preserving access until expiresAt
  const cancelRes = await request({
    host: '127.0.0.1', port, path: '/api/subscription/cancel', method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { key: licenseKey, reason: 'user_requested_cancel' });

  assert.strictEqual(cancelRes.status, 200);
  assert.strictEqual(cancelRes.body.ok, true);
  assert.strictEqual(cancelRes.body.cancelAtPeriodEnd, true);
  assert.strictEqual(storedLic.cancelAtPeriodEnd, true);
  assert.strictEqual(storedLic.billingStatus, 'cancelled');

  // 7. Idempotent re-cancellation
  const reCancelRes = await request({
    host: '127.0.0.1', port, path: '/api/subscription/cancel', method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { key: licenseKey });

  assert.strictEqual(reCancelRes.status, 200);
  assert.strictEqual(reCancelRes.body.alreadyCancelled, true);

  // 8. License remains active until billing period ends
  const postCancelVal = await request({
    host: '127.0.0.1', port, path: '/api/validate', method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { key: licenseKey });

  assert.strictEqual(postCancelVal.body.active, true, 'License remains active after cancellation until cycle end');
  assert.strictEqual(postCancelVal.body.cancelAtPeriodEnd, true);
  assert.strictEqual(postCancelVal.body.billingStatus, 'cancelled');
});
