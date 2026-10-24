'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');

function runAdmin(args, fakeSupabase, failingSave = false) {
  const script = `
    const Module = require('node:module');
    const originalLoad = Module._load;
    const old = { hash: 'old-hash', hint: 'TL-OLD', email: 'trader@example.com', plan: 'pro_monthly',
      createdAt: 100, expiresAt: null, paymentId: 'pay_original', devices: [], revoked: false };
    const store = { licenses: { 'old-hash': old }, saveSync() { ${failingSave ? "throw new Error('read-only cache')" : 'return true;'} } };
    const fake = ${fakeSupabase};
    Module._load = function(request, parent, isMain) {
      if (parent && parent.filename && parent.filename.endsWith('/server/admin.js')) {
        if (request === './store') return store;
        if (request === './supabase') return fake;
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    process.argv = ['node', 'admin.js', ...${JSON.stringify(args)}];
    require('./server/admin.js');
  `;
  return spawnSync(process.execPath, ['-e', script], { cwd: root, encoding: 'utf8' });
}

test('admin reissue reveals the one-time key after remote commit despite local cache failure', () => {
  const remote = `{
    isConfigured() { return true; },
    fetchLicensesByEmail() { return Promise.resolve([]); },
    fetchLicensesByPayment() { return Promise.resolve([]); },
    reissueLicense() { return Promise.resolve({ ok: true }); },
    syncLicense() { return Promise.resolve({ ok: true }); }
  }`;
  const result = runAdmin(['reissue', 'trader@example.com'], remote, true);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /old key revoked: TL-OLD/);
  assert.match(result.stdout, /NEW KEY \(shown once\): TL-/);
  assert.match(result.stderr, /Supabase reissue succeeded; local cache update failed/);
});

test('admin payment lookup uses authoritative Supabase payment and reissue linkage', () => {
  const remote = `{
    isConfigured() { return true; },
    fetchLicensesByEmail() { throw new Error('email lookup must not run'); },
    fetchLicensesByPayment(id) {
      if (id !== 'pay_remote') throw new Error('wrong payment id');
      return Promise.resolve([{ hash: 'remote-hash', hint: 'TL-REMOTE', email: 'remote@example.com',
        plan: 'pro_plus_ai_monthly', createdAt: 200, expiresAt: null, originalPaymentId: id,
        devices: [], revoked: false }]);
    }
  }`;
  const result = runAdmin(['lookup', 'pay_remote'], remote);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /TL-REMOTE/);
  assert.match(result.stdout, /remote@example.com/);
  assert.match(result.stdout, /pay_remote/);
});
