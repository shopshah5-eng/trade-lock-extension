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
const { PLANS, getPlan } = require('./plans');
const TLMarket = fs.existsSync(path.join(__dirname, 'lib', 'market.js'))
  ? require('./lib/market')
  : require('../lib/market');
const mockData = require('./mockData');
const fyers = require('./fyers');
const ai = require('./ai');

const FYERS_APP_ID = process.env.FYERS_APP_ID || '';
const FYERS_SECRET = process.env.FYERS_SECRET || '';
const FYERS_REDIRECT_URL = process.env.FYERS_REDIRECT_URL || '';
const FYERS_ACCESS_TOKEN = process.env.FYERS_ACCESS_TOKEN || '';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const emailService = require('./email');
const supabase = require('./supabase');
const L = require('./license');
const store = require('./store');

const PORT = Number(process.env.PORT || 8787);
const KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || '';
const DEMO_MODE = process.env.TL_DEMO_MODE === '1'; // issues test keys w/o payment
const MAX_DEVICES = 3;

const razorpayConfigured = () => Boolean(KEY_ID && KEY_SECRET);

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
  const ip = (req.headers && (req.headers['x-forwarded-for'] || req.socket?.remoteAddress)) || '127.0.0.1';
  const now = Date.now();
  let entry = rateLimitMap.get(ip);
  if (!entry || now - entry.start > windowMs) {
    entry = { count: 1, start: now };
    rateLimitMap.set(ip, entry);
    return false;
  }
  entry.count++;
  return entry.count > limit;
}

