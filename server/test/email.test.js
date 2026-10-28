'use strict';
const test = require('node:test');
const assert = require('node:assert');
const emailService = require('../email');

test('formatPlanName formats known and fallback plans', () => {
  assert.strictEqual(emailService.formatPlanName('pro_monthly'), 'Pro — Monthly Subscription (₹199/month)');
  assert.strictEqual(emailService.formatPlanName('pro_yearly'), 'Pro — Yearly Subscription (₹1,499/year)');
  assert.strictEqual(emailService.formatPlanName('pro_plus_ai'), 'Pro+ AI Markets — Monthly Subscription (₹399/month)');
  assert.strictEqual(emailService.formatPlanName('lifetime'), 'Founder Lifetime (₹2,999 one-time)');
  assert.strictEqual(emailService.formatPlanName('custom_test'), 'custom_test');
  assert.strictEqual(emailService.formatPlanName(null), 'Pro');
});

test('buildHtmlTemplate contains key, plan name and activation instructions', () => {
  const html = emailService.buildHtmlTemplate({
    licenseKey: 'TL-ABCDE-12345-FGHIJ-67890',
    plan: 'lifetime',
    email: 'trader@example.com',
    expiresAt: null
  });

  assert.ok(html.includes('TL-ABCDE-12345-FGHIJ-67890'));
  assert.ok(html.includes('Founder Lifetime'));
  assert.ok(html.includes('Perpetual Lifetime Access'));
  assert.ok(html.includes('How to activate in 30 seconds'));
  assert.ok(html.includes('Rules & settings'));
});

test('buildPlainText contains key and step-by-step instructions', () => {
  const text = emailService.buildPlainText({
    licenseKey: 'TL-MONTH-11111-22222-33333',
    plan: 'pro_monthly',
    expiresAt: 1750000000000
  });

  assert.ok(text.includes('TL-MONTH-11111-22222-33333'));
  assert.ok(text.includes('HOW TO ACTIVATE IN CHROME'));
  assert.ok(text.includes('Pro — Monthly Subscription'));
  assert.ok(text.includes('Current paid period ends'));
  assert.ok(text.includes('auto-renews unless cancelled'));
});

test('sendLicenseEmail skips safely when apiKey is empty', async () => {
  const res = await emailService.sendLicenseEmail({
    to: 'test@example.com',
    licenseKey: 'TL-TEST-123',
    apiKey: ''
  });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.skipped, true);
  assert.strictEqual(res.reason, 'missing_resend_api_key');
});

test('sendLicenseEmail skips safely when recipient is empty', async () => {
  const res = await emailService.sendLicenseEmail({
    to: '',
    licenseKey: 'TL-TEST-123',
    apiKey: 're_test_dummy'
  });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.skipped, true);
  assert.strictEqual(res.reason, 'missing_recipient_or_key');
});

test('sendLicenseEmail executes API request with Bearer auth and payload', async () => {
  let calledUrl = '';
  let calledHeaders = {};
  let calledBody = null;

  const mockFetch = async (url, opts) => {
    calledUrl = url;
    calledHeaders = opts.headers;
    calledBody = JSON.parse(opts.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: 'resend_email_test_999' })
    };
  };

  const res = await emailService.sendLicenseEmail({
    to: 'buyer@domain.com',
    licenseKey: 'TL-BUYER-KEY-12345',
    plan: 'pro_yearly',
    apiKey: 're_mock_api_key_xyz',
    from: 'Trade Lock <test@resend.dev>',
    fetchImpl: mockFetch
  });

  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.id, 'resend_email_test_999');
  assert.strictEqual(calledUrl, 'https://api.resend.com/emails');
  assert.strictEqual(calledHeaders.Authorization, 'Bearer re_mock_api_key_xyz');
  assert.strictEqual(calledBody.to, 'buyer@domain.com');
  assert.strictEqual(calledBody.from, 'Trade Lock <test@resend.dev>');
  assert.ok(calledBody.subject.includes('Your Trade Lock Pro License Key'));
  assert.ok(calledBody.html.includes('TL-BUYER-KEY-12345'));
});

test('sendLicenseEmail handles upstream Resend API error cleanly without throwing', async () => {
  const mockFetch = async () => {
    return {
      ok: false,
      status: 422,
      json: async () => ({
        name: 'validation_error',
        message: 'The domain is not verified'
      })
    };
  };

  const res = await emailService.sendLicenseEmail({
    to: 'buyer@domain.com',
    licenseKey: 'TL-ERR-123',
    apiKey: 're_mock_api_key_xyz',
    fetchImpl: mockFetch
  });

  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.status, 422);
  assert.ok(res.error.includes('domain is not verified') || res.error.includes('validation_error'));
});


test('email templates use plan-specific device limits', () => {
  const pro = emailService.buildHtmlTemplate({ licenseKey: 'TL-TEST', plan: 'pro_monthly', email: 'pro@example.com', expiresAt: null });
  const plus = emailService.buildHtmlTemplate({ licenseKey: 'TL-TEST', plan: 'pro_plus_ai_monthly', email: 'plus@example.com', expiresAt: null });
  assert.ok(pro.includes('up to 3 devices'));
  assert.ok(plus.includes('up to 5 devices'));
  assert.ok(plus.includes('Monthly Subscription'));
  assert.ok(!plus.includes('Perpetual Lifetime Access'));
});


test('email templates do not promise universal open-position deferral and escape HTML keys', () => {
  const html = emailService.buildHtmlTemplate({ licenseKey: 'TL-<TEST>&KEY', plan: 'pro_monthly', email: 'pro@example.com', expiresAt: null });
  const text = emailService.buildPlainText({ licenseKey: 'TL-TEST', plan: 'pro_monthly', expiresAt: null });
  assert.ok(html.includes('TL-&lt;TEST&gt;&amp;KEY'));
  assert.ok(html.includes('Manual locks are immediate'));
  assert.ok(html.includes('Detection is best-effort') || html.includes('detection is best-effort'));
  assert.ok(text.includes('Manual locks are immediate'));
  assert.strictEqual(text.includes('ensuring you are never locked out'), false);
});
