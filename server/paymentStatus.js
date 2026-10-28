'use strict';

/*
 * Payment readiness checks.
 *
 * Both the /api/admin/payment-status endpoint and `npm run doctor` use this, so
 * the answer a developer gets on their laptop is the same one the deployed
 * server gives. Each check reports ok plus a `detail` that names the next
 * action, because "false" is not a useful error message at 11pm before launch.
 */

const supabase = require('./supabase');
const marketFeed = require('./marketFeed');
const { subscriptionPlans } = require('./plans');

const PROVIDER_TIMEOUT_MS = Number(process.env.PROVIDER_TIMEOUT_MS) || 8000;

function isServerless() {
  return Boolean(process.env.NETLIFY || process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
}

function razorpayConfigured() {
  return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

function supabaseCreds() {
  return {
    url: (process.env.SUPABASE_URL || '').replace(/\/$/, ''),
    key: process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || '',
  };
}

/** True when a licence can be persisted on this host. */
function paymentPersistenceReady() {
  if (supabase.isConfigured()) return true;
  // A local JSON store is fine on a long-lived host, never on serverless.
  return !isServerless();
}

/** Mirrors server/index.js: demo checkout is opt-in and refused on hosted hosts. */
function demoCheckoutEnabled() {
  if (isServerless()) return false;
  if (process.env.NODE_ENV === 'production') return false;
  if (process.env.TL_DEMO_MODE !== '1') return false;
  // A demo checkout next to live keys would be confusing at best.
  return !razorpayConfigured();
}

async function probe(url, key, pathname, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    const opts = Object.assign({}, options || {}, {
      headers: Object.assign({ apikey: key, Authorization: 'Bearer ' + key }, (options && options.headers) || {}),
      signal: controller.signal,
    });
    return await fetch(url + pathname, opts);
  } finally {
    clearTimeout(timer);
  }
}

const RPC_PROBES = {
  // Include every argument, including the newer subscription fields. PostgREST
  // resolves RPCs by signature: calling with {} can report even a correct
  // function as missing, while an old eight-argument overload must not pass.
  fulfill_order: {
    p_order_id: null, p_payment_id: null, p_email: null, p_plan: null,
    p_hash: null, p_hint: null, p_created_at: null, p_expires_at: null,
    p_subscription_id: null, p_provider_plan_id: null, p_billing_model: null,
    p_billing_status: 'active', p_current_period_start: null,
    p_current_period_end: null, p_cancel_at_period_end: false,
  },
  record_payment: {
    p_payment_id: null, p_license_hash: null, p_subscription_id: null,
    p_order_id: null, p_email: null, p_plan: null, p_amount: null, p_currency: 'INR',
  },
  mark_payment_refunded: { p_payment_id: null },
  reissue_license: { p_old_hash: null, p_new_hash: null, p_new_hint: null },
};

/**
 * Probe every table/column and RPC signature used by checkout and webhooks.
 * All RPC payloads fail validation before mutating data. A validation response
 * proves reachability; a PostgREST function-resolution error does not.
 */
async function checkSchema(url, key) {
  if (!url || !key) return { ok: false, detail: 'Skipped: Supabase not configured' };

  try {
    const tables = {
      licenses: 'hash,subscription_id,billing_model,billing_status,billing_event_at',
      orders: 'order_id,subscription_id,billing_model,fulfillment_status',
      processed_webhooks: 'event_id',
      payment_history: 'payment_id,license_hash,refunded,refunded_at',
    };
    const missing = [];
    for (const [table, columns] of Object.entries(tables)) {
      const r = await probe(url, key, '/rest/v1/' + table + '?select=' + columns + '&limit=1');
      if (r.status === 404) {
        missing.push(table);
      } else if (r.status === 401 || r.status === 403) {
        return { ok: false, detail: 'Key rejected (HTTP ' + r.status + '). Use the service_role key, not the anon key.' };
      } else if (!r.ok) {
        const body = await r.text().catch(() => '');
        return { ok: false, detail: 'Querying ' + table + ' failed: HTTP ' + r.status +
          (/column|PGRST/i.test(body) ? ' (a required column is missing)' : '') + '. Re-run server/schema.sql.' };
      }
    }
    if (missing.length) {
      return { ok: false, detail: 'Missing tables: ' + missing.join(', ') + '. Run server/schema.sql in the SQL editor.' };
    }

    for (const [name, payload] of Object.entries(RPC_PROBES)) {
      const rpc = await probe(url, key, '/rest/v1/rpc/' + name, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      const body = await rpc.text().catch(() => '');
      const unresolved = rpc.status === 404 || /PGRST202|Could not find the function/i.test(body);
      if (unresolved) {
        return { ok: false, detail: 'The required ' + name + '() function/signature is missing. Re-run server/schema.sql.' };
      }
      if (rpc.status === 401 || rpc.status === 403) {
        return { ok: false, detail: name + '() rejected the key. Check the service_role key, function grants and RLS policies.' };
      }
      if (!rpc.ok && rpc.status >= 500) {
        return { ok: false, detail: name + '() probe failed: HTTP ' + rpc.status + '. Check the function and database logs.' };
      }
    }
    return { ok: true, detail: 'Required tables, billing columns and payment RPC signatures are reachable' };
  } catch (error) {
    return { ok: false, detail: 'Supabase unreachable: ' + (error.message || 'network error') };
  }
}

/** Full readiness report. Never throws; network failures land in `detail`. */
async function collect() {
  const { url, key } = supabaseCreds();
  const rzp = razorpayConfigured();
  const sb = supabase.isConfigured();
  const serverless = isServerless();

  const checks = {
    razorpay: {
      ok: rzp,
      detail: rzp
        ? 'RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET present'
        : 'Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET (Razorpay -> Account & Settings -> API Keys)',
    },
    razorpayPlans: (() => {
      const missing = subscriptionPlans()
        .map((plan) => 'RAZORPAY_PLAN_' + plan.id.toUpperCase())
        .filter((name) => !process.env[name]);
      return {
        ok: missing.length === 0,
        detail: missing.length
          ? 'Set pre-created recurring plan IDs: ' + missing.join(', ')
          : 'All recurring checkout plans have pre-created Razorpay plan IDs',
      };
    })(),
    webhookSecret: {
      ok: Boolean(process.env.RAZORPAY_WEBHOOK_SECRET),
      detail: process.env.RAZORPAY_WEBHOOK_SECRET
        ? 'RAZORPAY_WEBHOOK_SECRET present'
        : 'Set RAZORPAY_WEBHOOK_SECRET (the webhook secret, not the API key secret)',
    },
    supabase: {
      ok: sb,
      // Only a serverless host genuinely needs Supabase. A long-lived process
      // persists to its JSON store (see paymentPersistenceReady), so failing
      // this check there would contradict the server and stall a launch that
      // is actually ready.
      advisory: !serverless,
      detail: sb
        ? 'SUPABASE_URL + SUPABASE_SERVICE_KEY present'
        : serverless
          ? 'Required on serverless: set SUPABASE_URL and SUPABASE_SERVICE_KEY (service role key, not anon)'
          : 'Optional here: the local JSON store is used. Set SUPABASE_URL + SUPABASE_SERVICE_KEY for backups or multiple instances',
    },
    platform: {
      ok: paymentPersistenceReady(),
      detail: serverless
        ? 'Serverless host: Supabase is REQUIRED for payments to persist'
        : 'Long-lived host: the local JSON store is also usable',
    },
    schema: Object.assign(await checkSchema(url, key), { advisory: !serverless && !sb }),
  };

  // Checkout also needs an admin token to protect the diagnostic endpoints, and
  // a public base URL so Razorpay can call back to the right place.
  checks.adminToken = {
    ok: Boolean(process.env.FYERS_ADMIN_TOKEN),
    detail: process.env.FYERS_ADMIN_TOKEN
      ? 'FYERS_ADMIN_TOKEN present'
      : 'Set FYERS_ADMIN_TOKEN (guards /api/admin/*; generate 32 random bytes)',
  };
  // Market data is what the Pro+ tabs render. It never blocks a payment, but
  // "no live data" is the most common reason someone says the product is
  // broken, so the same command answers both questions.
  const feed = marketFeed.resolveProvider();
  checks.marketProvider = {
    ok: feed.configured,
    advisory: true,
    detail: feed.configured
      ? feed.id + ' configured - ' + feed.tokenNote
      : feed.tokenNote,
  };
  if (feed.configured && feed.id === 'fyers') {
    checks.marketToken = {
      ok: false,
      advisory: true,
      detail: 'Fyers access tokens expire every day at 06:30 IST. Re-mint one with POST /api/admin/market-token before the open.',
    };
  }

  checks.publicBaseUrl = {
    ok: Boolean(process.env.PUBLIC_BASE_URL),
    // Advisory: the default Netlify origin is already allowed by CORS, so this
    // only matters on a custom domain. It must not block a working deployment.
    advisory: true,
    detail: process.env.PUBLIC_BASE_URL
      ? 'PUBLIC_BASE_URL present'
      : 'Recommended on a custom domain: set PUBLIC_BASE_URL, e.g. https://your-domain.com',
  };

  // Mirrors server/index.js: on a long-lived host the JSON store satisfies
  // payment persistence, so the Supabase pair must not block checkout there.
  const blocking = ['razorpay', 'razorpayPlans', 'webhookSecret', 'adminToken']
    .concat(serverless ? ['supabase', 'schema'] : []);
  const ready = blocking.every((k) => checks[k].ok);

  return {
    ok: ready,
    paymentPersistenceReady: paymentPersistenceReady(),
    demoCheckout: demoCheckoutEnabled(),
    checks,
    blocking,
    next: ready
      ? 'Checkout is configured. Make an authorized test purchase at the listed price, verify renewal/recovery, then refund it in Razorpay.'
      : 'Fix the failing checks above, redeploy, then re-run this.',
  };
}

module.exports = {
  collect, checkSchema, razorpayConfigured, paymentPersistenceReady, isServerless, demoCheckoutEnabled,
};
