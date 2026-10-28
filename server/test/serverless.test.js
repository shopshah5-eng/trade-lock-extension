'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const baseFile = path.join(os.tmpdir(), `trade-lock-serverless-${process.pid}-${Date.now()}`);
process.env.TL_DATA_FILE = baseFile + '-local.json';
process.env.NETLIFY = '1';
process.env.RAZORPAY_KEY_ID = 'rzp_test_mock';
process.env.RAZORPAY_KEY_SECRET = 'mock_key_secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'mock_webhook_secret';
process.env.RESEND_API_KEY = 'mock_resend_key';
process.env.SUPABASE_URL = '';
process.env.SUPABASE_SERVICE_KEY = '';
process.env.SUPABASE_KEY = '';
process.env.RAZORPAY_PLAN_PRO_MONTHLY = 'plan_mock_pro_monthly';
process.env.RAZORPAY_PLAN_PRO_YEARLY = 'plan_mock_pro_yearly';
process.env.RAZORPAY_PLAN_PRO_PLUS_AI_MONTHLY = 'plan_mock_plus_monthly';
process.env.RAZORPAY_PLAN_PRO_PLUS_AI_YEARLY = 'plan_mock_plus_yearly';
delete process.env.TL_DEMO_MODE;

const remote = { orders: new Map(), licenses: new Map(), webhooks: new Map(), payments: new Map() };
let orderSequence = 0;
let failNextFulfillment = false;
let failNextEmail = false;
let failNextLicenseSync = false;
let fulfillmentCalls = 0;
const originalFetch = global.fetch;

function rowLicense(body) {
  return {
    hash: body.hash || body.p_hash, hint: body.hint || body.p_hint, email: body.email || body.p_email,
    plan: body.plan || body.p_plan, created_at: body.created_at || body.p_created_at,
    expires_at: body.expires_at || body.p_expires_at, payment_id: body.payment_id || body.p_payment_id,
    order_id: body.order_id || body.p_order_id,
    // Preserve subscription/billing fields from new RPC params
    subscription_id: body.subscription_id || body.p_subscription_id || null,
    billing_model: body.billing_model || body.p_billing_model || null,
    billing_status: body.billing_status || body.p_billing_status || 'active',
    provider_plan_id: body.provider_plan_id || body.p_provider_plan_id || null,
    current_period_start: body.current_period_start || body.p_current_period_start || null,
    current_period_end: body.current_period_end || body.p_current_period_end || null,
    cancel_at_period_end: Boolean(body.cancel_at_period_end || body.p_cancel_at_period_end),
    devices: body.devices || [], revoked: !!body.revoked,
    email_sent_at: body.email_sent_at || null,
    original_payment_id: body.original_payment_id || body.p_original_payment_id || null,
    original_order_id: body.original_order_id || body.p_original_order_id || null,
  };
}

