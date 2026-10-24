'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const R = require('../lib/rules.js');

test('Build 10 Functional Unit Tests: TL_RELEASED and TL_RELEASE_MANUAL Security Invariants', async (t) => {
  // 1. Content script TL_RELEASED message handler behavior simulation
  function simulateContentReleasedHandler(storedState, localState, now, sender, extId, storageError) {
    let loopCalled = false;
    let recoverySent = false;
    let response = null;
    let overlayBuilt = false;

    function buildOverlay() { overlayBuilt = true; }
    function buildSubframeBlocker() { overlayBuilt = true; }
    function sendResponse(res) {
      response = res;
    }

    const effectiveExtId = extId || 'valid-trade-lock-id';
    if (sender && sender.id && sender.id !== effectiveExtId) {
      sendResponse({ ok: false, error: 'UNAUTHORIZED_SENDER' });
      return { localState, loopCalled, recoverySent, response, overlayBuilt };
    }

    if (storageError) {
      if (localState && localState.lock && localState.lock.active) buildOverlay();
      recoverySent = true;
      sendResponse({ ok: false, error: 'STORAGE_STATE_MISSING_OR_CORRUPT', recovering: true });
      return { localState, loopCalled, recoverySent, response, overlayBuilt };
    }

    var stored = storedState;
    if (!stored || !stored.lock || typeof stored.lock.active !== 'boolean') {
      if (localState && localState.lock && localState.lock.active) buildOverlay();
      recoverySent = true;
      sendResponse({ ok: false, error: 'STORAGE_STATE_MISSING_OR_CORRUPT', recovering: true });
      return { localState, loopCalled, recoverySent, response, overlayBuilt };
    }

    if (stored.lock.active) {
      var until = Number(stored.lock.until);
      if (isNaN(until) || until <= 0 || (now < until && !stored.lock.emergencyOverridden)) {
        sendResponse({ ok: false, error: 'LOCK_STILL_ACTIVE', until: stored.lock.until });
        return { localState, loopCalled, recoverySent, response, overlayBuilt };
      }
    }

    if (localState && localState.lock && localState.lock.active && !localState.lock.manual) {
      var localUntil = Number(localState.lock.until);
      if (!isNaN(localUntil) && localUntil > now && !stored.lock.emergencyOverridden) {
        buildOverlay();
        sendResponse({ ok: false, error: 'RULE_LOCK_UNEXPIRED', until: localUntil });
        return { localState, loopCalled, recoverySent, response, overlayBuilt };
      }
    }

    localState = stored;
    loopCalled = true;
    sendResponse({ ok: true, state: localState });
    return { localState, loopCalled, recoverySent, response, overlayBuilt };
  }

  await t.test('TL_RELEASED: Missing storage fails closed, keeps lock active, triggers recovery', () => {
    const activeLockState = {
      lock: { active: true, reason: 'Max daily loss reached', until: Date.now() + 3600000, manual: false }
    };

    const result = simulateContentReleasedHandler(null, activeLockState, Date.now());
    assert.strictEqual(result.response.ok, false);
    assert.strictEqual(result.response.error, 'STORAGE_STATE_MISSING_OR_CORRUPT');
    assert.strictEqual(result.response.recovering, true);
    assert.strictEqual(result.localState.lock.active, true, 'Active lock must NOT be cleared');
    assert.strictEqual(result.overlayBuilt, true, 'Overlay must be actively maintained');
    assert.strictEqual(result.recoverySent, true, 'Recovery request must be triggered');
    assert.strictEqual(result.loopCalled, false);
  });

  await t.test('TL_RELEASED: Corrupted storage (missing lock object) fails closed, keeps lock active', () => {
    const activeLockState = {
      lock: { active: true, reason: 'Max daily loss reached', until: Date.now() + 3600000, manual: false }
    };
    const corruptStorage = { session: { trades: 5 } }; // No lock object!

    const result = simulateContentReleasedHandler(corruptStorage, activeLockState, Date.now());
    assert.strictEqual(result.response.ok, false);
    assert.strictEqual(result.response.error, 'STORAGE_STATE_MISSING_OR_CORRUPT');
    assert.strictEqual(result.localState.lock.active, true, 'Corrupt storage must fail-closed');
    assert.strictEqual(result.overlayBuilt, true);
    assert.strictEqual(result.recoverySent, true);
  });

  await t.test('TL_RELEASED: Delayed or failed storage read error fails closed, keeps lock active', () => {
    const activeLockState = {
      lock: { active: true, reason: 'Trades limit', until: Date.now() + 100000, manual: false }
    };

    const result = simulateContentReleasedHandler(null, activeLockState, Date.now(), null, null, new Error('Storage read timeout'));
    assert.strictEqual(result.response.ok, false);
    assert.strictEqual(result.response.error, 'STORAGE_STATE_MISSING_OR_CORRUPT');
    assert.strictEqual(result.localState.lock.active, true);
    assert.strictEqual(result.overlayBuilt, true);
  });

  await t.test('TL_RELEASED: Forged sender (external extension or webpage) rejects release immediately', () => {
    const now = Date.now();
    const storedUnlockedState = { lock: { active: false } };
    const localActiveLock = { lock: { active: true, manual: true, until: now + 5000 } };
    const fakeSender = { id: 'malicious-extension' };

    const result = simulateContentReleasedHandler(storedUnlockedState, localActiveLock, now, fakeSender, 'valid-trade-lock-id');
    assert.strictEqual(result.response.ok, false);
    assert.strictEqual(result.response.error, 'UNAUTHORIZED_SENDER');
    assert.strictEqual(result.localState.lock.active, true);
    assert.strictEqual(result.loopCalled, false);
  });

  await t.test('TL_RELEASED: Forged notification with background storage still active rejects release', () => {
    const now = Date.now();
    const storedActiveRuleLock = {
      lock: { active: true, reason: 'Loss limit', until: now + 500000, manual: false }
    };
    const localActiveLock = Object.assign({}, storedActiveRuleLock);

    const result = simulateContentReleasedHandler(storedActiveRuleLock, localActiveLock, now);
    assert.strictEqual(result.response.ok, false);
    assert.strictEqual(result.response.error, 'LOCK_STILL_ACTIVE');
    assert.strictEqual(result.localState.lock.active, true);
    assert.strictEqual(result.loopCalled, false);
  });

  await t.test('TL_RELEASED: Forged notification with storage inactive but local rule lock unexpired fails closed', () => {
    const now = Date.now();
    const storedUnlockedState = {
      lock: { active: false, reason: null, until: null, manual: false }
    };
    const localActiveRuleLock = {
      lock: { active: true, reason: 'Loss limit', until: now + 500000, manual: false }
    };

    const result = simulateContentReleasedHandler(storedUnlockedState, localActiveRuleLock, now);
    assert.strictEqual(result.response.ok, false);
    assert.strictEqual(result.response.error, 'RULE_LOCK_UNEXPIRED');
    assert.strictEqual(result.localState.lock.active, true, 'Rule lock must remain active prior to until timestamp');
    assert.strictEqual(result.overlayBuilt, true);
  });

  await t.test('TL_RELEASED: Legitimate authoritative unlock transitions cleanly', () => {
    const now = Date.now();
    const activeLockState = {
      lock: { active: true, reason: 'Manual lock', until: now + 500000, manual: true }
    };
    const storedUnlockedState = {
      lock: { active: false, reason: null, until: null, manual: false },
      status: 'NORMAL'
    };

    const result = simulateContentReleasedHandler(storedUnlockedState, activeLockState, now);
    assert.strictEqual(result.response.ok, true);
    assert.strictEqual(result.localState.lock.active, false);
    assert.strictEqual(result.loopCalled, true);
  });

  // 2. Background manual release authorization simulation
  function simulateBackgroundManualRelease(msg, sender, state, extensionId) {
    let response = null;
    function sendResponse(r) { response = r; }

    const extId = extensionId || 'valid-trade-lock-id';
    if (sender && sender.id && sender.id !== extId) {
      sendResponse({ success: false, error: 'UNAUTHORIZED_SENDER', message: 'Unauthorized message sender context.' });
      return { response, state };
    }
    const isTabSender = !!(sender && sender.tab);
    const isWebUrl = !!(sender && sender.url && !sender.url.startsWith('chrome-extension://'));
    if (isTabSender || isWebUrl) {
      sendResponse({ success: false, error: 'UNAUTHORIZED_SENDER', message: 'Unauthorized message sender context. Manual release must originate from the extension popup.' });
      return { response, state };
    }
    if (!msg.confirmed) {
      sendResponse({ success: false, error: 'CONFIRMATION_REQUIRED', message: 'Manual release requires explicit user confirmation.' });
      return { response, state };
    }
    if (!state || !state.lock || !state.lock.active) {
      sendResponse({ success: false, reason: 'NO_ACTIVE_LOCK' });
      return { response, state };
    }
    if (!state.lock.manual) {
      sendResponse({
        success: false,
        error: 'RULE_LOCK_PROTECTED',
        message: 'Rule-triggered locks cannot be released manually.'
      });
      return { response, state };
    }

    state.lock = { active: false, reason: null, since: null, until: null, manual: false };
    state.status = 'NORMAL';
    state.statusReason = null;
    state.audit = (state.audit || []).concat([{
      action: 'MANUAL_LOCK_RELEASED',
      releasedAt: Date.now(),
      source: (sender && sender.url) || 'extension'
    }]).slice(-50);

    sendResponse({ success: true, message: 'Focus lock released.' });
    return { response, state };
  }

  await t.test('TL_RELEASE_MANUAL: Rejects unauthorized sender context', () => {
    const extId = 'valid-trade-lock-id';
    const fakeSender = { id: 'malicious-extension-id' };
    const state = { lock: { active: true, manual: true } };

    const result = simulateBackgroundManualRelease({ confirmed: true }, fakeSender, state, extId);
    assert.strictEqual(result.response.success, false);
    assert.strictEqual(result.response.error, 'UNAUTHORIZED_SENDER');
    assert.strictEqual(result.state.lock.active, true);
  });

  await t.test('TL_RELEASE_MANUAL: Rejects sender from tab / content script context', () => {
    const extId = 'valid-trade-lock-id';
    const tabSender = { id: extId, tab: { id: 101 }, url: 'https://kite.zerodha.com/' };
    const state = { lock: { active: true, manual: true } };

    const result = simulateBackgroundManualRelease({ confirmed: true }, tabSender, state, extId);
    assert.strictEqual(result.response.success, false);
    assert.strictEqual(result.response.error, 'UNAUTHORIZED_SENDER');
    assert.strictEqual(result.state.lock.active, true);
  });

  await t.test('TL_RELEASE_MANUAL: Rejects sender with non-extension URL', () => {
    const extId = 'valid-trade-lock-id';
    const webSender = { id: extId, url: 'https://kite.zerodha.com/dashboard' };
    const state = { lock: { active: true, manual: true } };

    const result = simulateBackgroundManualRelease({ confirmed: true }, webSender, state, extId);
    assert.strictEqual(result.response.success, false);
    assert.strictEqual(result.response.error, 'UNAUTHORIZED_SENDER');
    assert.strictEqual(result.state.lock.active, true);
  });

  await t.test('TL_RELEASE_MANUAL: Rejects unconfirmed request', () => {
    const extId = 'valid-trade-lock-id';
    const validSender = { id: extId, url: 'chrome-extension://' + extId + '/popup/popup.html' };
    const state = { lock: { active: true, manual: true } };

    const result = simulateBackgroundManualRelease({ confirmed: false }, validSender, state, extId);
    assert.strictEqual(result.response.success, false);
    assert.strictEqual(result.response.error, 'CONFIRMATION_REQUIRED');
    assert.strictEqual(result.state.lock.active, true);
  });

  await t.test('TL_RELEASE_MANUAL: Strictly rejects releasing automatic rule locks', () => {
    const extId = 'valid-trade-lock-id';
    const validSender = { id: extId, url: 'chrome-extension://' + extId + '/popup/popup.html' };
    const ruleLockState = {
      lock: { active: true, reason: 'maxDailyLoss', manual: false, until: Date.now() + 100000 }
    };

    const result = simulateBackgroundManualRelease({ confirmed: true }, validSender, ruleLockState, extId);
    assert.strictEqual(result.response.success, false);
    assert.strictEqual(result.response.error, 'RULE_LOCK_PROTECTED');
    assert.strictEqual(result.state.lock.active, true, 'Rule lock must NOT be released manually');
  });

  await t.test('TL_RELEASE_MANUAL: Successfully releases manual focus lock and records audit', () => {
    const extId = 'valid-trade-lock-id';
    const validSender = { id: extId, url: 'chrome-extension://' + extId + '/popup/popup.html' };
    const manualLockState = {
      lock: { active: true, reason: 'Manual lock', manual: true, until: Date.now() + 100000 },
      status: 'LOCKED',
      audit: []
    };

    const result = simulateBackgroundManualRelease({ confirmed: true }, validSender, manualLockState, extId);
    assert.strictEqual(result.response.success, true);
    assert.strictEqual(result.state.lock.active, false);
    assert.strictEqual(result.state.status, 'NORMAL');
    assert.strictEqual(result.state.audit.length, 1);
    assert.strictEqual(result.state.audit[0].action, 'MANUAL_LOCK_RELEASED');
  });

  // 3. Trade undo and reset protections
  await t.test('undoLastTrade: Strictly rejects trade reversal when rule lock is active', () => {
    const state = {
      lock: { active: true, reason: 'maxDailyLoss', manual: false, until: Date.now() + 100000 },
      log: [{ pnl: -6000, risk: 1000, source: 'manual' }],
      session: { trades: 1, pnl: -6000, riskUsed: 1000, consecutiveLosses: 1 }
    };

    const res = R.undoLastTrade(state);
    assert.ok(res, 'Must return rejection response');
    assert.strictEqual(res.rejected, true);
    assert.strictEqual(res.reason, 'RULE_LOCK_ACTIVE');
    assert.strictEqual(state.session.trades, 1, 'Trades count must not decrease');
    assert.strictEqual(state.session.pnl, -6000, 'P&L must not be altered');
  });

  await t.test('undoLastTrade: Allows undo when unlocked and trade is manual', () => {
    const state = {
      lock: { active: false, reason: null, manual: false },
      log: [{ pnl: 500, risk: 200, source: 'manual' }],
      session: { trades: 1, pnl: 500, riskUsed: 200, consecutiveLosses: 0 }
    };

    const res = R.undoLastTrade(state);
    assert.ok(res);
    assert.strictEqual(res.pnl, 500);
    assert.strictEqual(state.session.trades, 0);
  });
});