function readBody(req) {
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

async function issueLicense(email, plan, paymentId, orderId) {
  // One payment -> one key; re-verifying never mints a second one.
  for (const lic of Object.values(store.licenses)) {
    if (lic.paymentId && lic.paymentId === paymentId) {
      return { lic, key: issuedThisProcess.get(paymentId) || null };
    }
  }
  const key = L.generateLicenseKey();
  const p = getPlan(plan);
  const lic = {
    hash: L.hashKey(key), hint: L.keyHint(key), email: String(email || '').toLowerCase(),
    plan, createdAt: Date.now(), expiresAt: L.expiryFor(p.durationDays),
    paymentId: paymentId || null, orderId: orderId || null,
    devices: [], revoked: false,
  };
  store.licenses[lic.hash] = lic;
  if (paymentId) issuedThisProcess.set(paymentId, key);
  store.save();
  if (supabase.isConfigured()) {
    await supabase.syncLicense(lic).catch(() => {});
  }
  return { lic, key };
}

async function razorpayCreateOrder(plan, email) {
  const auth = Buffer.from(KEY_ID + ':' + KEY_SECRET).toString('base64');
  const r = await fetch('https://api.razorpay.com/v1/orders', {
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
const processedWebhooks = new Set();

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
      return json(res, 200, { plans: Object.values(PLANS) }, req);
    }
    if (req.method === 'GET' && url.pathname === '/api/config') {
      return json(res, 200, { keyId: KEY_ID, demoMode: DEMO_MODE, configured: razorpayConfigured(),
        fyersConfigured: Boolean(FYERS_APP_ID && FYERS_ACCESS_TOKEN),
        openRouterConfigured: Boolean(OPENROUTER_API_KEY),
        geminiConfigured: Boolean(GEMINI_API_KEY),
        resendConfigured: Boolean(RESEND_API_KEY),
        supabaseConfigured: supabase.isConfigured() }, req);
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, configured: razorpayConfigured(), demoMode: DEMO_MODE }, req);
    }

    if (req.method === 'POST' && url.pathname === '/api/create-order') {
      if (isRateLimited(req, 20, 60000)) return json(res, 429, { error: 'rate_limited', detail: 'Too many requests' }, req);
      const { plan: planId, email } = await readJson(req);
      const plan = getPlan(planId);
      if (!plan) return json(res, 400, { error: 'unknown_plan' }, req);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '')) return json(res, 400, { error: 'valid_email_required' }, req);

      const normalizedEmail = String(email).toLowerCase().trim();

      if (DEMO_MODE && !razorpayConfigured()) {
        const orderId = 'order_DEMO_' + Date.now().toString(36);
        store.orders[orderId] = {
          email: normalizedEmail,
          plan: planId,
          amount: plan.amount,
          currency: plan.currency,
          status: 'demo',
          createdAt: Date.now()
        };
        store.save();
        return json(res, 200, { demo: true, orderId, amount: plan.amount, currency: plan.currency, plan: planId }, req);
      }
      if (!razorpayConfigured()) return json(res, 503, { error: 'payments_not_configured' }, req);

      const order = await razorpayCreateOrder(plan, normalizedEmail);
      store.orders[order.id] = {
        email: normalizedEmail,
        plan: planId,
        amount: order.amount,
        currency: order.currency,
        status: 'created',
        createdAt: Date.now()
      };
      store.save();
      if (supabase.isConfigured()) {
        await supabase.syncOrder(order.id, store.orders[order.id]).catch(() => {});
      }
      return json(res, 200, { orderId: order.id, amount: order.amount, currency: order.currency, plan: planId }, req);
    }

    if (req.method === 'POST' && url.pathname === '/api/verify-payment') {
      if (isRateLimited(req, 20, 60000)) return json(res, 429, { error: 'rate_limited', detail: 'Too many requests' }, req);
      const { orderId, paymentId, signature, email, plan: planId } = await readJson(req);
      if (!orderId || !paymentId) {
        return json(res, 400, { error: 'invalid_request', detail: 'orderId and paymentId are required' }, req);
      }

      let order = store.orders[orderId];
      if (!order && supabase.isConfigured()) {
        const remoteOrder = await supabase.fetchOrder(orderId);
        if (remoteOrder) {
          order = { email: remoteOrder.email, plan: remoteOrder.plan, amount: remoteOrder.amount, currency: remoteOrder.currency, status: remoteOrder.status, paymentId: remoteOrder.payment_id };
          store.orders[orderId] = order;
        }
      }
      if (!order) return json(res, 400, { error: 'unknown_order' }, req);

      // Customer identity binding: Caller email cannot override the original order email
      if (email && String(email).toLowerCase().trim() !== String(order.email).toLowerCase().trim()) {
        return json(res, 400, { error: 'email_mismatch', detail: 'Supplied email does not match order record' }, req);
      }
      // Plan binding: Caller cannot substitute an unauthorized plan
      if (planId && planId !== order.plan) {
        return json(res, 400, { error: 'plan_mismatch', detail: 'Supplied plan does not match order record' }, req);
      }

      // Concurrency lock to prevent concurrent double-fulfillment race conditions
      if (inFlightOrders.has(orderId)) {
        return json(res, 409, { error: 'fulfillment_in_progress', detail: 'Order verification is already in progress' }, req);
      }
      inFlightOrders.add(orderId);

      try {
        // Idempotency: If order was already paid and fulfilled, return existing license without generating duplicate key
        if (order.status === 'paid' && order.fulfillmentStatus === 'FULFILLED') {
          const existingLic = Object.values(store.licenses).find(l => l.orderId === orderId || (l.paymentId && l.paymentId === (order.paymentId || paymentId)));
          if (existingLic) {
            return json(res, 200, {
              ok: true,
              licenseKey: issuedThisProcess.get(existingLic.paymentId) || null,
              hint: existingLic.hint,
              plan: existingLic.plan,
              expiresAt: existingLic.expiresAt,
              alreadyFulfilled: true,
              note: 'Order already fulfilled. Key delivered via confirmation email.'
            }, req);
          }
        }

        if (DEMO_MODE && !razorpayConfigured()) {
          if (!String(orderId).startsWith('order_DEMO_')) return json(res, 400, { error: 'bad_demo_order' }, req);
        } else {
          if (!signature || !L.verifyPaymentSignature(orderId, paymentId, signature, KEY_SECRET)) {
            return json(res, 400, { error: 'signature_mismatch' }, req);
          }
        }

        // Durable fulfillment state: payment confirmed, initiating license issuance
        order.status = 'PAID_PENDING_FULFILLMENT';
        order.paymentId = paymentId || null;
        order.paidAt = Date.now();
        store.save();

        // Strictly bind license issuance and email to original order.email
        const customerEmail = order.email;
        const plan = order.plan;
        let issued;
        try {
          issued = await issueLicense(customerEmail, plan, paymentId || ('demo_' + orderId), orderId);
          order.status = 'paid';
          order.fulfillmentStatus = 'FULFILLED';
          order.fulfilledAt = Date.now();
          store.save();
        } catch (fulfillmentErr) {
          order.fulfillmentStatus = 'FULFILLMENT_FAILED';
          store.save();
          throw fulfillmentErr;
        }

        if (supabase.isConfigured()) {
          await supabase.syncOrder(orderId, order).catch(() => {});
        }

        if (issued.key && customerEmail) {
          emailService.sendLicenseEmail({
            to: customerEmail,
            licenseKey: issued.key,
            plan,
            expiresAt: issued.lic.expiresAt,
          }).then(res => {
            if (res.ok) console.log('[email] Sent license key to', customerEmail, '(id:', res.id, ')');
            else console.warn('[email] Could not send to', customerEmail, res.error);
          }).catch(err => {
            console.error('[email] Delivery exception:', err && err.message ? err.message : err);
          });
        }

        return json(res, 200, {
          ok: true, licenseKey: issued.key, hint: issued.lic.hint,
          plan, expiresAt: issued.lic.expiresAt,
          emailSent: Boolean(issued.key && customerEmail),
          note: issued.key ? 'Save this key now — it is shown once.' : 'Key already issued for this payment; use the copy from your purchase.',
        }, req);
      } finally {
        inFlightOrders.delete(orderId);
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/webhook') {
      const raw = await readBody(req);
      const sig = req.headers['x-razorpay-signature'];
      if (!WEBHOOK_SECRET) return json(res, 503, { error: 'webhook_not_configured' });
      if (!L.verifyWebhookSignature(raw, sig, WEBHOOK_SECRET)) return json(res, 400, { error: 'bad_signature' });
      let evt = {};
      try { evt = JSON.parse(raw.toString('utf8')); } catch (e) { /* ignore */ }

      const eventId = evt.id || (evt.payload && evt.payload.payment && evt.payload.payment.entity && evt.payload.payment.entity.id);
      if (eventId && processedWebhooks.has(eventId)) {
        return json(res, 200, { duplicate: true, received: true });
      }
      if (eventId) {
        processedWebhooks.add(eventId);
        if (processedWebhooks.size > 1000) {
          const first = processedWebhooks.values().next().value;
          processedWebhooks.delete(first);
        }
      }

      const entity = evt.payload && evt.payload.payment && evt.payload.payment.entity;
      if (evt.event === 'payment.captured' && entity && store.orders[entity.order_id]) {
        const order = store.orders[entity.order_id];
        if (order.status !== 'paid' || order.fulfillmentStatus !== 'FULFILLED') {
          order.status = 'PAID_PENDING_FULFILLMENT';
          order.paymentId = entity.id;
          order.paidAt = Date.now();
          store.save();

          try {
            const customerEmail = order.email;
            const issued = await issueLicense(customerEmail, order.plan, entity.id, entity.order_id);
            order.status = 'paid';
            order.fulfillmentStatus = 'FULFILLED';
            order.fulfilledAt = Date.now();
            store.save();

            if (issued.key && customerEmail) {
              emailService.sendLicenseEmail({
                to: customerEmail,
                licenseKey: issued.key,
                plan: order.plan,
                expiresAt: issued.lic.expiresAt,
              }).then(res => {
                if (res.ok) console.log('[email-webhook] Sent license key to', customerEmail, '(id:', res.id, ')');
              }).catch(err => {
                console.error('[email-webhook] Exception:', err && err.message ? err.message : err);
              });
            }
          } catch (fulfillErr) {
            console.error('[webhook] License fulfillment failed:', fulfillErr);
            order.fulfillmentStatus = 'FULFILLMENT_FAILED';
            store.save();
          }
        }
      }
      return json(res, 200, { received: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/validate') {
      if (isRateLimited(req, 60, 60000)) return json(res, 429, { error: 'rate_limited' }, req);
      const { key, deviceId } = await readJson(req);
      const hash = L.hashKey(key || '');
      let lic = store.licenses[hash];
      if (!lic && supabase.isConfigured()) {
        lic = await supabase.fetchLicense(hash);
        if (lic) store.licenses[hash] = lic;
      }
      const st = L.licenseStatus(lic);
      if (lic && st.active && deviceId) {
        if (!lic.devices.includes(deviceId)) {
          if (lic.devices.length >= MAX_DEVICES) {
            return json(res, 200, { active: false, reason: 'device_limit', maxDevices: MAX_DEVICES }, req);
          }
          lic.devices.push(deviceId);
          store.save();
          supabase.updateLicenseDevices(hash, lic.devices).catch(() => {});
        }
      }
      return json(res, 200, {
        active: st.active, reason: st.reason,
        plan: lic ? lic.plan : null,
        expiresAt: lic ? lic.expiresAt : null,
        hint: lic ? lic.hint : null,
        devicesUsed: lic ? lic.devices.length : 0, maxDevices: MAX_DEVICES,
      }, req);
    }


    // ------------------------------------------------ market intelligence ----
    if (req.method === 'GET' && url.pathname === '/api/market/demo') {
      const symbol = (url.searchParams.get('symbol') || 'NIFTY').toUpperCase();
      const candles = mockData.demoCandles(symbol);
      const analysis = TLMarket.analyze(candles, { symbol, timeframe: '5m', optionChain: mockData.demoOptionChain(symbol, candles[candles.length - 1].c), daysToExpiry: 2 });
      const brief = await ai.summarize({ apiKey: OPENROUTER_API_KEY, geminiApiKey: GEMINI_API_KEY, analysis });
      return json(res, 200, { demo: true, symbol, candles: candles.length, analysis, brief }, req);
    }

    if (req.method === 'POST' && url.pathname === '/api/market/analyze') {
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
      const brief = await ai.summarize({ apiKey: OPENROUTER_API_KEY, geminiApiKey: GEMINI_API_KEY, analysis, coach: body.coach || null });
      return json(res, 200, { analysis, brief }, req);
    }

    if (req.method === 'GET' && url.pathname === '/api/fyers/auth-url') {
      if (isRateLimited(req, 20, 60000)) return json(res, 429, { error: 'rate_limited' }, req);
      if (!FYERS_APP_ID || !FYERS_REDIRECT_URL) return json(res, 503, { error: 'fyers_not_configured' }, req);
      return json(res, 200, { url: fyers.buildAuthUrl(FYERS_APP_ID, FYERS_REDIRECT_URL) }, req);
    }

    if (req.method === 'GET' && url.pathname === '/api/fyers/callback-page') {
      const authCode = url.searchParams.get('auth_code');
      if (!authCode) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<h2 style="font-family:sans-serif;color:#f85149">No auth_code received from Fyers.</h2>');
      }
      try {
        const token = await fyers.exchangeAuthCode({ appId: FYERS_APP_ID, secret: FYERS_SECRET, authCode });
        const tokenStr = String(token.access_token || '');
        const masked = tokenStr ? (tokenStr.slice(0, 8) + '...' + tokenStr.slice(-6)) : 'N/A';
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(`
          <!DOCTYPE html>
          <html>
          <head><meta charset="utf-8"><title>Fyers Token Generated</title></head>
          <body style="font-family:system-ui,-apple-system,sans-serif;background:#0d1117;color:#c9d1d9;padding:40px;max-width:650px;margin:auto;line-height:1.6">
            <h2 style="color:#37d39b;margin-bottom:8px">✓ Fyers Authentication Succeeded</h2>
            <p style="color:#8b949e;margin-top:0">Authorization code was exchanged. Copy your token below into your server environment as <code>FYERS_ACCESS_TOKEN</code>:</p>
            <div style="background:#161b22;padding:16px;border-radius:8px;word-break:break-all;font-family:monospace;color:#58a6ff;border:1px solid #30363d;font-size:13px;user-select:all">${tokenStr}</div>
            <p style="margin-top:20px;font-size:13px;color:#8b949e">Preview: ${masked}. Do not publicly share this URL.</p>
          </body>
          </html>
        `);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(`<h2 style="font-family:sans-serif;color:#f85149">Token Exchange Failed</h2><p style="font-family:sans-serif;color:#8b949e">${err.message}</p>`);
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/fyers/exchange') {
      if (isRateLimited(req, 10, 60000)) return json(res, 429, { error: 'rate_limited' }, req);
      const { authCode } = await readJson(req);
      if (!FYERS_APP_ID || !FYERS_SECRET) return json(res, 503, { error: 'fyers_not_configured' }, req);
      const token = await fyers.exchangeAuthCode({ appId: FYERS_APP_ID, secret: FYERS_SECRET, authCode });
      return json(res, 200, { ok: true, accessToken: token.access_token,
        note: 'Store this as FYERS_ACCESS_TOKEN on the server. Treat it like a password.' }, req);
    }

    if (req.method === 'GET' && url.pathname === '/api/market/live') {
      if (isRateLimited(req, 40, 60000)) return json(res, 429, { error: 'rate_limited' }, req);
      if (!FYERS_APP_ID || !FYERS_ACCESS_TOKEN) return json(res, 503, { error: 'fyers_not_configured',
        hint: 'Set FYERS_APP_ID and FYERS_ACCESS_TOKEN, or use /api/market/demo' }, req);
      const symbol = url.searchParams.get('symbol') || 'NSE:NIFTY50-INDEX';
      const resolution = url.searchParams.get('resolution') || '15';
      const client = fyers.createClient({ appId: FYERS_APP_ID, accessToken: FYERS_ACCESS_TOKEN });
      const to = Math.floor(Date.now() / 1000);
      const hist = await client.history({ symbol, resolution, rangeFrom: String(to - 10 * 86400), rangeTo: String(to) });
      const candles = fyers.normalizeHistory(hist);
      let chain = null;
      try { chain = fyers.normalizeOptionChain(await client.optionChain({ symbol, strikeCount: 12 })); } catch (e) { chain = null; }
      const analysis = TLMarket.analyze(candles, { symbol, timeframe: resolution + 'm', optionChain: chain });
      return json(res, 200, { symbol, candles: candles.length, analysis, brief }, req);
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
      (DEMO_MODE ? '  DEMO_MODE=on' : ''));
  });
}

module.exports = server;
