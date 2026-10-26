'use strict';
/*
 * Trade Lock — license & checkout server.
 *
 *   GET  /                      pricing page (public/index.html)
 *   GET  /api/plans             plan catalogue (paise)
 *   GET  /api/config            { keyId, demoMode } for the checkout page
 *   POST /api/create-order      { plan, email }            -> Razorpay order
 *   POST /api/verify-payment    { orderId, paymentId, signature, email }
 *                               -> verifies Razorpay signature, issues key
 *   POST /api/webhook           Razorpay webhook (raw body, signature header)
 *   POST /api/validate          { key, deviceId }          -> license status
 *
 * No dependencies: Node >= 18 (global fetch) only.
 * Razorpay credentials come from env — see .env.example / RAZORPAY_SETUP.md.
 */
require('./env').loadEnvFile(); // server/.env, if present
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { PLANS, getPlan, canonicalPlanId, isAvailable, purchasablePlans } = require('./plans');
const marketFeed = require('./marketFeed');
const upstoxProvider = require('./providers/upstox');
const TLMarket = fs.existsSync(path.join(__dirname, 'lib', 'market.js'))
  ? require('./lib/market')
  : require('../lib/market');
const fyers = require('./fyers');
const ai = require('./ai');

const FYERS_APP_ID = process.env.FYERS_APP_ID || '';
const FYERS_SECRET = process.env.FYERS_SECRET || '';
const FYERS_REDIRECT_URL = process.env.FYERS_REDIRECT_URL || '';
const FYERS_ACCESS_TOKEN = process.env.FYERS_ACCESS_TOKEN || '';
const FYERS_ADMIN_TOKEN = process.env.FYERS_ADMIN_TOKEN || '';

const getFyersAppId = () => process.env.FYERS_APP_ID || FYERS_APP_ID || '';
const getFyersSecret = () => process.env.FYERS_SECRET || FYERS_SECRET || '';
const getFyersRedirectUrl = () => process.env.FYERS_REDIRECT_URL || FYERS_REDIRECT_URL || '';
const getFyersAccessToken = () => process.env.FYERS_ACCESS_TOKEN || FYERS_ACCESS_TOKEN || '';

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const emailService = require('./email');
const supabase = require('./supabase');
const paymentStatus = require('./paymentStatus');
const L = require('./license');
const store = require('./store');

const PORT = Number(process.env.PORT || 8787);
const KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || '';
const IS_SERVERLESS = Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY || process.env.VERCEL);
const PROVIDER_TIMEOUT_MS = Number(process.env.PROVIDER_TIMEOUT_MS || 15000);

/*
 * Local test checkout. This is NOT market data - it issues a licence without a
 * payment so the purchase flow can be exercised offline.
 *
 * It is opt-in (TL_DEMO_MODE=1), refuses to run in production, and refuses to
 * run on any hosted platform. Without that last guard a stray env var on Netlify
 * would hand out free lifetime licences.
 */
const isDemoMode = () =>
  process.env.TL_DEMO_MODE === '1' &&
  process.env.NODE_ENV !== 'production' &&
  !IS_SERVERLESS;
const DEMO_MODE = isDemoMode();
const razorpayConfigured = () => Boolean((process.env.RAZORPAY_KEY_ID !== undefined ? process.env.RAZORPAY_KEY_ID : KEY_ID) && (process.env.RAZORPAY_KEY_SECRET !== undefined ? process.env.RAZORPAY_KEY_SECRET : KEY_SECRET));
const isServerless = () => Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY || process.env.VERCEL || IS_SERVERLESS);
const demoCheckoutEnabled = () => isDemoMode() && !razorpayConfigured();
const paymentPersistenceReady = () => demoCheckoutEnabled() || supabase.isConfigured() || !isServerless();

async function providerFetch(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

// ------------------------------------------------------------ helpers ----

function getCorsOrigin(req) {
  if (!req || !req.headers) return '*';
  const origin = req.headers.origin || '';
  if (!origin) return '*';
  if (origin.startsWith('chrome-extension://')) return origin;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  if (origin === 'https://trade-lock-app.netlify.app' || (process.env.PUBLIC_BASE_URL && origin === process.env.PUBLIC_BASE_URL)) {
    return origin;
  }
  return null;
}

function json(res, code, obj, req) {
  const body = JSON.stringify(obj);
  const allowOrigin = getCorsOrigin(req);
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  };
  if (allowOrigin) {
    headers['Access-Control-Allow-Origin'] = allowOrigin;
  }
  res.writeHead(code, headers);
  res.end(body);
}

const rateLimitMap = new Map();
function isRateLimited(req, limit = 60, windowMs = 60000) {
  const forwarded = req.headers && req.headers['x-forwarded-for'];
  const ip = String(forwarded ? forwarded.split(',')[0].trim() : (req.socket?.remoteAddress || '127.0.0.1'));
  const key = ip + ':' + limit + ':' + windowMs;
  const now = Date.now();
  if (rateLimitMap.size > 10000) {
    for (const [k, v] of rateLimitMap) if (now - v.start > windowMs) rateLimitMap.delete(k);
    if (rateLimitMap.size > 10000) rateLimitMap.clear();
  }
  let entry = rateLimitMap.get(key);
  if (!entry || now - entry.start > windowMs) {
    entry = { count: 1, start: now };
    rateLimitMap.set(key, entry);
    return false;
  }
  entry.count++;
  return entry.count > limit;
}

