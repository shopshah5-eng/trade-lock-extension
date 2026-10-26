'use strict';

/*
 * Payment readiness must be verifiable before a customer discovers the gap.
 * These tests run the real check against a local stand-in for the Supabase REST
 * API, so the "would a payment actually work?" answer is exercised end to end
 * rather than mocked at the function boundary.
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

/** Minimal Supabase REST stand-in. `missing` names tables that 404. */
function fakeSupabase({ missing = [], rejectKey = false, failRpc = false } = {}) {
  const seen = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      seen.push(req.method + ' ' + req.url);
      res.setHeader('content-type', 'application/json');

      if (req.url.includes('/rpc/')) {
        // fulfill_order raises on null arguments; that is a live function.
        res.statusCode = failRpc ? 404 : 400;
        return res.end('{}');
      }
      const table = (req.url.match(/\/rest\/v1\/([a-z_]+)/) || [])[1];
      if (rejectKey) { res.statusCode = 401; return res.end('{}'); }
      if (missing.includes(table)) { res.statusCode = 404; return res.end('{}'); }
      res.statusCode = 200;
      return res.end('[]');
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ url: 'http://127.0.0.1:' + server.address().port, close: () => server.close(), seen });
    });
  });
}

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  return fn().finally(restore);
}

const { checkSchema, collect } = require('../paymentStatus');

const CLEAR = {
  RAZORPAY_KEY_ID: undefined, RAZORPAY_KEY_SECRET: undefined, RAZORPAY_WEBHOOK_SECRET: undefined,
  SUPABASE_URL: undefined, SUPABASE_SERVICE_KEY: undefined, SUPABASE_KEY: undefined,
  FYERS_ADMIN_TOKEN: undefined, PUBLIC_BASE_URL: undefined, TL_DEMO_MODE: undefined,
  NETLIFY: undefined, VERCEL: undefined, AWS_LAMBDA_FUNCTION_NAME: undefined, NODE_ENV: undefined,
};

test('checkSchema passes when all tables and the RPC answer', async () => {
  const sb = await fakeSupabase();
  try {
    const r = await checkSchema(sb.url, 'service-key');
    assert.strictEqual(r.ok, true, r.detail);
    // All three tables must be probed, not just one.
    for (const t of ['licenses', 'orders', 'processed_webhooks']) {
      assert.ok(sb.seen.some((s) => s.includes('/rest/v1/' + t)), `must probe ${t}`);
    }
  } finally { sb.close(); }
});

test('checkSchema names the missing table', async () => {
  const sb = await fakeSupabase({ missing: ['orders'] });
  try {
    const r = await checkSchema(sb.url, 'service-key');
    assert.strictEqual(r.ok, false);
    assert.match(r.detail, /Missing tables: orders/);
    assert.match(r.detail, /schema\.sql/, 'must tell the user how to fix it');
  } finally { sb.close(); }
});

test('checkSchema spots an anon key instead of the service_role key', async () => {
  const sb = await fakeSupabase({ rejectKey: true });
  try {
    const r = await checkSchema(sb.url, 'anon-key');
    assert.strictEqual(r.ok, false);
    assert.match(r.detail, /service_role/);
  } finally { sb.close(); }
});

test('checkSchema spots a missing fulfill_order function', async () => {
  const sb = await fakeSupabase({ failRpc: true });
  try {
    const r = await checkSchema(sb.url, 'service-key');
    assert.strictEqual(r.ok, false);
    assert.match(r.detail, /fulfill_order/);
  } finally { sb.close(); }
});

test('checkSchema reports an unreachable host without throwing', async () => {
  const r = await checkSchema('http://127.0.0.1:1', 'key');
  assert.strictEqual(r.ok, false);
  assert.match(r.detail, /unreachable/);
});

test('collect reports every blocker when nothing is configured', async () => {
  await withEnv(CLEAR, async () => {
    const report = await collect();
    assert.strictEqual(report.ok, false);
    for (const key of ['razorpay', 'webhookSecret', 'supabase', 'schema', 'adminToken']) {
      assert.strictEqual(report.checks[key].ok, false, `${key} must be reported as failing`);
      assert.ok(report.checks[key].detail.length > 10, `${key} must explain how to fix it`);
    }
    assert.strictEqual(report.demoCheckout, false);

    // A long-lived host stores orders in its JSON file, so Supabase is optional
    // there. Blocking on it would contradict /api/create-order, which accepts
    // payments in exactly this configuration.
    assert.deepStrictEqual(report.blocking, ['razorpay', 'webhookSecret', 'adminToken']);
    assert.strictEqual(report.checks.supabase.advisory, true);
    assert.strictEqual(report.checks.schema.advisory, true);
    assert.match(report.checks.supabase.detail, /optional/i);
  });
});

