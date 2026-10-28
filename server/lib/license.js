/*
 * Trade Lock — license client (browser side).
 * Validates a key against the license server and caches the result in
 * chrome.storage.local under `tlLicense`. The server is the source of truth;
 * this file only talks to it and shapes the response.
 */
(function (root) {
  'use strict';

  function deviceId() {
    return new Promise(function (resolve) {
      chrome.storage.local.get('tlDeviceId', function (res) {
        if (res && res.tlDeviceId) return resolve(res.tlDeviceId);
        var id = 'dev-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
        chrome.storage.local.set({ tlDeviceId: id }, function () { resolve(id); });
      });
    });
  }

  /** POST /api/validate. Resolves {active, plan, expiresAt, reason} or {active:false, reason:'network'}. */
  function validate(apiBase, key) {
    var base = String(apiBase || '').replace(/\/+$/, '');
    if (!base) return Promise.resolve({ active: false, reason: 'no_server' });
    return deviceId().then(function (dev) {
      return fetch(base + '/api/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: key, deviceId: dev })
      }).then(function (r) { return r.json(); })
        .then(function (data) {
          // Device registration is part of the entitlement decision. Retrying
          // without a device ID would bypass maxDevices whenever the registry
          // is unavailable, so the server's fail-closed response is final.
          return data;
        })
        .catch(function () { return { active: false, reason: 'network' }; });
    });
  }

  /** Validate and persist the outcome. Resolves the stored license object. */
  function activate(apiBase, key) {
    var normKey = String(key || '').trim().toUpperCase().replace(/\s+/g, '');
    return new Promise(function (resolveGet) {
      chrome.storage.local.get('tlLicense', function (data) {
        resolveGet(data && data.tlLicense);
      });
    }).then(function (existing) {
      return validate(apiBase, normKey).then(function (res) {
        if (res.reason === 'network' && existing && existing.active && existing.key === normKey) {
          var now = Date.now();
          if (!existing.expiresAt || existing.expiresAt > now) {
            return existing;
          }
        }
        var lic = {
          key: normKey,
          active: !!res.active, plan: res.plan || null,
          expiresAt: res.expiresAt || null, reason: res.reason || null,
          proPlus: !!res.proPlus, billingModel: res.billingModel || null,
          billingStatus: res.billingStatus || (res.active ? 'active' : 'inactive'),
          subscriptionId: res.subscriptionId || null,
          currentPeriodEnd: res.currentPeriodEnd || res.expiresAt || null,
          cancelAtPeriodEnd: !!res.cancelAtPeriodEnd, cancelledAt: res.cancelledAt || null,
          failureReason: res.failureReason || null,
          devicesUsed: res.devicesUsed || 0, maxDevices: res.maxDevices || null,
          validatedAt: Date.now()
        };
        return new Promise(function (resolve) {
          chrome.storage.local.set({ tlLicense: lic }, function () { resolve(lic); });
        });
      });
    });
  }

  root.TLLicense = { validate: validate, activate: activate, deviceId: deviceId };
})(typeof globalThis !== 'undefined' ? globalThis : this);
