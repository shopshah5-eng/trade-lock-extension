/*
 * Trade Lock — content script.
 *
 * Runs on every broker tab (top frame + iframes). Responsibilities:
 *   - keep today's counters in chrome.storage.local (shared with popup/options)
 *   - poll the order book / positions table and feed fills into the counters
 *   - evaluate the rules and raise the lock overlay the moment one trips
 *   - survive tampering (overlay removed, page reloaded, console edits)
 *
 * The overlay is an extension iframe loaded from lock.html. Page JavaScript
 * cannot reach into it, so `document.querySelector(...).remove()` from the
 * console takes out the frame element only — a MutationObserver puts it back
 * within a frame, and an optional auto-reload re-locks from scratch.
 */
(function () {
  'use strict';

  if (window.__TL_LOADED__) return;
  window.__TL_LOADED__ = true;

  var R = globalThis.TLRules;
  var D = globalThis.TLDetect;
  var MKT = globalThis.TLMarket;
  var marketSnap = null;
  var IS_TOP = window.top === window;

  var settings = Object.assign({}, R.DEFAULT_SETTINGS);
  var license = null;
  function eff(raw) { return R.effectiveSettings(raw, license, Date.now()); }
  var state = R.defaultState(Date.now());
  var iframe = null;
  var tamperAt = 0;
  var lastWrite = 0;
  var dirty = false;

  var LOCK_URL = chrome.runtime.getURL('content/lock.html');

  // ------------------------------------------------------------ storage ----

  function saveState() {
    var now = Date.now();
    dirty = true;
    if (now - lastWrite < 400) return;   // throttle; the flush below catches it
    lastWrite = now;
    dirty = false;
    try { chrome.storage.local.set({ tlState: state, tlSavedAt: now }); } catch (e) {}
    try { chrome.runtime.sendMessage({ type: 'TL_STATE', state: state }); } catch (e) {}
  }

  function flush() {
    if (!dirty) return;
    dirty = false; lastWrite = Date.now();
    try { chrome.storage.local.set({ tlState: state, tlSavedAt: Date.now() }); } catch (e) {}
  }
  setInterval(flush, 1000);
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', function () { if (document.hidden) flush(); });

  function load() {
    chrome.storage.local.get(['tlSettings', 'tlState', 'tlLicense', 'tlMarket'], function (res) {
      if (res && res.tlMarket) marketSnap = res.tlMarket;
      if (res && res.tlLicense) license = res.tlLicense;
      if (res && res.tlSettings) settings = eff(Object.assign({}, R.DEFAULT_SETTINGS, res.tlSettings));
      if (res && res.tlState) state = res.tlState;
      R.syncSession(state, settings, Date.now());
      loop();
      startDetector();
    });
  }

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local') return;
    if (changes.tlSettings) settings = eff(Object.assign({}, R.DEFAULT_SETTINGS, changes.tlSettings.newValue));
    if (changes.tlMarket) { marketSnap = changes.tlMarket.newValue; if (IS_TOP) renderHud(); }
    if (changes.tlLicense) { license = changes.tlLicense.newValue; chrome.storage.local.get('tlSettings', function (r2) { if (r2 && r2.tlSettings) settings = eff(Object.assign({}, R.DEFAULT_SETTINGS, r2.tlSettings)); loop(); }); }
    // Only adopt another tab's state if we are not the one currently writing.
    if (changes.tlState && Date.now() - lastWrite > 1500) state = changes.tlState.newValue;
    loop();
  });

  // -------------------------------------------------------------- lock ----

  var overlayEl = null;
  var subframeEl = null;

  // Safe mode by default: Chart Mode keeps charts active & emergency position exits clickable
  var isChartMode = true;

  function buildOverlay(violation) {
    if (overlayEl) { try { overlayEl.remove(); } catch (e) {} }

    var mode = (settings && settings.enforcementMode) || 'warning';
    var isVerifiedBroker = D && D.isVerifiedOrderRestrictionBroker ? D.isVerifiedOrderRestrictionBroker(location.hostname) : false;

    var modeBadgeText = '⚠️ DISCIPLINE WARNING';
    var modeBadgeBg = 'rgba(245,158,11,0.2)';
    var modeBadgeColor = '#fbbf24';
    var modeDesc = 'Page remains interactive. Discipline reminder active.';

    if (mode === 'warning') {
      modeBadgeText = '⚠️ DISCIPLINE WARNING';
      modeBadgeBg = 'rgba(245,158,11,0.2)';
      modeBadgeColor = '#fbbf24';
      modeDesc = 'Mode A: Page remains interactive. You can still place orders. This is a discipline reminder, not an enforced block.';
    } else if (mode === 'order_restrict') {
      if (isVerifiedBroker) {
        modeBadgeText = '🛡️ ORDER RESTRICTION ACTIVE';
        modeBadgeBg = 'rgba(59,130,246,0.2)';
        modeBadgeColor = '#60a5fa';
        modeDesc = 'Mode B: New orders intercepted on verified broker. Position exits (Square off / Exit / Cancel) remain accessible.';
      } else {
        modeBadgeText = '⚠️ ENFORCEMENT UNAVAILABLE';
        modeBadgeBg = 'rgba(245,158,11,0.2)';
        modeBadgeColor = '#fbbf24';
        modeDesc = 'Broker adapter unverified for ' + location.hostname + '. Operating in Warning mode. Orders not blocked.';
      }
    } else if (mode === 'full_site') {
      modeBadgeText = '🔒 FULL TRADING-SITE RESTRICTION';
      modeBadgeBg = 'rgba(239,68,68,0.2)';
      modeBadgeColor = '#f87171';
      modeDesc = 'Mode C: Whole broker site restricted. Warning: Managing open positions may be blocked.';
    } else if (mode === 'chart_only') {
      modeBadgeText = '📊 CHART RESTRICTION ACTIVE';
      modeBadgeBg = 'rgba(168,85,247,0.2)';
      modeBadgeColor = '#c084fc';
      modeDesc = 'Mode D: Charting sites restricted. Broker order entry elsewhere is not blocked.';
    }

    var root = document.createElement('div');
    root.setAttribute('id', 'tl-lock-root');
    root.setAttribute('aria-label', isChartMode ? 'Trade Lock Chart Mode' : 'Trading screen locked');

    if (isChartMode) {
      root.style.cssText = [
        'position: fixed !important',
        'top: 0 !important',
        'left: 0 !important',
        'right: 0 !important',
        'height: 52px !important',
        'z-index: 2147483647 !important',
        'background: rgba(13, 17, 23, 0.96) !important',
        'backdrop-filter: blur(12px) !important',
        '-webkit-backdrop-filter: blur(12px) !important',
        'border-bottom: 2px solid ' + (mode === 'warning' ? '#f59e0b' : '#ff4d4f') + ' !important',
        'box-shadow: 0 4px 20px rgba(0,0,0,0.7) !important',
        'display: flex !important',
        'align-items: center !important',
        'justify-content: space-between !important',
        'padding: 0 20px !important',
        'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important',
        'color: #e6edf3 !important',
        'font-size: 13px !important',
        'user-select: none !important',
        'box-sizing: border-box !important'
      ].join(';') + ';';

      root.innerHTML = [
        '<div style="display:flex;align-items:center;gap:12px">',
          '<span style="background:' + modeBadgeBg + ';color:' + modeBadgeColor + ';padding:4px 8px;border-radius:6px;font-weight:700;font-size:11px;letter-spacing:0.06em">' + modeBadgeText + '</span>',
          '<span id="tl-overlay-title" style="color:#f0f6fc;font-weight:600">Trading limit hit</span>',
          '<span style="color:#6e7681">|</span>',
          '<span style="color:#c9d1d9;font-size:12px;font-weight:500">' + modeDesc + '</span>',
        '</div>',
        '<div style="display:flex;align-items:center;gap:16px">',
          '<span style="color:#8b949e;font-size:12px">Unlocks at 09:15 IST</span>',
          '<span id="tl-overlay-timer" style="font-family:monospace;font-size:14px;font-weight:700;color:#58a6ff">--:--:--</span>',
          '<button id="tl-btn-fullmode" style="background:#21262d;color:#c9d1d9;border:1px solid #30363d;padding:6px 12px;border-radius:6px;font-size:12px;cursor:pointer;font-weight:600">View Card</button>',
        '</div>'
      ].join('');
    } else {
      root.style.cssText = [
        'position: fixed !important',
        'inset: 0 !important',
        'width: 100vw !important',
        'height: 100vh !important',
        'z-index: 2147483647 !important',
        'background: #07090f !important',
        'color: #e8ecf5 !important',
        'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif !important',
        'display: flex !important',
        'align-items: center !important',
        'justify-content: center !important',
        'padding: 24px !important',
        'box-sizing: border-box !important',
        'user-select: none !important',
        '-webkit-user-select: none !important',
        'pointer-events: auto !important',
        'overflow: hidden !important'
      ].join(';') + ';';

      root.innerHTML = [
        '<div style="width:min(640px, 100%); text-align:center; padding:36px 30px 24px; border-radius:24px; background:linear-gradient(180deg, rgba(255,255,255,.07), rgba(255,255,255,.02)); border:1px solid rgba(255,255,255,.12); box-shadow:0 40px 120px rgba(0,0,0,.85), inset 0 1px 0 rgba(255,255,255,.08); box-sizing:border-box;">',
          '<div style="width:96px; height:96px; margin:0 auto 16px; position:relative; display:grid; place-items:center;">',
            '<div style="position:absolute; inset:0; border-radius:50%; background:conic-gradient(from 0deg, #ff4d4f, #ff9a3d, #ff4d4f); filter:blur(16px); opacity:.65;"></div>',
            '<div style="position:absolute; inset:6px; border-radius:50%; background:#0b0f18; border:1px solid rgba(255,255,255,.14); display:grid; place-items:center;">',
              '<svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#ff5c5c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">',
                '<rect x="3" y="11" width="18" height="11" rx="2" ry="2" fill="rgba(255,92,92,0.18)"></rect>',
                '<path d="M7 11V7a5 5 0 0 1 10 0v4"></path>',
                '<circle cx="12" cy="16" r="1.5" fill="#ff5c5c"></circle>',
              '</svg>',
            '</div>',
          '</div>',
          '<div style="font-size:11px; letter-spacing:.18em; text-transform:uppercase; color:' + modeBadgeColor + '; font-weight:800; margin-bottom:8px;">' + modeBadgeText + '</div>',
          '<h1 id="tl-overlay-title" style="margin:0 0 8px; font-size:clamp(22px, 3.8vw, 30px); font-weight:800; color:#ffffff; letter-spacing:-.02em;">You hit your limit</h1>',
          '<p id="tl-overlay-detail" style="margin:0 auto 20px; max-width:480px; color:#a9b3c6; font-size:14px; line-height:1.5;">One of your trading discipline rules for today was reached.</p>',
          '<div id="tl-overlay-timer" style="font-size:clamp(34px, 6vw, 48px); font-weight:800; letter-spacing:-.03em; margin:0 0 4px; font-variant-numeric:tabular-nums; background:linear-gradient(180deg, #ffffff, #c2cbe0); -webkit-background-clip:text; -webkit-text-fill-color:transparent;">--:--:--</div>',
          '<p id="tl-overlay-until" style="color:#8c97ad; font-size:12px; margin:0 0 20px;">unlocks at next market open (09:15 IST)</p>',
          '<div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:10px; margin-bottom:18px;">',
            '<div style="background:rgba(255,255,255,.04); border:1px solid rgba(255,255,255,.08); border-radius:12px; padding:10px 8px;">',
              '<div style="font-size:10px; letter-spacing:.12em; text-transform:uppercase; color:#7f8aa1; margin-bottom:4px;">Trades Today</div>',
              '<div id="tl-overlay-trades" style="font-size:16px; font-weight:700; color:#ffffff;">0 / 5</div>',
            '</div>',
            '<div style="background:rgba(255,255,255,.04); border:1px solid rgba(255,255,255,.08); border-radius:12px; padding:10px 8px;">',
              '<div style="font-size:10px; letter-spacing:.12em; text-transform:uppercase; color:#7f8aa1; margin-bottom:4px;">Realised P&L</div>',
              '<div id="tl-overlay-pnl" style="font-size:16px; font-weight:700; color:#ffffff;">₹0.00</div>',
            '</div>',
            '<div style="background:rgba(255,255,255,.04); border:1px solid rgba(255,255,255,.08); border-radius:12px; padding:10px 8px;">',
              '<div style="font-size:10px; letter-spacing:.12em; text-transform:uppercase; color:#7f8aa1; margin-bottom:4px;">Risk Used</div>',
              '<div id="tl-overlay-risk" style="font-size:16px; font-weight:700; color:#ffffff;">₹0.00</div>',
            '</div>',
          '</div>',
          '<div style="display:flex; justify-content:center; gap:10px; margin-bottom:18px;">',
            '<button id="tl-btn-chartmode" style="background:#238636; color:#ffffff; border:none; padding:10px 18px; border-radius:8px; font-weight:600; font-size:13px; cursor:pointer; display:flex; align-items:center; gap:6px;">📈 Switch to Top Banner</button>',
          '</div>',
          '<div style="font-size:11.5px; color:#8c97ad; line-height:1.45; border-top:1px solid rgba(255,255,255,.08); padding-top:14px;">',
            '<b>Enforcement Policy:</b> ' + modeDesc + '<br>',
            '<span style="color:#6e7681">Browser enforcement applies inside Chrome on this device. External mobile trading apps are not restricted.</span>',
          '</div>',
        '</div>'
      ].join('');
    }

    var parent = document.documentElement || document.body;
    if (parent) parent.appendChild(root);
    overlayEl = root;

    // Attach Chart Mode toggles
    var btnChart = root.querySelector('#tl-btn-chartmode');
    if (btnChart) {
      btnChart.addEventListener('click', function(e) {
        e.stopPropagation();
        isChartMode = true;
        buildOverlay(violation);
      });
    }
    var btnFull = root.querySelector('#tl-btn-fullmode');
    if (btnFull) {
      btnFull.addEventListener('click', function(e) {
        e.stopPropagation();
        isChartMode = false;
        buildOverlay(violation);
      });
    }

    updateOverlay(violation);
  }

  function updateOverlay(violation) {
    if (!overlayEl) return;
    var copy = lockCopy(violation || (state.lock.manual ? null : R.evaluate(state, settings)));
    var titleEl = overlayEl.querySelector('#tl-overlay-title');
    var detailEl = overlayEl.querySelector('#tl-overlay-detail');
    var timerEl = overlayEl.querySelector('#tl-overlay-timer');
    var untilEl = overlayEl.querySelector('#tl-overlay-until');
    var tradesEl = overlayEl.querySelector('#tl-overlay-trades');
    var pnlEl = overlayEl.querySelector('#tl-overlay-pnl');
    var riskEl = overlayEl.querySelector('#tl-overlay-risk');

    if (titleEl) titleEl.textContent = state.lock.manual ? 'Self-imposed lock' : copy.title;
    if (detailEl) detailEl.textContent = state.lock.manual ? 'You locked this screen yourself. It reopens at the next market open.' : copy.detail;
    if (timerEl && state.lock.until) timerEl.textContent = R.countdown(state.lock.until, Date.now());
    if (untilEl && state.lock.until) untilEl.textContent = 'unlocks ' + (R.istLabel(state.lock.until) || 'at the next market open');

    var sess = state.session || {};
    if (tradesEl) tradesEl.textContent = sess.trades + (settings.maxTradesPerDay ? ' / ' + settings.maxTradesPerDay : '');
    if (pnlEl) {
      pnlEl.textContent = R.inr(sess.pnl || 0);
      pnlEl.style.color = (sess.pnl > 0 ? '#37d39b' : (sess.pnl < 0 ? '#ff6b6b' : '#ffffff'));
    }
    if (riskEl) riskEl.textContent = R.inr(sess.riskUsed || 0);
  }

  function buildSubframeBlocker() {
    if (subframeEl && subframeEl.isConnected) return;
    var href = '';
    try { href = window.location.href || ''; } catch (e) {}
    // Never block charting or analysis frames
    if (/chart|tradingview|tv\.|graph/i.test(href) || isChartMode) return;

    var d = document.createElement('div');
    d.setAttribute('id', 'tl-lock-subframe');
    d.style.cssText = 'position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;background:#07090f!important;z-index:2147483647!important;pointer-events:auto!important;';
    var parent = document.documentElement || document.body;
    if (parent) parent.appendChild(d);
    subframeEl = d;
  }

  function removeOverlay() {
    if (overlayEl) {
      try { overlayEl.remove(); } catch (e) {}
      overlayEl = null;
    }
    if (subframeEl) {
      try { subframeEl.remove(); } catch (e) {}
      subframeEl = null;
    }
  }

  // Intercept new order actions only in Mode B (Verified New-Order Restriction) on verified adapters
  document.addEventListener('click', function (e) {
    if (!state.lock.active) return;
    var mode = (settings && settings.enforcementMode) || 'warning';
    // Mode A (Warning): Page remains interactive. Never intercepts order actions.
    if (mode === 'warning') return;

    // Mode B: Verified New-Order Restriction
    if (mode === 'order_restrict') {
      var isVerified = D && D.isVerifiedOrderRestrictionBroker ? D.isVerifiedOrderRestrictionBroker(location.hostname) : false;
      if (!isVerified) return; // Do not intercept if adapter not verified

      var target = e.target;
      if (!target) return;
      var btn = target.closest('button, a, input[type="submit"]');
      if (!btn) return;
      var text = (btn.textContent || btn.value || '').toLowerCase();
      var isEmergencyExit = /exit|close|square\s*off|cancel|cancel\s*all/i.test(text);
      if (isEmergencyExit) return; // Always allow emergency exits!

      var isNewOrder = /buy|sell|place\s*order|submit/i.test(text);
      if (isNewOrder) {
        e.preventDefault();
        e.stopPropagation();
        showToast('🛡️ Verified Order Restriction: New orders blocked. Position exits (Square off/Exit) remain accessible.');
      }
    }
  }, true);

  function onTamper() {
    state.tamperCount = (state.tamperCount || 0) + 1;
    tamperAt = Date.now();
    saveState();
    if (settings.reloadOnTamper !== false && Date.now() > (onTamper._last || 0) + 2000) {
      onTamper._last = Date.now();
      try { location.reload(); } catch (e) {}
    }
  }

  if (IS_TOP) {
    var mo = new MutationObserver(function (muts) {
      if (!state.lock.active) return;
      for (var i = 0; i < muts.length; i++) {
        var removed = muts[i].removedNodes;
        for (var j = 0; j < removed.length; j++) {
          if (removed[j] === overlayEl) { onTamper(); buildOverlay(); return; }
        }
      }
      if (overlayEl && !overlayEl.isConnected) { onTamper(); buildOverlay(); }
    });

    function watch() {
      try { mo.observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {}
    }
    if (document.documentElement) watch();
    else document.addEventListener('DOMContentLoaded', watch);
  }

  // Swallow interactions with the page underneath only during Mode C (Full Trading-Site Restriction)
  ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu', 'wheel', 'touchstart', 'keydown', 'keypress'].forEach(function (type) {
    document.addEventListener(type, function (e) {
      var mode = (settings && settings.enforcementMode) || 'warning';
      if (!state.lock.active || isChartMode || mode !== 'full_site') return;
      e.stopImmediatePropagation();
      e.preventDefault();
    }, true);
    window.addEventListener(type, function (e) {
      var mode = (settings && settings.enforcementMode) || 'warning';
      if (!state.lock.active || isChartMode || mode !== 'full_site') return;
      e.stopImmediatePropagation();
      e.preventDefault();
    }, true);
  });

  // --------------------------------------------------------------- hud ----

  var hud = null;

  function hudCss() {
    var s = document.createElement('style');
    s.textContent = [
      '#tl-hud{position:fixed;z-index:2147483646;bottom:18px;right:18px;width:246px;',
      'font:12px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;',
      'background:rgba(12,15,23,.94);color:#e8ecf5;border:1px solid rgba(255,255,255,.12);',
      'border-radius:14px;box-shadow:0 18px 44px rgba(0,0,0,.5);backdrop-filter:blur(8px);overflow:hidden}',
      '#tl-hud *{box-sizing:border-box}',
      '#tl-hud .h{display:flex;align-items:center;gap:6px;padding:8px 10px;cursor:move;',
      'background:rgba(255,255,255,.05);border-bottom:1px solid rgba(255,255,255,.08);',
      'font-weight:700;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#9aa5bb}',
      '#tl-hud .h .dot{width:7px;height:7px;border-radius:50%;background:#37d39b;margin-right:auto}',
      '#tl-hud .h.warn .dot{background:#ffb020}',
      '#tl-hud .b{padding:10px}',
      '#tl-hud .row{display:flex;justify-content:space-between;gap:8px;padding:3px 0;color:#a9b3c6}',
      '#tl-hud .row b{color:#e8ecf5;font-variant-numeric:tabular-nums;font-weight:600}',
      '#tl-hud .bar{height:4px;border-radius:99px;background:rgba(255,255,255,.1);margin:6px 0 8px;overflow:hidden}',
      '#tl-hud .bar>i{display:block;height:100%;background:linear-gradient(90deg,#37d39b,#ffb020,#ff4d4f)}',
      '#tl-hud .btns{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px}',
      '#tl-hud button{font:inherit;font-size:11.5px;font-weight:600;padding:7px 4px;border-radius:9px;',
      'border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.07);color:#e8ecf5;cursor:pointer}',
      '#tl-hud button:hover{background:rgba(255,255,255,.14)}',
      '#tl-hud button.win{border-color:rgba(55,211,155,.5);color:#7ff0c4}',
      '#tl-hud button.loss{border-color:rgba(255,107,107,.5);color:#ff9d9d}',
      '#tl-hud button.lock{grid-column:1/-1;border-color:rgba(255,107,107,.55);background:rgba(255,77,79,.16);color:#ffb3b3}',
      '#tl-hud .foot{display:flex;justify-content:space-between;gap:6px;margin-top:8px;font-size:10.5px;color:#7f8aa1}',
      '#tl-hud .foot a{color:#8ab4ff;text-decoration:none}',
      '#tl-hud.min .b{display:none}'
    ].join('');
    document.documentElement.appendChild(s);
  }

  function buildHud() {
    if (hud && hud.isConnected) return;
    hudCss();
    var el = document.createElement('div');
    el.setAttribute('id', 'tl-hud');   // attribute, so #tl-hud actually resolves
    el.innerHTML =
      '<div class="h"><span class="dot"></span><span>Trade Lock</span><span id="tl-min">\u2013</span></div>' +
      '<div class="b">' +
        '<div class="row"><span>Trades</span><b id="tl-trades">0</b></div>' +
        '<div class="bar"><i id="tl-bar1" style="width:0%"></i></div>' +
        '<div class="row"><span>Realised P&amp;L</span><b id="tl-pnl">\u20B90.00</b></div>' +
        '<div class="bar"><i id="tl-bar2" style="width:0%"></i></div>' +
        '<div class="row"><span>Risk used</span><b id="tl-risk">\u20B90.00</b></div>' +
        '<div id="tl-market" style="display:none;margin-top:7px;padding:7px 8px;border-radius:8px;font-size:11px;line-height:1.5;background:rgba(255,176,32,.10);border:1px solid rgba(255,176,32,.35);color:#ffd28a"></div>' +
        '<div class="btns">' +
          '<button class="win" id="tl-win" title="Log a winning trade">+ Win</button>' +
          '<button class="loss" id="tl-loss" title="Log a losing trade">\u2212 Loss</button>' +
          '<button id="tl-undo" title="Undo the last logged trade">Undo</button>' +
          '<button id="tl-open" title="Open options">Rules</button>' +
          '<button class="lock" id="tl-locknow">Lock screen now</button>' +
        '</div>' +
        '<div class="foot"><span id="tl-mode">manual</span><a href="#" id="tl-reset">reset day</a></div>' +
      '</div>';
    body().appendChild(el);
    hud = el;

    var saved = null;
    try { saved = JSON.parse(localStorage.getItem('tl-hud-pos') || 'null'); } catch (e) {}
    if (saved && isFinite(saved.x) && isFinite(saved.y)) {
      el.style.left = saved.x + 'px'; el.style.top = saved.y + 'px';
      el.style.right = 'auto'; el.style.bottom = 'auto';
    }

    el.querySelector('.h').addEventListener('mousedown', function (ev) {
      ev.preventDefault();
      var r = el.getBoundingClientRect();
      var ox = ev.clientX - r.left, oy = ev.clientY - r.top;
      function mv(e2) {
        el.style.left = Math.max(0, Math.min(window.innerWidth - 60, e2.clientX - ox)) + 'px';
        el.style.top = Math.max(0, Math.min(window.innerHeight - 30, e2.clientY - oy)) + 'px';
        el.style.right = 'auto'; el.style.bottom = 'auto';
      }
      function up() {
        document.removeEventListener('mousemove', mv);
        document.removeEventListener('mouseup', up);
        try {
          localStorage.setItem('tl-hud-pos', JSON.stringify({
            x: parseInt(el.style.left, 10), y: parseInt(el.style.top, 10)
          }));
        } catch (e) {}
      }
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
    });

    el.querySelector('#tl-min').addEventListener('click', function () { el.classList.toggle('min'); });
    el.querySelector('#tl-win').addEventListener('click', function () { quickLog(1); });
    el.querySelector('#tl-loss').addEventListener('click', function () { quickLog(-1); });
    el.querySelector('#tl-undo').addEventListener('click', function () {
      R.undoLastTrade(state); saveState(); loop();
    });
    el.querySelector('#tl-open').addEventListener('click', function () {
      chrome.runtime.sendMessage({ type: 'TL_OPEN_OPTIONS' });
    });
    el.querySelector('#tl-reset').addEventListener('click', function (e) {
      e.preventDefault();
      if (confirm('Reset today\u2019s Trade Lock counters? This also clears an active lock.')) {
        state = R.resetDay(state, settings, Date.now());
        saveState(); loop();
      }
    });
    el.querySelector('#tl-locknow').addEventListener('click', function () {
      R.lockNow(state, settings, Date.now()); saveState(); loop();
    });
  }

  var lastPnl = 0;

  function quickLog(sign) {
    // Suggest the last realised amount; fall back to the per-trade risk limit.
    var guess = lastPnl ? Math.abs(lastPnl) : (Number(settings.maxRiskPerTrade) || 1000);
    var v = prompt((sign > 0 ? 'Win' : 'Loss') + ' amount in \u20B9', String(guess));
    if (v === null) return;
    var amt = Math.abs(parseFloat(String(v).replace(/[^0-9.]/g, '')));
    if (!isFinite(amt) || amt <= 0) return;
    lastPnl = sign * amt;
    R.logTrade(state, settings, {
      pnl: sign * amt, risk: R.plannedRiskPerTrade ? R.plannedRiskPerTrade(settings) : 0, source: 'manual'
    }, Date.now());
    saveState(); loop();
  }

  function renderHud() {
    if (!hud || !hud.isConnected) return;
    var mEl = hud.querySelector('#tl-market');
    if (mEl) {
      var warns = (MKT && marketSnap && marketSnap.analysis)
        ? MKT.marketWarnings(marketSnap.analysis, state.session, settings) : [];
      if (warns.length) {
        mEl.style.display = 'block';
        mEl.textContent = (warns[0].level === 'danger' ? '\u{1F534} ' : warns[0].level === 'ok' ? '\u{1F7E2} ' : '\u{1F7E0} ') + warns[0].text;
      } else if (marketSnap && marketSnap.analysis && marketSnap.analysis.ok) {
        mEl.style.display = 'block';
        mEl.style.background = 'rgba(76,141,255,.10)';
        mEl.style.borderColor = 'rgba(76,141,255,.35)';
        mEl.style.color = '#b9d2ff';
        mEl.textContent = '\u{1F4CA} ' + (marketSnap.symbol || '') + ' ' + marketSnap.analysis.price +
          ' · ' + marketSnap.analysis.trend + ' · VWAP ' + marketSnap.analysis.vwap;
      } else {
        mEl.style.display = 'none';
      }
    }
    var sess = state.session, s = settings;
    hud.querySelector('.h').classList.toggle('warn', sess.trades >= (s.maxTradesPerDay || Infinity) * 0.8);
    hud.querySelector('#tl-trades').textContent = sess.trades + (s.maxTradesPerDay ? ' / ' + s.maxTradesPerDay : '');
    hud.querySelector('#tl-pnl').textContent = R.inr(sess.pnl);
    hud.querySelector('#tl-risk').textContent = R.inr(sess.riskUsed);
    hud.querySelector('#tl-bar1').style.width = Math.round(R.progress(sess.trades, s.maxTradesPerDay) * 100) + '%';
    hud.querySelector('#tl-bar2').style.width = Math.round(R.progress(Math.abs(sess.pnl), s.maxDailyLoss) * 100) + '%';
    hud.querySelector('#tl-mode').textContent = state.pendingLock
      ? '\u26a0 limit reached \u2014 locks when your open trade closes'
      : (s.autoDetect ? 'auto-detect on' : 'manual only') + ' \u00b7 ' + state.session.date +
        ((state.session.openTrades || 0) > 0 ? ' \u00b7 ' + state.session.openTrades + ' open' : '');
  }

  // ---------------------------------------------------------- detector ----

  var detectorTimer = null;

  function startDetector() {
    if (detectorTimer) clearInterval(detectorTimer);
    if (!settings.autoDetect) return;
    var every = Math.max(1000, Number(settings.detectIntervalMs) || 3000);
    detectorTimer = setInterval(detectOnce, every);
    detectOnce();
  }

  function detectOnce() {
    if (!settings.autoDetect || state.lock.active) return;
    if (document.hidden) return;
    var found;
    try {
      found = D.scan(document, { riskPerUnit: Number(settings.riskPerUnit) || 0 });
    } catch (e) { return; }

    var changed = false;
    var seen = state.detectorSeen || (state.detectorSeen = {});

    if (settings.countAutoTrades !== false) {
      (found.orders || []).forEach(function (o) {
        var sig = D.rowSig(o);
        if (seen[sig]) return;
        seen[sig] = true;
        changed = true;
        if (o.pnl) lastPnl = o.pnl;
        R.logTrade(state, settings, {
          symbol: o.symbol, side: o.side, qty: o.qty, pnl: o.pnl,
          risk: settings.countAutoRisk === false ? 0 : o.risk, source: 'auto'
        }, Date.now());
        state.session.autoTrades = (state.session.autoTrades || 0) + 1;
      });
    }

    // How many trades are still running? Positions rows with qty != 0, or a
    // net open quantity across today's fills. The lock waits for these.
    var hasPositions = !!(found.positions && found.positions.length);
    var hasOrders = !!(found.orders && found.orders.length);
    var positionsOpen = (found.positions || []).filter(function (p) { return Number(p.qty) !== 0; }).length;
    var netOpen = D.netOpenSymbols ? D.netOpenSymbols(found.orders || []) : 0;
    if (hasPositions) {
      if (positionsOpen !== (state.session.openTrades || 0)) {
        state.session.openTrades = positionsOpen;
        changed = true;
      }
    } else if (hasOrders) {
      if (netOpen !== (state.session.openTrades || 0)) {
        state.session.openTrades = netOpen;
        changed = true;
      }
    }

    // Open exposure: highest notional currently on the positions table.
    if (settings.countAutoRisk !== false && found.positions && found.positions.length) {
      var maxNotional = 0;
      found.positions.forEach(function (p) { maxNotional = Math.max(maxNotional, Math.abs(p.risk) || 0); });
      if (maxNotional && maxNotional !== state.session.openExposure) {
        state.session.openExposure = maxNotional;
        changed = true;
      }
    }

    if (changed) saveState();
    loop();
  }

  // -------------------------------------------------------------- loop ----

  function lockCopy(violation) {
    if (!violation) {
      return { title: 'Screen locked', detail: 'You locked this screen yourself. It reopens at the next market open.' };
    }
    return { title: violation.title, detail: violation.detail };
  }

  function loop() {
    var res = R.tick(state, settings, Date.now(), { openTrades: state.session.openTrades || 0 });
    state = res.state;
    if (res.changed) saveState();

    if (state.lock && state.lock.active && state.lock.until > Date.now()) {
      if (IS_TOP) {
        buildOverlay(res.violation);
      } else {
        buildSubframeBlocker();
      }
    } else {
      removeOverlay();
      if (IS_TOP) {
        buildHud();
        renderHud();
      }
    }
  }

  function postState(violation) {
    if (IS_TOP && state.lock && state.lock.active) {
      updateOverlay(violation);
    }
  }

  setInterval(function () {
    try {
      chrome.storage.local.get(['tlState', 'tlSettings', 'tlLicense', 'tlMarket'], function (res) {
        if (res && res.tlMarket) marketSnap = res.tlMarket;
        if (res && res.tlLicense) license = res.tlLicense;
        if (res && res.tlSettings) settings = eff(Object.assign({}, R.DEFAULT_SETTINGS, res.tlSettings));
        if (res && res.tlState) state = res.tlState;
        loop();
        if (state.lock && state.lock.active && IS_TOP) updateOverlay();
      });
    } catch (e) { loop(); }
  }, 500);

  // --------------------------------------------------------- messaging ----

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'TL_PING') {
      sendResponse({ ok: true, top: IS_TOP, host: location.hostname, locked: !!(state.lock && state.lock.active && state.lock.until > Date.now()) });
      return;
    }
    if (msg.type === 'TL_GET_STATE') {
      var res = R.tick(state, settings, Date.now(), { openTrades: state.session.openTrades || 0 });
      state = res.state;
      var v = res.violation || (state.lock.manual ? null : R.evaluate(state, settings));
      sendResponse({
        ok: true, state: state, settings: settings,
        violation: v, copy: lockCopy(v),
        untilLabel: state.lock.until ? R.istLabel(state.lock.until) : ''
      });
      return;
    }
    if (msg.type === 'TL_LOG') {
      R.logTrade(state, settings, {
        pnl: Number(msg.pnl) || 0, risk: Number(msg.risk) || 0,
        symbol: msg.symbol || '', source: 'popup'
      }, Date.now());
      saveState(); loop();
      sendResponse({ ok: true, state: state });
      return;
    }
    if (msg.type === 'TL_LOCK_NOW') {
      R.lockNow(state, settings, Date.now()); saveState(); loop();
      sendResponse({ ok: true, state: state });
      return;
    }
    if (msg.type === 'TL_RESET' || msg.type === 'TL_RELEASED') {
      state = R.resetDay(state, settings, Date.now()); saveState(); loop();
      sendResponse({ ok: true, state: state });
      return;
    }
    if (msg.type === 'TL_SETTINGS') {
      settings = eff(Object.assign({}, R.DEFAULT_SETTINGS, msg.settings || {}));
      startDetector(); loop();
      sendResponse({ ok: true });
      return;
    }
  });

  // The lock iframe asks its parent for fresh state.
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.tl !== 'getState') return;
    if (iframe && iframe.contentWindow) postState();
  });

  // --------------------------------------------------------------- go ----

  if (IS_TOP) {
    load();
  } else {
    // Iframes only need the lock frame and the input blocking.
    chrome.storage.local.get(['tlSettings', 'tlState', 'tlLicense', 'tlMarket'], function (res) {
      if (res && res.tlMarket) marketSnap = res.tlMarket;
      if (res && res.tlLicense) license = res.tlLicense;
      if (res && res.tlSettings) settings = eff(Object.assign({}, R.DEFAULT_SETTINGS, res.tlSettings));
      if (res && res.tlState) state = res.tlState;
      loop();
      setInterval(function () {
        chrome.storage.local.get(['tlState'], function (r2) {
          if (r2 && r2.tlState) { state = r2.tlState; loop(); }
        });
      }, 2000);
    });
  }
})();
