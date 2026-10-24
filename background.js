/*
 * Trade Lock — service worker.
 *
 * The content script owns the counters, but a service worker is needed for the
 * things that must happen while no broker tab is open:
 *   - an alarm that fires exactly when the lock expires, so the overlay drops
 *     even if the tab was closed the whole time
 *   - the toolbar badge
 *   - the optional hard block (declarativeNetRequest redirect to lock.html)
 *   - installing sane defaults on first run
 */

var RELEASE_ALARM = 'tl-release';
var TICK_ALARM = 'tl-tick';
var BLOCK_RULE_ID = 91001;

if (typeof importScripts === 'function') {
  try { importScripts('lib/rules.js'); } catch (e) {}
}

var NSE_HOLIDAYS_FALLBACK = {
  2025: ['2025-02-26', '2025-03-14', '2025-03-31', '2025-04-10', '2025-04-14',
         '2025-04-18', '2025-05-01', '2025-08-15', '2025-08-27', '2025-10-02',
         '2025-10-21', '2025-10-22', '2025-11-05', '2025-12-25'],
  2026: ['2026-01-26', '2026-03-03', '2026-03-26', '2026-03-31', '2026-04-03',
         '2026-04-14', '2026-05-01', '2026-05-28', '2026-06-26', '2026-09-14',
         '2026-10-02', '2026-10-20', '2026-11-10', '2026-11-24', '2026-12-25']
};

var DEFAULT_SETTINGS = {
  maxTradesPerDay: 5,
  maxDailyLoss: 5000,
  profitTarget: 3000,
  maxRiskPerTrade: 0,
  maxDailyRisk: 0,
  maxConsecutiveLosses: 3,
  marketOpenMin: 555,
  minLockMinutes: 15,
  skipWeekends: true,
  skipHolidays: true,
  holidays: [],
  autoDetect: true,
  detectIntervalMs: 3000,
  countAutoTrades: true,
  countAutoRisk: true,
  riskPerUnit: 0,
  reloadOnTamper: true,
  blockSiteWhenLocked: false,
  enforcementMode: 'warning', // 'warning' (Mode A) | 'order_restrict' (Mode B) | 'full_site' (Mode C) | 'chart_only' (Mode D)
  fullSiteAcknowledged: false,
  blockedHosts: [
    'kite.zerodha.com', 'upstox.com', 'web.angelone.in', 'angelone.in',
    'web.dhan.co', 'dhan.co', 'trade.5paisa.com', 'www.5paisa.com',
    'trade.fyers.in', 'fyers.in',
    'groww.in', 'trade.groww.in',
    'web.sahi.com', 'sahi.com',
    'shoonya.finvasia.com', 'shoonya.com', 'finvasia.com',
    'kotakneo.com', 'trade.kotaksecurities.com', 'kotaksecurities.com',
    'paytmmoney.com', 'icicidirect.com', 'breeze.icicidirect.com',
    'hdfcsky.com', 'aliceblueonline.com', 'ant.aliceblueonline.com',
    'sharekhan.com', 'myespresso.com', 'motilaloswal.com'
  ]
};

// ------------------------------------------------------------- helpers ----

function getSettings() {
  return chrome.storage.local.get(['tlSettings', 'tlLicense']).then(function (res) {
    return TLRules.effectiveSettings(res.tlSettings, res.tlLicense, Date.now());
  });
}

function getState() {
  return chrome.storage.local.get('tlState').then(function (res) { return res.tlState || null; });
}

var opQueue = Promise.resolve();
function enqueueOp(fn) {
  var p = opQueue.then(fn, fn);
  opQueue = p.catch(function () {});
  return p;
}

// --------------------------------------------------------------- badge ----

function lockBadgeImage() {
  var c = new OffscreenCanvas(128, 128);
  var x = c.getContext('2d');
  x.fillStyle = '#e5484d';
  x.beginPath();
  if (x.roundRect) x.roundRect(0, 0, 128, 128, 28); else x.rect(0, 0, 128, 128);
  x.fill();
  x.strokeStyle = '#ffffff';
  x.lineWidth = 9;
  x.lineCap = 'round';
  x.beginPath();
  x.arc(64, 52, 20, Math.PI, 0);           // shackle
  x.stroke();
  x.fillStyle = '#ffffff';
  if (x.roundRect) { x.beginPath(); x.roundRect(34, 54, 60, 46, 10); x.fill(); }
  else x.fillRect(34, 54, 60, 46);
  return c;
}

