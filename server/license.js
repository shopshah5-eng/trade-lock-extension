'use strict';
/*
 * License + Razorpay signature logic. Pure functions (node:crypto only) so the
 * exact code the server runs is unit-tested without network or credentials.
 */
const crypto = require('node:crypto');

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L — readable keys

function generateLicenseKey() {
  const bytes = crypto.randomBytes(20);
  let out = '';
  for (let i = 0; i < 20; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return 'TL-' + out.replace(/(.{5})(?=.)/g, '$1-');
}

function normalizeKey(key) {
  return String(key || '').trim().toUpperCase().replace(/\s+/g, '');
}

function hashKey(key) {
  return crypto.createHash('sha256').update(normalizeKey(key)).digest('hex');
}

function keyHint(key) {
  const k = normalizeKey(key);
  return k.length > 9 ? k.slice(0, 7) + '…' + k.slice(-4) : k;
}

/** Razorpay checkout signature: HMAC_SHA256(order_id + "|" + payment_id, secret). */
function verifyPaymentSignature(orderId, paymentId, signature, secret) {
  if (!orderId || !paymentId || !signature || !secret) return false;
  const expected = crypto.createHmac('sha256', secret)
    .update(orderId + '|' + paymentId).digest('hex');
  return safeEqual(expected, String(signature).toLowerCase());
}

/** Razorpay subscription signature: HMAC_SHA256(payment_id + "|" + subscription_id, secret). */
function verifySubscriptionSignature(paymentId, subscriptionId, signature, secret) {
  if (!paymentId || !subscriptionId || !signature || !secret) return false;
  const expected = crypto.createHmac('sha256', secret)
    .update(paymentId + '|' + subscriptionId).digest('hex');
  return safeEqual(expected, String(signature).toLowerCase());
}

/** Razorpay webhook signature: HMAC_SHA256(raw_body, webhook_secret). */
function verifyWebhookSignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  const expected = crypto.createHmac('sha256', secret)
    .update(rawBody).digest('hex');
  return safeEqual(expected, String(signature).toLowerCase());
}

function safeEqual(a, b) {
  const ba = Buffer.from(a); const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function expiryFor(durationDays, fromMs) {
  if (!durationDays) return null; // lifetime
  return (fromMs || Date.now()) + durationDays * 24 * 3600 * 1000;
}

function licenseStatus(lic, now) {
  const t = now || Date.now();
  if (!lic) return { active: false, reason: 'not_found' };
  if (lic.revoked) return { active: false, reason: 'revoked' };
  if (lic.expiresAt && t > lic.expiresAt) return { active: false, reason: 'expired', expiresAt: lic.expiresAt };
  return { active: true, reason: 'ok', plan: lic.plan, expiresAt: lic.expiresAt || null };
}

module.exports = {
  generateLicenseKey, normalizeKey, hashKey, keyHint,
  verifyPaymentSignature, verifySubscriptionSignature, verifyWebhookSignature, expiryFor, licenseStatus,
};
