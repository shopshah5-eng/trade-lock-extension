'use strict';
/*
 * Support CLI. Run with the same durable-store environment as production.
 *   node admin.js list
 *   node admin.js lookup trader@example.com
 *   node admin.js reissue trader@example.com   -> revokes old key, prints a NEW one once
 *   node admin.js revoke TL-XXXXX-...
 * Plain keys are never persisted; only hashes are stored.
 */
const store = require('./store');
const L = require('./license');
const supabase = require('./supabase');

const [cmd, arg] = process.argv.slice(2);

function show(lic) {
  console.log({
    hint: lic.hint, email: lic.email, plan: lic.plan,
    created: new Date(lic.createdAt).toISOString(),
    expires: lic.expiresAt ? new Date(lic.expiresAt).toISOString() : 'lifetime',
    devices: (lic.devices || []).length, revoked: !!lic.revoked,
    paymentId: lic.paymentId || lic.originalPaymentId,
  });
}

async function lookup(emailOrPayment) {
  const needle = String(emailOrPayment || '').toLowerCase();
  let hits = Object.values(store.licenses).filter(l =>
    l.email === needle || l.paymentId === emailOrPayment || l.originalPaymentId === emailOrPayment);
  if (supabase.isConfigured()) {
    const remote = needle.includes('@')
      ? await supabase.fetchLicensesByEmail(needle)
      : await supabase.fetchLicensesByPayment(emailOrPayment);
    const byHash = new Map(hits.map(l => [l.hash, l]));
    remote.forEach(l => byHash.set(l.hash, l));
    hits = Array.from(byHash.values());
  }
  return hits;
}

async function main() {
  if (cmd === 'list') {
    const all = Object.values(store.licenses);
    if (supabase.isConfigured()) console.log('Showing local cache only; use lookup <email> for authoritative Supabase records.');
    console.log(all.length + ' license(s)');
    all.forEach(show);
  } else if (cmd === 'lookup' && arg) {
    const hits = await lookup(arg);
    if (!hits.length) console.log('no license for', arg);
    hits.forEach(show);
  } else if (cmd === 'reissue' && arg) {
    const now = Date.now();
    const hits = (await lookup(arg))
      .filter(l => l.email === arg.toLowerCase() && !l.revoked && (!l.expiresAt || l.expiresAt > now))
      .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
    if (!hits.length) throw new Error('no active, unexpired license for ' + arg);
    const old = hits[0];
    const key = L.generateLicenseKey();
    const replacement = {
      hash: L.hashKey(key), hint: L.keyHint(key), email: old.email, plan: old.plan,
      createdAt: Date.now(), expiresAt: old.expiresAt,
      paymentId: null, orderId: null,
      originalPaymentId: old.originalPaymentId || old.paymentId || null,
      originalOrderId: old.originalOrderId || old.orderId || null,
      devices: [], revoked: false, reissuedFrom: old.hint,
    };
    let remoteCommitted = false;
    if (supabase.isConfigured()) {
      const result = await supabase.reissueLicense(old.hash, replacement.hash, replacement.hint);
      if (!result.ok) throw new Error('Supabase reissue failed: ' + result.error);
      remoteCommitted = true;
    }
    old.revoked = true;
    old.revokedReason = 'support_reissue';
    old.revokedAt = Date.now();
    store.licenses[old.hash] = old;
    store.licenses[replacement.hash] = replacement;
    try {
      store.saveSync();
    } catch (e) {
      if (!remoteCommitted) throw e;
      // The durable replacement already exists. Never hide its one-time key
      // just because an optional local cache could not be updated.
      console.error('[admin] Supabase reissue succeeded; local cache update failed:', e.message);
    }
    console.log('old key revoked:', old.hint);
    console.log('NEW KEY (shown once):', key);
  } else if (cmd === 'revoke' && arg) {
    const hash = L.hashKey(arg);
    let lic = store.licenses[hash];
    if (supabase.isConfigured()) lic = await supabase.fetchLicense(hash);
    if (!lic) throw new Error('key not found');
    lic.revoked = true;
    lic.revokedReason = 'support_revoke';
    lic.revokedAt = Date.now();
    if (supabase.isConfigured()) {
      const result = await supabase.syncLicense(lic);
      if (!result.ok) throw new Error('Supabase revoke failed: ' + result.error);
    }
    store.licenses[hash] = lic;
    store.saveSync();
    console.log('revoked:', lic.hint, lic.email);
  } else {
    console.log('usage: node admin.js list | lookup <email|paymentId> | reissue <email> | revoke <key>');
  }
}

main().catch(err => {
  console.error('[admin]', err.message);
  process.exitCode = 1;
});