function setBadge(active) {
  try {
    chrome.action.setBadgeBackgroundColor({ color: active ? '#e5484d' : '#00000000' });
    if (active) {
      chrome.action.setBadgeText({ text: '\u{1F512}' });
      try { chrome.action.setBadgeImage({ imageData: lockBadgeImage() }); } catch (e) {}
    } else {
      chrome.action.setBadgeText({ text: '' });
    }
  } catch (e) {}
}

// -------------------------------------------------------------- alarms ----

function armAlarms(state) {
  return Promise.all([
    chrome.alarms.clear(RELEASE_ALARM),
    chrome.alarms.clear(TICK_ALARM)
  ]).then(function () {
    return chrome.alarms.create(TICK_ALARM, { periodInMinutes: 1 });
  }).then(function () {
    if (state && state.lock && state.lock.active && state.lock.until > Date.now()) {
      return chrome.alarms.create(RELEASE_ALARM, { when: state.lock.until });
    }
    return null;
  });
}

// --------------------------------------------------- declarativeNetRequest ----

function syncBlockRules(state, settings) {
  var fullSiteMode = settings && (settings.enforcementMode === 'full_site' && settings.fullSiteAcknowledged);
  // Legacy blockSiteWhenLocked must never bypass the explicit Mode C acknowledgement.
  var on = Boolean(fullSiteMode && (state && state.lock && state.lock.active));
  var hosts = (settings.blockedHosts || []).filter(Boolean);
  var removeRuleIds = [BLOCK_RULE_ID, BLOCK_RULE_ID + 1];

  var addRules = [];
  if (on && hosts.length) {
    // Top-level main_frame redirect only using valid Chrome DNR extensionPath syntax
    addRules.push({
      id: BLOCK_RULE_ID,
      priority: 100,
      action: { type: 'redirect', redirect: { extensionPath: '/content/lock.html' } },
      condition: {
        requestDomains: hosts,
        resourceTypes: ['main_frame']
      }
    });
  }

  return chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: removeRuleIds, addRules: addRules })
    .then(function () {
      return chrome.storage.local.set({
        tlEnforcement: {
          status: on ? 'ACTIVE' : 'IDLE',
          ruleId: BLOCK_RULE_ID,
          activeRuleCount: addRules.length,
          lastSync: Date.now(),
          error: null
        }
      });
    })
    .catch(function (e) {
      console.warn('[Trade Lock] DNR sync failed', e);
      return chrome.storage.local.set({
        tlEnforcement: {
          status: 'ENFORCEMENT_UNAVAILABLE',
          ruleId: BLOCK_RULE_ID,
          activeRuleCount: 0,
          lastSync: Date.now(),
          error: e && e.message ? e.message : String(e)
        }
      });
    });
}


// ------------------------------------------------------- market intel ----

function marketUrl(settings) {
  var base = String(settings.licenseApiBase || 'https://trade-lock-app.netlify.app').replace(/\/+$/, '');
  var symbol = settings.marketSymbol || 'NIFTY';
  if (settings.marketSource === 'live') {
    var fyersSymbol = symbol === 'NIFTY' ? 'NSE:NIFTY50-INDEX' : 'NSE:' + symbol + '-INDEX';
    return base + '/api/market/live?symbol=' + encodeURIComponent(fyersSymbol);
  }
  return base + '/api/market/demo?symbol=' + encodeURIComponent(symbol);
}

/** Fetch a market snapshot and cache it for the HUD/popup (tlMarket). */
function fetchMarket() {
  return getSettings().then(function (settings) {
    if (settings.marketEnabled === false) return null;
    return chrome.storage.local.get('tlLicense').then(function (licRes) {
      var lic = licRes.tlLicense;
      var headers = {};
      if (settings.marketSource === 'live' && lic && lic.key && TLRules.isProPlus(lic, Date.now())) {
        headers.Authorization = 'Bearer ' + lic.key;
      }
      return fetch(marketUrl(settings), { headers: headers });
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.analysis) return null;
        var snap = { fetchedAt: Date.now(), source: settings.marketSource || 'demo',
                     symbol: settings.marketSymbol || 'NIFTY', analysis: data.analysis, brief: data.brief || null };
        return chrome.storage.local.set({ tlMarket: snap }).then(function () { return snap; });
      })
      .catch(function () { return null; }); // server offline: HUD just shows no market line
  });
}

// ------------------------------------------------------------- refresh ----

