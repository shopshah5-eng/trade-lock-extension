'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const inlineScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
assert.strictEqual(inlineScripts.length, 1, 'pricing page must have one inline application script');
// init() is exercised by the server/browser integration tests. These cases drive
// buy() directly so they can control the exact provider and verification sequence.
const script = inlineScripts[0][1].replace(/init\(\)\.catch\([^;]+;\s*$/, '');

function harness({ plan = 'pro_monthly', recurring = true, autoHandler = true, demo = false } = {}) {
  const elements = new Map();
  const location = { pathname: '/', search: '', hash: '' };
  const storage = new Map();
  const calls = { create: 0, verify: 0, razorpay: 0 };
  const instances = [];
  let verifyMode = 'success';

  const document = {
    title: '',
    getElementById(id) {
      if (!elements.has(id)) {
        elements.set(id, {
          id, style: {}, dataset: { amount: recurring ? '19900' : '299900' },
          value: '', textContent: '', innerHTML: '', disabled: false,
          scrollIntoView() {},
        });
      }
      return elements.get(id);
    },
    querySelectorAll() { return []; },
    createElement() { return { style: {}, select() {} }; },
    body: { appendChild() {}, removeChild() {} },
  };
  const context = {
    console, document, location,
    window: { location, addEventListener() {} },
    history: {
      replaceState(_state, _title, url) {
        const query = String(url).split('?')[1] || '';
        location.search = query.split('#')[0];
      },
    },
    sessionStorage: {
      getItem(key) { return storage.has(key) ? storage.get(key) : null; },
      setItem(key, value) { storage.set(key, String(value)); },
      removeItem(key) { storage.delete(key); },
    },
    navigator: {},
    setTimeout(fn) { fn(); return 0; },
    clearTimeout() {},
    URLSearchParams,
  };
  context.fetch = async (url, options = {}) => {
    if (url === '/api/create-order') {
      calls.create += 1;
      const target = recurring ? 'sub_checkout_1' : 'order_checkout_1';
      return {
        ok: true, status: 200,
        async json() {
          return recurring
            ? { ok: true, subscriptionId: target, orderId: target, plan, recurring: true, amount: 19900, currency: 'INR', demo }
            : { ok: true, orderId: target, plan, recurring: false, amount: 299900, currency: 'INR', demo };
        },
      };
    }
    if (url === '/api/verify-payment') {
      calls.verify += 1;
      if (verifyMode === 'fail') return { ok: false, status: 500, async json() { return { error: 'injected_verify_outage' }; } };
      if (verifyMode === 'nonretryable') return { ok: false, status: 400, async json() { return { error: 'injected_bad_signature' }; } };
      return { ok: true, status: 200, async json() { return { ok: true, licenseKey: 'TL-CHECKOUT-KEY', emailSent: true }; } };
    }
    throw new Error('unexpected fetch: ' + url);
  };
  function Razorpay(options) {
    calls.razorpay += 1;
    this.options = options;
    this.handlers = {};
    instances.push(this);
  }
  Razorpay.prototype.on = function (event, handler) { this.handlers[event] = handler; };
  Razorpay.prototype.emit = function (event, value) {
    assert.ok(this.handlers[event], 'missing handler for ' + event);
    return this.handlers[event](value);
  };
  Razorpay.prototype.open = function () {
    if (!autoHandler) return;
    this.handlerPromise = this.options.handler({
      razorpay_subscription_id: this.options.subscription_id,
      razorpay_order_id: this.options.order_id,
      razorpay_payment_id: 'pay_checkout_1',
      razorpay_signature: 'signed_checkout_callback',
    });
  };
  context.Razorpay = Razorpay;
  vm.createContext(context);
  vm.runInContext(script, context);
  vm.runInContext("CONFIG = { keyId: 'rzp_test_checkout', demoMode: " + String(demo) + " }", context);
  document.getElementById('email-' + plan).value = 'buyer@example.com';

  return {
    context, document, calls, instances, storage,
    button: { disabled: false, textContent: '', dataset: { amount: recurring ? '19900' : '299900' } },
    setVerifyMode(value) { verifyMode = value; },
  };
}

test('checkout retry verifies the same payment without creating or opening another subscription', async () => {
  const h = harness();
  h.setVerifyMode('fail');
  await h.context.buy('pro_monthly', h.button);
  assert.strictEqual(h.calls.create, 1);
  assert.strictEqual(h.calls.razorpay, 1);
  await h.instances[0].handlerPromise;
  assert.strictEqual(h.calls.verify, 9, 'bounded retry should exhaust the injected 500s');
  assert.strictEqual(h.button.textContent, 'Retry verification');
  assert.ok(h.storage.has('tlCheckoutPayment:sub_checkout_1'), 'paid verification payload must survive the retry');

  h.setVerifyMode('success');
  await h.context.buy('pro_monthly', h.button);
  assert.strictEqual(h.calls.create, 1, 'retry must not create another provider target');
  assert.strictEqual(h.calls.razorpay, 1, 'retry must not reopen paid checkout');
  assert.strictEqual(h.calls.verify, 10, 'retry must verify the saved payment directly');
  assert.strictEqual(h.document.getElementById('key').textContent, 'TL-CHECKOUT-KEY');
  assert.strictEqual(h.storage.has('tlCheckoutPayment:sub_checkout_1'), false);
  assert.strictEqual(h.button.textContent, 'Done ✓');
});

test('canonical alias handoff reuses its subscription and rejects a mismatched callback target', async () => {
  const h = harness({ autoHandler: false });
  vm.runInContext("query.set('plan', 'pro_sub'); query.set('email', 'buyer@example.com'); query.set('subscriptionId', 'sub_alias_target')", h.context);
  await h.context.buy('pro_monthly', h.button);
  assert.strictEqual(h.calls.create, 0, 'alias handoff must not create a duplicate target');
  assert.strictEqual(h.instances[0].options.subscription_id, 'sub_alias_target');
  // Force a mismatched provider callback without running the normal open helper.
  await h.instances[0].options.handler({
    razorpay_subscription_id: 'sub_attacker_or_stale_target',
    razorpay_payment_id: 'pay_mismatch', razorpay_signature: 'bad_target_signature',
  });
  assert.strictEqual(h.calls.verify, 0, 'mismatched target must never reach fulfillment');
  assert.strictEqual(h.storage.size, 0);
  assert.match(h.document.getElementById('err').textContent, /different checkout target/);
});

test('dismissal and failed payment reopen the same checkout target without creating duplicates', async () => {
  const h = harness({ autoHandler: false });
  await h.context.buy('pro_monthly', h.button);
  const target = h.instances[0].options.subscription_id;
  h.instances[0].options.modal.ondismiss();
  assert.strictEqual(h.button.disabled, false);
  assert.strictEqual(h.button.textContent, 'Retry checkout');

  await h.context.buy('pro_monthly', h.button);
  assert.strictEqual(h.calls.create, 1);
  assert.strictEqual(h.calls.razorpay, 2);
  assert.strictEqual(h.instances[1].options.subscription_id, target);
  h.instances[1].emit('payment.failed', { error: { description: 'card declined' } });
  assert.match(h.document.getElementById('err').textContent, /card declined/);
  assert.strictEqual(h.button.textContent, 'Retry payment');

  await h.context.buy('pro_monthly', h.button);
  assert.strictEqual(h.calls.create, 1);
  assert.strictEqual(h.calls.razorpay, 3);
  assert.strictEqual(h.instances[2].options.subscription_id, target);
  assert.strictEqual(h.storage.size, 0, 'an unpaid dismissal/failure has no fulfillment payload');
});

test('non-retryable verification preserves the paid payload and never retries in a loop', async () => {
  const h = harness();
  h.setVerifyMode('nonretryable');
  await h.context.buy('pro_monthly', h.button);
  await h.instances[0].handlerPromise;
  assert.strictEqual(h.calls.verify, 1, 'HTTP 400 must not be retried');
  assert.strictEqual(h.button.textContent, 'Retry verification');
  assert.ok(h.storage.has('tlCheckoutPayment:sub_checkout_1'));

  h.setVerifyMode('success');
  await h.context.buy('pro_monthly', h.button);
  assert.strictEqual(h.calls.create, 1);
  assert.strictEqual(h.calls.razorpay, 1);
  assert.strictEqual(h.calls.verify, 2);
  assert.strictEqual(h.document.getElementById('key').textContent, 'TL-CHECKOUT-KEY');
  assert.strictEqual(h.storage.size, 0);
});

test('Founder uses a one-time order with approved amount and fulfills its callback', async () => {
  const h = harness({ plan: 'founder_lifetime', recurring: false });
  await h.context.buy('founder_lifetime', h.button);
  await h.instances[0].handlerPromise;
  const options = h.instances[0].options;
  assert.strictEqual(options.order_id, 'order_checkout_1');
  assert.strictEqual(options.subscription_id, undefined);
  assert.strictEqual(options.amount, 299900);
  assert.strictEqual(options.currency, 'INR');
  assert.strictEqual(h.calls.create, 1);
  assert.strictEqual(h.calls.verify, 1);
  assert.strictEqual(h.document.getElementById('key').textContent, 'TL-CHECKOUT-KEY');
  assert.strictEqual(h.button.textContent, 'Done ✓');
});

test('demo checkout fulfills without invoking Razorpay or creating a payment payload', async () => {
  const h = harness({ demo: true });
  await h.context.buy('pro_monthly', h.button);
  assert.strictEqual(h.calls.create, 1);
  assert.strictEqual(h.calls.verify, 1);
  assert.strictEqual(h.calls.razorpay, 0);
  assert.strictEqual(h.document.getElementById('key').textContent, 'TL-CHECKOUT-KEY');
  assert.strictEqual(h.storage.size, 0);
  assert.strictEqual(h.button.textContent, 'Done ✓');
});