function readBody(req) {
  if (req.rawBody) {
    if (Buffer.isBuffer(req.rawBody)) return Promise.resolve(req.rawBody);
    if (typeof req.rawBody === 'string') return Promise.resolve(Buffer.from(req.rawBody, 'utf8'));
  }
  if (req.body) {
    if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body);
    if (typeof req.body === 'string') return Promise.resolve(Buffer.from(req.body, 'utf8'));
    if (typeof req.body === 'object') return Promise.resolve(Buffer.from(JSON.stringify(req.body), 'utf8'));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => { chunks.push(c); if (Buffer.concat(chunks).length > 1e6) reject(new Error('too big')); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return req.body;
  }
  const raw = await readBody(req);
  try { return JSON.parse(raw.toString('utf8') || '{}'); } catch (e) { return {}; }
}

// In-memory ONLY: paymentId -> plain key, so a retried verify in this process
// can re-show the key. The plain key is NEVER written to disk — only its hash.
const issuedThisProcess = new Map();

function cacheLicense(lic) {
  if (!lic) return null;
  lic.devices = Array.isArray(lic.devices) ? lic.devices : [];
  store.licenses[lic.hash] = lic;
  return lic;
}

async function findExistingLicense(paymentId, orderId) {
  if (supabase.isConfigured()) {
    // Remote state is authoritative: a local cache must not resurrect a
    // revoked/reissued license or skip a failed email-status synchronization.
    let remote = orderId ? await supabase.fetchLicenseBy('order_id', orderId) : null;
    if (!remote && paymentId) remote = await supabase.fetchLicenseBy('payment_id', paymentId);
    return cacheLicense(remote);
  }
  return Object.values(store.licenses).find(l =>
    (orderId && l.orderId === orderId) || (paymentId && l.paymentId === paymentId)) || null;
}

async function persistOrder(orderId, order) {
  store.orders[orderId] = order;
  store.saveSync();
  if (supabase.isConfigured()) {
    const result = await supabase.syncOrder(orderId, order);
    if (!result.ok) throw new Error('durable_order_persistence_failed: ' + (result.error || 'unknown error'));
  }
}

async function issueLicense(email, planId, paymentId, orderId) {
  const existing = await findExistingLicense(paymentId, orderId);
  if (existing) {
    const existingOrder = store.orders[orderId];
    // Supabase fulfillment/order linkage is owned by the remote transaction.
    // Never let a stale local order overwrite it through the generic upsert.
    if (!supabase.isConfigured() && existingOrder &&
        (existingOrder.status !== 'paid' || existingOrder.fulfillmentStatus !== 'FULFILLED')) {
      Object.assign(existingOrder, { status: 'paid',
        paymentId: existing.paymentId || existingOrder.paymentId || paymentId,
        fulfillmentStatus: 'FULFILLED', fulfilledAt: Date.now() });
      await persistOrder(orderId, existingOrder);
    }
    return { lic: existing, key: issuedThisProcess.get(paymentId) || null, existing: true };
  }
  const p = getPlan(planId);
  if (!p || !p.amount) throw new Error('invalid_paid_plan');
  const order = store.orders[orderId];
  if (!order) throw new Error('unknown_order_during_fulfillment');
  const key = L.generateLicenseKey();
  const lic = {
    hash: L.hashKey(key), hint: L.keyHint(key), email: String(email || '').toLowerCase(),
    plan: p.id, createdAt: Date.now(), expiresAt: L.expiryFor(p.durationDays),
    paymentId: paymentId || null, orderId: orderId || null,
    devices: [], revoked: false,
  };

  if (supabase.isConfigured()) {
    const tx = await supabase.fulfillOrder(orderId, order, lic);
    if (!tx.ok) throw new Error('durable_fulfillment_failed: ' + (tx.error || 'unknown error'));
    if (tx.hash !== lic.hash) {
      const concurrentlyIssued = await supabase.fetchLicense(tx.hash);
      if (!concurrentlyIssued) throw new Error('fulfillment_hash_mismatch');
      cacheLicense(concurrentlyIssued);
      Object.assign(order, { status: 'paid',
        paymentId: concurrentlyIssued.paymentId || order.paymentId || paymentId,
        fulfillmentStatus: 'FULFILLED', fulfilledAt: Date.now() });
      store.saveSync();
      return { lic: concurrentlyIssued, key: issuedThisProcess.get(paymentId) || null, existing: true };
    }
  }

  cacheLicense(lic);
  Object.assign(order, {
    status: 'paid', paymentId, paidAt: order.paidAt || Date.now(),
    fulfillmentStatus: 'FULFILLED', fulfilledAt: Date.now(),
  });
  store.saveSync();
  issuedThisProcess.set(paymentId, key);
  return { lic, key, existing: false };
}

async function sendIssuedLicenseEmail(issued, email, plan) {
  if (!issued.key || !email) return { ok: false, skipped: true, reason: 'no_new_key' };
  const result = await emailService.sendLicenseEmail({
    to: email, licenseKey: issued.key, plan,
    expiresAt: issued.lic.expiresAt, fetchImpl: providerFetch,
  });
  if (result.ok) {
    const previousSentAt = issued.lic.emailSentAt || null;
    issued.lic.emailSentAt = Date.now();
    if (supabase.isConfigured()) {
      const synced = await supabase.syncLicense(issued.lic);
      if (!synced.ok) {
        issued.lic.emailSentAt = previousSentAt;
        store.saveSync();
        console.error('[email] Provider accepted the key, but email status persistence failed.');
        return { ...result, persistenceError: synced.error || 'email_status_sync_failed' };
      }
    }
    store.saveSync();
  }
  return result;
}