var cachedBlockedHosts = DEFAULT_SETTINGS.blockedHosts.slice();

function isBrokerUrl(url) {
  if (!url) return false;
  try {
    var host = new URL(url).hostname.toLowerCase();
    var hosts = cachedBlockedHosts || DEFAULT_SETTINGS.blockedHosts || [];
    return hosts.some(function (b) {
      return host === b || host.endsWith('.' + b);
    });
  } catch (e) {
    return false;
  }
}

function enforceLockOnBrokerTabs() {
  return getState().then(function (state) {
    if (!state || !state.lock || !state.lock.active || state.lock.until <= Date.now()) return;
    return chrome.tabs.query({}).then(function (tabs) {
      return Promise.all(tabs.map(function (tab) {
        if (!tab.url || !isBrokerUrl(tab.url)) return Promise.resolve();
        return chrome.tabs.sendMessage(tab.id, { type: 'TL_ENFORCE_LOCK', state: state }).catch(function () {
          if (chrome.scripting && chrome.scripting.executeScript) {
            return chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: ['lib/rules.js', 'lib/detector.js', 'lib/market.js', 'content/lock.js']
            }).catch(function () {});
          }
        });
      }));
    });
  });
}

function refresh() {
  return Promise.all([getState(), getSettings()]).then(function (r) {
    var state = r[0], settings = r[1];
    if (settings && settings.blockedHosts && settings.blockedHosts.length) {
      cachedBlockedHosts = settings.blockedHosts;
    }
    var active = !!(state && state.lock && state.lock.active && state.lock.until > Date.now());
    setBadge(active);
    fetchMarket();
    if (active) enforceLockOnBrokerTabs();
    return Promise.all([armAlarms(state), syncBlockRules(state, settings)]).then(function () {
      return { active: active, state: state, settings: settings };
    });
  });
}

function notifyTabs(type, payload) {
  return chrome.tabs.query({}).then(function (tabs) {
    return Promise.all(tabs.map(function (t) {
      return chrome.tabs.sendMessage(t.id, Object.assign({ type: type }, payload || {}))
        .catch(function () { return null; });
    }));
  });
}

function releaseIfDue() {
  return enqueueOp(function () {
    return Promise.all([getState(), getSettings()]).then(function (r) {
      var state = r[0], settings = r[1];
      if (!state || !state.lock || !state.lock.active) return refresh();
      var now = Date.now();
      var until = Number(state.lock.until);

      // Safeguard against missing, malformed, or invalid unlock timestamps.
      // An active lock must NEVER be released simply because 'until' is missing, NaN, <= 0, or invalid!
      if (isNaN(until) || until <= 0) {
        console.warn('[Trade Lock Security] Active lock has invalid until timestamp. Repairing until market open.');
        var repairedUntil = (typeof TLRules !== 'undefined' && TLRules.nextMarketOpen)
          ? TLRules.nextMarketOpen(now, settings)
          : (now + 18 * 3600 * 1000);
        state.lock.until = repairedUntil;
        return chrome.storage.local.set({ tlState: state, tlSavedAt: now }).then(refresh);
      }

      // Only release if the configured unlock condition is actually satisfied!
      if (now < until) return refresh();

      // Authoritative background release transition
      state.lock = { active: false, reason: null, since: null, until: null, manual: false, mode: (settings && settings.enforcementMode) || 'warning' };
      state.status = 'NORMAL';
      state.statusReason = null;
      return chrome.storage.local.set({ tlState: state, tlSavedAt: now })
        .then(function () {
          return notifyTabs('TL_RELEASED', { state: state, released: true });
        })
        .then(refresh);
    });
  });
}

// --------------------------------------------------------- state guard ----

function latestManualRelease(state) {
  var audit = state && Array.isArray(state.audit) ? state.audit : [];
  for (var i = audit.length - 1; i >= 0; i--) {
    if (audit[i] && audit[i].action === 'MANUAL_LOCK_RELEASED' && Number(audit[i].releasedAt) > 0) {
      return audit[i];
    }
  }
  return null;
}

function isNewManualRelease(oldState, newState) {
  if (!oldState || !oldState.lock || !oldState.lock.manual) return false;
  var since = Number(oldState.lock.since);
  var previous = latestManualRelease(oldState);
  var current = latestManualRelease(newState);
  if (!current || !(since > 0) || Number(current.releasedAt) < since) return false;
  return !previous || Number(current.releasedAt) > Number(previous.releasedAt) ||
    (newState.audit || []).length > (oldState.audit || []).length;
}