global.fetch = async (url, options = {}) => {
  const target = new URL(String(url));
  const method = options.method || 'GET';
  if (target.href === 'https://api.razorpay.com/v1/orders') {
    const body = JSON.parse(options.body);
    return { ok: true, status: 200, json: async () => ({ id: `order_remote_${++orderSequence}`, amount: body.amount, currency: body.currency }) };
  }
  if (target.href === 'https://api.razorpay.com/v1/subscriptions') {
    const body = JSON.parse(options.body);
    return { ok: true, status: 200, json: async () => ({
      id: `sub_remote_${++orderSequence}`, plan_id: body.plan_id, status: 'active',
      current_end: Math.floor(Date.now() / 1000) + 30 * 86400,
    }) };
  }
  if (target.href === 'https://api.razorpay.com/v1/plans') {
    return { ok: true, status: 200, json: async () => ({ id: `plan_remote_${++orderSequence}` }) };
  }
  if (target.href.startsWith('https://api.razorpay.com/v1/subscriptions/') && target.href.endsWith('/cancel')) {
    return { ok: true, status: 200, json: async () => ({ id: 'sub_remote_cancel', status: 'cancelled' }) };
  }
  if (target.href === 'https://api.resend.com/emails') {
    if (failNextEmail) {
      failNextEmail = false;
      return { ok: false, status: 500, json: async () => ({ message: 'injected email outage' }) };
    }
    return { ok: true, status: 200, json: async () => ({ id: 'email_remote' }) };
  }
  if (target.origin !== 'https://supabase.mock') throw new Error('Unexpected outbound URL: ' + target.href);
  const body = options.body ? JSON.parse(options.body) : null;
  const ok = data => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
  const fail = (status, message) => ({ ok: false, status, json: async () => ({ message }), text: async () => message });

  if (target.pathname === '/rest/v1/orders' && method === 'POST') {
    remote.orders.set(body.order_id, { ...body, created_at: body.created_at || new Date().toISOString() });
    return ok(null);
  }
  if (target.pathname === '/rest/v1/orders' && method === 'GET') {
    const id = target.searchParams.get('order_id').replace('eq.', '');
    return ok(remote.orders.has(id) ? [remote.orders.get(id)] : []);
  }
  if (target.pathname === '/rest/v1/licenses' && method === 'POST') {
    if (failNextLicenseSync && body.email_sent_at) {
      failNextLicenseSync = false;
      return fail(500, 'injected email-status database outage');
    }
    remote.licenses.set(body.hash, { ...(remote.licenses.get(body.hash) || {}), ...rowLicense(body), ...body });
    return ok(null);
  }
  if (target.pathname === '/rest/v1/licenses' && method === 'GET') {
    if (target.searchParams.has('or')) {
      const expression = target.searchParams.get('or');
      const match = expression.match(/^\(payment_id\.eq\.([^,]+),original_payment_id\.eq\.([^)]+)\)$/);
      assert.ok(match, 'unexpected refund OR query: ' + expression);
      const rows = Array.from(remote.licenses.values()).filter(l =>
        l.payment_id === match[1] || l.original_payment_id === match[2]);
      return ok(rows);
    }
    const field = ['hash', 'order_id', 'payment_id', 'subscription_id'].find(f => target.searchParams.has(f));
    const value = target.searchParams.get(field).replace('eq.', '');
    const rows = Array.from(remote.licenses.values()).filter(l => l[field] === value);
    return ok(rows.slice(0, 1));
  }
  if (target.pathname === '/rpc/reissue_license' && method === 'POST') {
    const old = remote.licenses.get(body.p_old_hash);
    if (!old || old.revoked) return fail(400, 'active license not found');
    // Model the real SQL: null unique columns on old row, then insert replacement
    // with subscription linkage transferred.
    const savedSubId = old.subscription_id;
    old.revoked = true;
    old.revoked_reason = 'support_reissue';
    old.revoked_at = new Date().toISOString();
    old.original_payment_id = old.original_payment_id || old.payment_id;
    old.original_order_id = old.original_order_id || old.order_id;
    old.payment_id = null;
    old.order_id = null;
    old.subscription_id = null;
    remote.licenses.set(old.hash, old);
    const replacement = { ...old, hash: body.p_new_hash, hint: body.p_new_hint,
      created_at: new Date().toISOString(),
      payment_id: null, order_id: null,
      // Transfer subscription linkage to replacement
      subscription_id: savedSubId,
      reissued_from: old.hint, devices: [], revoked: false,
      revoked_reason: null, revoked_at: null, email_sent_at: null };
    remote.licenses.set(replacement.hash, replacement);
    // Update payment history to point to replacement hash
    for (const [pid, ph] of remote.payments) {
      if (ph.license_hash === body.p_old_hash) {
        remote.payments.set(pid, { ...ph, license_hash: body.p_new_hash });
      }
    }
    return ok(replacement.hash);
  }
  if (target.pathname === '/rpc/fulfill_order' && method === 'POST') {
    fulfillmentCalls++;
    if (failNextFulfillment) {
      failNextFulfillment = false;
      return fail(500, 'injected database outage');
    }
    // Check subscription_id as well as order_id for idempotency
    const existing = Array.from(remote.licenses.values()).find(l =>
      l.order_id === body.p_order_id ||
      (body.p_subscription_id && l.subscription_id === body.p_subscription_id) ||
      l.payment_id === body.p_payment_id);
    if (existing) return ok(existing.hash);
    const order = remote.orders.get(body.p_order_id);
    if (!order) return fail(400, 'unknown order');
    const lic = rowLicense(body);
    remote.licenses.set(lic.hash, lic);
    remote.orders.set(body.p_order_id, { ...order, status: 'paid', payment_id: body.p_payment_id,
      subscription_id: body.p_subscription_id || null,
      billing_model: body.p_billing_model || null,
      fulfillment_status: 'FULFILLED', fulfilled_at: new Date().toISOString() });
    // Record initial payment in history
    if (body.p_payment_id) {
      remote.payments.set(body.p_payment_id, {
        payment_id: body.p_payment_id, license_hash: lic.hash,
        subscription_id: body.p_subscription_id || null,
        order_id: body.p_order_id, email: body.p_email, plan: body.p_plan,
        captured_at: new Date().toISOString(), refunded: false,
      });
    }
    return ok(lic.hash);
  }
  if (target.pathname === '/rpc/record_payment' && method === 'POST') {
    if (!remote.payments.has(body.p_payment_id)) {
      remote.payments.set(body.p_payment_id, {
        payment_id: body.p_payment_id, license_hash: body.p_license_hash,
        subscription_id: body.p_subscription_id || null,
        order_id: body.p_order_id || null, email: body.p_email || null,
        plan: body.p_plan || null, captured_at: new Date().toISOString(), refunded: false,
      });
    }
    return ok(null);
  }
  if (target.pathname === '/rpc/mark_payment_refunded' && method === 'POST') {
    const ph = remote.payments.get(body.p_payment_id);
    if (ph && !ph.refunded) { ph.refunded = true; ph.refunded_at = new Date().toISOString(); }
    return ok(ph ? ph.license_hash : null);
  }
  if (target.pathname === '/rest/v1/payment_history' && method === 'GET') {
    const pid = (target.searchParams.get('payment_id') || '').replace('eq.', '');
    const rows = pid ? Array.from(remote.payments.values()).filter(p => p.payment_id === pid) : [];
    return ok(rows.map(p => ({ license_hash: p.license_hash })));
  }
  if (target.pathname === '/rest/v1/processed_webhooks' && method === 'POST') {
    remote.webhooks.set(body.event_id, body);
    return ok(null);
  }
  if (target.pathname === '/rest/v1/processed_webhooks' && method === 'GET') {
    const id = target.searchParams.get('event_id').replace('eq.', '');
    return ok(remote.webhooks.has(id) ? [remote.webhooks.get(id)] : []);
  }
  throw new Error('Unhandled Supabase mock route: ' + method + ' ' + target.href);
};

