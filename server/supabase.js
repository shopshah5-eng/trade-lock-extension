'use strict';
/* Supabase REST adapter. Payment routes fail closed when these operations fail. */
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || '';
const FETCH_TIMEOUT_MS = Number(process.env.PROVIDER_TIMEOUT_MS || 15000);

function isConfigured() { return Boolean(SUPABASE_URL && SUPABASE_KEY); }

async function request(pathname, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(SUPABASE_URL + pathname, {
      ...options,
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function errorResult(res, prefix) {
  const detail = await res.text().catch(() => '');
  return { ok: false, status: res.status, error: `${prefix}: ${res.status} ${detail}`.trim() };
}

async function syncLicense(lic) {
  if (!isConfigured()) return { ok: false, skipped: true };
  try {
    const res = await request('/rest/v1/licenses', {
      method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({
        hash: lic.hash, hint: lic.hint, email: lic.email, plan: lic.plan,
        created_at: new Date(lic.createdAt).toISOString(),
        expires_at: lic.expiresAt ? new Date(lic.expiresAt).toISOString() : null,
        payment_id: lic.paymentId || null, order_id: lic.orderId || null,
        original_payment_id: lic.originalPaymentId || null,
        original_order_id: lic.originalOrderId || null,
        reissued_from: lic.reissuedFrom || null,
        devices: lic.devices || [], revoked: Boolean(lic.revoked),
        revoked_reason: lic.revokedReason || null,
        revoked_at: lic.revokedAt ? new Date(lic.revokedAt).toISOString() : null,
        email_sent_at: lic.emailSentAt ? new Date(lic.emailSentAt).toISOString() : null,
      }),
    });
    return res.ok ? { ok: true } : errorResult(res, 'license sync failed');
  } catch (e) { return { ok: false, error: e.message }; }
}

async function syncOrder(orderId, order) {
  if (!isConfigured()) return { ok: false, skipped: true };
  try {
    const res = await request('/rest/v1/orders', {
      method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({
        order_id: orderId, email: order.email, plan: order.plan,
        amount: order.amount == null ? null : Number(order.amount),
        currency: order.currency || 'INR', status: order.status,
        payment_id: order.paymentId || null,
        fulfillment_status: order.fulfillmentStatus || null,
        paid_at: order.paidAt ? new Date(order.paidAt).toISOString() : null,
        fulfilled_at: order.fulfilledAt ? new Date(order.fulfilledAt).toISOString() : null,
        updated_at: new Date().toISOString(),
      }),
    });
    return res.ok ? { ok: true } : errorResult(res, 'order sync failed');
  } catch (e) { return { ok: false, error: e.message }; }
}

function normalizeLicense(r) {
  if (!r) return null;
  return {
    hash: r.hash, hint: r.hint, email: r.email, plan: r.plan,
    createdAt: new Date(r.created_at).getTime(),
    expiresAt: r.expires_at ? new Date(r.expires_at).getTime() : null,
    paymentId: r.payment_id, orderId: r.order_id,
    originalPaymentId: r.original_payment_id, originalOrderId: r.original_order_id,
    reissuedFrom: r.reissued_from,
    devices: Array.isArray(r.devices) ? r.devices : [], revoked: Boolean(r.revoked),
    revokedReason: r.revoked_reason || null,
    revokedAt: r.revoked_at ? new Date(r.revoked_at).getTime() : null,
    emailSentAt: r.email_sent_at ? new Date(r.email_sent_at).getTime() : null,
  };
}

async function fetchLicenseBy(field, value) {
  if (!isConfigured() || !value) return null;
  if (!['hash', 'order_id', 'payment_id'].includes(field)) throw new Error('invalid license lookup field');
  const res = await request(`/rest/v1/licenses?${field}=eq.${encodeURIComponent(value)}&select=*&order=created_at.desc&limit=1`);
  if (!res.ok) throw new Error(`Supabase license lookup failed: ${res.status}`);
  const rows = await res.json();
  return Array.isArray(rows) && rows.length ? normalizeLicense(rows[0]) : null;
}

async function fetchLicense(hash) { return fetchLicenseBy('hash', hash); }

async function fetchLicensesByPayment(paymentId) {
  if (!isConfigured() || !paymentId) return [];
  const value = encodeURIComponent(paymentId);
  const res = await request(`/rest/v1/licenses?or=(payment_id.eq.${value},original_payment_id.eq.${value})&select=*&order=created_at.desc&limit=100`);
  if (!res.ok) throw new Error(`Supabase refund lookup failed: ${res.status}`);
  const rows = await res.json();
  return Array.isArray(rows) ? rows.map(normalizeLicense) : [];
}

async function fetchLicensesByEmail(email) {
  if (!isConfigured() || !email) return [];
  const res = await request(`/rest/v1/licenses?email=eq.${encodeURIComponent(email)}&select=*&order=created_at.desc&limit=20`);
  if (!res.ok) throw new Error(`Supabase email lookup failed: ${res.status}`);
  const rows = await res.json();
  return Array.isArray(rows) ? rows.map(normalizeLicense) : [];
}

function normalizeOrder(r) {
  if (!r) return null;
  return {
    email: r.email, plan: r.plan, amount: r.amount == null ? null : Number(r.amount),
    currency: r.currency || 'INR', status: r.status, paymentId: r.payment_id || null,
    fulfillmentStatus: r.fulfillment_status || null,
    createdAt: r.created_at ? new Date(r.created_at).getTime() : null,
    paidAt: r.paid_at ? new Date(r.paid_at).getTime() : null,
    fulfilledAt: r.fulfilled_at ? new Date(r.fulfilled_at).getTime() : null,
  };
}

async function fetchOrder(orderId) {
  if (!isConfigured() || !orderId) return null;
  const res = await request(`/rest/v1/orders?order_id=eq.${encodeURIComponent(orderId)}&select=*&limit=1`);
  if (!res.ok) throw new Error(`Supabase order lookup failed: ${res.status}`);
  const rows = await res.json();
  return Array.isArray(rows) && rows.length ? normalizeOrder(rows[0]) : null;
}

/* Atomically inserts at most one license and marks the order fulfilled. */
async function fulfillOrder(orderId, order, lic) {
  if (!isConfigured()) return { ok: false, skipped: true };
  try {
    const res = await request('/rpc/fulfill_order', {
      method: 'POST',
      body: JSON.stringify({
        p_order_id: orderId, p_payment_id: lic.paymentId || null,
        p_email: order.email, p_plan: order.plan,
        p_hash: lic.hash, p_hint: lic.hint,
        p_created_at: new Date(lic.createdAt).toISOString(),
        p_expires_at: lic.expiresAt ? new Date(lic.expiresAt).toISOString() : null,
      }),
    });
    if (!res.ok) return errorResult(res, 'fulfillment transaction failed');
    const data = await res.json();
    const hash = typeof data === 'string' ? data : (data && (data.hash || data.fulfill_order)) || null;
    if (!hash) return { ok: false, error: 'fulfillment transaction returned no license hash' };
    return { ok: true, hash };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function hasWebhook(eventId) {
  if (!isConfigured() || !eventId) return false;
  const res = await request(`/rest/v1/processed_webhooks?event_id=eq.${encodeURIComponent(eventId)}&select=event_id&limit=1`);
  if (!res.ok) throw new Error(`Supabase webhook lookup failed: ${res.status}`);
  const rows = await res.json();
  return Array.isArray(rows) && rows.length > 0;
}

async function markWebhookProcessed(eventId, event) {
  if (!isConfigured()) return { ok: false, skipped: true };
  try {
    const res = await request('/rest/v1/processed_webhooks', {
      method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates' },
      body: JSON.stringify({ event_id: eventId, event: event || null }),
    });
    return res.ok ? { ok: true } : errorResult(res, 'webhook receipt failed');
  } catch (e) { return { ok: false, error: e.message }; }
}



async function reissueLicense(oldHash, newHash, newHint) {
  if (!isConfigured()) return { ok: false, skipped: true };
  try {
    const res = await request('/rpc/reissue_license', {
      method: 'POST',
      body: JSON.stringify({ p_old_hash: oldHash, p_new_hash: newHash, p_new_hint: newHint }),
    });
    if (!res.ok) return errorResult(res, 'license reissue failed');
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function registerDevice(hash, deviceId, maxDevices) {
  if (!isConfigured()) return { ok: false, skipped: true };
  try {
    const res = await request('/rpc/register_device', {
      method: 'POST',
      body: JSON.stringify({ p_hash: hash, p_device_id: deviceId, p_max_devices: maxDevices }),
    });
    if (!res.ok) return errorResult(res, 'device registration failed');
    const data = await res.json();
    const value = Array.isArray(data) ? data[0] : data;
    if (!value || typeof value.allowed !== 'boolean') return { ok: false, error: 'invalid device registration response' };
    return { ok: true, allowed: value.allowed, devicesUsed: Number(value.devices_used) || 0,
      reason: value.reason || null };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function updateLicenseDevices(hash, devices) {
  if (!isConfigured() || !hash) return false;
  try {
    const res = await request(`/rest/v1/licenses?hash=eq.${encodeURIComponent(hash)}`, {
      method: 'PATCH', body: JSON.stringify({ devices }),
    });
    return res.ok;
  } catch (e) { return false; }
}

module.exports = {
  isConfigured, syncLicense, syncOrder, fetchLicense, fetchLicenseBy,
  fetchLicensesByEmail, fetchLicensesByPayment, fetchOrder, fulfillOrder, hasWebhook,
  markWebhookProcessed, reissueLicense, registerDevice, updateLicenseDevices,
};