function stateSignature(state) {
  try { return JSON.stringify(state || null); } catch (e) { return ''; }
}

var expectedRepairSignature = null;

// Broker tabs and extension pages share one storage object. A stale tab must
// not erase an unexpired lock or resurrect a focus lock already released by
// the authoritative background transition.
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'local' || !changes || !changes.tlState) return;
  var oldState = changes.tlState.oldValue || null;
  var newState = changes.tlState.newValue || null;
  var newSignature = stateSignature(newState);
  if (expectedRepairSignature && newSignature === expectedRepairSignature) {
    expectedRepairSignature = null;
    return;
  }

  var oldActive = !!(oldState && oldState.lock && oldState.lock.active);
  var newActive = !!(newState && newState.lock && newState.lock.active);
  var now = Date.now();
  var repair = null;

  if (oldActive && !newActive) {
    var oldUntil = Number(oldState.lock.until);
    var legitimatelyExpired = Number.isFinite(oldUntil) && oldUntil > 0 && oldUntil <= now;
    if (!legitimatelyExpired && !isNewManualRelease(oldState, newState)) {
      repair = (newState && typeof newState === 'object') ? newState : oldState;
      if (!repair || typeof repair !== 'object') return;
      repair.lock = oldState.lock;
      repair.status = oldState.status;
      repair.statusReason = oldState.statusReason;
      repair.statusTimestamp = oldState.statusTimestamp;
      repair.pendingLock = oldState.pendingLock;
    }
  } else if (!oldActive && newActive && newState && newState.lock) {
    var newUntil = Number(newState.lock.until);
    var release = latestManualRelease(oldState);
    var staleManual = !!(release && newState.lock.manual &&
      Number(newState.lock.since) <= Number(release.releasedAt));
    if ((Number.isFinite(newUntil) && newUntil <= now) || staleManual) {
      repair = newState;
      if (oldState) {
        repair.lock = oldState.lock;
        repair.status = oldState.status;
        repair.statusReason = oldState.statusReason;
        repair.statusTimestamp = oldState.statusTimestamp;
        repair.pendingLock = oldState.pendingLock;
      } else {
        repair.lock = { active: false, reason: null, since: null, until: null, manual: false };
        repair.status = 'NORMAL';
        repair.statusReason = null;
      }
    }
  }
  if (!repair) {
    // Direct writes from an extension page still need immediate badge, alarm,
    // and DNR synchronization even if their separate runtime message was lost.
    if (oldActive !== newActive) {
      enqueueOp(refresh).catch(function (e) { console.warn('[Trade Lock] Lock-state refresh failed', e); });
    }
    return;
  }

  enqueueOp(function () {
    return getState().then(function (current) {
      // A newer transition already superseded this storage event.
      if (stateSignature(current) !== newSignature) return null;
      expectedRepairSignature = stateSignature(repair);
      return chrome.storage.local.set({ tlState: repair, tlSavedAt: Date.now() }).then(refresh);
    });
  }).catch(function (e) { console.warn('[Trade Lock Security] Could not repair lock state', e); });
});

// ---------------------------------------------------------------- init ----

chrome.runtime.onInstalled.addListener(function (details) {
  if (details.reason !== 'install') { refresh(); return; }
  chrome.storage.local.get(['tlSettings', 'tlState']).then(function (res) {
    var patch = {};
    if (!res.tlSettings) patch.tlSettings = Object.assign({}, DEFAULT_SETTINGS);
    if (!res.tlState) {
      patch.tlState = {
        version: 1,
        session: { start: Date.now(), date: '', trades: 0, autoTrades: 0, pnl: 0, riskUsed: 0,
                   consecutiveLosses: 0, maxTradeRisk: 0, lastTradeAt: null },
        lock: { active: false, reason: null, since: null, until: null, manual: false },
        detectorSeen: {}, log: [], tamperCount: 0
      };
    }
    if (Object.keys(patch).length) return chrome.storage.local.set(patch);
  }).then(refresh);
});

chrome.runtime.onStartup.addListener(refresh);

chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm.name === RELEASE_ALARM) releaseIfDue();
  else if (alarm.name === TICK_ALARM) releaseIfDue();
});

chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
  if (tab && tab.url && isBrokerUrl(tab.url)) {
    getState().then(function (state) {
      if (state && state.lock && state.lock.active && state.lock.until > Date.now()) {
        enforceLockOnBrokerTabs();
      }
    });
  }
});