function request(port, method, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const raw = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, method, path: route,
      headers: { ...(raw ? { 'Content-Type': 'application/json' } : {}), ...headers } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) {}
        resolve({ status: res.statusCode, body: json, text });
      });
    });
    req.on('error', reject);
    if (raw) req.write(raw);
    req.end();
  });
}

let server;
let port;
let fileSequence = 0;
async function start() {
  if (!process.env.SUPABASE_URL) {
    process.env.SUPABASE_URL = '';
    process.env.SUPABASE_SERVICE_KEY = '';
    process.env.SUPABASE_KEY = '';
    delete require.cache[require.resolve('../supabase.js')];
    delete require.cache[require.resolve('../index.js')];
  }
  server = require('../index.js');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
}
async function stop() {
  if (server) await new Promise(resolve => server.close(resolve));
  server = null;
}
async function reload({ emptyLocal = false, reloadSupabase = false } = {}) {
  await stop();
  if (emptyLocal) process.env.TL_DATA_FILE = `${baseFile}-cold-${++fileSequence}.json`;
  for (const name of ['../index.js', '../store.js', ...(reloadSupabase ? ['../supabase.js'] : [])]) {
    delete require.cache[require.resolve(name)];
  }
  await start();
}
function paymentSignature(orderId, paymentId) {
  return crypto.createHmac('sha256', 'mock_key_secret').update(orderId + '|' + paymentId).digest('hex');
}
async function createOrder(email = 'remote@example.com') {
  const res = await request(port, 'POST', '/api/create-order', { plan: 'pro_monthly', email });
  assert.strictEqual(res.status, 200, res.text);
  return res.body;
}
async function verify(orderId, paymentId) {
  return request(port, 'POST', '/api/verify-payment', {
    orderId, paymentId, email: 'remote@example.com', signature: paymentSignature(orderId, paymentId),
  });
}