test('a serverless host is blocked until Supabase is configured', async () => {
  await withEnv(Object.assign({}, CLEAR, {
    NETLIFY: 'true',
    RAZORPAY_KEY_ID: 'rzp_test_1',
    RAZORPAY_KEY_SECRET: 'secret',
    RAZORPAY_WEBHOOK_SECRET: 'whsec',
    FYERS_ADMIN_TOKEN: 'admin',
  }), async () => {
    const report = await collect();
    assert.deepStrictEqual(report.blocking, ['razorpay', 'webhookSecret', 'adminToken', 'supabase', 'schema']);
    assert.strictEqual(report.checks.supabase.advisory, false);
    assert.match(report.checks.supabase.detail, /required on serverless/i);
    assert.strictEqual(report.ok, false, 'Netlify without Supabase cannot persist an order');
    assert.strictEqual(report.paymentPersistenceReady, false);
  });
});

test('collect passes when the full payment configuration is present', async () => {
  const sb = await fakeSupabase();
  try {
    await withEnv(Object.assign({}, CLEAR, {
      RAZORPAY_KEY_ID: 'rzp_test_1',
      RAZORPAY_KEY_SECRET: 'secret',
      RAZORPAY_WEBHOOK_SECRET: 'whsec',
      SUPABASE_URL: sb.url,
      SUPABASE_SERVICE_KEY: 'service-key',
      FYERS_ADMIN_TOKEN: 'admin',
    }), async () => {
      const report = await collect();
      assert.strictEqual(report.ok, true, JSON.stringify(report.checks, null, 2));
      assert.strictEqual(report.paymentPersistenceReady, true);
      assert.match(report.next, /test purchase/i);
    });
  } finally { sb.close(); }
});

test('an advisory setting never blocks checkout', async () => {
  const sb = await fakeSupabase();
  try {
    await withEnv(Object.assign({}, CLEAR, {
      RAZORPAY_KEY_ID: 'rzp_test_1',
      RAZORPAY_KEY_SECRET: 'secret',
      RAZORPAY_WEBHOOK_SECRET: 'whsec',
      SUPABASE_URL: sb.url,
      SUPABASE_SERVICE_KEY: 'service-key',
      FYERS_ADMIN_TOKEN: 'admin',
      PUBLIC_BASE_URL: undefined,
    }), async () => {
      const report = await collect();
      assert.strictEqual(report.checks.publicBaseUrl.ok, false);
      assert.strictEqual(report.checks.publicBaseUrl.advisory, true);
      assert.strictEqual(report.ok, true, 'a missing custom domain must not block payments');
    });
  } finally { sb.close(); }
});

test('demo checkout can never be enabled on a hosted platform', async () => {
  await withEnv(Object.assign({}, CLEAR, { TL_DEMO_MODE: '1', NETLIFY: 'true' }), async () => {
    const report = await collect();
    assert.strictEqual(report.demoCheckout, false, 'Netlify must refuse demo licences');
  });
  await withEnv(Object.assign({}, CLEAR, { TL_DEMO_MODE: '1', NODE_ENV: 'production' }), async () => {
    const report = await collect();
    assert.strictEqual(report.demoCheckout, false, 'production must refuse demo licences');
  });
});

test('server/.env.example documents every variable the server reads', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');

  const example = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  // Commented placeholders count; that is how optional overrides are listed.
  const documented = new Set(
    [...example.matchAll(/^#?\s*([A-Z_0-9]+)=/gm)].map((m) => m[1])
  );

  const used = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'test') walk(full);
      } else if (entry.name.endsWith('.js')) {
        for (const m of fs.readFileSync(full, 'utf8').matchAll(/process\.env\.([A-Z_0-9]+)/g)) {
          used.add(m[1]);
        }
      }
    }
  };
  walk(root);

  // Supplied by the platform, not by the operator.
  const platform = new Set(['NODE_ENV', 'HOME', 'USERPROFILE', 'NETLIFY', 'VERCEL',
    'AWS_LAMBDA_FUNCTION_NAME']);
  const undocumented = [...used].filter((k) => !platform.has(k) && !documented.has(k));

  assert.deepStrictEqual(undocumented, [],
    `these variables are read but not in .env.example: ${undocumented.join(', ')}`);
});