chrome.tabs.onActivated.addListener(function (activeInfo) {
  chrome.tabs.get(activeInfo.tabId).then(function (tab) {
    if (tab && tab.url && isBrokerUrl(tab.url)) {
      getState().then(function (state) {
        if (state && state.lock && state.lock.active && state.lock.until > Date.now()) {
          enforceLockOnBrokerTabs();
        }
      });
    }
  }).catch(function () {});
});

// ------------------------------------------------------------ messages ----

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'TL_STATE') {
    // Content script pushed fresh counters. Keep badge/alarm/block in sync.
    refresh().then(function (r) { sendResponse({ ok: true, locked: r.active }); });
    return true;
  }
  if (msg.type === 'TL_LOCK_NOW') {
    enqueueOp(function () {
      return getSettings().then(function (settings) {
        return getState().then(function (st) {
          var state = st || {
            version: 1,
            session: { start: Date.now(), date: '', trades: 0, autoTrades: 0, pnl: 0, riskUsed: 0,
                       consecutiveLosses: 0, maxTradeRisk: 0, lastTradeAt: null },
            lock: { active: false, reason: null, since: null, until: null, manual: false },
            detectorSeen: {}, log: [], tamperCount: 0
          };
          if (state.lock && state.lock.active && !state.lock.manual) {
            sendResponse({ ok: false, error: 'RULE_LOCK_PROTECTED',
              message: 'An automatic rule lock is already active and cannot be converted to a manual focus lock.',
              state: state });
            return;
          }
          if (typeof TLRules !== 'undefined' && TLRules.lockNow) {
            TLRules.lockNow(state, settings, Date.now());
          } else {
            var until = (typeof TLRules !== 'undefined' && TLRules.nextMarketOpen)
              ? TLRules.nextMarketOpen(Date.now(), settings)
              : (Date.now() + 18 * 3600 * 1000);
            state.lock = { active: true, reason: 'Manual lock', since: Date.now(), until: until, manual: true };
            state.status = 'LOCKED';
            state.statusTimestamp = Date.now();
            state.statusReason = 'Manual lock';
          }
          return chrome.storage.local.set({ tlState: state, tlSavedAt: Date.now() }).then(function () {
            return refresh().then(function () {
              enforceLockOnBrokerTabs();
              sendResponse({ ok: true, state: state });
            });
          });
        });
      });
    });
    return true;
  }
  if (msg.type === 'TL_RELEASE_MANUAL') {
    if (sender && sender.id && sender.id !== chrome.runtime.id) {
      sendResponse({ success: false, error: 'UNAUTHORIZED_SENDER', message: 'Unauthorized message sender context.' });
      return;
    }
    var isTabSender = !!(sender && sender.tab);
    var isWebUrl = !!(sender && sender.url && !sender.url.startsWith('chrome-extension://'));
    if (isTabSender || isWebUrl) {
      sendResponse({ success: false, error: 'UNAUTHORIZED_SENDER', message: 'Unauthorized message sender context. Manual release must originate from the extension popup.' });
      return;
    }
    if (!msg.confirmed) {
      sendResponse({ success: false, error: 'CONFIRMATION_REQUIRED', message: 'Manual release requires explicit user confirmation.' });
      return;
    }
    enqueueOp(function () {
      return getState().then(function (state) {
        if (!state || !state.lock || !state.lock.active) {
          sendResponse({ success: false, reason: 'NO_ACTIVE_LOCK' });
          return;
        }
        if (!state.lock.manual) {
          sendResponse({
            success: false,
            error: 'RULE_LOCK_PROTECTED',
            message: 'Rule-triggered locks cannot be released manually.'
          });
          return;
        }
        state.lock = { active: false, reason: null, since: null, until: null, manual: false };
        state.status = 'NORMAL';
        state.statusReason = null;
        state.audit = (state.audit || []).concat([{
          action: 'MANUAL_LOCK_RELEASED',
          releasedAt: Date.now(),
          source: (sender && sender.url) || 'extension'
        }]).slice(-50);
        return chrome.storage.local.set({ tlState: state, tlSavedAt: Date.now() }).then(function () {
          return refresh().then(function () {
            return notifyTabs('TL_RELEASED', { state: state, released: true }).then(function () {
              sendResponse({ success: true, message: 'Focus lock released.' });
            });
          });
        });
      });
    });
    return true;
  }
  if (msg.type === 'TL_EMERGENCY_OVERRIDE') {
    sendResponse({
      success: false,
      error: 'FORBIDDEN_OPERATION',
      message: 'Emergency override is strictly disabled in production builds. Active rule locks cannot be bypassed.'
    });
    return true;
  }
  if (msg.type === 'TL_ENSURE_LOCKED') {
    if (msg.tabId && chrome.scripting && chrome.scripting.executeScript) {
      chrome.scripting.executeScript({
        target: { tabId: msg.tabId },
        files: ['lib/rules.js', 'lib/detector.js', 'lib/market.js', 'content/lock.js']
      }).then(getState).then(function (state) {
        // Recovery reapplies authoritative state; it must never create a lock
        // merely because the popup could not reach an existing content script.
        return chrome.tabs.sendMessage(msg.tabId, { type: 'TL_ENFORCE_LOCK', state: state })
          .catch(function () {}).then(function () { sendResponse({ ok: true }); });
      }).catch(function () { sendResponse({ ok: false }); });
      return true;
    }
    sendResponse({ ok: false });
    return true;
  }
  if (msg.type === 'TL_OPEN_SIDE_PANEL') {
    var requestedTab = msg.tab || 'overview';
    var targetUrl = chrome.runtime.getURL('options/options.html#' + requestedTab);
    chrome.storage.local.set({ tlActiveTab: requestedTab }).catch(function () {});
    if (chrome.sidePanel && chrome.sidePanel.open) {
      chrome.windows.getCurrent().then(function (win) {
        if (!win || !win.id) throw new Error('No window');
        if (chrome.sidePanel.setOptions) {
          chrome.sidePanel.setOptions({
            windowId: win.id,
            path: 'options/options.html#' + requestedTab,
            enabled: true
          }).catch(function () {});
        }
        return chrome.sidePanel.open({ windowId: win.id });
      }).then(function () {
        try {
          chrome.runtime.sendMessage({ type: 'TL_SWITCH_TAB', tab: requestedTab }, function () {
            void chrome.runtime.lastError;
          });
        } catch (e) {}
        sendResponse({ ok: true, sidePanel: true, tab: requestedTab });
      }).catch(function () {
        if (chrome.tabs && chrome.tabs.create) {
          chrome.tabs.create({ url: targetUrl });
        } else {
          chrome.runtime.openOptionsPage();
        }
        sendResponse({ ok: true, fallback: true, tab: requestedTab });
      });
      return true;
    } else {
      if (chrome.tabs && chrome.tabs.create) {
        chrome.tabs.create({ url: targetUrl });
      } else {
        chrome.runtime.openOptionsPage();
      }
      sendResponse({ ok: true, fallback: true, tab: requestedTab });
      return true;
    }
  }
  if (msg.type === 'TL_OPEN_OPTIONS') {
    var targetUrl = chrome.runtime.getURL('options/options.html' + (msg.tab ? '#' + msg.tab : ''));
    if (chrome.tabs && chrome.tabs.query) {
      chrome.tabs.query({}, function (tabs) {
        var existing = (tabs || []).find(function (t) {
          return t.url && t.url.indexOf(chrome.runtime.getURL('options/options.html')) !== -1;
        });
        if (existing && existing.id) {
          chrome.tabs.update(existing.id, { active: true, url: targetUrl });
          if (existing.windowId && chrome.windows && chrome.windows.update) {
            chrome.windows.update(existing.windowId, { focused: true });
          }
        } else if (chrome.tabs.create) {
          chrome.tabs.create({ url: targetUrl });
        } else {
          chrome.runtime.openOptionsPage();
        }
      });
    } else if (chrome.tabs && chrome.tabs.create) {
      chrome.tabs.create({ url: targetUrl });
    } else {
      chrome.runtime.openOptionsPage();
    }
    return;
  }
  if (msg.type === 'TL_REFRESH') {
    refresh().then(function (r) { sendResponse({ ok: true, locked: r.active }); });
    return true;
  }
  if (msg.type === 'TL_SETTINGS_SAVED') {
    refresh().then(function (r) { sendResponse({ ok: true }); });
    return true;
  }
  if (msg.type === 'TL_CHECK_RELEASE') {
    releaseIfDue().then(function (r) {
      sendResponse({ ok: true, active: r ? r.active : false });
    });
    return true;
  }
});

// A safety net in case the SW was asleep when the lock expired.
setInterval(function () { releaseIfDue(); }, 60 * 1000);
refresh();