test('serverless payments fail closed without Supabase and recover through remote transactions', async t => {
  t.after(async () => {
    await stop();
    global.fetch = originalFetch;
    for (const file of fs.readdirSync(os.tmpdir())) {
      if (file.startsWith(path.basename(baseFile))) fs.rmSync(path.join(os.tmpdir(), file), { force: true });
    }
  });
  await start();
  const noDb = await request(port, 'POST', '/api/create-order', { plan: 'pro_monthly', email: 'remote@example.com' });
  assert.strictEqual(noDb.status, 503);
  assert.strictEqual(noDb.body.error, 'payment_persistence_not_configured');
  assert.match(noDb.body.detail, /SUPABASE_URL/, 'the 503 must name the env var the owner has to set');
  assert.strictEqual(orderSequence, 0, 'must not create a Razorpay order before durable storage is available');

  process.env.SUPABASE_URL = 'https://supabase.mock';
  process.env.SUPABASE_SERVICE_KEY = 'service-role-mock';
  await reload({ reloadSupabase: true });

  const first = await createOrder();
  failNextFulfillment = true;
  const failed = await verify(first.orderId, 'pay_remote_1');
  assert.strictEqual(failed.status, 500);
  assert.strictEqual(remote.licenses.size, 0);

  const recovered = await verify(first.orderId, 'pay_remote_1');
  assert.strictEqual(recovered.status, 200, recovered.text);
  assert.ok(recovered.body.licenseKey);
  assert.strictEqual(recovered.body.emailSent, true);
  assert.strictEqual(remote.licenses.size, 1);
  assert.strictEqual(fulfillmentCalls, 2);

  // Empty local file simulates a different cold serverless instance.
  await reload({ emptyLocal: true });
  const cold = await verify(first.orderId, 'pay_remote_1');
  assert.strictEqual(cold.status, 200, cold.text);
  assert.strictEqual(cold.body.licenseKey, null);
  assert.strictEqual(cold.body.alreadyFulfilled, true);
  assert.strictEqual(cold.body.emailSent, true);
  assert.strictEqual(remote.licenses.size, 1);
  assert.strictEqual(fulfillmentCalls, 2);

  // A poisoned/stale local order must not replace the authoritative remote
  // payment link or fulfill a second payment against the same order.
  const localStore = require('../store');
  localStore.orders[first.orderId] = { ...localStore.orders[first.orderId],
    status: 'created', paymentId: null, fulfillmentStatus: null };
  const mismatched = await verify(first.orderId, 'pay_remote_different');
  assert.strictEqual(mismatched.status, 409, mismatched.text);
  assert.strictEqual(mismatched.body.error, 'order_payment_mismatch');
  assert.strictEqual(remote.orders.get(first.orderId).payment_id, 'pay_remote_1');
  assert.strictEqual(remote.licenses.size, 1);
  assert.strictEqual(fulfillmentCalls, 2);

  const second = await createOrder();
  await reload({ emptyLocal: true });
  const event = { id: 'evt_remote_1', event: 'payment.captured',
    payload: { payment: { entity: { id: 'pay_remote_webhook', order_id: second.orderId } } } };
  const raw = JSON.stringify(event);
  const signature = crypto.createHmac('sha256', 'mock_webhook_secret').update(raw).digest('hex');
  const webhook = await request(port, 'POST', '/api/webhook', raw, { 'x-razorpay-signature': signature });
  assert.strictEqual(webhook.status, 200, webhook.text);
  assert.strictEqual(Array.from(remote.licenses.values()).filter(l => l.payment_id === 'pay_remote_webhook').length, 1);
  assert.ok(remote.webhooks.has('evt_remote_1'));

  await reload({ emptyLocal: true });
  const replay = await request(port, 'POST', '/api/webhook', raw, { 'x-razorpay-signature': signature });
  assert.strictEqual(replay.status, 200);
  assert.strictEqual(replay.body.duplicate, true);
  assert.strictEqual(Array.from(remote.licenses.values()).filter(l => l.payment_id === 'pay_remote_webhook').length, 1);

  // Browser verification still shows a new key when email fails, but reports the
  // failure truthfully. Webhook processing remains retryable until delivery succeeds.
  const emailOrder = await createOrder();
  failNextEmail = true;
  const emailFailed = await verify(emailOrder.orderId, 'pay_email_failed');
  assert.strictEqual(emailFailed.status, 200, emailFailed.text);
  assert.ok(emailFailed.body.licenseKey);
  assert.strictEqual(emailFailed.body.emailSent, false);
  assert.strictEqual(emailFailed.body.emailError, 'email_delivery_failed');

  const retryOrder = await createOrder();
  const retryEvent = { id: 'evt_email_retry', event: 'payment.captured',
    payload: { payment: { entity: { id: 'pay_email_retry', order_id: retryOrder.orderId } } } };
  const retryRaw = JSON.stringify(retryEvent);
  const retrySignature = crypto.createHmac('sha256', 'mock_webhook_secret').update(retryRaw).digest('hex');
  failNextEmail = true;
  const webhookFailed = await request(port, 'POST', '/api/webhook', retryRaw, { 'x-razorpay-signature': retrySignature });
  assert.strictEqual(webhookFailed.status, 500);
  assert.ok(!remote.webhooks.has('evt_email_retry'));
  const webhookRetried = await request(port, 'POST', '/api/webhook', retryRaw, { 'x-razorpay-signature': retrySignature });
  assert.strictEqual(webhookRetried.status, 200, webhookRetried.text);
  assert.ok(remote.webhooks.has('evt_email_retry'));
  assert.strictEqual(Array.from(remote.licenses.values()).filter(l => l.payment_id === 'pay_email_retry').length, 1);

  const statusOrder = await createOrder();
  failNextLicenseSync = true;
  const statusFailed = await verify(statusOrder.orderId, 'pay_email_status_retry');
  assert.strictEqual(statusFailed.status, 200, statusFailed.text);
  assert.strictEqual(statusFailed.body.emailSent, true, 'provider acceptance is distinct from database status persistence');
  const statusHash = Array.from(remote.licenses.values()).find(l => l.payment_id === 'pay_email_status_retry').hash;
  assert.strictEqual(remote.licenses.get(statusHash).email_sent_at, null);
  const statusRetried = await verify(statusOrder.orderId, 'pay_email_status_retry');
  assert.strictEqual(statusRetried.status, 200, statusRetried.text);
  assert.strictEqual(statusRetried.body.licenseKey, statusFailed.body.licenseKey);
  assert.ok(remote.licenses.get(statusHash).email_sent_at);

  // Reissue through the same RPC adapter used by support, then refund the
  // original payment. Both the old and replacement keys must be revoked.
  const original = Array.from(remote.licenses.values()).find(l => l.payment_id === 'pay_remote_1');
  const L = require('../license');
  const replacementKey = L.generateLicenseKey();
  const replacementHash = L.hashKey(replacementKey);
  const reissued = await require('../supabase').reissueLicense(original.hash, replacementHash, L.keyHint(replacementKey));
  assert.strictEqual(reissued.ok, true);
  assert.strictEqual(remote.licenses.get(replacementHash).original_payment_id, 'pay_remote_1');
  assert.strictEqual(remote.licenses.get(replacementHash).revoked, false);

  const refundEvent = { id: 'evt_refund_refund_entity', event: 'refund.processed',
    payload: { refund: { entity: { id: 'rfnd_remote_1', payment_id: 'pay_remote_1' } } } };
  const refundRaw = JSON.stringify(refundEvent);
  const refundSignature = crypto.createHmac('sha256', 'mock_webhook_secret').update(refundRaw).digest('hex');
  const refunded = await request(port, 'POST', '/api/webhook', refundRaw, { 'x-razorpay-signature': refundSignature });
  assert.strictEqual(refunded.status, 200, refunded.text);
  const refundedLicense = Array.from(remote.licenses.values()).find(l => l.payment_id === 'pay_remote_1' || l.original_payment_id === 'pay_remote_1');
  assert.strictEqual(refundedLicense.revoked, true);
  const validation = await request(port, 'POST', '/api/validate', { key: recovered.body.licenseKey });
  assert.strictEqual(validation.status, 200);
  assert.strictEqual(validation.body.active, false);
  assert.strictEqual(validation.body.reason, 'revoked');
  const replacementValidation = await request(port, 'POST', '/api/validate', { key: replacementKey });
  assert.strictEqual(replacementValidation.body.active, false);
  assert.strictEqual(replacementValidation.body.reason, 'revoked');
  assert.strictEqual(remote.licenses.get(replacementHash).revoked, true);
  const verifyRevoked = await verify(first.orderId, 'pay_remote_1');
  assert.strictEqual(verifyRevoked.status, 409);
  assert.strictEqual(verifyRevoked.body.error, 'license_revoked');
  assert.strictEqual(verifyRevoked.body.licenseKey, null);
});