async function requireProPlus(req) {
  if (adminAuthorized(req)) return { plan: 'pro_plus', active: true, proPlus: true };
  const auth = String(req.headers.authorization || '');
  const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!key) return null;
  const hash = L.hashKey(key);
  const lic = supabase.isConfigured() ? await supabase.fetchLicense(hash) : store.licenses[hash];
  if (!lic || !L.licenseStatus(lic).active) return null;
  const plan = getPlan(lic.plan);
  return plan && plan.proPlus ? lic : null;
}

function adminAuthorized(req) {
  const supplied = String(req.headers['x-admin-token'] ||
    (String(req.headers.authorization || '').startsWith('Bearer ') ? req.headers.authorization.slice(7).trim() : ''));
  if (!FYERS_ADMIN_TOKEN || !supplied || supplied.length !== FYERS_ADMIN_TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(FYERS_ADMIN_TOKEN));
}

function createFyersState() {
  const payload = Date.now() + '.' + crypto.randomBytes(16).toString('hex');
  const sig = crypto.createHmac('sha256', getFyersSecret()).update(payload).digest('hex');
  return Buffer.from(payload + '.' + sig).toString('base64url');
}

function validFyersState(state) {
  if (state === 'trade-lock') return true;
  try {
    const decoded = Buffer.from(String(state || ''), 'base64url').toString('utf8');
    const parts = decoded.split('.');
    if (parts.length !== 3 || Date.now() - Number(parts[0]) > 10 * 60 * 1000 || Number(parts[0]) > Date.now() + 30000) return false;
    const expected = crypto.createHmac('sha256', getFyersSecret()).update(parts[0] + '.' + parts[1]).digest('hex');
    if (expected.length !== parts[2].length) return false;
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts[2]));
  } catch (e) { return false; }
}

async function razorpayCreateOrder(plan, email) {
  const auth = Buffer.from(KEY_ID + ':' + KEY_SECRET).toString('base64');
  const r = await providerFetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + auth },
    body: JSON.stringify({
      amount: plan.amount, currency: plan.currency,
      receipt: 'tl_' + Date.now().toString(36),
      notes: { product: 'trade-lock', plan: plan.id, email: email || '' },
    }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error('Razorpay: ' + (data.error && data.error.description || r.status));
  return data;
}

const inFlightOrders = new Set();

// -------------------------------------------------------------- routes ----

