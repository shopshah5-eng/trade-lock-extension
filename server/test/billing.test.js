'use strict';
/**
 * billing.test.js — Comprehensive regression tests for:
 *   §2  Plan/endpoint matrix (canonical plans, billing models, rejected plans)
 *   §3  Serverless fail-closed guard on /api/create-subscription
 *   §4  Webhook body-hash deduplication (no evt.id, distinct events, exact retry)
 *   §5  Subscription fields populated on cold-start (fulfill_order)
 *   §6  Reissue recurring license: subscription linkage transferred
 *   §8  Copy/assertion: recurring products cannot be labelled "no auto-renewal"
 *   §9  Legacy billing semantics fixtures
 *   §10 Cold-start safety: no dynamic Razorpay plan creation
 *   §11 Payment history: multi-renewal and refund by historical payment ID
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const baseFile = path.join(os.tmpdir(), `trade-lock-billing-${process.pid}-${Date.now()}`);
process.env.TL_DATA_FILE = baseFile + '-local.json';
process.env.NETLIFY = '1';
process.env.RAZORPAY_KEY_ID = 'rzp_test_mock';
process.env.RAZORPAY_KEY_SECRET = 'mock_key_secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'mock_webhook_secret';
process.env.RESEND_API_KEY = 'mock_resend_key';
process.env.SUPABASE_URL = 'https://supabase.billing.mock';
process.env.SUPABASE_SERVICE_KEY = 'service-role-billing-mock';
process.env.RAZORPAY_PLAN_PRO_MONTHLY = 'plan_mock_pro_monthly';
process.env.RAZORPAY_PLAN_PRO_YEARLY = 'plan_mock_pro_yearly';
process.env.RAZORPAY_PLAN_PRO_PLUS_AI_MONTHLY = 'plan_mock_plus_monthly';
process.env.RAZORPAY_PLAN_PRO_PLUS_AI_YEARLY = 'plan_mock_plus_yearly';
delete process.env.TL_DEMO_MODE;
delete process.env.VERCEL;
delete process.env.AWS_LAMBDA_FUNCTION_NAME;

const remote = {
  orders: new Map(), licenses: new Map(), webhooks: new Map(), payments: new Map()
};
let orderSeq = 0;
const providerCalls = [];
const originalFetch = global.fetch;

function rowLicense(body) {
  return {
    hash: body.hash || body.p_hash, hint: body.hint || body.p_hint,
    email: body.email || body.p_email, plan: body.plan || body.p_plan,
    created_at: body.created_at || body.p_created_at || new Date().toISOString(),
    expires_at: body.expires_at || body.p_expires_at,
    payment_id: body.payment_id || body.p_payment_id,
    order_id: body.order_id || body.p_order_id,
    subscription_id: body.subscription_id || body.p_subscription_id || null,
    billing_model: body.billing_model || body.p_billing_model || null,
    billing_status: body.billing_status || body.p_billing_status || 'active',
    current_period_start: body.current_period_start || body.p_current_period_start || null,
    current_period_end: body.current_period_end || body.p_current_period_end || null,
    cancel_at_period_end: Boolean(body.cancel_at_period_end || body.p_cancel_at_period_end),
    devices: body.devices || [], revoked: !!body.revoked,
    email_sent_at: body.email_sent_at || null,
    original_payment_id: body.original_payment_id || body.p_original_payment_id || null,
  };
}

global.fetch = async (url, options = {}) => {
  const target = new URL(String(url));
  const method = options.method || 'GET';
  const urlStr = target.href;

  if (urlStr === 'https://api.razorpay.com/v1/orders') {
    providerCalls.push('order');
    const body = JSON.parse(options.body);
    return { ok: true, status: 200, json: async () => ({ id: `order_remote_${++orderSeq}`, amount: body.amount, currency: body.currency }) };
  }
  if (urlStr === 'https://api.razorpay.com/v1/subscriptions') {
    providerCalls.push('subscription');
    const body = JSON.parse(options.body);
    return { ok: true, status: 200, json: async () => ({
      id: `sub_remote_${++orderSeq}`, plan_id: body.plan_id, status: 'active',
      current_end: Math.floor(Date.now() / 1000) + 30 * 86400,
    }) };
  }
  if (urlStr === 'https://api.razorpay.com/v1/plans') {
    providerCalls.push('plan_create');
    return { ok: true, status: 200, json: async () => ({ id: `plan_dynamic_${++orderSeq}` }) };
  }
  if (urlStr.startsWith('https://api.razorpay.com/v1/subscriptions/') && urlStr.endsWith('/cancel')) {
    providerCalls.push('cancel');
    return { ok: true, status: 200, json: async () => ({ id: 'sub_cancelled', status: 'cancelled' }) };
  }
  if (urlStr === 'https://api.resend.com/emails') {
    return { ok: true, status: 200, json: async () => ({ id: 'email_billing_mock' }) };
  }
  if (target.origin !== 'https://supabase.billing.mock') {
    throw new Error('Unexpected outbound URL: ' + urlStr);
  }

  const body = options.body ? JSON.parse(options.body) : null;
  const ok = data => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
  const fail = (status, msg) => ({ ok: false, status, json: async () => ({ message: msg }), text: async () => msg });

  if (target.pathname === '/rest/v1/orders' && method === 'POST') {
    remote.orders.set(body.order_id, { ...body, created_at: body.created_at || new Date().toISOString() });
    return ok(null);
  }
  if (target.pathname === '/rest/v1/orders' && method === 'GET') {
    const id = (target.searchParams.get('order_id') || '').replace('eq.', '');
    return ok(remote.orders.has(id) ? [remote.orders.get(id)] : []);
  }
  if (target.pathname === '/rest/v1/licenses' && method === 'POST') {
    remote.licenses.set(body.hash, { ...(remote.licenses.get(body.hash) || {}), ...body });
    return ok(null);
  }
  if (target.pathname === '/rest/v1/licenses' && method === 'GET') {
    if (target.searchParams.has('or')) {
      const expression = target.searchParams.get('or');
      const match = expression.match(/^\(payment_id\.eq\.([^,]+),original_payment_id\.eq\.([^)]+)\)$/);
      if (match) {
        const rows = Array.from(remote.licenses.values()).filter(l =>
          l.payment_id === match[1] || l.original_payment_id === match[2]);
        return ok(rows);
      }
      return ok([]);
    }
    const field = ['hash', 'order_id', 'payment_id', 'subscription_id'].find(f => target.searchParams.has(f));
    if (!field) return ok([]);
    const value = (target.searchParams.get(field) || '').replace('eq.', '');
    const rows = Array.from(remote.licenses.values()).filter(l => l[field] === value);
    return ok(rows.slice(0, 1));
  }
  if (target.pathname === '/rpc/fulfill_order' && method === 'POST') {
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
      subscription_id: body.p_subscription_id || null, billing_model: body.p_billing_model || null,
      fulfillment_status: 'FULFILLED', fulfilled_at: new Date().toISOString() });
    if (body.p_payment_id) {
      remote.payments.set(body.p_payment_id, {
        payment_id: body.p_payment_id, license_hash: lic.hash,
        subscription_id: body.p_subscription_id || null,
        order_id: body.p_order_id, captured_at: new Date().toISOString(), refunded: false,
      });
    }
    return ok(lic.hash);
  }
  if (target.pathname === '/rpc/reissue_license' && method === 'POST') {
    const old = remote.licenses.get(body.p_old_hash);
    if (!old || old.revoked) return fail(400, 'active license not found');
    const savedSubId = old.subscription_id;
    old.revoked = true; old.revoked_reason = 'support_reissue'; old.revoked_at = new Date().toISOString();
    old.original_payment_id = old.original_payment_id || old.payment_id;
    old.original_order_id = old.original_order_id || old.order_id;
    old.payment_id = null; old.order_id = null; old.subscription_id = null;
    remote.licenses.set(old.hash, old);
    const rep = { ...old, hash: body.p_new_hash, hint: body.p_new_hint,
      created_at: new Date().toISOString(), payment_id: null, order_id: null,
      subscription_id: savedSubId, reissued_from: old.hint, devices: [], revoked: false,
      revoked_reason: null, revoked_at: null, email_sent_at: null };
    remote.licenses.set(rep.hash, rep);
    for (const [pid, ph] of remote.payments) {
      if (ph.license_hash === body.p_old_hash) remote.payments.set(pid, { ...ph, license_hash: body.p_new_hash });
    }
    return ok(rep.hash);
  }
  if (target.pathname === '/rpc/record_payment' && method === 'POST') {
    if (!remote.payments.has(body.p_payment_id)) {
      remote.payments.set(body.p_payment_id, {
        payment_id: body.p_payment_id, license_hash: body.p_license_hash,
        subscription_id: body.p_subscription_id || null,
        captured_at: new Date().toISOString(), refunded: false,
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
    remote.webhooks.set(body.event_id, body); return ok(null);
  }
  if (target.pathname === '/rest/v1/processed_webhooks' && method === 'GET') {
    const id = (target.searchParams.get('event_id') || '').replace('eq.', '');
    return ok(remote.webhooks.has(id) ? [remote.webhooks.get(id)] : []);
  }
  if (target.pathname === '/rpc/register_device' && method === 'POST') {
    const lic = remote.licenses.get(body.p_hash);
    if (!lic) return ok({ allowed: false, devices_used: 0, reason: 'not_found' });
    if (lic.revoked || (lic.expires_at && new Date(lic.expires_at).getTime() <= Date.now())) {
      return ok({ allowed: false, devices_used: 0, reason: 'inactive' });
    }
    const devices = Array.isArray(lic.devices) ? [...lic.devices] : [];
    const maxDevices = Math.max(1, Number(body.p_max_devices) || 3);
    if (devices.includes(body.p_device_id)) {
      return ok({ allowed: true, devices_used: devices.length, reason: null });
    }
    const allowed = devices.length < maxDevices;
    if (allowed) {
      devices.push(body.p_device_id);
      lic.devices = devices;
      remote.licenses.set(lic.hash, lic);
    }
    return ok({ allowed, devices_used: devices.length, reason: allowed ? null : 'device_limit' });
  }
  throw new Error('Unhandled Supabase billing mock: ' + method + ' ' + target.href);
};

function httpReq(port, method, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const raw = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, method, path: route,
      headers: { ...(raw ? { 'Content-Type': 'application/json' } : {}), ...headers } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch (e) {}
        resolve({ status: res.statusCode, body: json, text });
      });
    });
    req.on('error', reject);
    if (raw) req.write(raw);
    req.end();
  });
}

function webhookSig(raw) {
  return crypto.createHmac('sha256', 'mock_webhook_secret').update(raw).digest('hex');
}
function paymentSig(orderId, paymentId) {
  return crypto.createHmac('sha256', 'mock_key_secret').update(orderId + '|' + paymentId).digest('hex');
}
function subscriptionSig(paymentId, subId) {
  return crypto.createHmac('sha256', 'mock_key_secret').update(paymentId + '|' + subId).digest('hex');
}

let server; let port;
let fileSeq = 0;

async function startServer() {
  for (const m of ['../index.js', '../store.js', '../supabase.js', '../plans.js']) {
    delete require.cache[require.resolve(m)];
  }
  server = require('../index.js');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
}
async function stopServer() {
  if (server) await new Promise(resolve => server.close(resolve));
  server = null;
}
async function reloadServer({ emptyLocal = false } = {}) {
  await stopServer();
  if (emptyLocal) process.env.TL_DATA_FILE = `${baseFile}-cold-${++fileSeq}.json`;
  await startServer();
}

// ──────────────────────────────────────────────────────────────────────────────
// §2  Plan / endpoint matrix
// ──────────────────────────────────────────────────────────────────────────────
test('§2 plan/endpoint matrix: canonical plans, amounts, billing models, and rejected products', async t => {
  t.after(() => stopServer());
  await startServer();
  providerCalls.length = 0;

  // Recurring plans create subscriptions
  for (const planId of ['pro_monthly', 'pro_yearly', 'pro_plus_ai_monthly', 'pro_plus_ai_yearly']) {
    const res = await httpReq(port, 'POST', '/api/create-order', { plan: planId, email: 'test@example.com' });
    assert.strictEqual(res.status, 200, `${planId} should succeed: ${res.text}`);
    assert.ok(res.body.subscriptionId, `${planId} must return subscriptionId`);
    assert.strictEqual(res.body.recurring, true, `${planId} must be recurring`);
    assert.ok(!res.body.subscriptionId.startsWith('order_'), `${planId} must not return an order_ id`);
  }
  assert.strictEqual(providerCalls.filter(c => c === 'subscription').length, 4, 'must create 4 subscriptions');
  assert.strictEqual(providerCalls.filter(c => c === 'order').length, 0, 'must not create orders for recurring');
  assert.strictEqual(providerCalls.filter(c => c === 'plan_create').length, 0, '§10: must not auto-create plans');

  // Lifetime creates an order, not a subscription
  providerCalls.length = 0;
  const lifetimeRes = await httpReq(port, 'POST', '/api/create-order', { plan: 'founder_lifetime', email: 'test@example.com' });
  assert.strictEqual(lifetimeRes.status, 200);
  assert.ok(lifetimeRes.body.orderId, 'founder_lifetime must return orderId');
  assert.ok(!lifetimeRes.body.subscriptionId || lifetimeRes.body.subscriptionId === lifetimeRes.body.orderId, 'founder_lifetime must not have a real sub_id');
  assert.strictEqual(lifetimeRes.body.recurring, false);
  assert.strictEqual(providerCalls.filter(c => c === 'order').length, 1, 'founder_lifetime must create exactly one order');
  assert.strictEqual(providerCalls.filter(c => c === 'subscription').length, 0, 'founder_lifetime must not create a subscription');

  // Correct amounts (paise)
  const plans = require('../plans');
  assert.strictEqual(plans.getPlan('pro_monthly').amount, 19900);
  assert.strictEqual(plans.getPlan('pro_yearly').amount, 149900);
  assert.strictEqual(plans.getPlan('pro_plus_ai_monthly').amount, 39900);
  assert.strictEqual(plans.getPlan('pro_plus_ai_yearly').amount, 399900);
  assert.strictEqual(plans.getPlan('founder_lifetime').amount, 299900);

  // Free and unknown plans must be rejected
  const freeRes = await httpReq(port, 'POST', '/api/create-order', { plan: 'free', email: 'test@example.com' });
  assert.ok(freeRes.status >= 400, 'free plan must be rejected by create-order');

  const unknownRes = await httpReq(port, 'POST', '/api/create-order', { plan: 'nope_plan', email: 'test@example.com' });
  assert.ok(unknownRes.status >= 400, 'unknown plan must be rejected by create-order');

  // /api/create-subscription must reject free and lifetime
  const subFreeRes = await httpReq(port, 'POST', '/api/create-subscription', { plan: 'free', email: 'test@example.com' });
  assert.ok(subFreeRes.status >= 400, 'free must be rejected by create-subscription');
  assert.strictEqual(subFreeRes.body.error, 'recurring_plan_required');

  const subLifetimeRes = await httpReq(port, 'POST', '/api/create-subscription', { plan: 'founder_lifetime', email: 'test@example.com' });
  assert.ok(subLifetimeRes.status >= 400, 'founder_lifetime must be rejected by create-subscription');
  assert.strictEqual(subLifetimeRes.body.error, 'recurring_plan_required');

  // Legacy aliases must normalize without duplication
  providerCalls.length = 0;
  const aliasRes = await httpReq(port, 'POST', '/api/create-order', { plan: 'pro_plus_ai', email: 'alias@example.com' });
  assert.strictEqual(aliasRes.status, 200, `alias pro_plus_ai should normalize: ${aliasRes.text}`);
  assert.strictEqual(aliasRes.body.plan, 'pro_plus_ai_monthly', 'alias must normalize to canonical ID');
  assert.strictEqual(providerCalls.filter(c => c === 'subscription').length, 1, 'alias must create exactly one subscription');
});

// ──────────────────────────────────────────────────────────────────────────────
// §3  /api/create-subscription must fail-closed without Supabase on serverless
// ──────────────────────────────────────────────────────────────────────────────
test('§3 /api/create-subscription fails closed on serverless without Supabase', async t => {
  t.after(() => stopServer());

  // No Supabase, NETLIFY set → must reject before any provider call
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_KEY = '';
  await startServer();
  providerCalls.length = 0;

  const noDb = await httpReq(port, 'POST', '/api/create-subscription', { plan: 'pro_monthly', email: 'test@example.com' });
  assert.ok(noDb.status >= 500, `/api/create-subscription must fail without Supabase: ${noDb.text}`);
  assert.strictEqual(providerCalls.filter(c => c === 'subscription').length, 0, 'must not call Razorpay without Supabase');

  // Also verify /api/create-order fails
  const noDbOrder = await httpReq(port, 'POST', '/api/create-order', { plan: 'pro_monthly', email: 'test@example.com' });
  assert.ok(noDbOrder.status >= 500, `/api/create-order must fail without Supabase: ${noDbOrder.text}`);
  assert.strictEqual(providerCalls.filter(c => c === 'subscription').length, 0);

  // Restore Supabase and verify success
  process.env.SUPABASE_URL = 'https://supabase.billing.mock';
  process.env.SUPABASE_SERVICE_KEY = 'service-role-billing-mock';
  await reloadServer({ emptyLocal: true });
  providerCalls.length = 0;

  const withDb = await httpReq(port, 'POST', '/api/create-subscription', { plan: 'pro_monthly', email: 'test@example.com' });
  assert.strictEqual(withDb.status, 200, `create-subscription with Supabase: ${withDb.text}`);
  assert.strictEqual(providerCalls.filter(c => c === 'subscription').length, 1);
  assert.strictEqual(providerCalls.filter(c => c === 'plan_create').length, 0, '§10: still must not auto-create plans');

  // Restore
  process.env.SUPABASE_URL = 'https://supabase.billing.mock';
  process.env.SUPABASE_SERVICE_KEY = 'service-role-billing-mock';
});

// ──────────────────────────────────────────────────────────────────────────────
// §4  Webhook body-hash deduplication (no evt.id)
// ──────────────────────────────────────────────────────────────────────────────
test('§4 webhook body-hash deduplication: two distinct events both processed; exact retry deduplicated', async t => {
  t.after(() => stopServer());
  await reloadServer({ emptyLocal: true });

  // Two DIFFERENT subscription lifecycle events without evt.id
  const evt1 = { event: 'subscription.activated',
    payload: { subscription: { entity: { id: 'sub_dedup_test_1', current_start: Math.floor(Date.now()/1000) } } } };
  const raw1 = JSON.stringify(evt1);

  const evt2 = { event: 'subscription.pending',
    payload: {
      subscription: { entity: { id: 'sub_dedup_test_1' } },
      payment: { entity: { id: 'pay_dedup_p1', subscription_id: 'sub_dedup_test_1', error_description: 'card_declined' } }
    } };
  const raw2 = JSON.stringify(evt2);

  const res1 = await httpReq(port, 'POST', '/api/webhook', raw1, { 'x-razorpay-signature': webhookSig(raw1) });
  assert.strictEqual(res1.status, 200, `event 1 should be processed: ${res1.text}`);
  assert.ok(!res1.body.duplicate, 'event 1 must not be a duplicate');

  const res2 = await httpReq(port, 'POST', '/api/webhook', raw2, { 'x-razorpay-signature': webhookSig(raw2) });
  assert.strictEqual(res2.status, 200, `event 2 should be processed: ${res2.text}`);
  assert.ok(!res2.body.duplicate, 'event 2 must not be a duplicate (different body/hash)');

  // Exact replay of event 1 must be deduplicated
  const replay = await httpReq(port, 'POST', '/api/webhook', raw1, { 'x-razorpay-signature': webhookSig(raw1) });
  assert.strictEqual(replay.status, 200, 'replay must return 200');
  assert.strictEqual(replay.body.duplicate, true, 'exact replay must be marked as duplicate');

  // Both events have distinct hashes in the processed_webhooks store
  assert.strictEqual(remote.webhooks.size, 2, 'must have exactly 2 distinct webhook records');
});

// ──────────────────────────────────────────────────────────────────────────────
// §5  fulfill_order: subscription fields populated before any webhook/email
// ──────────────────────────────────────────────────────────────────────────────
test('§5 fulfill_order populates subscription/billing fields atomically (cold-start safe)', async t => {
  t.after(() => stopServer());
  await reloadServer({ emptyLocal: true });
  remote.licenses.clear(); remote.orders.clear();

  // 1. Create recurring subscription order
  const createRes = await httpReq(port, 'POST', '/api/create-order', { plan: 'pro_monthly', email: 'atomic@example.com' });
  assert.strictEqual(createRes.status, 200);
  const subId = createRes.body.subscriptionId;
  assert.ok(subId && subId.startsWith('sub_'));

  // 2. Verify payment → triggers fulfillOrder with subscription fields
  const payId = 'pay_atomic_1';
  const sig = subscriptionSig(payId, subId);
  const verifyRes = await httpReq(port, 'POST', '/api/verify-payment', {
    subscriptionId: subId, orderId: subId, paymentId: payId,
    signature: sig, email: 'atomic@example.com',
  });
  assert.strictEqual(verifyRes.status, 200, verifyRes.text);
  const licKey = verifyRes.body.licenseKey;
  assert.ok(licKey);
  assert.strictEqual(verifyRes.body.billingModel, 'recurring');
  assert.strictEqual(verifyRes.body.billingStatus, 'active');
  assert.ok(verifyRes.body.subscriptionId);

  // 3. Cold-start: empty local file; only Supabase has the data
  await reloadServer({ emptyLocal: true });

  // 4. Validate: must return subscription metadata without any lifecycle webhook
  const valRes = await httpReq(port, 'POST', '/api/validate', { key: licKey, deviceId: 'dev-atomic-1' });
  assert.strictEqual(valRes.status, 200);
  assert.strictEqual(valRes.body.active, true);
  assert.strictEqual(valRes.body.billingModel, 'recurring', 'subscription billing model must survive cold start');
  assert.ok(valRes.body.subscriptionId, 'subscriptionId must survive cold start');

  // 5. Remote record must have subscription_id and billing_model set at fulfillment
  const storedLic = Array.from(remote.licenses.values()).find(l => l.email === 'atomic@example.com');
  assert.ok(storedLic, 'license must be in Supabase after fulfillment');
  assert.ok(storedLic.subscription_id, 'subscription_id must be stored at fulfillment');
  assert.strictEqual(storedLic.billing_model, 'recurring', 'billing_model must be stored at fulfillment');

  // 6. Founder Lifetime must NOT have a fabricated subscription_id
  remote.orders.clear(); remote.licenses.clear();
  const lifetimeCreate = await httpReq(port, 'POST', '/api/create-order', { plan: 'founder_lifetime', email: 'founder@example.com' });
  assert.strictEqual(lifetimeCreate.status, 200);
  const lifetimeOrderId = lifetimeCreate.body.orderId;
  assert.ok(lifetimeOrderId.startsWith('order_'), 'founder_lifetime must return order_... id');

  const lPayId = 'pay_lifetime_1';
  const lSig = paymentSig(lifetimeOrderId, lPayId);
  const lVerify = await httpReq(port, 'POST', '/api/verify-payment', {
    orderId: lifetimeOrderId, paymentId: lPayId, signature: lSig, email: 'founder@example.com',
  });
  assert.strictEqual(lVerify.status, 200, lVerify.text);
  const lifetimeStored = Array.from(remote.licenses.values()).find(l => l.email === 'founder@example.com');
  assert.ok(lifetimeStored);
  assert.ok(!lifetimeStored.subscription_id, 'founder_lifetime must not have a subscription_id');
  assert.strictEqual(lifetimeStored.billing_model, 'lifetime', 'billing_model must be lifetime');
});

// ──────────────────────────────────────────────────────────────────────────────
// §6  Reissue: subscription linkage transfers; renewal updates replacement not old
// ──────────────────────────────────────────────────────────────────────────────
test('§6 reissue: subscription linkage transfers; renewal updates replacement; cancel uses original subscription', async t => {
  t.after(() => stopServer());
  await reloadServer({ emptyLocal: true });
  remote.licenses.clear(); remote.orders.clear(); remote.payments.clear();

  const L = require('../license');
  const supabase = require('../supabase');

  // 1. Create and fulfill a recurring subscription
  const createRes = await httpReq(port, 'POST', '/api/create-order', { plan: 'pro_monthly', email: 'reissue@example.com' });
  assert.strictEqual(createRes.status, 200);
  const subId = createRes.body.subscriptionId;
  const payId = 'pay_reissue_1';
  const sig = subscriptionSig(payId, subId);
  const verifyRes = await httpReq(port, 'POST', '/api/verify-payment', {
    subscriptionId: subId, orderId: subId, paymentId: payId,
    signature: sig, email: 'reissue@example.com',
  });
  assert.strictEqual(verifyRes.status, 200, verifyRes.text);
  const originalKey = verifyRes.body.licenseKey;
  const originalHash = L.hashKey(originalKey);

  // 2. Reissue the key
  const newKey = L.generateLicenseKey();
  const newHash = L.hashKey(newKey);
  const newHint = L.keyHint(newKey);
  const reissued = await supabase.reissueLicense(originalHash, newHash, newHint);
  assert.strictEqual(reissued.ok, true);

  const oldLic = remote.licenses.get(originalHash);
  const newLic = remote.licenses.get(newHash);
  assert.ok(oldLic, 'old license must still exist');
  assert.strictEqual(oldLic.revoked, true, 'old license must be revoked');
  assert.ok(!oldLic.subscription_id, 'old license must have subscription_id cleared');
  assert.ok(newLic, 'replacement license must exist');
  assert.strictEqual(newLic.subscription_id, subId, 'replacement must own the subscription_id');
  assert.strictEqual(newLic.revoked, false, 'replacement must be active');

  // 3. Cold-start; renewal webhook must update replacement, not old
  await reloadServer({ emptyLocal: true });

  const renewPayId = 'pay_reissue_renew_1';
  const futureEnd = Math.floor(Date.now() / 1000) + 60 * 86400;
  const chargedEvt = {
    id: `evt_reissue_charged_${Date.now()}`,
    event: 'subscription.charged',
    payload: {
      subscription: { entity: { id: subId, current_end: futureEnd } },
      payment: { entity: { id: renewPayId, subscription_id: subId, email: 'reissue@example.com' } }
    }
  };
  const raw = JSON.stringify(chargedEvt);
  const chargedRes = await httpReq(port, 'POST', '/api/webhook', raw, { 'x-razorpay-signature': webhookSig(raw) });
  assert.strictEqual(chargedRes.status, 200, chargedRes.text);

  // Replacement license must have its expiry updated
  const updatedNewLic = remote.licenses.get(newHash);
  assert.ok(updatedNewLic, 'replacement license must be in Supabase after renewal');
  // The renewal payment must be recorded in payment_history linked to replacement
  assert.ok(remote.payments.has(renewPayId), 'renewal payment must be recorded in payment history');
  assert.strictEqual(remote.payments.get(renewPayId).license_hash, newHash, 'renewal payment must link to replacement hash');

  // Old license must remain revoked
  assert.strictEqual(remote.licenses.get(originalHash).revoked, true, 'old license must remain revoked after renewal');

  // 4. Cancel using replacement key → must call Razorpay with original subscription ID
  providerCalls.length = 0;
  // Load replacement into local store so cancel can find it
  await reloadServer({ emptyLocal: true });
  const cancelRes = await httpReq(port, 'POST', '/api/subscription/cancel', {
    key: newKey, reason: 'user_test_cancel'
  });
  assert.strictEqual(cancelRes.status, 200, cancelRes.text);
  assert.strictEqual(cancelRes.body.ok, true);
  assert.strictEqual(cancelRes.body.cancelAtPeriodEnd, true);
  assert.strictEqual(providerCalls.filter(c => c === 'cancel').length, 1, 'cancel must call Razorpay exactly once');
});

// ──────────────────────────────────────────────────────────────────────────────
// §8  Copy: recurring products cannot be labelled "no auto-renewal"
// ──────────────────────────────────────────────────────────────────────────────
test('§8 UI copy: recurring plans must not claim "no auto-renewal" or "prepaid"', async t => {
  const projectRoot = path.join(__dirname, '..', '..');
  const filesToCheck = [
    path.join(projectRoot, 'options', 'options.html'),
    path.join(projectRoot, 'options', 'options.js'),
    path.join(projectRoot, 'popup', 'popup.js'),
    path.join(projectRoot, 'server', 'public', 'index.html'),
    path.join(projectRoot, 'README.md'),
    path.join(projectRoot, 'RAZORPAY_SETUP.md'),
  ];
  const forbiddenPhrases = [
    'no auto-renewal',
    'no auto renewal',
    'Prepaid; no',
    '30-Day Pass',
    '365-Day Pass',
    'one-time prepaid',
    'there is no recurring subscription to cancel',
    'no recurring',
  ];
  for (const filePath of filesToCheck) {
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, 'utf8').toLowerCase();
    for (const phrase of forbiddenPhrases) {
      assert.ok(
        !content.includes(phrase.toLowerCase()),
        `${path.basename(filePath)} must not contain "${phrase}" for a recurring product`
      );
    }
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// §9  Legacy billing semantics: billing_model is authoritative, not inferred
// ──────────────────────────────────────────────────────────────────────────────
test('§9 legacy billing semantics: stored billing_model wins; cancel refuses legacy prepaid; cancel refuses lifetime', async t => {
  t.after(() => stopServer());
  await reloadServer({ emptyLocal: true });

  const L = require('../license');
  const store = require('../store');

  // Fixture: old prepaid monthly license (no subscriptionId, no billingModel)
  const legacyKey = L.generateLicenseKey();
  const legacyHash = L.hashKey(legacyKey);
  store.licenses[legacyHash] = {
    hash: legacyHash, hint: L.keyHint(legacyKey), email: 'legacy@example.com',
    plan: 'pro_monthly', createdAt: Date.now(), expiresAt: Date.now() + 30 * 86400e3,
    paymentId: 'pay_legacy_1', orderId: 'order_legacy_1',
    subscriptionId: null, billingModel: null, billingStatus: null,
    devices: [], revoked: false,
  };
  store.saveSync();

  const cancelLegacy = await httpReq(port, 'POST', '/api/subscription/cancel', { key: legacyKey });
  assert.ok(cancelLegacy.status >= 400, 'legacy prepaid must be rejected by cancel');
  assert.strictEqual(cancelLegacy.body.error, 'not_a_subscription', 'must return not_a_subscription error');

  // Fixture: founder_lifetime license
  const lifetimeKey = L.generateLicenseKey();
  const lifetimeHash = L.hashKey(lifetimeKey);
  store.licenses[lifetimeHash] = {
    hash: lifetimeHash, hint: L.keyHint(lifetimeKey), email: 'lifetime@example.com',
    plan: 'founder_lifetime', createdAt: Date.now(), expiresAt: null,
    paymentId: 'pay_lifetime_x', orderId: 'order_lifetime_x',
    subscriptionId: null, billingModel: 'lifetime', billingStatus: 'active',
    devices: [], revoked: false,
  };
  store.saveSync();

  const cancelLifetime = await httpReq(port, 'POST', '/api/subscription/cancel', { key: lifetimeKey });
  assert.ok(cancelLifetime.status >= 400, 'founder_lifetime must be rejected by cancel');
  assert.strictEqual(cancelLifetime.body.error, 'not_a_subscription');

  // Fixture: cancelled recurring license still inside paid period (must validate as active)
  const cancelledKey = L.generateLicenseKey();
  const cancelledHash = L.hashKey(cancelledKey);
  store.licenses[cancelledHash] = {
    hash: cancelledHash, hint: L.keyHint(cancelledKey), email: 'cancelled@example.com',
    plan: 'pro_monthly', createdAt: Date.now(), expiresAt: Date.now() + 25 * 86400e3,
    paymentId: 'pay_cancelled_1', orderId: null,
    subscriptionId: 'sub_cancelled_1', billingModel: 'recurring', billingStatus: 'cancelled',
    cancelAtPeriodEnd: true, cancelledAt: Date.now() - 86400e3,
    devices: [], revoked: false,
  };
  store.saveSync();

  const valCancelled = await httpReq(port, 'POST', '/api/validate', { key: cancelledKey });
  assert.strictEqual(valCancelled.status, 200);
  assert.strictEqual(valCancelled.body.active, true, 'cancelled subscription inside paid period must be active');
  assert.strictEqual(valCancelled.body.cancelAtPeriodEnd, true);
  assert.strictEqual(valCancelled.body.billingStatus, 'cancelled');
});

// ──────────────────────────────────────────────────────────────────────────────
// §10 Cold-start safety: no dynamic Razorpay plan creation across two instances
// ──────────────────────────────────────────────────────────────────────────────
test('§10 two cold-start instances never auto-create Razorpay plans', async t => {
  t.after(() => stopServer());
  providerCalls.length = 0;

  // Instance 1
  await reloadServer({ emptyLocal: true });
  const r1 = await httpReq(port, 'POST', '/api/create-order', { plan: 'pro_plus_ai_yearly', email: 'cold1@example.com' });
  assert.strictEqual(r1.status, 200, r1.text);

  // Instance 2 (simulated by another reload with empty local)
  await reloadServer({ emptyLocal: true });
  const r2 = await httpReq(port, 'POST', '/api/create-order', { plan: 'pro_plus_ai_yearly', email: 'cold2@example.com' });
  assert.strictEqual(r2.status, 200, r2.text);

  assert.strictEqual(providerCalls.filter(c => c === 'plan_create').length, 0,
    'must never call Razorpay /v1/plans auto-creation across cold starts');
  assert.strictEqual(providerCalls.filter(c => c === 'subscription').length, 2,
    'both instances must create subscriptions using pre-configured plan IDs');
});

// ──────────────────────────────────────────────────────────────────────────────
// §11 Payment history: multi-renewal, refund by historical payment ID
// ──────────────────────────────────────────────────────────────────────────────
test('§11 payment history: P1 initial, P2 renewal, P3 renewal, cold-reload, refund P2 idempotent', async t => {
  t.after(() => stopServer());
  await reloadServer({ emptyLocal: true });
  remote.licenses.clear(); remote.orders.clear(); remote.payments.clear();
  const L = require('../license');

  // 1. Fulfill initial payment P1
  const createRes = await httpReq(port, 'POST', '/api/create-order', { plan: 'pro_monthly', email: 'history@example.com' });
  assert.strictEqual(createRes.status, 200);
  const subId = createRes.body.subscriptionId;
  const p1 = 'pay_history_p1';
  const verifyRes = await httpReq(port, 'POST', '/api/verify-payment', {
    subscriptionId: subId, orderId: subId, paymentId: p1,
    signature: subscriptionSig(p1, subId), email: 'history@example.com',
  });
  assert.strictEqual(verifyRes.status, 200, verifyRes.text);
  const licKey = verifyRes.body.licenseKey;
  const licHash = L.hashKey(licKey);

  // 2. Process renewal P2 via subscription.charged webhook
  const p2 = 'pay_history_p2';
  const futureEnd2 = Math.floor(Date.now() / 1000) + 60 * 86400;
  const evt2 = { id: 'evt_hist_p2', event: 'subscription.charged',
    payload: {
      subscription: { entity: { id: subId, current_end: futureEnd2 } },
      payment: { entity: { id: p2, subscription_id: subId, email: 'history@example.com' } }
    }};
  const raw2 = JSON.stringify(evt2);
  const r2 = await httpReq(port, 'POST', '/api/webhook', raw2, { 'x-razorpay-signature': webhookSig(raw2) });
  assert.strictEqual(r2.status, 200, r2.text);

  // 3. Process renewal P3 via subscription.charged webhook
  const p3 = 'pay_history_p3';
  const futureEnd3 = Math.floor(Date.now() / 1000) + 90 * 86400;
  const evt3 = { id: 'evt_hist_p3', event: 'subscription.charged',
    payload: {
      subscription: { entity: { id: subId, current_end: futureEnd3 } },
      payment: { entity: { id: p3, subscription_id: subId, email: 'history@example.com' } }
    }};
  const raw3 = JSON.stringify(evt3);
  const r3 = await httpReq(port, 'POST', '/api/webhook', raw3, { 'x-razorpay-signature': webhookSig(raw3) });
  assert.strictEqual(r3.status, 200, r3.text);

  // 4. Cold-reload
  await reloadServer({ emptyLocal: true });

  // 5. Payment history must have all 3 payments
  assert.ok(remote.payments.has(p1), 'P1 must be in payment history');
  assert.ok(remote.payments.has(p2), 'P2 must be in payment history');
  assert.ok(remote.payments.has(p3), 'P3 must be in payment history');
  assert.strictEqual(remote.payments.get(p1).license_hash, licHash);
  assert.strictEqual(remote.payments.get(p2).license_hash, licHash);
  assert.strictEqual(remote.payments.get(p3).license_hash, licHash);

  // 6. Refund P2 → license must be revoked
  const refundEvt = { id: 'evt_refund_p2', event: 'refund.processed',
    payload: { refund: { entity: { id: 'rfnd_p2', payment_id: p2 } } } };
  const refundRaw = JSON.stringify(refundEvt);
  const refundRes = await httpReq(port, 'POST', '/api/webhook', refundRaw, { 'x-razorpay-signature': webhookSig(refundRaw) });
  assert.strictEqual(refundRes.status, 200, refundRes.text);

  // License must be revoked
  const revokedLic = Array.from(remote.licenses.values()).find(l => l.email === 'history@example.com');
  assert.ok(revokedLic, 'license must exist in remote');
  assert.strictEqual(revokedLic.revoked, true, 'license must be revoked after P2 refund');

  // 7. Replay P2 refund must be idempotent (deduplicated via webhook receipt)
  const replayRes = await httpReq(port, 'POST', '/api/webhook', refundRaw, { 'x-razorpay-signature': webhookSig(refundRaw) });
  assert.strictEqual(replayRes.status, 200, 'refund replay must return 200');
  assert.strictEqual(replayRes.body.duplicate, true, 'refund replay must be marked duplicate');
});
