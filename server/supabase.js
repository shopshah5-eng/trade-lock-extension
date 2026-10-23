'use strict';
/*
 * Optional Supabase Cloud PostgreSQL Sync Adapter.
 *
 * If SUPABASE_URL and SUPABASE_SERVICE_KEY (or SUPABASE_KEY) are set in .env,
 * this adapter syncs every issued license and payment order to Supabase REST tables:
 *   - licenses
 *   - orders
 *
 * Uses native fetch (Node >= 18) with zero extra npm packages.
 */

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || '';

function isConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_KEY);
}

/**
 * Sync a newly issued license to Supabase.
 */
async function syncLicense(lic) {
  if (!isConfigured()) return { ok: false, skipped: true };

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/licenses`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates'
      },
      body: JSON.stringify({
        hash: lic.hash,
        hint: lic.hint,
        email: lic.email,
        plan: lic.plan,
        created_at: new Date(lic.createdAt).toISOString(),
        expires_at: lic.expiresAt ? new Date(lic.expiresAt).toISOString() : null,
        payment_id: lic.paymentId,
        order_id: lic.orderId,
        devices: lic.devices || [],
        revoked: Boolean(lic.revoked)
      })
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      console.warn('[supabase] Sync license error:', res.status, err);
      return { ok: false, error: err };
    }
    return { ok: true };
  } catch (e) {
    console.error('[supabase] Network exception syncing license:', e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * Sync an order status update to Supabase.
 */
async function syncOrder(orderId, orderData) {
  if (!isConfigured()) return { ok: false, skipped: true };

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/orders`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates'
      },
      body: JSON.stringify({
        order_id: orderId,
        email: orderData.email,
        plan: orderData.plan,
        status: orderData.status,
        payment_id: orderData.paymentId || null,
        updated_at: new Date().toISOString()
      })
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      console.warn('[supabase] Sync order error:', res.status, err);
      return { ok: false, error: err };
    }
    return { ok: true };
  } catch (e) {
    console.error('[supabase] Network exception syncing order:', e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * Fetch a license from Supabase by its hash.
 */
async function fetchLicense(hash) {
  if (!isConfigured() || !hash) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/licenses?hash=eq.${encodeURIComponent(hash)}&select=*`, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`
      }
    });
    if (!res.ok) return null;
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const r = rows[0];
    return {
      hash: r.hash,
      hint: r.hint,
      email: r.email,
      plan: r.plan,
      createdAt: new Date(r.created_at).getTime(),
      expiresAt: r.expires_at ? new Date(r.expires_at).getTime() : null,
      paymentId: r.payment_id,
      orderId: r.order_id,
      devices: Array.isArray(r.devices) ? r.devices : [],
      revoked: Boolean(r.revoked)
    };
  } catch (e) {
    console.error('[supabase] fetchLicense error:', e.message);
    return null;
  }
}

/**
 * Fetch an order from Supabase by its order_id.
 */
async function fetchOrder(orderId) {
  if (!isConfigured() || !orderId) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/orders?order_id=eq.${encodeURIComponent(orderId)}&select=*`, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`
      }
    });
    if (!res.ok) return null;
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    return rows[0];
  } catch (e) {
    console.error('[supabase] fetchOrder error:', e.message);
    return null;
  }
}

/**
 * Update the devices array for a license in Supabase.
 */
async function updateLicenseDevices(hash, devices) {
  if (!isConfigured() || !hash) return false;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/licenses?hash=eq.${encodeURIComponent(hash)}`, {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ devices })
    });
    return res.ok;
  } catch (e) {
    return false;
  }
}

module.exports = {
  isConfigured,
  syncLicense,
  syncOrder,
  fetchLicense,
  fetchOrder,
  updateLicenseDevices
};