const server = http.createServer(async (req, res) => {
  let cleanUrl = req.url;
  if (cleanUrl.startsWith('/.netlify/functions/api')) {
    cleanUrl = cleanUrl.replace('/.netlify/functions/api', '') || '/';
  }
  const url = new URL(cleanUrl, 'http://localhost');
  try {
    if (req.method === 'OPTIONS') return json(res, 204, {}, req);

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (req.method === 'GET' && url.pathname === '/api/plans') {
      return json(res, 200, { plans: purchasablePlans() }, req);
    }
    if (req.method === 'GET' && url.pathname === '/api/config') {
      const feed = marketFeed.resolveProvider();
      return json(res, 200, { keyId: KEY_ID, demoMode: demoCheckoutEnabled(), configured: razorpayConfigured(),
        marketProvider: feed.id,
        marketFeedConfigured: feed.configured,
        marketCredential: feed.tokenNote,
        upstoxConfigured: Boolean(process.env.UPSTOX_ANALYTICS_TOKEN),
        fyersConfigured: Boolean(FYERS_APP_ID && FYERS_ACCESS_TOKEN),
        openRouterConfigured: Boolean(OPENROUTER_API_KEY),
        geminiConfigured: Boolean(GEMINI_API_KEY),
        resendConfigured: Boolean(RESEND_API_KEY),
        supabaseConfigured: supabase.isConfigured() }, req);
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      const feed = marketFeed.resolveProvider();
      return json(res, 200, {
        ok: true,
        configured: razorpayConfigured(),
        demoMode: demoCheckoutEnabled(),
        paymentPersistenceReady: paymentPersistenceReady(),
        marketFeed: { provider: feed.id, configured: feed.configured, credential: feed.tokenNote },
        cache: marketFeed.cacheStats(),
      }, req);
    }

    if (req.method === 'POST' && url.pathname === '/api/create-order') {
      if (isRateLimited(req, 20, 60000)) return json(res, 429, { error: 'rate_limited', detail: 'Too many requests' }, req);
      const { plan: planId, email } = await readJson(req);
      const plan = getPlan(planId);
      if (!plan || !plan.amount) return json(res, 400, { error: 'unknown_plan' }, req);
      if (!isAvailable(planId)) {
        return json(res, 409, {
          error: 'plan_not_available',
          detail: 'This plan is not open for purchase yet. Pro+ market data requires a licensed redistributable feed and is not sold at this time.',
        }, req);
      }
      if (!paymentPersistenceReady()) return json(res, 503, {
        error: 'payment_persistence_not_configured',
        detail: 'Serverless deployments must set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY so an order survives between the checkout request and the Razorpay webhook. Locally the file store is used and this is not required.',
      }, req);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '')) return json(res, 400, { error: 'valid_email_required' }, req);

      const normalizedEmail = String(email).toLowerCase().trim();

      if (demoCheckoutEnabled()) {
        const orderId = 'order_DEMO_' + Date.now().toString(36);
        store.orders[orderId] = {
          email: normalizedEmail,
          plan: plan.id,
          amount: plan.amount,
          currency: plan.currency,
          status: 'demo',
          createdAt: Date.now()
        };
        await persistOrder(orderId, store.orders[orderId]);
        return json(res, 200, { demo: true, orderId, amount: plan.amount, currency: plan.currency, plan: plan.id }, req);
      }
      if (!razorpayConfigured()) return json(res, 503, {
        error: 'payments_not_configured',
        detail: 'Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET on the licence server to take payments.',
      }, req);

      const order = await razorpayCreateOrder(plan, normalizedEmail);
      store.orders[order.id] = {
        email: normalizedEmail,
        plan: plan.id,
        amount: order.amount,
        currency: order.currency,
        status: 'created',
        createdAt: Date.now()
      };
      await persistOrder(order.id, store.orders[order.id]);
      return json(res, 200, { orderId: order.id, amount: order.amount, currency: order.currency, plan: plan.id }, req);
    }

    if (req.method === 'POST' && url.pathname === '/api/verify-payment') {
      if (isRateLimited(req, 20, 60000)) return json(res, 429, { error: 'rate_limited', detail: 'Too many requests' }, req);
      if (!paymentPersistenceReady()) return json(res, 503, { error: 'payment_persistence_not_configured' }, req);
      const { orderId, paymentId, signature, email, plan: planId } = await readJson(req);
      if (!orderId || !paymentId || String(orderId).length > 128 || String(paymentId).length > 128) {
        return json(res, 400, { error: 'invalid_request', detail: 'orderId and paymentId are required' }, req);
      }

      let order = supabase.isConfigured() ? await supabase.fetchOrder(orderId) : store.orders[orderId];
      if (order && supabase.isConfigured()) store.orders[orderId] = order;
      if (!order) return json(res, 400, { error: 'unknown_order' }, req);
      if (email && String(email).toLowerCase().trim() !== String(order.email).toLowerCase().trim()) {
        return json(res, 400, { error: 'email_mismatch', detail: 'Supplied email does not match order record' }, req);
      }
      if (planId && canonicalPlanId(planId) !== canonicalPlanId(order.plan)) {
        return json(res, 400, { error: 'plan_mismatch', detail: 'Supplied plan does not match order record' }, req);
      }
      if (inFlightOrders.has(orderId)) {
        return json(res, 409, { error: 'fulfillment_in_progress', retryAfterMs: 1000 }, req);
      }
      inFlightOrders.add(orderId);

      try {
        if (demoCheckoutEnabled()) {
          if (!String(orderId).startsWith('order_DEMO_') ||
            (order.status !== 'demo' && !(order.status === 'paid' && order.fulfillmentStatus === 'FULFILLED'))) {
            return json(res, 400, { error: 'bad_demo_order' }, req);
          }
        } else if (!signature || !L.verifyPaymentSignature(orderId, paymentId, signature, KEY_SECRET)) {
          return json(res, 400, { error: 'signature_mismatch' }, req);
        }
        if (order.paymentId && order.paymentId !== paymentId) {
          return json(res, 409, { error: 'order_payment_mismatch', licenseKey: null,
            detail: 'This order is already linked to a different payment. Contact support for assistance.' }, req);
        }

        const customerEmail = order.email;
        const canonicalPlan = canonicalPlanId(order.plan);
        const alreadyFulfilled = order.status === 'paid' && order.fulfillmentStatus === 'FULFILLED';
        let issued = await issueLicense(customerEmail, canonicalPlan, paymentId, orderId);
        const issuedStatus = L.licenseStatus(issued.lic);
        if (!issuedStatus.active) {
          return json(res, 409, { error: 'license_' + (issuedStatus.reason || 'inactive'),
            alreadyFulfilled: true, licenseKey: null, emailSent: Boolean(issued.lic.emailSentAt) }, req);
        }
        let emailResult = { ok: false, skipped: true };

        // A warm-process retry can re-show its cached key. A cold retry cannot,
        // but emailSentAt tells us whether delivery had already completed.
        if (issued.key && !issued.lic.emailSentAt) {
          emailResult = await sendIssuedLicenseEmail(issued, customerEmail, canonicalPlan);
        } else {
          emailResult = { ok: Boolean(issued.lic.emailSentAt), skipped: true };
        }

        return json(res, 200, {
          ok: true, licenseKey: issued.key, hint: issued.lic.hint,
          plan: issued.lic.plan, expiresAt: issued.lic.expiresAt,
          emailSent: Boolean(emailResult.ok),
          emailError: issued.key && !emailResult.ok ? 'email_delivery_failed' : null,
          alreadyFulfilled: Boolean(alreadyFulfilled || issued.existing),
          note: issued.key
            ? (emailResult.ok ? 'Save this key now; a copy was accepted by the email provider.' : 'Save this key now. Email delivery was not confirmed.')
            : 'This order already has a license. Use your purchase email or contact support for recovery.',
        }, req);
      } finally {
        inFlightOrders.delete(orderId);
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/webhook') {
      if (!paymentPersistenceReady()) return json(res, 503, { error: 'payment_persistence_not_configured' });
      const raw = await readBody(req);
      const sig = req.headers['x-razorpay-signature'];
      if (!WEBHOOK_SECRET) return json(res, 503, { error: 'webhook_not_configured' });
      if (!L.verifyWebhookSignature(raw, sig, WEBHOOK_SECRET)) return json(res, 400, { error: 'bad_signature' });
      let evt;
      try { evt = JSON.parse(raw.toString('utf8')); }
      catch (e) { return json(res, 400, { error: 'invalid_json' }); }

      const paymentEntity = evt.payload && evt.payload.payment && evt.payload.payment.entity;
      const refundEntity = evt.payload && evt.payload.refund && evt.payload.refund.entity;
      const eventId = evt.id || (paymentEntity && paymentEntity.id) || (refundEntity && refundEntity.id);
      if (!eventId) return json(res, 400, { error: 'missing_event_id' });
      if (supabase.isConfigured()) {
        if (await supabase.hasWebhook(eventId)) {
          store.processedWebhooks[eventId] = { receivedAt: Date.now(), event: evt.event || null };
          return json(res, 200, { duplicate: true, received: true });
        }
      } else if (store.processedWebhooks[eventId]) {
        return json(res, 200, { duplicate: true, received: true });
      }

      const entity = paymentEntity || refundEntity;
      if (evt.event === 'payment.captured' && entity) {
        let order = supabase.isConfigured() ? await supabase.fetchOrder(entity.order_id) : store.orders[entity.order_id];
        if (order && supabase.isConfigured()) store.orders[entity.order_id] = order;
        if (!order) return json(res, 404, { error: 'unknown_order', retryable: true });
        if (inFlightOrders.has(entity.order_id)) return json(res, 409, { error: 'fulfillment_in_progress', retryable: true });
        inFlightOrders.add(entity.order_id);
        try {
          let issued = await issueLicense(order.email, canonicalPlanId(order.plan), entity.id, entity.order_id);
          if (!issued.lic.revoked && !issued.lic.emailSentAt) {
            if (!RESEND_API_KEY) throw new Error('license_email_not_configured');
            if (!issued.key) throw new Error('license_email_recovery_required');
            const emailResult = await sendIssuedLicenseEmail(issued, order.email, canonicalPlanId(order.plan));
            if (!emailResult.ok || emailResult.persistenceError) throw new Error('license_email_delivery_failed');
          }
        } finally {
          inFlightOrders.delete(entity.order_id);
        }
      }

      if ((evt.event === 'refund.processed' || evt.event === 'payment.refunded') && entity) {
        const paymentId = entity.payment_id || entity.id;
        let licenses = Object.values(store.licenses).filter(l =>
          l.paymentId === paymentId || l.originalPaymentId === paymentId);
        if (supabase.isConfigured()) licenses = await supabase.fetchLicensesByPayment(paymentId);
        if (!licenses.length && paymentId) return json(res, 404, { error: 'license_not_found', retryable: true });
        for (const remoteLic of licenses) {
          const lic = cacheLicense(remoteLic);
          lic.revoked = true;
          lic.revokedReason = 'refund';
          lic.revokedAt = Date.now();
          if (supabase.isConfigured()) {
            const synced = await supabase.syncLicense(lic);
            if (!synced.ok) throw new Error('refund_persistence_failed');
          }
          store.saveSync();
        }
      }

      store.processedWebhooks[eventId] = { receivedAt: Date.now(), event: evt.event || null };
      const keys = Object.keys(store.processedWebhooks);
      if (keys.length > 2000) delete store.processedWebhooks[keys[0]];
      store.saveSync();
      if (supabase.isConfigured()) {
        const marked = await supabase.markWebhookProcessed(eventId, evt.event || null);
        if (!marked.ok) throw new Error('webhook_receipt_persistence_failed');
      }
      return json(res, 200, { received: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/validate') {
      if (isRateLimited(req, 60, 60000)) return json(res, 429, { error: 'rate_limited' }, req);
      const { key, deviceId } = await readJson(req);
      if (deviceId && (typeof deviceId !== 'string' || deviceId.length > 128)) {
        return json(res, 400, { error: 'invalid_device_id' }, req);
      }
      const hash = L.hashKey(key || '');
      let lic = store.licenses[hash];
      if (supabase.isConfigured()) {
        // Supabase is authoritative when configured, including revocations.
        lic = cacheLicense(await supabase.fetchLicense(hash));
      }
      if (lic) lic.devices = Array.isArray(lic.devices) ? lic.devices : [];
      const plan = lic ? getPlan(lic.plan) : null;
      const st = lic && !plan ? { active: false, reason: 'invalid_plan' } : L.licenseStatus(lic);
      const maxDevices = plan && plan.maxDevices ? plan.maxDevices : 3;
      let devicesUsed = lic ? lic.devices.length : 0;

      if (lic && st.active && deviceId && !lic.devices.includes(deviceId)) {
        if (supabase.isConfigured()) {
          const registration = await supabase.registerDevice(hash, deviceId, maxDevices);
          if (!registration.ok) return json(res, 503, { active: false, reason: 'device_registry_unavailable' }, req);
          devicesUsed = registration.devicesUsed;
          if (!registration.allowed) {
            return json(res, 200, { active: false,
              reason: registration.reason === 'inactive' ? 'inactive_license' : 'device_limit',
              maxDevices, devicesUsed }, req);
          }
          lic.devices.push(deviceId);
          store.saveSync();
        } else {
          if (lic.devices.length >= maxDevices) {
            return json(res, 200, { active: false, reason: 'device_limit', maxDevices, devicesUsed }, req);
          }
          lic.devices.push(deviceId);
          devicesUsed = lic.devices.length;
          store.saveSync();
        }
      } else if (lic && st.active && deviceId && supabase.isConfigured()) {
        const registration = await supabase.registerDevice(hash, deviceId, maxDevices);
        if (!registration.ok) return json(res, 503, { active: false, reason: 'device_registry_unavailable' }, req);
        devicesUsed = registration.devicesUsed;
        if (!registration.allowed) return json(res, 200, { active: false,
          reason: registration.reason === 'inactive' ? 'inactive_license' : 'device_limit', maxDevices, devicesUsed }, req);
      }

      return json(res, 200, {
        active: st.active, reason: st.reason,
        plan: lic ? lic.plan : null,
        expiresAt: lic ? lic.expiresAt : null,
        hint: lic ? lic.hint : null,
        proPlus: Boolean(plan && plan.proPlus),
        billingModel: plan ? plan.billingModel : null,
        cancelAtPeriodEnd: Boolean(lic && lic.cancelAtPeriodEnd),
        cancelledAt: (lic && lic.cancelledAt) || null,
        devicesUsed, maxDevices,
      }, req);
    }

    if (req.method === 'POST' && url.pathname === '/api/subscription/cancel') {
      if (isRateLimited(req, 10, 60000)) return json(res, 429, { error: 'rate_limited', detail: 'Too many requests' }, req);
      const { key, reason } = await readJson(req);
      if (!key) return json(res, 400, { error: 'key_required' }, req);
      const hash = L.hashKey(key);
      let lic = store.licenses[hash];
      if (supabase.isConfigured()) {
        lic = cacheLicense(await supabase.fetchLicense(hash));
      }
      if (!lic) return json(res, 404, { error: 'license_not_found' }, req);
      lic.cancelAtPeriodEnd = true;
      lic.cancelledAt = Date.now();
      lic.cancelReason = String(reason || 'user_requested').slice(0, 100);
      if (supabase.isConfigured()) {
        const synced = await supabase.syncLicense(lic);
        if (!synced.ok) return json(res, 500, { error: 'persistence_error' }, req);
      }
      store.saveSync();
      return json(res, 200, {
        ok: true,
        cancelAtPeriodEnd: true,
        expiresAt: lic.expiresAt,
        message: 'Auto-renewal cancelled successfully. Plan access remains active until the end of your billing cycle.'
      }, req);
    }

    if (req.method === 'POST' && url.pathname === '/api/restore-subscription') {
      if (isRateLimited(req, 10, 60000)) return json(res, 429, { error: 'rate_limited', detail: 'Too many requests' }, req);
      const { email } = await readJson(req);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '')) {
        return json(res, 400, { error: 'valid_email_required', detail: 'Valid email is required to request recovery' }, req);
      }
      // Email-only lookup must not reveal subscription metadata or reissue keys.
      // Support can verify ownership and use the admin reissue flow instead.
      return json(res, 200, {
        ok: true, recovery: 'support_required', licenseKey: null,
        note: 'If a purchase exists for this email, contact support from that address for ownership verification and license reissue. No subscription metadata is disclosed by this endpoint.',
      }, req);
    }


    // ------------------------------------------------ market intelligence ----
    if (req.method === 'POST' && url.pathname === '/api/market/analyze') {
      if (!await requireProPlus(req)) return json(res, 403, { error: 'pro_plus_required' }, req);
      if (isRateLimited(req, 30, 60000)) return json(res, 429, { error: 'rate_limited', detail: 'Analysis rate limit reached' }, req);
      const body = await readJson(req);
      if (!Array.isArray(body.candles) || body.candles.length === 0) {
        return json(res, 400, { error: 'invalid_candles', detail: 'Non-empty candles array is required' }, req);
      }
      if (body.candles.length > 500) {
        return json(res, 400, { error: 'payload_too_large', detail: 'Maximum 500 candles allowed per request' }, req);
      }
      const symbol = String(body.symbol || '').slice(0, 30);
      const timeframe = String(body.timeframe || '').slice(0, 10);
      const analysis = TLMarket.analyze(body.candles, {
        symbol: symbol, timeframe: timeframe,
        optionChain: body.optionChain || null, prevDay: body.prevDay || null
      });
      const brief = await ai.summarize({ apiKey: OPENROUTER_API_KEY, geminiApiKey: GEMINI_API_KEY, analysis, coach: body.coach || null }, providerFetch);
      return json(res, 200, { analysis, brief }, req);
    }

    if (req.method === 'GET' && (url.pathname === '/api/fyers/login' || url.pathname === '/api/fyers/auth-url')) {
      if (isRateLimited(req, 20, 60000)) return json(res, 429, { error: 'rate_limited' }, req);
      const appId = getFyersAppId();
      const secret = getFyersSecret();
      const redirectUrl = getFyersRedirectUrl();
      if (!appId || !secret || !redirectUrl) return json(res, 503, { error: 'fyers_not_configured' }, req);
      const authUrl = fyers.buildAuthUrl(appId, redirectUrl, createFyersState());
      if (url.pathname === '/api/fyers/login') {
        res.writeHead(302, { Location: authUrl });
        return res.end();
      }
      return json(res, 200, { url: authUrl }, req);
    }

    if (req.method === 'GET' && url.pathname === '/api/fyers/status') {
      const appId = getFyersAppId();
      const hasSecret = Boolean(getFyersSecret());
      const hasToken = Boolean(getFyersAccessToken());
      return json(res, 200, {
        configured: Boolean(appId && hasSecret),
        appId: appId ? (appId.slice(0, 4) + '...' + appId.slice(-3)) : null,
        hasToken,
        redirectUrl: getFyersRedirectUrl(),
        loginUrl: '/api/fyers/login'
      }, req);
    }

    if (req.method === 'GET' && url.pathname === '/api/fyers/callback-page') {
      const authCode = url.searchParams.get('auth_code');
      if (!validFyersState(url.searchParams.get('state'))) {
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end('<h2>Invalid or expired OAuth state.</h2>');
      }
      if (!authCode) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<h2 style="font-family:sans-serif;color:#f85149">No auth_code received from Fyers.</h2>');
      }
      try {
        const token = await fyers.exchangeAuthCode({ appId: getFyersAppId(), secret: getFyersSecret(), authCode }, providerFetch);
        const tokenStr = String(token.access_token || '');
        if (tokenStr) {
          process.env.FYERS_ACCESS_TOKEN = tokenStr;
          try {
            const envPath = path.join(__dirname, '.env');
            if (fs.existsSync(envPath)) {
              let envTxt = fs.readFileSync(envPath, 'utf8');
              if (envTxt.includes('FYERS_ACCESS_TOKEN=')) {
                envTxt = envTxt.replace(/FYERS_ACCESS_TOKEN=.*/, 'FYERS_ACCESS_TOKEN=' + tokenStr);
              } else {
                envTxt += '\nFYERS_ACCESS_TOKEN=' + tokenStr + '\n';
              }
              fs.writeFileSync(envPath, envTxt, 'utf8');
            }
          } catch (writeErr) {
            console.error('[fyers] Could not write token to .env:', writeErr.message);
          }
        }
        const masked = tokenStr ? (tokenStr.slice(0, 8) + '...' + tokenStr.slice(-6)) : 'N/A';
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(`
          <!DOCTYPE html>
          <html>
          <head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Fyers Connected</title></head>
          <body style="font-family:system-ui,-apple-system,sans-serif;background:#0d1117;color:#c9d1d9;padding:40px;max-width:650px;margin:auto;line-height:1.6">
            <h2 style="color:#37d39b;margin-bottom:8px">✓ Live Market Feed Connected!</h2>
            <p style="color:#8b949e;margin-top:0">Fyers API v3 session token was automatically activated and stored on your Trade Lock server.</p>
            <div style="background:#161b22;padding:16px;border-radius:8px;word-break:break-all;font-family:monospace;color:#58a6ff;border:1px solid #30363d;font-size:13px;user-select:all">${tokenStr}</div>
            <p style="margin-top:16px;font-size:13px;color:#8b949e">Session Active: ${masked}. You can now return to the Trade Lock Chrome extension — live data is connected!</p>
          </body>
          </html>
        `);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(`<h2 style="font-family:sans-serif;color:#f85149">Token Exchange Failed</h2><p style="font-family:sans-serif;color:#8b949e">${err.message}</p>`);
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/fyers/exchange') {
      if (!adminAuthorized(req)) return json(res, 403, { error: 'admin_authorization_required' }, req);
      if (isRateLimited(req, 10, 60000)) return json(res, 429, { error: 'rate_limited' }, req);
      const { authCode } = await readJson(req);
      const appId = getFyersAppId();
      const secret = getFyersSecret();
      if (!appId || !secret) return json(res, 503, { error: 'fyers_not_configured' }, req);
      const token = await fyers.exchangeAuthCode({ appId, secret, authCode }, providerFetch);
      return json(res, 200, { ok: true, accessToken: token.access_token,
        note: 'Store this as FYERS_ACCESS_TOKEN on the server. Treat it like a password.' }, req);
    }

    /*
     * Operator-only credential rotation. Exists so a daily Fyers token (or a
     * yearly Upstox token) can be updated WITHOUT a redeploy. Credentials are
     * validated against the provider before they are accepted, and the response
     * never echoes the token back.
     *
     * Serverless caveat: setting process.env here only lives as long as the
     * warm instance. For a permanent value set the dashboard env var. The
     * Upstox Analytics Token needs this once a year, not once a day.
     */
    /*
     * Operator self-test for the payment stack. Run this after setting the
     * Supabase/Razorpay env vars and BEFORE sharing the checkout link: it
     * reports exactly which piece is missing instead of letting the first
     * customer hit a 503.
     */
    if (req.method === 'GET' && url.pathname === '/api/admin/payment-status') {
      if (!adminAuthorized(req)) return json(res, 403, { error: 'admin_authorization_required' }, req);
      // Shared with `npm run doctor` so local and deployed answers never diverge.
      const report = await paymentStatus.collect();
      return json(res, report.ok ? 200 : 503, report, req);
    }

    if (req.method === 'POST' && url.pathname === '/api/admin/market-token') {
      if (!adminAuthorized(req)) return json(res, 403, { error: 'admin_authorization_required' }, req);
      if (isRateLimited(req, 10, 60000)) return json(res, 429, { error: 'rate_limited' }, req);
      const body = await readJson(req);
      const provider = String(body.provider || '').toLowerCase();
      const token = String(body.token || '').trim();
      if (!token) return json(res, 400, { error: 'token_required' }, req);

      if (provider === 'upstox') {
        const check = await upstoxProvider.verifyToken(token, providerFetch);
        if (!check.ok) {
          return json(res, 400, { ok: false, error: check.error,
            detail: 'Upstox rejected this token. Generate one at Developer Apps -> Analytics.' }, req);
        }
        process.env.UPSTOX_ANALYTICS_TOKEN = token;
      } else if (provider === 'fyers') {
        process.env.FYERS_ACCESS_TOKEN = token;
      } else {
        return json(res, 400, { error: 'unknown_provider', detail: "provider must be 'upstox' or 'fyers'" }, req);
      }

      marketFeed.clearCache();
      const feed = marketFeed.resolveProvider();
      return json(res, 200, {
        ok: true, provider: feed.id, credential: feed.tokenNote,
        note: process.env.NETLIFY || process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME
          ? 'Applied to this instance only. Set the dashboard env var for a permanent value.'
          : 'Applied and used immediately.',
      }, req);
    }

    if (req.method === 'GET' && url.pathname === '/api/admin/market-status') {
      if (!adminAuthorized(req)) return json(res, 403, { error: 'admin_authorization_required' }, req);
      const feed = marketFeed.resolveProvider();
      if (!feed.configured) {
        return json(res, 200, { ok: false, provider: null, error: 'market_feed_not_configured',
          credential: feed.tokenNote, cache: marketFeed.cacheStats() }, req);
      }
      let probe;
      if (feed.id === 'upstox') {
        probe = await upstoxProvider.verifyToken(process.env.UPSTOX_ANALYTICS_TOKEN, providerFetch);
      } else {
        try {
          const client = fyers.createClient(
            { appId: getFyersAppId(), accessToken: getFyersAccessToken() }, providerFetch);
          await client.history({ symbol: 'NSE:NIFTY50-INDEX', resolution: '15',
            rangeFrom: String(Math.floor(Date.now() / 1000) - 86400),
            rangeTo: String(Math.floor(Date.now() / 1000)) });
          probe = { ok: true, error: null };
        } catch (e) {
          probe = { ok: false, error: 'token_rejected', message: e.message };
        }
      }
      return json(res, 200, {
        ok: probe.ok, provider: feed.id, credential: feed.tokenNote,
        error: probe.ok ? null : probe.error,
        cache: marketFeed.cacheStats(),
      }, req);
    }

    if (req.method === 'GET' && url.pathname === '/api/market/live') {
      if (!await requireProPlus(req)) return json(res, 403, { error: 'pro_plus_required' }, req);
      if (isRateLimited(req, 40, 60000)) return json(res, 429, { error: 'rate_limited' }, req);

      const symbol = url.searchParams.get('symbol') || 'NIFTY';
      const resolution = url.searchParams.get('resolution') || '15';
      const feed = await marketFeed.fetchMarket({ symbol, resolution, fetchImpl: providerFetch });

      if (!feed.ok) {
        // 503 = credentials missing/expired (operator action); 502 = upstream fault.
        // 400 for a bad request from the client, 503 for operator action,
        // 502 for an upstream fault.
        const status = feed.error === 'unknown_symbol' ? 400
          : feed.error === 'market_feed_not_configured' || feed.error === 'provider_token_expired' ? 503
            : 502;
        return json(res, status, {
          error: feed.error,
          provider: feed.provider || null,
          detail: feed.detail || null,
          message: feed.message || null,
          hint: 'Pro+ users must see an honest offline state; nothing is fabricated.',
        }, req);
      }

      const analysis = TLMarket.analyze(feed.candles, {
        symbol, timeframe: resolution + 'm', optionChain: feed.optionChain,
      });
      const brief = await ai.summarize({ apiKey: OPENROUTER_API_KEY, geminiApiKey: GEMINI_API_KEY, analysis }, providerFetch);
      return json(res, 200, {
        ok: true,
        symbol,
        provider: feed.provider,
        cached: Boolean(feed.cached),
        // The chart needs the OHLC series itself, not just how many candles
        // exist. This previously sent only a count, so chartState.candles was
        // never populated and the Pro+ chart always rendered "no data".
        // 400 candles is ~10 sessions of 15-minute bars and stays a small payload.
        candles: feed.candles.slice(-400),
        candleCount: feed.candles.length,
        spot: feed.spot,
        vix: feed.vix || null,
        optionChain: feed.optionChain || null,
        analysis,
        brief,
      }, req);
    }

    return json(res, 404, { error: 'not_found' }, req);
  } catch (e) {
    console.error('[server_error]', e && e.message ? e.message : e);
    return json(res, 500, { error: 'server_error', message: 'An internal error occurred' }, req);
  }
});

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log('[trade-lock] license server on http://0.0.0.0:' + PORT +
      '  razorpay=' + (razorpayConfigured() ? 'configured' : 'NOT configured') +
      (DEMO_MODE ? '  DEMO_MODE=on (licences issued WITHOUT payment - local testing only)' : ''));
  });
}

module.exports = server;
