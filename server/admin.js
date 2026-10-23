'use strict';
/*
 * Support CLI for the license store.
 *
 *   node admin.js list
 *   node admin.js lookup trader@example.com
 *   node admin.js reissue trader@example.com   -> revokes old key, prints a NEW one (shown once)
 *   node admin.js revoke  TL-XXXXX-...         -> disables a key (refund / chargeback)
 *
 * Plain keys are never stored (hash only), so a lost key cannot be recovered --
 * reissue is the recovery path.
 */
const store = require('./store');
const L = require('./license');
const { getPlan } = require('./plans');

const [cmd, arg] = process.argv.slice(2);

function show(lic) {
  console.log({
    hint: lic.hint, email: lic.email, plan: lic.plan,
    created: new Date(lic.createdAt).toISOString(),
    expires: lic.expiresAt ? new Date(lic.expiresAt).toISOString() : 'lifetime',
    devices: lic.devices.length, revoked: !!lic.revoked, paymentId: lic.paymentId,
  });
}

if (cmd === 'list') {
  const all = Object.values(store.licenses);
  console.log(all.length + ' license(s)');
  all.forEach(show);
} else if (cmd === 'lookup' && arg) {
  const hits = Object.values(store.licenses)
    .filter((l) => l.email === arg.toLowerCase() || l.paymentId === arg);
  if (!hits.length) console.log('no license for', arg);
  hits.forEach(show);
} else if (cmd === 'reissue' && arg) {
  const hits = Object.values(store.licenses).filter((l) => l.email === arg.toLowerCase() && !l.revoked);
  if (!hits.length) { console.log('no active license for', arg); process.exit(1); }
  const old = hits[hits.length - 1];
  old.revoked = true;
  const key = L.generateLicenseKey();
  const lic = {
    hash: L.hashKey(key), hint: L.keyHint(key), email: old.email, plan: old.plan,
    createdAt: Date.now(), expiresAt: old.expiresAt,
    paymentId: old.paymentId, orderId: old.orderId, devices: [], revoked: false,
    reissuedFrom: old.hint,
  };
  store.licenses[lic.hash] = lic;
  store.saveSync();
  console.log('old key revoked:', old.hint);
  console.log('NEW KEY (shown once):', key);
} else if (cmd === 'revoke' && arg) {
  const lic = store.licenses[L.hashKey(arg)];
  if (!lic) { console.log('key not found'); process.exit(1); }
  lic.revoked = true; store.saveSync();
  console.log('revoked:', lic.hint, lic.email);
} else {
  console.log('usage: node admin.js list | lookup <email|paymentId> | reissue <email> | revoke <key>');
}
