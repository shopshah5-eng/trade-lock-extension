/* Trade Lock — options and dashboard controller. */
(function () {
  'use strict';

  var R = globalThis.TLRules;
  var M = globalThis.TLMarket;
  var I = globalThis.TLInsights;

  var NUM = ['maxTradesPerDay', 'maxDailyLoss', 'profitTarget', 'maxConsecutiveLosses',
             'maxRiskPerTrade', 'maxDailyRisk', 'minLockMinutes', 'detectIntervalMs', 'riskPerUnit',
             'totalCapital', 'dailyRiskPercent', 'perTradeRiskPercent'];
  var BOOL = ['skipWeekends', 'skipHolidays', 'autoDetect', 'countAutoTrades',
              'countAutoRisk', 'reloadOnTamper', 'fullSiteAcknowledged'];

  var dirty = false;
  var currentState = null;
  var currentSettings = {};
  var currentLicense = null;
  var revalidateTried = false;
  var currentJournal = [];

  function el(id) { return document.getElementById(id); }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }

  function toggleFullSiteAckBox(mode) {
    var box = el('fullSiteAckBox');
    if (!box) return;
    box.style.display = mode === 'full_site' ? 'block' : 'none';
  }

  // ------------------------------------------------------------- tabs ----

  function switchTab(name) {
    if (!name) name = 'overview';
    var clean = name.replace(/^#/, '');
    if (clean === 'charts') clean = 'market';
    var btns = document.querySelectorAll('#mainTabs .tab-btn');
    var contents = document.querySelectorAll('.tab-content');
    var targetBtn = document.querySelector('#mainTabs .tab-btn[data-tab="' + clean + '"]');
    var targetContent = el('tab-' + clean);

    if (!targetContent) {
      clean = 'overview';
      targetBtn = document.querySelector('#mainTabs .tab-btn[data-tab="overview"]');
      targetContent = el('tab-overview');
    }

    btns.forEach(function (b) { b.classList.remove('active'); });
    contents.forEach(function (c) { c.classList.remove('active'); });

    if (targetBtn) targetBtn.classList.add('active');
    if (targetContent) targetContent.classList.add('active');

    if (clean === 'market') {
      renderMarketAndOiDashboard();
    } else if (clean === 'options') {
      renderOptionsChainView();
    }

    if (window.location.hash !== '#' + clean) {
      history.replaceState(null, '', '#' + clean);
    }
  }

  function initTabs() {
    var btns = document.querySelectorAll('#mainTabs .tab-btn');
    btns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        switchTab(btn.getAttribute('data-tab'));
      });
    });

    window.addEventListener('hashchange', function () {
      switchTab(window.location.hash);
    });

    // Listen for tab switch requests from background service worker (e.g. side panel open)
    if (chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener(function (msg) {
        if (msg && msg.type === 'TL_SWITCH_TAB' && msg.tab) {
          switchTab(msg.tab);
        }
      });
    }

    if (window.location.hash) {
      switchTab(window.location.hash);
    } else {
      chrome.storage.local.get(['tlActiveTab'], function (res) {
        if (res && res.tlActiveTab) {
          switchTab(res.tlActiveTab);
        }
      });
    }
  }

  // ------------------------------------------------------------- plan ----

  function updatePlanSummary() {
    var cap = parseFloat(el('totalCapital').value) || 0;
    var dPct = parseFloat(el('dailyRiskPercent').value) || 0;
    var tPct = parseFloat(el('perTradeRiskPercent').value) || 0;
    var box = el('planSummary');
    if (!box) return;
    if (cap > 0 && (dPct > 0 || tPct > 0)) {
      var day = R.dailyRiskLimit({ totalCapital: cap, dailyRiskPercent: dPct });
      var per = R.plannedRiskPerTrade({ totalCapital: cap, perTradeRiskPercent: tPct });
      box.innerHTML = 'On ' + R.inr(cap) + ' capital: daily risk budget <b>' + (day ? R.inr(day) : '—') +
        '</b> · planned risk per trade <b>' + (per ? R.inr(per) : '—') + '</b>. ' +
        'The screen locks when the day\'s used risk reaches the budget — but only after your open trade closes.';
    } else {
      box.textContent = 'Set capital and percentages to see your derived limits.';
    }
  }

  function markDirty() {
    dirty = true;
    if (el('dirtyNote')) el('dirtyNote').textContent = 'unsaved changes';
  }

  function minutesToHHMM(m) {
    m = Math.max(0, Math.min(1439, Math.round(Number(m) || 0)));
    return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  }
  function hhmmToMinutes(s) {
    var m = String(s || '').trim().match(/^(\d{1,2})[:.]?(\d{2})?$/);
    if (!m) return null;
    var h = parseInt(m[1], 10), mm = parseInt(m[2] || '0', 10);
    if (h > 23 || mm > 59) return null;
    return h * 60 + mm;
  }

  function parseLines(text) {
    return String(text || '').split(/[\n,]+/).map(function (s) { return s.trim(); }).filter(Boolean);
  }

  // ------------------------------------------------------------- render ----

  function fill(s) {
    NUM.forEach(function (k) {
      if (el(k)) el(k).value = (s[k] === null || s[k] === undefined) ? '' : s[k];
    });
    BOOL.forEach(function (k) {
      if (el(k)) el(k).checked = !!s[k];
    });
    if (el('enforcementMode')) el('enforcementMode').value = s.enforcementMode || 'warning';
    if (el('fullSiteAcknowledged')) el('fullSiteAcknowledged').checked = !!s.fullSiteAcknowledged;
    toggleFullSiteAckBox(s.enforcementMode || 'warning');
    if (el('marketOpen')) el('marketOpen').value = minutesToHHMM(s.marketOpenMin);
    if (el('marketSymbol') && s.marketSymbol) el('marketSymbol').value = s.marketSymbol;
    if (el('marketSource') && s.marketSource) el('marketSource').value = s.marketSource;
    if (el('planTradesMirror')) el('planTradesMirror').value = s.maxTradesPerDay || '';
    updatePlanSummary();
    if (el('holidays')) el('holidays').value = (s.holidays || []).join('\n');
    if (el('blockedHosts')) el('blockedHosts').value = (s.blockedHosts || []).join('\n');
    if (el('openTimeLabel')) el('openTimeLabel').textContent = minutesToHHMM(s.marketOpenMin) + ' IST';
    renderCalendarStatus(s);
  }

  function renderCalendarStatus(settings) {
    var box = el('calendarStatusBox');
    if (!box || !R || !R.calendarStatus) return;
    var status = R.calendarStatus(Date.now(), settings);
    if (status.stale) {
      box.innerHTML = '⚠️ <span style="color:#f59e0b;font-weight:600">Calendar Update Required:</span> ' +
        escapeHtml(status.message);
    } else if (status.source === 'custom') {
      box.innerHTML = '✓ Using <b>' + status.count + ' custom holiday dates</b>.';
    } else {
      box.innerHTML = '✓ Built-in NSE ' + status.year + ' trading calendar (' + status.count + ' holidays active).';
    }
  }

  function read() {
    var s = Object.assign({}, currentSettings || {});
    NUM.forEach(function (k) {
      if (el(k)) {
        var v = parseFloat(el(k).value);
        s[k] = isFinite(v) ? v : 0;
      }
    });
    BOOL.forEach(function (k) {
      if (el(k)) s[k] = !!el(k).checked;
    });
    if (el('enforcementMode')) s.enforcementMode = el('enforcementMode').value;
    if (el('fullSiteAcknowledged')) s.fullSiteAcknowledged = !!el('fullSiteAcknowledged').checked;
    if (s.enforcementMode === 'full_site' && !s.fullSiteAcknowledged) {
      s.enforcementMode = 'warning';
      if (el('enforcementMode')) el('enforcementMode').value = 'warning';
      toggleFullSiteAckBox('warning');
    }
    if (el('planTradesMirror')) {
      var mirror = parseFloat(el('planTradesMirror').value);
      if (isFinite(mirror)) s.maxTradesPerDay = mirror;
    }
    if (el('marketOpen')) {
      var mo = hhmmToMinutes(el('marketOpen').value);
      s.marketOpenMin = (mo === null ? 555 : mo);
      if (el('openTimeLabel')) el('openTimeLabel').textContent = minutesToHHMM(s.marketOpenMin) + ' IST';
    }
    if (el('marketSymbol')) s.marketSymbol = el('marketSymbol').value;
    if (el('marketSource')) s.marketSource = el('marketSource').value;
    if (el('holidays')) s.holidays = parseLines(el('holidays').value).filter(function (d) { return /^\d{4}-\d{2}-\d{2}$/.test(d); });
    if (el('blockedHosts')) s.blockedHosts = parseLines(el('blockedHosts').value);
    return s;
  }

  function row(k, v, off) {
    return '<tr><td class="k">' + k + '</td><td class="v ' + (off ? 'off' : '') + '">' + v + '</td></tr>';
  }

  function renderToday(state, settings) {
    currentState = state;
    currentSettings = settings || currentSettings;
    var t = el('todayTable');
    if (!t) return;

    if (!state || !state.session) {
      t.innerHTML = row('Session', 'not started yet — open a broker tab', true);
      return;
    }
    var s = state.session;
    var lock = state.lock || {};

    // Telemetry Bento cards on Overview tab
    if (el('ovTradesVal')) el('ovTradesVal').textContent = s.trades + (settings.maxTradesPerDay ? ' / ' + settings.maxTradesPerDay : '');
    if (el('ovTradesSub')) el('ovTradesSub').textContent = (s.autoTrades || 0) + ' auto · ' + Math.max(0, s.trades - (s.autoTrades || 0)) + ' manual';
    if (el('ovPnlVal')) {
      el('ovPnlVal').textContent = R.inr(s.pnl);
      el('ovPnlVal').className = 'stat-val ' + (s.pnl > 0 ? 'pos' : (s.pnl < 0 ? 'neg' : ''));
    }
    if (el('ovPnlSub')) el('ovPnlSub').textContent = settings.maxDailyLoss ? 'Max loss ₹' + settings.maxDailyLoss : 'No loss limit';
    if (el('ovStreakVal')) el('ovStreakVal').textContent = s.consecutiveLosses;
    if (el('ovStreakSub')) el('ovStreakSub').textContent = settings.maxConsecutiveLosses ? 'Max ' + settings.maxConsecutiveLosses + ' allowed' : 'No streak limit';

    if (I) {
      var ia = I.analyze(state.log, s, settings);
      if (el('ovDisciplineScore')) el('ovDisciplineScore').textContent = ia.score + ' / 100';
      if (el('ovDisciplineSub')) el('ovDisciplineSub').textContent = ia.grade + ' discipline rating';
    }

    t.innerHTML =
      row('Session date', s.date || '—') +
      row('Trades', s.trades + (settings.maxTradesPerDay ? ' / ' + settings.maxTradesPerDay : '')) +
      row(' of which auto-detected', s.autoTrades || 0) +
      row('Realised P&amp;L', R.inr(s.pnl)) +
      row('Risk committed', R.inr(s.riskUsed)) +
      row('Largest single-trade risk', R.inr(s.maxTradeRisk || 0)) +
      row('Open exposure (auto)', R.inr(s.openExposure || 0)) +
      row('Consecutive losses', s.consecutiveLosses) +
      row('Lock', lock.active
        ? 'ACTIVE — releases ' + R.istLabel(lock.until)
        : 'not locked', false) +
      row('Tamper events seen', state.tamperCount || 0);

    var pill = el('lockPill');
    if (pill) {
      pill.textContent = lock.active ? 'LOCKED' : 'UNLOCKED';
      pill.className = 'pill ' + (lock.active ? 'on' : 'off');
    }
    renderProAnalytics(state, settings, currentLicense);
  }

  function planState(settings, lic) {
    settings = settings || currentSettings || {};
    lic = lic || currentLicense;
    var pro = R.isPro(lic, Date.now());
    var proPlus = R.isProPlus ? R.isProPlus(lic, Date.now()) : pro;
    return { enforced: true, pro: pro, proPlus: proPlus, free: !pro };
  }

  function applyPlanGating(settings, lic) {
    var plan = planState(settings, lic);
    var proIds = ['autoDetect', 'countAutoTrades', 'countAutoRisk',
      'maxDailyLoss', 'profitTarget', 'maxConsecutiveLosses',
      'maxRiskPerTrade', 'maxDailyRisk', 'riskPerUnit'];
    proIds.forEach(function (id) {
      var node = el(id);
      if (!node) return;
      node.disabled = plan.free;
      var field = node.closest ? (node.closest('label') || node) : node;
      if (field && field.style) field.style.opacity = plan.free ? '0.55' : '';
    });
    // Note: Free users have full access to export their own trade logs to CSV & JSON without a paywall
    if (el('reportBtn')) el('reportBtn').disabled = plan.free;
    document.querySelectorAll('[data-tab="market"], [data-tab="options"], [data-tab="ai"]').forEach(function (tab) {
      tab.disabled = !plan.proPlus;
      tab.title = plan.proPlus ? '' : 'Pro+ AI or Founder Lifetime required';
      tab.setAttribute('aria-label', tab.textContent.trim() + (plan.proPlus ? '' : ' (Pro+ required)'));
    });
    ['marketEnabled', 'marketSource', 'chatInput', 'chatSendBtn'].forEach(function (id) {
      if (el(id)) el(id).disabled = !plan.proPlus;
    });
    document.querySelectorAll('.prompt-chip').forEach(function (chip) { chip.disabled = !plan.proPlus; });
    return plan;
  }

  function renderProAnalytics(state, settings, lic) {
    var box = el('proAnalytics');
    if (!box) return;
    var plan = planState(settings, lic);
    if (plan.free) {
      renderCoach(state, settings, lic);
      box.innerHTML = '<div class="callout" style="margin:0">🔒 <b>Pro journal analytics locked.</b> ' +
        'Upgrade to see win-rate, average win/loss, biggest loss, and risk totals for today\'s trades. (Trade log export remains free.)</div>';
      return;
    }
    renderCoach(state, settings, lic);
    var a = R.summarizeLog(state && state.log);
    box.innerHTML = '<h3 style="margin:12px 0 6px;font-size:13px">Today\'s journal analytics <span style="color:var(--ok)">(Pro)</span></h3>' +
      '<table class="limits">' +
      row('Closed trades', a.trades + ' (auto ' + a.autoTrades + ' · manual ' + a.manualTrades + ')') +
      row('Win rate', a.winRate + '% (' + a.wins + 'W / ' + a.losses + 'L)') +
      row('Gross profit / loss', R.inr(a.grossProfit) + ' / ' + R.inr(a.grossLoss)) +
      row('Average win / loss', R.inr(a.avgWin) + ' / ' + R.inr(a.avgLoss)) +
      row('Largest win / loss', R.inr(a.largestWin) + ' / ' + R.inr(a.largestLoss)) +
      row('Total risk logged', R.inr(a.totalRisk)) +
      '</table>';
  }

  // ------------------------------------------------------------ license ----

  function renderLicense(lic, settings) {
    currentLicense = lic;
    currentSettings = settings || currentSettings;
    applyPlanGating(settings, lic);
    var box = el('licStatus');
    if (!box) return;
    var pro = R.isPro(lic, Date.now());
    var planId = R.canonicalPlanId ? R.canonicalPlanId((lic && lic.plan) || 'free') : ((lic && lic.plan) || 'free');
    if (lic && lic.key && el('licKey')) el('licKey').value = lic.key;

    if (pro) {
      var planNames = {
        pro_monthly: 'Pro 30-day Prepaid (₹199)',
        pro_yearly: 'Pro 365-day Prepaid (₹1,499)',
        pro_plus_ai_monthly: 'Pro+ AI 30-day Prepaid (₹399)',
        pro_plus_ai_yearly: 'Pro+ AI 365-day Prepaid (₹3,999)',
        founder_lifetime: 'Founder Lifetime (₹2,999)'
      };
      var pName = planNames[planId] || (lic.plan || 'Pro Active');
      var expStr = lic.expiresAt ? ('valid until <b>' + R.istLabel(lic.expiresAt) + '</b>') : '<b>Lifetime Access</b>';
      box.className = 'callout green';
      box.innerHTML = '<b>Active Prepaid Plan:</b> You are on the <b>' + pName + '</b> plan (' + expStr + '). ' +
        'Advanced discipline rules, generic broker-table detection, and plan device entitlements are active.';
    } else {
      box.className = 'callout blue';
      box.innerHTML = '<b>Free Tier Active.</b> Trade-count lock, manual trade logging, and full monthly trade journal are enabled. ' +
        'Upgrade to Pro for table detection and advanced rules, or Pro+ for market features and the discipline coach.' +
        (lic && lic.reason ? ' <span style="color:var(--dim)">(Status note: ' + escapeHtml(lic.reason) + ')</span>' : '');
    }

    if (lic && (lic.plan === 'pro_yearly' || lic.plan === 'pro_plus_ai_yearly') && selectedBillingCycle === 'monthly') {
      selectedBillingCycle = 'yearly';
    }
    applyBillingCycle(selectedBillingCycle, lic);
  }

  var selectedBillingCycle = 'monthly';

  function applyBillingCycle(cycle, lic) {
    selectedBillingCycle = cycle;
    var isYearly = cycle === 'yearly';
    var toggle = el('billingCycleToggle');
    var knob = el('billingCycleKnob');
    var mLabel = el('billingMonthlyLabel');
    var yLabel = el('billingYearlyLabel');

    if (toggle) toggle.setAttribute('aria-checked', isYearly ? 'true' : 'false');
    if (knob) knob.style.left = isYearly ? '21px' : '3px';
    if (mLabel) {
      mLabel.style.color = isYearly ? 'var(--dim)' : '#fff';
      mLabel.style.fontWeight = isYearly ? '500' : '700';
    }
    if (yLabel) {
      yLabel.style.color = isYearly ? '#fff' : 'var(--dim)';
      yLabel.style.fontWeight = isYearly ? '700' : '500';
    }

    // Update Pro Card
    var proName = el('proCardName');
    var proPrice = el('proCardPrice');
    var proSub = el('proCardSub');
    var proBtn = el('proCardBtn');
    if (proName) proName.textContent = isYearly ? 'Pro 365-Day' : 'Pro 30-Day';
    if (proPrice) proPrice.innerHTML = isYearly ? '₹1,499 <span style="font-size:12px;font-weight:400">/ 365 days</span>' : '₹199 <span style="font-size:12px;font-weight:400">/ 30 days</span>';
    if (proSub) proSub.textContent = isYearly ? '365-day prepaid access · equivalent ₹125/month (Save 37%)' : 'Complete risk rules suite · 30-day prepaid access';
    if (proBtn) proBtn.setAttribute('data-plan', isYearly ? 'pro_yearly' : 'pro_monthly');

    // Update Pro+ AI Card
    var proAiName = el('proAiCardName');
    var proAiPrice = el('proAiCardPrice');
    var proAiSub = el('proAiCardSub');
    var proAiBadge = el('proAiBadge');
    var proAiBtn = el('proAiCardBtn');
    if (proAiName) proAiName.textContent = isYearly ? 'Pro+ AI 365-Day' : 'Pro+ AI 30-Day';
    if (proAiPrice) proAiPrice.innerHTML = isYearly ? '₹3,999 <span style="font-size:12px;font-weight:400">/ 365 days</span>' : '₹399 <span style="font-size:12px;font-weight:400">/ 30 days</span>';
    if (proAiSub) proAiSub.textContent = isYearly ? '365-day prepaid access · equivalent ₹333/month (Save 16%)' : 'Discipline + market intelligence · 30-day prepaid access';
    if (proAiBadge) proAiBadge.style.display = isYearly ? 'inline-block' : 'none';
    if (proAiBtn) proAiBtn.setAttribute('data-plan', isYearly ? 'pro_plus_ai_yearly' : 'pro_plus_ai_monthly');

    // Update plan buttons in comparison cards
    var planId = R.canonicalPlanId ? R.canonicalPlanId((lic && lic.plan) || 'free') : ((lic && lic.plan) || 'free');
    var pro = R.isPro(lic, Date.now());
    document.querySelectorAll('.plan-select-btn').forEach(function (btn) {
      var p = btn.getAttribute('data-plan');
      if (p === 'free') {
        btn.disabled = true;
        btn.textContent = pro ? 'Free (included)' : 'Current Plan';
        btn.style.opacity = '0.65';
        return;
      }
      if (p === planId) {
        btn.disabled = true;
        btn.textContent = 'Current Plan';
        btn.style.opacity = '0.65';
      } else {
        btn.disabled = false;
        btn.style.opacity = '1';
        if (p === 'pro_monthly') btn.textContent = pro ? 'Switch to Pro 30-Day' : 'Upgrade to Pro';
        else if (p === 'pro_yearly') btn.textContent = pro ? 'Switch to Pro 365-Day' : 'Get Pro 365-Day (Save 37%)';
        else if (p === 'pro_plus_ai_monthly') btn.textContent = 'Get Pro+ AI';
        else if (p === 'pro_plus_ai_yearly') btn.textContent = 'Get Pro+ AI 365-Day (Save 16%)';
        else if (p === 'founder_lifetime') btn.textContent = 'Get Founder Access';
      }
    });
  }

  if (el('billingCycleToggle')) {
    el('billingCycleToggle').addEventListener('click', function () {
      applyBillingCycle(selectedBillingCycle === 'yearly' ? 'monthly' : 'yearly', currentLicense);
    });
  }
  if (el('billingMonthlyLabel')) {
    el('billingMonthlyLabel').addEventListener('click', function () {
      applyBillingCycle('monthly', currentLicense);
    });
  }
  if (el('billingYearlyLabel')) {
    el('billingYearlyLabel').addEventListener('click', function () {
      applyBillingCycle('yearly', currentLicense);
    });
  }

  // Plan Selection & Checkout Flow
  document.querySelectorAll('.plan-select-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var plan = btn.getAttribute('data-plan');
      if (plan === 'free') return;

      var email = el('checkoutEmail') ? el('checkoutEmail').value.trim() : '';
      var notice = el('checkoutNotice');

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        if (notice) {
          notice.style.display = 'block';
          notice.style.background = 'rgba(239,68,68,0.12)';
          notice.style.border = '1px solid rgba(239,68,68,0.3)';
          notice.style.color = '#fca5a5';
          notice.innerHTML = '⚠️ <b>Email Required:</b> Please enter your email address in the field above before choosing a plan so your cryptographic license key can be delivered and restored.';
        }
        if (el('checkoutEmail')) el('checkoutEmail').focus();
        return;
      }

      // Persist email locally
      chrome.storage.local.set({ tlUserEmail: email });

      var api = (el('licApi').value.trim() || R.DEFAULT_SETTINGS.licenseApiBase).replace(/\/+$/, '');
      if (notice) {
        notice.style.display = 'block';
        notice.style.background = 'rgba(59,130,246,0.12)';
        notice.style.border = '1px solid rgba(59,130,246,0.3)';
        notice.style.color = '#93c5fd';
        notice.innerHTML = 'Initiating secure order for <b>' + escapeHtml(plan) + '</b> (' + escapeHtml(email) + ')…';
      }

      fetch(api + '/api/create-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: plan, email: email })
      })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!notice) return;
        if (data.payments_not_configured || data.error === 'payments_not_configured') {
          notice.style.background = 'rgba(245,158,11,0.12)';
          notice.style.border = '1px solid rgba(245,158,11,0.3)';
          notice.style.color = '#fcd34d';
          notice.innerHTML = '⚠️ <b>Payment Gateway Offline / Not Configured:</b> The Trade Lock backend server is running in development mode without live Razorpay credentials. No charges were made. In live production, this connects to Razorpay billing. For development, use an explicitly enabled demo checkout or paste a valid test license key above.';
        } else if (data.orderId) {
          notice.style.background = 'rgba(16,185,129,0.12)';
          notice.style.border = '1px solid rgba(16,185,129,0.3)';
          notice.style.color = '#6ee7b7';
          notice.innerHTML = '✓ Order <b>' + escapeHtml(data.orderId) + '</b> initialized for ' + escapeHtml(email) + '. ' +
            'Redirecting to payment gateway for signature authorization…';
          var checkoutUrl = api + '/?plan=' + encodeURIComponent(plan) + '&email=' + encodeURIComponent(email) + '&orderId=' + encodeURIComponent(data.orderId);
          if (chrome.tabs && chrome.tabs.create) {
            chrome.tabs.create({ url: checkoutUrl });
          } else {
            window.open(checkoutUrl, '_blank');
          }
        } else if (data.error) {
          notice.style.background = 'rgba(239,68,68,0.12)';
          notice.style.border = '1px solid rgba(239,68,68,0.3)';
          notice.style.color = '#fca5a5';
          notice.innerHTML = '⚠️ Checkout Error: ' + escapeHtml(data.error);
        }
      })
      .catch(function (err) {
        if (!notice) return;
        notice.style.background = 'rgba(245,158,11,0.12)';
        notice.style.border = '1px solid rgba(245,158,11,0.3)';
        notice.style.color = '#fcd34d';
        notice.innerHTML = '⚠️ <b>Payments Not Configured / Backend Offline:</b> Could not reach backend server at <code>' + escapeHtml(api) + '</code>. ' +
          'No card details are ever stored locally. In live production, this connects to Razorpay billing. You can test features by activating a license key directly.';
      });
    });
  });

  if (el('saveEmailBtn')) {
    el('saveEmailBtn').addEventListener('click', function () {
      var em = el('checkoutEmail') ? el('checkoutEmail').value.trim() : '';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) {
        alert('Please enter a valid email address.');
        return;
      }
      chrome.storage.local.set({ tlUserEmail: em }, function () {
        toast('Email saved');
      });
    });
  }

  // Restore Subscription Button (via Key or Email)
  if (el('licRestoreBtn')) {
    el('licRestoreBtn').addEventListener('click', function () {
      var key = el('licKey') ? el('licKey').value.trim() : '';
      if (!key && currentLicense && currentLicense.key) key = currentLicense.key;
      var api = (el('licApi').value.trim() || R.DEFAULT_SETTINGS.licenseApiBase).replace(/\/+$/, '');

      if (key) {
        if (el('licNote')) el('licNote').textContent = 'syncing license…';
        globalThis.TLLicense.activate(api, key).then(function (lic) {
          if (el('licNote')) {
            el('licNote').textContent = lic.active ? 'License synchronized ✓' : ('Sync status: ' + (lic.reason || 'not active'));
          }
          loadAll();
          toast('License synchronized');
        }).catch(function (err) {
          if (el('licNote')) el('licNote').textContent = 'Sync failed: ' + err.message;
        });
        return;
      }

      var email = el('checkoutEmail') ? el('checkoutEmail').value.trim() : '';
      if (!email) {
        alert('Please enter your purchase email for recovery guidance or a license key to validate.');
        if (el('checkoutEmail')) el('checkoutEmail').focus();
        return;
      }

      if (el('licNote')) el('licNote').textContent = 'requesting recovery guidance for ' + email + '…';
      fetch(api + '/api/restore-subscription', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email })
      })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.ok && data.recovery === 'support_required') {
          if (el('licNote')) el('licNote').textContent = data.note;
          alert('For account safety, email-only recovery does not reveal or replace a license. Contact support from your purchase email for ownership verification and reissue.');
        } else {
          if (el('licNote')) el('licNote').textContent = data.note || 'Recovery could not be completed.';
        }
      })
      .catch(function (err) {
        if (el('licNote')) el('licNote').textContent = 'Lookup failed: ' + err.message;
      });
    });
  }

  if (el('licActivate')) el('licActivate').addEventListener('click', function () {
    var key = el('licKey').value.trim();
    var api = el('licApi').value.trim() || R.DEFAULT_SETTINGS.licenseApiBase;
    if (!key) { if (el('licNote')) el('licNote').textContent = 'paste a license key first'; return; }
    if (el('licNote')) el('licNote').textContent = 'validating…';
    globalThis.TLLicense.activate(api, key).then(function (lic) {
      if (el('licNote')) {
        el('licNote').textContent = lic.active
          ? 'activated ✓ — remember to Save rules'
          : 'not active: ' + (lic.reason || 'unknown');
      }
      loadAll();
    });
  });

  if (el('licBuy')) el('licBuy').addEventListener('click', function () {
    switchTab('license');
  });

  function maybeRevalidate(lic, settings) {
    if (revalidateTried || !lic || !lic.key || !globalThis.TLLicense) return;
    var stale = !lic.validatedAt || (Date.now() - lic.validatedAt > 24 * 3600 * 1000);
    if (!stale) return;
    revalidateTried = true;
    globalThis.TLLicense.activate(settings.licenseApiBase || R.DEFAULT_SETTINGS.licenseApiBase, lic.key)
      .then(function () { loadAll(); })
      .catch(function () {});
  }

  function renderCoach(state, settings, lic) {
    var box = el('aiCoach');
    if (!box || !globalThis.TLInsights) return;
    var plan = planState(settings, lic);
    if (!plan.proPlus) {
      box.innerHTML = '<div class="callout" style="margin:0">🤖 <b>Discipline Coach locked (Pro+).</b> ' +
        'Pro+ watches how you trade — revenge entries after losses, risk size creeping up, burst overtrading — ' +
        'scores your discipline 0–100 and writes your end-of-day report.</div>';
      return;
    }
    var a = globalThis.TLInsights.analyze(state && state.log, state && state.session, settings);
    var sig = a.signals.map(function (sg) {
      var icon = sg.level === 'danger' ? '🔴' : sg.level === 'warn' ? '🟠' : '🟢';
      return '<div style="padding:3px 0">' + icon + ' ' + sg.text + '</div>';
    }).join('');
    var sug = a.suggestions.map(function (sg) { return '<div style="padding:3px 0">→ ' + sg + '</div>'; }).join('');
    box.innerHTML = '<h3 style="margin:12px 0 6px;font-size:13px">Discipline Coach (local rules) <span style="color:var(--ok)">(Pro+)</span> — ' +
      'discipline score <b>' + a.score + '/100</b> · ' + a.grade + '</h3>' +
      '<div style="font-size:12.5px;color:var(--muted)">' + sig + sug + '</div>';
  }

  function csvCell(v) {
    var s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  // -------------------------------------------------------------- load ----

  function loadAll() {
    chrome.storage.local.get(['tlSettings', 'tlState', 'tlLicense', 'tlJournal', 'tlUserEmail'], function (res) {
      if (res.tlUserEmail && el('checkoutEmail') && !el('checkoutEmail').value) {
        el('checkoutEmail').value = res.tlUserEmail;
      }
      currentLicense = res.tlLicense || null;
      var s = R.effectiveSettings(res.tlSettings, currentLicense, Date.now());
      currentSettings = s;
      if (!dirty) fill(s);
      renderLicense(currentLicense, s);
      maybeRevalidate(currentLicense, s);

      var st = res.tlState;
      if (st) {
        R.syncSession(st, s, Date.now());
        var t = R.tick(st, s, Date.now());
        currentState = t.state;
        renderToday(t.state, s);
      } else {
        currentState = R.defaultState(Date.now());
        renderToday(null, s);
      }

      currentJournal = Array.isArray(res.tlJournal) ? res.tlJournal : [];
      renderMonthlyJournal();
      renderOverviewJournalSummary(currentState, currentJournal);
    });
  }

  function renderOverviewJournalSummary(state, journal) {
    var emptyEl = el('ovJournalEmpty');
    var listEl = el('ovJournalTradesList');
    if (!emptyEl || !listEl) return;

    var trades = (state && state.log) || [];
    if (!trades.length && journal && journal.length) {
      var todayKey = R.todayIST();
      for (var i = 0; i < journal.length; i++) {
        if (journal[i] && journal[i].date === todayKey && Array.isArray(journal[i].trades)) {
          trades = journal[i].trades;
          break;
        }
      }
    }

    if (!trades || !trades.length) {
      emptyEl.style.display = 'block';
      listEl.style.display = 'none';
      return;
    }

    emptyEl.style.display = 'none';
    listEl.style.display = 'block';

    var recent = trades.slice(-5).reverse();
    var html = '<table class="limits" style="margin:0">';
    html += '<thead><tr><th>Time</th><th>Symbol</th><th>Side</th><th>Qty</th><th>P&amp;L</th><th>Source</th></tr></thead><tbody>';
    recent.forEach(function (t) {
      var pnlVal = (t.netPnl !== undefined && t.netPnl !== null) ? t.netPnl : t.pnl;
      var pnlClass = pnlVal > 0 ? 'color:#10b981;font-weight:700' : (pnlVal < 0 ? 'color:#ef4444;font-weight:700' : 'color:var(--dim)');
      var pnlSign = pnlVal > 0 ? '+' : '';
      var timeStr = t.at ? new Date(t.at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '—';
      html += '<tr>' +
        '<td>' + timeStr + '</td>' +
        '<td style="font-weight:700;color:#fff">' + escapeHtml(t.symbol || 'NIFTY') + '</td>' +
        '<td><span class="badge" style="' + (t.side === 'BUY' ? 'color:#34d399' : 'color:#f87171') + '">' + (t.side || 'BUY') + '</span></td>' +
        '<td>' + (t.qty || 1) + '</td>' +
        '<td style="' + pnlClass + '">' + pnlSign + R.inr(pnlVal || 0) + '</td>' +
        '<td><span style="font-size:10.5px;color:var(--dim)">' + escapeHtml(t.provenance || t.source || 'manual') + '</span></td>' +
      '</tr>';
    });
    html += '</tbody></table>';
    listEl.innerHTML = html;
  }

  if (el('ovJumpToJournal')) {
    el('ovJumpToJournal').addEventListener('click', function () {
      switchTab('journal');
    });
  }

  function save() {
    var s = read();
    chrome.storage.local.set({ tlSettings: s, tlSavedAt: Date.now() }, function () {
      dirty = false;
      if (el('dirtyNote')) el('dirtyNote').textContent = '';
      currentSettings = s;
      chrome.runtime.sendMessage({ type: 'TL_REFRESH' });
      chrome.tabs.query({}, function (tabs) {
        tabs.forEach(function (t) {
          try {
            chrome.tabs.sendMessage(t.id, { type: 'TL_SETTINGS_UPDATED', settings: s }, function () {
              void chrome.runtime.lastError;
            });
          } catch (e) {}
        });
      });
      loadAll();
      toast('Rules saved');
    });
  }

  function toast(msg) {
    var t = el('savedToast');
    if (!t) return;
    t.textContent = msg || 'Saved';
    t.classList.add('on');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.remove('on'); }, 1600);
  }

  // --------------------------------------------------- technical charts & canvas ----

  var chartState = {
    candles: [],
    analysis: null,
    zoom: 1.0,
    panOffset: 0,
    hoveredIdx: -1,
    symbol: 'NIFTY',
    timeframe: '15m',
    isDragging: false,
    dragStartX: 0,
    dragStartPan: 0
  };

  function getInstrumentConfig(sym) {
    if (M && M.INSTRUMENTS && M.INSTRUMENTS[sym]) return M.INSTRUMENTS[sym];
    var map = {
      NIFTY: { symbol: 'NIFTY', name: 'NIFTY 50', exchange: 'NSE', basePrice: 24520, step: 50, lotSize: 75 },
      BANKNIFTY: { symbol: 'BANKNIFTY', name: 'BANK NIFTY', exchange: 'NSE', basePrice: 51200, step: 100, lotSize: 15 },
      FINNIFTY: { symbol: 'FINNIFTY', name: 'FIN NIFTY', exchange: 'NSE', basePrice: 23850, step: 50, lotSize: 25 },
      MIDCPNIFTY: { symbol: 'MIDCPNIFTY', name: 'MIDCPNIFTY', exchange: 'NSE', basePrice: 12850, step: 25, lotSize: 50 },
      SENSEX: { symbol: 'SENSEX', name: 'BSE SENSEX', exchange: 'BSE', basePrice: 80400, step: 100, lotSize: 10 },
      BANKEX: { symbol: 'BANKEX', name: 'BSE BANKEX', exchange: 'BSE', basePrice: 58600, step: 100, lotSize: 15 }
    };
    return map[sym] || map.NIFTY;
  }

  function generateSampleCandles(basePrice, count, tf, symbol) {
    var sym = symbol || (el('marketSymbol') ? el('marketSymbol').value : 'NIFTY');
    var interval = tf || (el('marketTimeframe') ? el('marketTimeframe').value : '15m');
    if (M && typeof M.generateCandles === 'function') {
      return M.generateCandles(sym, interval, count || 60);
    }
    var candles = [];
    var now = Date.now() - ((count || 60) * 15 * 60 * 1000);
    var p = basePrice || 24520;
    for (var i = 0; i < (count || 60); i++) {
      var change = (Math.sin(i / 5) * 20) + ((i % 3 === 0 ? 1 : -1) * 12);
      var open = p;
      var close = p + change;
      var high = Math.max(open, close) + 15;
      var low = Math.min(open, close) - 14;
      p = close;
      candles.push({ t: now + (i * 15 * 60 * 1000), o: round(open), h: round(high), l: round(low), c: round(close), v: 1200 + (i * 50) });
    }
    return candles;
  }
  function round(n) { return Math.round(n * 100) / 100; }

  // Canvas Candlestick & Volume Chart Renderer
  function drawMarketCandleChart() {
    var canvas = el('marketCandleCanvas');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    if (!ctx) return;

    var rect = canvas.getBoundingClientRect();
    var width = rect.width || canvas.parentElement.clientWidth || 600;
    var height = rect.height || 320;
    var dpr = window.devicePixelRatio || 1;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    var candles = chartState.candles;
    if (!candles || !candles.length) {
      ctx.fillStyle = '#060913';
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = '#94a3b8';
      ctx.font = '12px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No market candle data available', width / 2, height / 2);
      return;
    }

    var rightMargin = 55;
    var bottomMargin = 24;
    var plotWidth = width - rightMargin;
    var totalHeight = height - bottomMargin;
    var pricePlotHeight = totalHeight * 0.76;
    var volPlotHeight = totalHeight * 0.20;
    var volPlotTop = pricePlotHeight + (totalHeight * 0.04);

    // Calculate visible candles according to zoom and pan offset.
    var windowed = M.chartWindow(candles, chartState.zoom, chartState.panOffset);
    chartState.panOffset = windowed.panOffset;
    var baseVisible = windowed.visibleCount;
    var candleSpacing = plotWidth / baseVisible;
    var candleWidth = Math.max(2, candleSpacing * 0.72);
    var startIdx = windowed.startIndex;
    var visibleCandles = windowed.candles;

    // Find min and max price & volume
    var minPrice = Infinity;
    var maxPrice = -Infinity;
    var maxVol = 1;

    visibleCandles.forEach(function (c) {
      if (c.l < minPrice) minPrice = c.l;
      if (c.h > maxPrice) maxPrice = c.h;
      if (c.v > maxVol) maxVol = c.v;
    });

    var priceRange = maxPrice - minPrice;
    if (priceRange <= 0) priceRange = 10;
    var padPrice = priceRange * 0.08;
    minPrice -= padPrice;
    maxPrice += padPrice;
    priceRange = maxPrice - minPrice;

    function getY(price) {
      return pricePlotHeight - ((price - minPrice) / priceRange) * pricePlotHeight;
    }

    // 1. Background
    ctx.fillStyle = '#060913';
    ctx.fillRect(0, 0, width, height);

    // 2. Horizontal Grid Lines & Price Axis
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#64748b';
    ctx.font = '10px monospace';
    ctx.textAlign = 'left';

    var priceSteps = 5;
    for (var s = 0; s <= priceSteps; s++) {
      var pVal = minPrice + (priceRange * (s / priceSteps));
      var y = getY(pVal);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(plotWidth, y);
      ctx.stroke();
      ctx.fillText(pVal.toFixed(1), plotWidth + 6, y + 3);
    }

    // 3. Draw Volume Histogram
    visibleCandles.forEach(function (c, idx) {
      var x = idx * candleSpacing + (candleSpacing / 2);
      var vHeight = (c.v / maxVol) * volPlotHeight;
      var yTop = totalHeight - vHeight;
      ctx.fillStyle = c.c >= c.o ? 'rgba(16, 185, 129, 0.28)' : 'rgba(239, 68, 68, 0.28)';
      ctx.fillRect(x - candleWidth / 2, yTop, candleWidth, vHeight);
    });

    // 4. Draw Candlesticks (Wicks and Bodies)
    visibleCandles.forEach(function (c, idx) {
      var x = idx * candleSpacing + (candleSpacing / 2);
      var isBull = c.c >= c.o;
      var color = isBull ? '#10b981' : '#ef4444';

      var yOpen = getY(c.o);
      var yClose = getY(c.c);
      var yHigh = getY(c.h);
      var yLow = getY(c.l);

      // Wick
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x, yHigh);
      ctx.lineTo(x, yLow);
      ctx.stroke();

      // Body
      var bodyTop = Math.min(yOpen, yClose);
      var bodyHeight = Math.max(1.5, Math.abs(yClose - yOpen));
      ctx.fillStyle = color;
      ctx.fillRect(x - candleWidth / 2, bodyTop, candleWidth, bodyHeight);
    });

    // 5. Draw EMA & VWAP Overlays
    var showEma = el('toggleEma') ? el('toggleEma').checked : true;
    var showVwap = el('toggleVwap') ? el('toggleVwap').checked : true;

    if (M) {
      var closes = visibleCandles.map(function (c) { return c.c; });
      if (showEma && closes.length >= 9) {
        var e9 = M.ema(closes, 9);
        var e20 = M.ema(closes, 20);

        // EMA 9 (Cyan)
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        e9.forEach(function (val, idx) {
          var x = idx * candleSpacing + (candleSpacing / 2);
          var y = getY(val);
          if (idx === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.stroke();

        // EMA 20 (Purple)
        ctx.strokeStyle = '#c084fc';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        e20.forEach(function (val, idx) {
          var x = idx * candleSpacing + (candleSpacing / 2);
          var y = getY(val);
          if (idx === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.stroke();
      }

      if (showVwap && visibleCandles.length >= 2) {
        var vw = M.vwap(visibleCandles);
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        vw.forEach(function (val, idx) {
          var x = idx * candleSpacing + (candleSpacing / 2);
          var y = getY(val);
          if (idx === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // 6. Crosshair & Hover Inspector
    if (chartState.hoveredIdx >= 0 && chartState.hoveredIdx < visibleCandles.length) {
      var hCandle = visibleCandles[chartState.hoveredIdx];
      var hX = chartState.hoveredIdx * candleSpacing + (candleSpacing / 2);
      var hY = getY(hCandle.c);

      // Vertical line
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(hX, 0);
      ctx.lineTo(hX, totalHeight);
      ctx.stroke();

      // Horizontal line
      ctx.beginPath();
      ctx.moveTo(0, hY);
      ctx.lineTo(plotWidth, hY);
      ctx.stroke();
      ctx.setLineDash([]);

      // Price badge on right
      ctx.fillStyle = '#3b82f6';
      ctx.fillRect(plotWidth, hY - 9, rightMargin - 4, 18);
      ctx.fillStyle = '#fff';
      ctx.fillText(hCandle.c.toFixed(1), plotWidth + 6, hY + 4);

      // Update Top Hover Bar
      var dateStr = new Date(hCandle.t).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
      var ohlcEl = el('chartOhlcBar');
      if (ohlcEl) {
        var diff = round(hCandle.c - hCandle.o);
        var diffColor = diff >= 0 ? '#10b981' : '#ef4444';
        ohlcEl.innerHTML =
          '<span><b>Time:</b> ' + dateStr + '</span>' +
          '<span><b>O:</b> ₹' + hCandle.o.toFixed(2) + '</span>' +
          '<span><b>H:</b> ₹' + hCandle.h.toFixed(2) + '</span>' +
          '<span><b>L:</b> ₹' + hCandle.l.toFixed(2) + '</span>' +
          '<span><b>C:</b> ₹' + hCandle.c.toFixed(2) + '</span>' +
          '<span style="color:' + diffColor + '"><b>Change:</b> ' + (diff >= 0 ? '+' : '') + diff.toFixed(2) + '</span>' +
          '<span><b>Vol:</b> ' + hCandle.v.toLocaleString('en-IN') + '</span>';
      }
    }

    // 7. Time Axis Labels (Every ~5 candles)
    ctx.fillStyle = '#64748b';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    var timeStep = Math.max(3, Math.floor(visibleCandles.length / 5));
    for (var tIdx = 0; tIdx < visibleCandles.length; tIdx += timeStep) {
      var tc = visibleCandles[tIdx];
      var tx = tIdx * candleSpacing + (candleSpacing / 2);
      var tStr = new Date(tc.t).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
      ctx.fillText(tStr, tx, height - 6);
    }
  }

  function initChartCanvasEvents() {
    var canvas = el('marketCandleCanvas');
    if (!canvas || canvas._inited) return;
    canvas._inited = true;

    canvas.addEventListener('mousedown', function (e) {
      chartState.isDragging = true;
      chartState.dragStartX = e.clientX;
      chartState.dragStartPan = chartState.panOffset || 0;
      canvas.style.cursor = 'grabbing';
    });
    window.addEventListener('mouseup', function () {
      if (!chartState.isDragging) return;
      chartState.isDragging = false;
      canvas.style.cursor = 'grab';
    });
    canvas.addEventListener('keydown', function (e) {
      var key = e.key;
      if (['ArrowLeft', 'ArrowRight', '+', '=', '-', '_', 'Home'].indexOf(key) === -1) return;
      e.preventDefault();
      if (key === 'Home') {
        chartState.zoom = 1;
        chartState.panOffset = 0;
      } else if (key === '+' || key === '=') {
        chartState.zoom = Math.min(3, (chartState.zoom || 1) * 1.25);
      } else if (key === '-' || key === '_') {
        chartState.zoom = Math.max(0.5, (chartState.zoom || 1) / 1.25);
      } else {
        var visible = Math.max(20, Math.min(chartState.candles.length,
          Math.round(chartState.candles.length / (chartState.zoom || 1))));
        var step = Math.max(1, Math.round(visible * 0.1));
        chartState.panOffset = (chartState.panOffset || 0) + (key === 'ArrowLeft' ? step : -step);
      }
      drawMarketCandleChart();
    });
    canvas.addEventListener('mousemove', function (e) {
      if (chartState.isDragging) {
        var dragVisible = Math.max(20, Math.min(chartState.candles.length,
          Math.round(chartState.candles.length / (chartState.zoom || 1))));
        var dragSpacing = (canvas.getBoundingClientRect().width - 55) / Math.max(1, dragVisible);
        chartState.panOffset = Math.max(0, Math.min(chartState.candles.length - dragVisible,
          chartState.dragStartPan + (e.clientX - chartState.dragStartX) / Math.max(1, dragSpacing)));
        drawMarketCandleChart();
        return;
      }
      var rect = canvas.getBoundingClientRect();
      var x = e.clientX - rect.left;
      var plotWidth = rect.width - 55;
      if (x < 0 || x > plotWidth || !chartState.candles.length) {
        chartState.hoveredIdx = -1;
      } else {
        var baseVisible = Math.max(20, Math.min(chartState.candles.length, Math.round(chartState.candles.length / chartState.zoom)));
        var candleSpacing = plotWidth / baseVisible;
        chartState.hoveredIdx = Math.floor(x / candleSpacing);
      }
      drawMarketCandleChart();
    });

    canvas.addEventListener('mouseleave', function () {
      chartState.isDragging = false;
      chartState.hoveredIdx = -1;
      drawMarketCandleChart();
      var ohlcEl = el('chartOhlcBar');
      if (ohlcEl) ohlcEl.innerHTML = '<span>Hover over chart to inspect candle values</span>';
    });

    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      if (e.deltaY < 0) {
        chartState.zoom = Math.min(3.0, chartState.zoom * 1.15);
      } else {
        chartState.zoom = Math.max(0.5, chartState.zoom / 1.15);
      }
      drawMarketCandleChart();
    }, { passive: false });

    // Indicator & Zoom button event listeners
    if (el('toggleEma')) el('toggleEma').addEventListener('change', drawMarketCandleChart);
    if (el('toggleVwap')) el('toggleVwap').addEventListener('change', drawMarketCandleChart);
    if (el('chartZoomInBtn')) el('chartZoomInBtn').addEventListener('click', function () {
      chartState.zoom = Math.min(3.0, chartState.zoom * 1.25);
      drawMarketCandleChart();
    });
    if (el('chartZoomOutBtn')) el('chartZoomOutBtn').addEventListener('click', function () {
      chartState.zoom = Math.max(0.5, chartState.zoom / 1.25);
      drawMarketCandleChart();
    });
    if (el('chartResetBtn')) el('chartResetBtn').addEventListener('click', function () {
      chartState.zoom = 1.0;
      chartState.panOffset = 0;
      drawMarketCandleChart();
    });

    window.addEventListener('resize', function () {
      if (el('tab-market') && el('tab-market').classList.contains('active')) {
        drawMarketCandleChart();
      }
    });
  }

  function renderMarketData(data) {
    var box = el('marketResult');
    if (!box) return;
    var a = data.analysis || {};
    if (!a.ok) {
      box.innerHTML = '<div class="callout" style="margin:0">Analysis unavailable: ' + (a.reason || 'unknown') + '</div>';
      return;
    }

    var zonesHtml = function (list, label) {
      if (!list || !list.length) return '';
      return '<tr><td class="k">' + label + '</td><td class="v">' + list.slice(-3).map(function (z) {
        return z.low + '–' + z.high + (z.mitigated ? ' (mitigated)' : ' (fresh)');
      }).join(' · ') + '</td></tr>';
    };

    var fvgsHtml = (a.fvgs || []).filter(function (g) { return !g.mitigated; }).slice(-3)
      .map(function (g) { return g.type + ' ' + g.low + '–' + g.high; }).join(' · ');

    var nearestRes = (a.nearestResistance || []).map(function (l) { return l.price + (l.source ? ' (' + l.source + ')' : ''); }).join(' · ') || '—';
    var nearestSup = (a.nearestSupport || []).map(function (l) { return l.price + (l.source ? ' (' + l.source + ')' : ''); }).join(' · ') || '—';

    box.innerHTML =
      '<div class="grid4" style="margin-bottom:14px">' +
        '<div class="stat-card"><span class="stat-lbl">Price / Trend</span><span class="stat-val">' + a.price + '</span><span class="stat-sub">' + a.trend + ' structure</span></div>' +
        '<div class="stat-card"><span class="stat-lbl">VWAP / EMA 20</span><span class="stat-val">' + (a.vwap || '—') + '</span><span class="stat-sub">EMA: ' + (a.ema20 || '—') + '</span></div>' +
        '<div class="stat-card"><span class="stat-lbl">RSI (14)</span><span class="stat-val">' + a.rsi14 + '</span><span class="stat-sub">' + (a.rsi14 > 70 ? 'Overbought' : a.rsi14 < 30 ? 'Oversold' : 'Neutral') + '</span></div>' +
        '<div class="stat-card"><span class="stat-lbl">ATR (14)</span><span class="stat-val">' + (a.atr14 || '—') + '</span><span class="stat-sub">Volatility range</span></div>' +
      '</div>' +
      '<table class="limits">' +
        row('Nearest Resistance', nearestRes) +
        row('Nearest Support', nearestSup) +
        zonesHtml(a.supplyZones, 'Supply Zones') +
        zonesHtml(a.demandZones, 'Demand Zones') +
        (fvgsHtml ? '<tr><td class="k">Unfilled FVGs</td><td class="v">' + fvgsHtml + '</td></tr>' : '') +
      '</table>' +
      '<div class="callout blue" style="margin-top:14px">' +
        '<b>AI Market Brief:</b> ' + (data.brief && data.brief.text ? escapeHtml(data.brief.text) : 'Market testing key zones. Watch for price reaction at nearest pivot.') +
      '</div>';
  }

  // ---------------------------------------------------- Market & OI Dashboard ----

  function renderMarketAndOiDashboard() {
    var symbol = el('marketSymbol') ? el('marketSymbol').value : 'NIFTY';
    var tf = el('marketTimeframe') ? el('marketTimeframe').value : '15m';
    var source = el('marketSource') ? el('marketSource').value : 'demo';
    var expiry = el('marketExpiry') ? el('marketExpiry').value : 'current';

    var cfg = getInstrumentConfig(symbol);
    var spot = cfg.basePrice;
    var step = cfg.step;

    var dte = expiry === 'monthly' ? 23 : (expiry === 'next' ? 9 : 2);
    var dteFactor = Math.sqrt(dte / 2);
    var decayRate = expiry === 'monthly' ? '~3.2% / day' : (expiry === 'next' ? '~7.5% / day' : '~18% / day');
    var baseStraddle = Math.round((spot * 0.01) * dteFactor);
    if (el('marketThetaVal')) {
      el('marketThetaVal').textContent = '₹' + baseStraddle + ' · ' + decayRate;
    }

    if (el('marketSpotVal')) el('marketSpotVal').textContent = '₹' + spot.toLocaleString('en-IN') + '.00';
    if (el('marketExchangeSub')) el('marketExchangeSub').textContent = cfg.exchange + ' ' + cfg.name;

    // Generate option strikes for visualization (15 strikes around spot)
    var rows = [];
    var start = Math.floor(spot / step) * step - (step * 7);
    var maxOi = 1;
    for (var i = 0; i < 15; i++) {
      var strike = start + (i * step);
      var callDist = (spot - strike) / step;
      var putDist = (strike - spot) / step;

      var timeValue = Math.round((140 - Math.abs(callDist) * 16) * dteFactor);
      var callPrice = Math.max(10, round((callDist > 0 ? (spot - strike) : 0) + timeValue));
      var putPrice = Math.max(10, round((putDist > 0 ? (strike - spot) : 0) + timeValue));

      var oiMultiplier = expiry === 'monthly' ? 1.6 : (expiry === 'next' ? 1.2 : 1.0);
      var callOi = Math.round((45000 + Math.abs(Math.sin((strike + 150) / 100)) * 95000) * oiMultiplier);
      var putOi = Math.round((40000 + Math.abs(Math.cos((strike + 250) / 100)) * 105000) * oiMultiplier);
      var callOiChg = Math.round(Math.sin(i * 1.5) * 14000);
      var putOiChg = Math.round(Math.cos(i * 1.5) * 15000);

      if (callOi > maxOi) maxOi = callOi;
      if (putOi > maxOi) maxOi = putOi;

      rows.push({
        strike: strike,
        callPrice: callPrice,
        callOi: callOi,
        callOiChange: callOiChg,
        putPrice: putPrice,
        putOi: putOi,
        putOiChange: putOiChg
      });
    }

    var summary = (M && M.oiSummary) ? M.oiSummary(rows, spot) : null;
    if (summary) {
      if (el('marketPcrVal')) el('marketPcrVal').textContent = summary.pcr;
      if (el('marketPcrBias')) {
        el('marketPcrBias').innerHTML = summary.pcr > 1.2
          ? '<span class="badge pro" style="font-size:10.5px">Bullish Bias</span>'
          : summary.pcr < 0.8
            ? '<span class="badge danger" style="font-size:10.5px">Bearish Bias</span>'
            : '<span class="badge" style="background:rgba(255,255,255,0.08);color:var(--muted);font-size:10.5px">Neutral Range</span>';
      }
      if (el('marketMaxPainVal')) {
        var dist = summary.maxPain ? (summary.maxPain - spot) : 0;
        el('marketMaxPainVal').textContent = (summary.maxPain ? summary.maxPain.toLocaleString('en-IN') : '—') +
          (dist ? ' (' + (dist > 0 ? '+' : '') + dist + ')' : '');
      }
    }

    // Render Dual-Bar Visual Chart
    var container = el('oiBarsContainer');
    if (container) {
      container.innerHTML = '';
      rows.forEach(function (r) {
        var isAtm = Math.abs(r.strike - spot) < step;
        var isCallWall = summary && r.strike === summary.maxCallOiStrike;
        var isPutWall = summary && r.strike === summary.maxPutOiStrike;

        var callPct = Math.max(3, Math.min(100, Math.round((r.callOi / maxOi) * 100)));
        var putPct = Math.max(3, Math.min(100, Math.round((r.putOi / maxOi) * 100)));

        var rowDiv = document.createElement('div');
        rowDiv.className = 'oi-bar-row' + (isAtm ? ' atm-row' : '');
        rowDiv.innerHTML =
          '<div class="oi-call-bar-wrap">' +
            (isCallWall ? '<span class="wall-tag call">Call Wall</span>' : '') +
            '<span style="color:#6ee7b7;font-weight:600">' + r.callOi.toLocaleString('en-IN') + '</span>' +
            '<div class="oi-bar call" style="width:' + callPct + '%"></div>' +
          '</div>' +
          '<div style="text-align:center">' +
            '<span class="oi-strike-badge' + (isAtm ? ' atm' : '') + '">' + r.strike.toLocaleString('en-IN') + (isAtm ? ' ★' : '') + '</span>' +
          '</div>' +
          '<div class="oi-put-bar-wrap">' +
            '<div class="oi-bar put" style="width:' + putPct + '%"></div>' +
            '<span style="color:#fca5a5;font-weight:600">' + r.putOi.toLocaleString('en-IN') + '</span>' +
            (isPutWall ? '<span class="wall-tag put">Put Wall</span>' : '') +
          '</div>';
        container.appendChild(rowDiv);
      });
    }

    // Compute Technical Candles, Indicators, and VIX Analytics
    computeLocalMarket(symbol, tf);

    var timeStr = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' IST';
    if (el('marketUpdatedTimestamp')) el('marketUpdatedTimestamp').textContent = 'Demo Render Time: ' + timeStr;
  }

  if (el('marketBtn')) {
    el('marketBtn').addEventListener('click', function () {
      renderMarketAndOiDashboard();
    });
  }
  if (el('marketSymbol')) el('marketSymbol').addEventListener('change', renderMarketAndOiDashboard);
  if (el('marketExpiry')) el('marketExpiry').addEventListener('change', renderMarketAndOiDashboard);
  if (el('marketTimeframe')) el('marketTimeframe').addEventListener('change', renderMarketAndOiDashboard);
  if (el('marketSource')) {
    el('marketSource').addEventListener('change', function () {
      if (el('marketSource').value === 'live') {
        alert('Live exchange WebSocket feed is not connected. Trade Lock runs in Deterministic Model mode to prevent unreliable data.');
        el('marketSource').value = 'demo';
      }
      renderMarketAndOiDashboard();
    });
  }

  function computeLocalMarket(symbol, tf) {
    var cfg = getInstrumentConfig(symbol);
    var candles = generateSampleCandles(cfg.basePrice, 60, tf, symbol);
    chartState.candles = candles;
    chartState.panOffset = 0;
    chartState.symbol = symbol;
    chartState.timeframe = tf;

    if (el('chartHeaderSymbol')) el('chartHeaderSymbol').textContent = cfg.name + ' (' + cfg.exchange + ')';
    if (el('chartIntervalBadge')) el('chartIntervalBadge').textContent = tf;
    if (el('chartCandleCount')) el('chartCandleCount').textContent = candles.length + ' candles';

    initChartCanvasEvents();

    if (!M) {
      if (el('marketNote')) el('marketNote').textContent = 'Engine not loaded';
      return;
    }

    var analysis = M.analyze(candles, { symbol: symbol, timeframe: tf });
    chartState.analysis = analysis;
    drawMarketCandleChart();

    // VIX Analytics & Regime Computation
    if (M.vixAnalytics) {
      var vix = M.vixAnalytics(13.85, 13.43);
      if (el('vixVal')) el('vixVal').textContent = vix.value;
      if (el('vixChg')) {
        el('vixChg').textContent = (vix.change >= 0 ? '+' : '') + vix.change + ' (' + (vix.changePct >= 0 ? '+' : '') + vix.changePct + '%)';
        el('vixChg').style.color = vix.change >= 0 ? '#10b981' : '#f87171';
      }
      if (el('vixRank')) el('vixRank').textContent = vix.ivRank + '% / ' + vix.ivPercentile + '%';
      if (el('vixRegimeBadge')) {
        el('vixRegimeBadge').textContent = 'Regime: ' + vix.status + ' (' + vix.value + ')';
        el('vixRegimeBadge').style.background = vix.isSpike ? 'rgba(239, 68, 68, 0.2)' : 'rgba(16, 185, 129, 0.18)';
        el('vixRegimeBadge').style.color = vix.isSpike ? '#f87171' : '#34d399';
      }
      if (el('vixAlertStatus')) {
        el('vixAlertStatus').textContent = vix.isSpike ? '⚠️ Spike Alert Triggered' : 'Normal';
        el('vixAlertStatus').style.color = vix.isSpike ? '#f87171' : '#34d399';
      }
    }

    if (el('marketNote')) el('marketNote').textContent = 'Deterministic Model (Simulated Demo Data) · ' + tf;
    renderMarketData({
      analysis: analysis,
      brief: {
        text: cfg.name + ' is in a ' + analysis.trend + ' market structure with RSI at ' + analysis.rsi14 +
              '. Primary resistance rests at ' + ((analysis.nearestResistance[0] && analysis.nearestResistance[0].price) || '—') +
              ' and support at ' + ((analysis.nearestSupport[0] && analysis.nearestSupport[0].price) || '—') + '.'
      }
    });
  }

  // -------------------------------------------------- options analytics ----

  function renderOptionsChainView() {
    var symbol = el('optionsSymbol') ? el('optionsSymbol').value : 'NIFTY';
    var expiry = el('optionsExpiry') ? el('optionsExpiry').value : 'current';
    var filter = el('optMoneynessFilter') ? el('optMoneynessFilter').value : 'near';

    var cfg = getInstrumentConfig(symbol);
    var spot = cfg.basePrice;
    var step = cfg.step;

    var dte = expiry === 'monthly' ? 23 : (expiry === 'next' ? 9 : 2);
    var dteFactor = Math.sqrt(dte / 2);
    var ivBase = expiry === 'monthly' ? 14.8 : (expiry === 'next' ? 14.2 : 13.5);

    if (el('optSpotPrice')) el('optSpotPrice').textContent = '₹' + spot.toLocaleString('en-IN') + '.00';

    var totalStrikes = filter === 'wide' ? 21 : filter === 'all' ? 29 : 11;
    var half = Math.floor(totalStrikes / 2);
    var start = Math.floor(spot / step) * step - (step * half);
    var rows = [];

    var atmCallTheta = 0;
    var atmPutTheta = 0;
    var atmCallPrice = 0;
    var atmPutPrice = 0;

    for (var i = 0; i < totalStrikes; i++) {
      var strike = start + (i * step);
      var callDist = (spot - strike) / step;
      var putDist = (strike - spot) / step;

      var callIv = round(ivBase + Math.abs(callDist) * 0.4);
      var putIv = round((ivBase + 0.5) + Math.abs(putDist) * 0.4);

      // Black-Scholes Greeks calculation for distinct Call vs Put Theta
      var callGreeks = (M && M.calculateGreeks) ? M.calculateGreeks(spot, strike, dte, callIv, true) : null;
      var putGreeks = (M && M.calculateGreeks) ? M.calculateGreeks(spot, strike, dte, putIv, false) : null;

      var callPrice = callGreeks ? callGreeks.price : Math.max(10, round((callDist > 0 ? (spot - strike) : 0) + Math.round((140 - Math.abs(callDist) * 16) * dteFactor)));
      var putPrice = putGreeks ? putGreeks.price : Math.max(10, round((putDist > 0 ? (strike - spot) : 0) + Math.round((140 - Math.abs(putDist) * 16) * dteFactor)));

      var callTheta = callGreeks ? callGreeks.thetaDay : round(-18 * dteFactor);
      var putTheta = putGreeks ? putGreeks.thetaDay : round(-16 * dteFactor);

      if (Math.abs(strike - spot) < step) {
        atmCallTheta = callTheta;
        atmPutTheta = putTheta;
        atmCallPrice = callPrice;
        atmPutPrice = putPrice;
      }

      var oiMultiplier = expiry === 'monthly' ? 1.6 : (expiry === 'next' ? 1.2 : 1.0);
      var callOi = Math.round((50000 + Math.abs(Math.sin((strike + 120) / 100)) * 85000) * oiMultiplier);
      var putOi = Math.round((45000 + Math.abs(Math.cos((strike + 220) / 100)) * 90000) * oiMultiplier);
      var callOiChange = Math.round(Math.sin(i * 1.3) * 12000);
      var putOiChange = Math.round(Math.cos(i * 1.3) * 11000);

      var callVol = Math.round(callOi * 0.35 + Math.abs(Math.sin(i)) * 15000);
      var putVol = Math.round(putOi * 0.35 + Math.abs(Math.cos(i)) * 15000);

      if (filter === 'itm' && !(strike < spot)) continue;
      if (filter === 'otm' && !(strike > spot)) continue;

      rows.push({
        strike: strike,
        callPrice: callPrice,
        callTheta: callTheta,
        callOi: callOi,
        callOiChange: callOiChange,
        callVol: callVol,
        callIv: callIv,
        putPrice: putPrice,
        putTheta: putTheta,
        putOi: putOi,
        putOiChange: putOiChange,
        putVol: putVol,
        putIv: putIv
      });
    }

    // Update Telemetry with Distinct Call & Put Theta
    if (el('optCallThetaVal')) el('optCallThetaVal').textContent = '₹' + atmCallTheta.toFixed(2) + ' / d';
    if (el('optCallThetaSub')) {
      var callPct = atmCallPrice > 0 ? Math.round((Math.abs(atmCallTheta) / atmCallPrice) * 100) : 14;
      el('optCallThetaSub').textContent = '~' + callPct + '% decay / day (DTE ' + dte + ')';
    }
    if (el('optPutThetaVal')) el('optPutThetaVal').textContent = '₹' + atmPutTheta.toFixed(2) + ' / d';
    if (el('optPutThetaSub')) {
      var putPct = atmPutPrice > 0 ? Math.round((Math.abs(atmPutTheta) / atmPutPrice) * 100) : 12;
      el('optPutThetaSub').textContent = '~' + putPct + '% decay / day (DTE ' + dte + ')';
    }
    if (el('optHourlyDecay')) {
      var hourlyDecay = Math.abs(atmCallTheta + atmPutTheta) / 2 / 6.25;
      el('optHourlyDecay').textContent = '₹-' + hourlyDecay.toFixed(2) + ' / hr';
    }

    if (M && M.oiSummary) {
      var summary = M.oiSummary(rows, spot);
      if (summary) {
        if (el('optPcrVal')) el('optPcrVal').textContent = summary.pcr;
        if (el('optPcrBias')) {
          el('optPcrBias').textContent = summary.pcr > 1.2 ? 'Bullish Sentiment' : summary.pcr < 0.8 ? 'Bearish Sentiment' : 'Neutral Range';
        }
        if (el('optMaxPain')) el('optMaxPain').textContent = summary.maxPain ? summary.maxPain.toLocaleString('en-IN') : spot.toLocaleString('en-IN');
      }
    }

    var tbody = el('optionsChainTbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    rows.forEach(function (r) {
      var isAtm = Math.abs(r.strike - spot) < step;
      var isCallItm = r.strike < spot;
      var isPutItm = r.strike > spot;

      var tr = document.createElement('tr');
      if (isAtm) tr.className = 'atm';
      tr.innerHTML =
        '<td class="call-col ' + (isCallItm ? 'call-itm' : '') + '">' + r.callOi.toLocaleString('en-IN') + '</td>' +
        '<td class="call-col ' + (isCallItm ? 'call-itm' : '') + '">' + (r.callOiChange >= 0 ? '+' : '') + r.callOiChange.toLocaleString('en-IN') + '</td>' +
        '<td class="call-col ' + (isCallItm ? 'call-itm' : '') + '">' + r.callVol.toLocaleString('en-IN') + '</td>' +
        '<td class="call-col ' + (isCallItm ? 'call-itm' : '') + '">' + r.callIv + '%</td>' +
        '<td class="call-col ' + (isCallItm ? 'call-itm' : '') + '" style="color:#f59e0b;font-size:11px">₹' + r.callTheta.toFixed(1) + '</td>' +
        '<td class="call-col ' + (isCallItm ? 'call-itm' : '') + '" style="font-weight:700;border-right:1px solid var(--line)">₹' + r.callPrice.toFixed(2) + '</td>' +
        '<td class="strike">' + r.strike.toLocaleString('en-IN') + (isAtm ? ' <span class="badge" style="background:#fbbf24;color:#000;font-size:9px;padding:1px 4px">ATM</span>' : '') + '</td>' +
        '<td class="put-col ' + (isPutItm ? 'put-itm' : '') + '" style="font-weight:700;border-left:1px solid var(--line)">₹' + r.putPrice.toFixed(2) + '</td>' +
        '<td class="put-col ' + (isPutItm ? 'put-itm' : '') + '" style="color:#f59e0b;font-size:11px">₹' + r.putTheta.toFixed(1) + '</td>' +
        '<td class="put-col ' + (isPutItm ? 'put-itm' : '') + '">' + r.putIv + '%</td>' +
        '<td class="put-col ' + (isPutItm ? 'put-itm' : '') + '">' + r.putVol.toLocaleString('en-IN') + '</td>' +
        '<td class="put-col ' + (isPutItm ? 'put-itm' : '') + '">' + (r.putOiChange >= 0 ? '+' : '') + r.putOiChange.toLocaleString('en-IN') + '</td>' +
        '<td class="put-col ' + (isPutItm ? 'put-itm' : '') + '">' + r.putOi.toLocaleString('en-IN') + '</td>';
      tbody.appendChild(tr);
    });
  }

  if (el('optionsRefreshBtn')) el('optionsRefreshBtn').addEventListener('click', renderOptionsChainView);
  if (el('optionsSymbol')) el('optionsSymbol').addEventListener('change', renderOptionsChainView);
  if (el('optionsExpiry')) el('optionsExpiry').addEventListener('change', renderOptionsChainView);
  if (el('optMoneynessFilter')) el('optMoneynessFilter').addEventListener('change', renderOptionsChainView);

  // ---------------------------------------------------- AI assistant ----

  function appendChatMessage(role, text) {
    var box = el('chatMessages');
    if (!box) return;
    var msg = document.createElement('div');
    msg.className = 'chat-msg ' + (role === 'user' ? 'user' : 'assistant');
    msg.innerHTML = escapeHtml(text).replace(/\n/g, '<br>');
    box.appendChild(msg);
    box.scrollTop = box.scrollHeight;
  }

  function handleAiSend() {
    var input = el('chatInput');
    if (!input) return;
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    appendChatMessage('user', text);

    // AI response engine: grounded in pure mathematical models, deterministic rules, and audit logs
    setTimeout(function () {
      var query = text.toLowerCase();
      var resp = '';
      var timeStr = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' IST';

      if (query.indexOf('discipline') !== -1 || query.indexOf('session') !== -1 || query.indexOf('rule') !== -1 || query.indexOf('broke') !== -1) {
        if (!currentState || !currentState.session || !currentState.session.trades) {
          resp = 'Discipline Audit · ' + timeStr + ':\n' +
                 'Insufficient trade data for discipline audit (0 trades recorded today).\n' +
                 'Trade execution signals, tilt scoring, and discipline audit activate once your first trade is logged or auto-detected.';
        } else if (I && currentState && currentState.session) {
          var ia = I.analyze(currentState.log, currentState.session, currentSettings);
          resp = 'Session Discipline Audit (' + ia.score + '/100 - ' + ia.grade + ') · ' + timeStr + ':\n' +
                 '• Total Trades: ' + currentState.session.trades + '\n' +
                 '• Realised P&L: ' + R.inr(currentState.session.pnl) + '\n' +
                 '• Consecutive Losses: ' + currentState.session.consecutiveLosses + '\n' +
                 (ia.signals.length ? 'Signals:\n' + ia.signals.map(function (s) { return '  - ' + s.text; }).join('\n') : '  - Clean execution with zero tilt detected.') +
                 '\n\n🛡️ Lock Policy: Authoritative risk-lock decisions are executed exclusively by the rules engine in lib/rules.js and cannot be overridden by AI.';
        } else {
          resp = 'Discipline Audit · ' + timeStr + ':\nInsufficient trade data for discipline audit (0 trades recorded today).';
        }
      } else if (query.indexOf('option') !== -1 || query.indexOf('pcr') !== -1 || query.indexOf('oi') !== -1) {
        var isDemoRequested = query.indexOf('demo') !== -1 || query.indexOf('sample') !== -1;
        var optSymbol = (el('optionsSymbol') && el('optionsSymbol').value) || 'NIFTY';

        if (isDemoRequested) {
          var optSpot = optSymbol === 'BANKNIFTY' ? 51200 : optSymbol === 'FINNIFTY' ? 23400 : 24520;
          var optStep = optSymbol === 'BANKNIFTY' ? 100 : 50;
          var optRows = [];
          var optStart = Math.floor(optSpot / optStep) * optStep - (optStep * 5);
          for (var idx = 0; idx < 11; idx++) {
            var sPrice = optStart + (idx * optStep);
            optRows.push({
              strike: sPrice,
              callOi: Math.round(50000 + Math.abs(Math.sin(sPrice / 100)) * 75000),
              putOi: Math.round(45000 + Math.abs(Math.cos(sPrice / 100)) * 80000)
            });
          }
          var oiSummary = (M && M.oiSummary) ? M.oiSummary(optRows, optSpot) : { pcr: 1.05, maxCallOiStrike: 24700, maxPutOiStrike: 24300, maxPain: 24500 };
          var sentiment = oiSummary.pcr > 1.2 ? 'Bullish bias' : oiSummary.pcr < 0.8 ? 'Bearish bias' : 'Neutral consolidation range';

          resp = '[SIMULATED DEMO DATA — NOT LIVE MARKET FEED]\n' +
                 '⚠️ Notice: The following figures are generated strictly for testing/demonstration purposes and do NOT reflect live exchange values.\n\n' +
                 '• Symbol: ' + optSymbol + ' (Simulated Underlying: ' + R.inr(optSpot) + ')\n' +
                 '• Put-Call Ratio (PCR): ' + oiSummary.pcr + ' (' + sentiment + ')\n' +
                 '• Call Wall (Sample Resistance): ' + oiSummary.maxCallOiStrike.toLocaleString('en-IN') + ' strike\n' +
                 '• Put Wall (Sample Support): ' + oiSummary.maxPutOiStrike.toLocaleString('en-IN') + ' strike\n' +
                 '• Max Pain Settlement Strike: ' + (oiSummary.maxPain ? oiSummary.maxPain.toLocaleString('en-IN') : '—') + '\n\n' +
                 '🛡️ Risk Lock Notice: AI analysis does not alter your risk limits or open/close trading locks.';
        } else {
          resp = '⚠️ LIVE MARKET DATA UNAVAILABLE\n\n' +
                 'No verified live exchange feed is currently connected (e.g. Fyers API or broker WebSocket).\n\n' +
                 'To protect your capital and maintain strict discipline, Trade Lock refuses to fabricate artificial PCR, open interest walls, or max pain levels.\n\n' +
                 '• To view real market calculations, connect a live feed under Settings → Market Intelligence.\n' +
                 '• To inspect synthetic data for interface verification, ask: "Show demo options data".\n\n' +
                 '🛡️ Risk Policy: Authoritative trading locks are executed strictly by the rules engine and cannot be altered by AI.';
        }
      } else if (query.indexOf('support') !== -1 || query.indexOf('resistance') !== -1 || query.indexOf('structure') !== -1 || query.indexOf('pivot') !== -1) {
        var isDemoReq = query.indexOf('demo') !== -1 || query.indexOf('sample') !== -1;
        var chartSym = (el('optionsSymbol') && el('optionsSymbol').value) || 'NIFTY';

        if (isDemoReq) {
          var chartSpot = chartSym === 'BANKNIFTY' ? 51200 : chartSym === 'FINNIFTY' ? 23400 : 24520;
          var chartCandles = (typeof generateSampleCandles === 'function') ? generateSampleCandles(chartSpot, 60) : [];
          var analysis = (M && M.analyze) ? M.analyze(chartCandles, { symbol: chartSym, timeframe: '5m' }) : null;
          var r1 = (analysis && analysis.nearestResistance && analysis.nearestResistance[0]) ? analysis.nearestResistance[0].price : (chartSpot + 120);
          var s1 = (analysis && analysis.nearestSupport && analysis.nearestSupport[0]) ? analysis.nearestSupport[0].price : (chartSpot - 120);
          var trend = (analysis && analysis.trend) ? analysis.trend : 'neutral consolidation';
          var rsiVal = (analysis && analysis.rsi14) ? analysis.rsi14 : 50;

          resp = '[SIMULATED DEMO DATA — NOT LIVE MARKET FEED]\n' +
                 '⚠️ Notice: The following technical levels are generated strictly from synthetic sample candles and do NOT reflect live exchange price action.\n\n' +
                 '• Symbol: ' + chartSym + ' · Trend: ' + trend + ' · Sample RSI(14): ' + rsiVal + '\n' +
                 '• Sample Resistance: ' + r1.toLocaleString('en-IN') + '\n' +
                 '• Sample Support: ' + s1.toLocaleString('en-IN') + '\n\n' +
                 '🛡️ Risk Lock Notice: Trade Lock locks trading screens solely based on verified rule limits, never simulated technical indicators.';
        } else {
          resp = '⚠️ LIVE MARKET DATA UNAVAILABLE\n\n' +
                 'No verified live broker feed is currently connected.\n\n' +
                 'Trade Lock will not invent synthetic support, resistance, pivot, or RSI numbers as real market levels.\n\n' +
                 '• Connect a verified live feed in Settings → Market Intelligence to compute live pivot zones.\n' +
                 '• To view simulated algorithmic levels for testing, ask: "Show demo market structure".\n\n' +
                 '🛡️ Risk Policy: Authoritative trading locks are executed strictly by the rules engine and cannot be altered by AI.';
        }
      } else {
        resp = 'Discipline & Risk Engine Guidance · ' + timeStr + ':\n' +
               'Keep trade count disciplined and adhere strictly to your predefined invalidation levels. ' +
               'Your active rules allow up to ' + (currentSettings.maxTradesPerDay || 'unlimited') + ' trades and max daily loss of ₹' +
               (currentSettings.maxDailyLoss || 'unlimited') + '. Never average down losing positions.\n\n' +
               '🛡️ Notice: The Trade Lock risk engine operates deterministically. AI chat is strictly informational.';
      }

      appendChatMessage('assistant', resp);
    }, 350);
  }

  if (el('chatSendBtn')) el('chatSendBtn').addEventListener('click', handleAiSend);
  if (el('chatInput')) el('chatInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') handleAiSend();
  });

  document.querySelectorAll('.prompt-chip').forEach(function (chip) {
    chip.addEventListener('click', function () {
      var promptText = chip.getAttribute('data-prompt');
      if (el('chatInput')) el('chatInput').value = promptText;
      handleAiSend();
    });
  });

  // ---------------------------------------------------- trade journal ----

  var selectedMonthKey = null;
  var allDaysCollapsed = false;

  function monthLabel(mKey) {
    if (!mKey || !/^\d{4}-\d{2}$/.test(mKey)) return mKey || '';
    var parts = mKey.split('-');
    var yr = parts[0];
    var mIdx = parseInt(parts[1], 10) - 1;
    var months = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December'];
    return (months[mIdx] || parts[1]) + ' ' + yr;
  }

  function renderMonthlyJournal() {
    var journal = (currentState && currentState.journal) || { version: 2, months: {} };
    if (!journal.months) journal.months = {};

    // Collect available months
    var monthKeys = Object.keys(journal.months);
    var curMonthKey = R.istMonthKey(Date.now());
    if (monthKeys.indexOf(curMonthKey) === -1) {
      monthKeys.push(curMonthKey);
    }
    monthKeys.sort().reverse(); // newest first

    if (!selectedMonthKey || monthKeys.indexOf(selectedMonthKey) === -1) {
      selectedMonthKey = monthKeys[0] || curMonthKey;
    }

    // Populate Month Selector dropdown
    var monthSel = el('jMonthSelector');
    if (monthSel) {
      monthSel.innerHTML = '';
      monthKeys.forEach(function (mk) {
        var opt = document.createElement('option');
        opt.value = mk;
        opt.textContent = monthLabel(mk);
        if (mk === selectedMonthKey) opt.selected = true;
        monthSel.appendChild(opt);
      });
    }

    // Monthly summary stats
    var monthData = journal.months[selectedMonthKey] || { month: selectedMonthKey, days: {}, summary: null };
    var mSummary = R.calculateMonthSummary(monthData.days || {});

    if (el('jTotalTrades')) el('jTotalTrades').textContent = mSummary.totalTrades;
    if (el('jWinRate')) el('jWinRate').textContent = mSummary.winRate + '% (' + mSummary.wins + 'W · ' + mSummary.losses + 'L)';
    if (el('jNetPnl')) {
      el('jNetPnl').textContent = (mSummary.netPnl >= 0 ? '+' : '') + R.inr(mSummary.netPnl);
      el('jNetPnl').className = 'stat-val ' + (mSummary.netPnl > 0 ? 'pos' : (mSummary.netPnl < 0 ? 'neg' : ''));
    }
    if (el('jBestDay')) {
      el('jBestDay').textContent = mSummary.bestDay
        ? mSummary.bestDay.date + ' (+' + R.inr(mSummary.bestDay.netPnl) + ')'
        : '—';
    }
    if (el('jWorstDay')) {
      el('jWorstDay').textContent = mSummary.worstDay
        ? mSummary.worstDay.date + ' (' + R.inr(mSummary.worstDay.netPnl) + ')'
        : '—';
    }

    // Render Daily Cards
    var container = el('jDaysContainer');
    if (!container) return;
    container.innerHTML = '';

    var daysObj = monthData.days || {};
    var dayKeys = Object.keys(daysObj).sort().reverse();

    var outcomeFilter = el('jFilterOutcome') ? el('jFilterOutcome').value : 'ALL';
    var sideFilter = el('jFilterSide') ? el('jFilterSide').value : 'ALL';
    var provFilter = el('jFilterProv') ? el('jFilterProv').value : 'ALL';
    var search = el('jSearch') ? el('jSearch').value.toLowerCase().trim() : '';

    var renderedDaysCount = 0;

    dayKeys.forEach(function (dStr) {
      var day = daysObj[dStr];
      var rawTrades = (day && day.trades) || [];

      // Filter trades
      var filteredTrades = rawTrades.filter(function (t) {
        var net = (t.netPnl !== undefined && t.netPnl !== null) ? t.netPnl : t.pnl;
        if (outcomeFilter === 'WIN' && net <= 0) return false;
        if (outcomeFilter === 'LOSS' && net >= 0) return false;
        if (outcomeFilter === 'BE' && net !== 0) return false;

        if (sideFilter === 'BUY' && t.side !== 'BUY') return false;
        if (sideFilter === 'SELL' && t.side !== 'SELL') return false;

        var prov = t.provenance || 'manual';
        if (provFilter === 'broker' && prov.indexOf('broker') === -1) return false;
        if (provFilter === 'manual' && prov.indexOf('broker') !== -1) return false;

        if (search) {
          var str = ((t.symbol || '') + ' ' + (t.setup || '') + ' ' + (t.notes || '') + ' ' + dStr).toLowerCase();
          if (str.indexOf(search) === -1) return false;
        }
        return true;
      });

      if (search && !filteredTrades.length) return; // Skip days with no matching trades when searching

      renderedDaysCount++;
      var dSummary = R.calculateDaySummary(rawTrades);

      var card = document.createElement('div');
      card.className = 'day-card' + (allDaysCollapsed ? ' collapsed' : '');

      var pnlClass = dSummary.netPnl > 0 ? 'color:#10b981' : (dSummary.netPnl < 0 ? 'color:#ef4444' : 'color:var(--dim)');
      var pnlSign = dSummary.netPnl > 0 ? '+' : '';

      // Day card header
      var headerHtml =
        '<div class="day-card-header">' +
          '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">' +
            '<span style="font-weight:750;font-size:13px;color:var(--text)">📅 ' + escapeHtml(dStr) + '</span>' +
            '<span class="badge" style="font-weight:700;' + pnlClass + '">' + pnlSign + R.inr(dSummary.netPnl) + ' Net</span>' +
            '<span class="badge">' + rawTrades.length + ' trade' + (rawTrades.length === 1 ? '' : 's') + '</span>' +
            '<span class="badge" style="color:#6ee7b7">' + dSummary.wins + 'W</span>' +
            '<span class="badge" style="color:#fca5a5">' + dSummary.losses + 'L</span>' +
            (dSummary.charges ? '<span class="badge" style="color:var(--dim)">Charges: ₹' + dSummary.charges + '</span>' : '') +
          '</div>' +
          '<div style="display:flex;align-items:center;gap:8px">' +
            '<span class="chevron" style="color:var(--dim);font-size:13px">▼</span>' +
          '</div>' +
        '</div>';

      // Day card body (trades table)
      var bodyHtml = '<div class="day-card-body">';
      if (!filteredTrades.length) {
        bodyHtml += '<div style="text-align:center;color:var(--dim);padding:14px;font-size:12px">No trades on this day match current filters.</div>';
      } else {
        bodyHtml +=
          '<div style="overflow-x:auto">' +
            '<table class="limits" style="margin:0;font-size:11.5px">' +
              '<thead>' +
                '<tr style="border-bottom:1px solid var(--line-strong);color:var(--dim)">' +
                  '<th>Time (IST)</th><th>Symbol</th><th>Side</th><th>Qty</th><th>Entry</th><th>Exit</th>' +
                  '<th>Gross P&amp;L</th><th>Charges</th><th>Net P&amp;L</th><th>Setup</th><th>Notes</th><th>Source</th><th></th>' +
                '</tr>' +
              '</thead>' +
              '<tbody>';

        filteredTrades.forEach(function (t) {
          var tTime = t.at ? new Date(t.at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '—';
          var net = (t.netPnl !== undefined && t.netPnl !== null) ? t.netPnl : t.pnl;
          var tPnlCls = net > 0 ? 'pos' : (net < 0 ? 'neg' : '');
          var isBroker = (t.provenance || '').indexOf('broker') !== -1;
          var provBadge = isBroker
            ? '<span class="badge pro" style="font-size:10px;padding:2px 5px">Broker table</span>'
            : '<span class="badge" style="font-size:10px;padding:2px 5px;background:rgba(255,255,255,0.06);color:var(--dim)">Manual</span>';

          bodyHtml +=
            '<tr>' +
              '<td style="white-space:nowrap;color:var(--dim)">' + tTime + '</td>' +
              '<td style="font-weight:700">' + escapeHtml(t.symbol || 'MANUAL') + '</td>' +
              '<td><span class="badge ' + (t.side === 'BUY' ? 'pro' : 'danger') + '" style="font-size:10px;padding:2px 6px">' + escapeHtml(t.side || 'BUY') + '</span></td>' +
              '<td>' + (t.qty || 1) + '</td>' +
              '<td>₹' + (t.entry || 0) + '</td>' +
              '<td>₹' + (t.exit || 0) + '</td>' +
              '<td style="color:var(--muted)">₹' + (t.pnl || 0).toLocaleString('en-IN') + '</td>' +
              '<td style="color:var(--dim)">₹' + (t.charges || 0) + '</td>' +
              '<td class="' + tPnlCls + '" style="font-weight:750">₹' + (net || 0).toLocaleString('en-IN') + '</td>' +
              '<td style="color:var(--text)">' + escapeHtml(t.setup || '—') + '</td>' +
              '<td style="color:var(--muted);max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + escapeHtml(t.notes || '') + '">' + escapeHtml(t.notes || '—') + '</td>' +
              '<td>' + provBadge + '</td>' +
              '<td><button type="button" class="danger delete-trade-btn" aria-label="Delete ' + escapeHtml(t.symbol || 'manual trade') + ' trade on ' + dStr + '" title="Delete trade" data-month="' + selectedMonthKey + '" data-date="' + dStr + '" data-id="' + escapeHtml(t.id) + '" style="padding:2px 6px;font-size:10px">×</button></td>' +
            '</tr>';
        });

        bodyHtml += '</tbody></table></div>';
      }
      bodyHtml += '</div>';

      card.innerHTML = headerHtml + bodyHtml;

      // Header click toggles collapsed state
      card.querySelector('.day-card-header').addEventListener('click', function () {
        card.classList.toggle('collapsed');
      });

      container.appendChild(card);
    });

    if (renderedDaysCount === 0) {
      container.innerHTML =
        '<div style="text-align:center;color:var(--dim);padding:36px;border:1px dashed var(--line-strong);border-radius:12px;background:rgba(0,0,0,0.2)">' +
          '<div style="font-size:14px;font-weight:600;margin-bottom:6px;color:var(--text)">No trade records for ' + monthLabel(selectedMonthKey) + '</div>' +
          '<div style="font-size:12px">Execute trades in your supported broker or click <b>+ Add Trade</b> above to log manual entries.</div>' +
        '</div>';
    }

    // Wire individual trade delete buttons
    container.querySelectorAll('.delete-trade-btn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var tId = btn.getAttribute('data-id');
        var dStr = btn.getAttribute('data-date');
        var mKey = btn.getAttribute('data-month');
        if (!confirm('Delete this trade record?')) return;

        chrome.storage.local.get(['tlState', 'tlJournal'], function (res) {
          var state = res.tlState;
          if (!state) return;
          state.log = (state.log || []).filter(function (x) { return String(x.id) !== String(tId); });
          if (R.rebuildSessionFromLog) R.rebuildSessionFromLog(state);
          if (state && state.journal && state.journal.months && state.journal.months[mKey]) {
            var dayRec = state.journal.months[mKey].days[dStr];
            if (dayRec && Array.isArray(dayRec.trades)) {
              dayRec.trades = dayRec.trades.filter(function (x) { return String(x.id) !== String(tId); });
              state.journal.months[mKey].summary = R.calculateMonthSummary(state.journal.months[mKey].days);
            }
          }
          if (state.journal && state.journal.months) {
            R.archiveDayToJournal(state.journal, state.session.date, state.log, state.session);
            Object.keys(state.journal.months).forEach(function (month) {
              var days = state.journal.months[month].days || {};
              Object.keys(days).forEach(function (day) {
                if (!(days[day].trades || []).length) delete days[day];
              });
              state.journal.months[month].summary = R.calculateMonthSummary(days);
              if (!Object.keys(days).length) delete state.journal.months[month];
            });
          }
          var flatJ = Array.isArray(res.tlJournal) ? res.tlJournal.filter(function (x) { return String(x.id) !== String(tId); }) : [];
          chrome.storage.local.set({ tlState: state, tlJournal: flatJ, tlSavedAt: Date.now() }, function () {
            currentState = state;
            renderMonthlyJournal();
            renderToday(currentState, currentSettings);
            renderOverviewJournalSummary(currentState, flatJ);
            toast('Trade deleted');
          });
        });
      });
    });
  }

  // Month selector change
  if (el('jMonthSelector')) {
    el('jMonthSelector').addEventListener('change', function () {
      selectedMonthKey = el('jMonthSelector').value;
      renderMonthlyJournal();
    });
  }

  // Toggle Collapse / Expand All Days
  if (el('jToggleDays')) {
    el('jToggleDays').addEventListener('click', function () {
      allDaysCollapsed = !allDaysCollapsed;
      el('jToggleDays').textContent = allDaysCollapsed ? 'Expand All Days' : 'Collapse All Days';
      document.querySelectorAll('#jDaysContainer .day-card').forEach(function (card) {
        if (allDaysCollapsed) card.classList.add('collapsed');
        else card.classList.remove('collapsed');
      });
    });
  }

  // Filter & Search listeners
  if (el('jSearch')) el('jSearch').addEventListener('input', renderMonthlyJournal);
  if (el('jFilterOutcome')) el('jFilterOutcome').addEventListener('change', renderMonthlyJournal);
  if (el('jFilterSide')) el('jFilterSide').addEventListener('change', renderMonthlyJournal);
  if (el('jFilterProv')) el('jFilterProv').addEventListener('change', renderMonthlyJournal);

  // Add Trade Drawer Toggle
  if (el('jOpenAddForm')) {
    el('jOpenAddForm').addEventListener('click', function () {
      if (el('jAddFormDrawer')) el('jAddFormDrawer').style.display = 'block';
    });
  }
  if (el('jCancelAddBtn')) {
    el('jCancelAddBtn').addEventListener('click', function () {
      if (el('jAddFormDrawer')) el('jAddFormDrawer').style.display = 'none';
    });
  }

  // Add Manual Trade Record
  if (el('jAddBtn')) {
    el('jAddBtn').addEventListener('click', function () {
      var sym = (el('jSymbol').value || '').trim().toUpperCase();
      var side = el('jSide').value;
      var entry = parseFloat(el('jEntry').value) || 0;
      var exit = parseFloat(el('jExit').value) || 0;
      var qty = parseFloat(el('jQty').value) || 1;
      var charges = parseFloat(el('jCharges').value) || 0;
      var plannedRisk = Math.max(0, parseFloat(el('jPlannedRisk').value) || 0);
      var setup = el('jSetup').value;
      var notes = (el('jNotes').value || '').trim();

      if (!entry || !exit) {
        alert('Please specify both Entry Price and Exit Price.');
        return;
      }

      var grossPnl = round((exit - entry) * qty * (side === 'BUY' ? 1 : -1));
      var netPnl = round(grossPnl - charges);

      var tradeRecord = {
        id: 'tl_tr_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
        at: Date.now(),
        symbol: sym || 'INDEX',
        side: side,
        entry: entry,
        exit: exit,
        qty: qty,
        pnl: grossPnl,
        charges: charges,
        netPnl: netPnl,
        risk: plannedRisk,
        plannedRisk: plannedRisk,
        setup: setup,
        notes: notes,
        provenance: 'manual'
      };

      chrome.storage.local.get(['tlState', 'tlSettings', 'tlLicense', 'tlJournal'], function (res) {
        var settings = R.effectiveSettings(res.tlSettings, res.tlLicense, Date.now());
        var state = res.tlState ? R.syncSession(res.tlState, settings, Date.now()) : R.defaultState(Date.now());

        R.logTrade(state, settings, {
          id: tradeRecord.id,
          symbol: tradeRecord.symbol,
          side: tradeRecord.side,
          entry: tradeRecord.entry,
          exit: tradeRecord.exit,
          qty: tradeRecord.qty,
          pnl: grossPnl,
          charges: charges,
          netPnl: netPnl,
          risk: plannedRisk,
          plannedRisk: plannedRisk,
          setup: setup,
          notes: notes,
          provenance: 'manual',
          source: 'manual'
        }, Date.now());

        var flatJournal = Array.isArray(res.tlJournal) ? res.tlJournal : [];
        flatJournal.unshift(tradeRecord);

        var t = R.tick(state, settings, Date.now());
        chrome.storage.local.set({ tlState: t.state, tlJournal: flatJournal, tlSavedAt: Date.now() }, function () {
          chrome.runtime.sendMessage({ type: 'TL_REFRESH' });

          // Reset inputs and close drawer
          el('jSymbol').value = '';
          el('jEntry').value = '';
          el('jExit').value = '';
          el('jCharges').value = '';
          el('jPlannedRisk').value = '';
          el('jNotes').value = '';
          if (el('jAddFormDrawer')) el('jAddFormDrawer').style.display = 'none';

          loadAll();
          toast('Trade logged to journal');
        });
      });
    });
  }

  // Export Scope Selection
  if (el('jExportScope')) {
    el('jExportScope').addEventListener('change', function () {
      var scope = el('jExportScope').value;
      var box = el('jCustomRangeFields') || el('jCustomRangeBox');
      if (box) box.style.display = scope === 'custom' ? 'flex' : 'none';
    });
  }

  // Export CSV (Formula-Safe)
  if (el('jExportCsv')) {
    el('jExportCsv').addEventListener('click', function () {
      var journal = (currentState && currentState.journal) || { version: 2, months: {} };
      var scope = el('jExportScope') ? el('jExportScope').value : 'month';
      var res = R.exportJournalData(journal, {
        scope: scope,
        month: selectedMonthKey,
        date: R.todayIST(),
        startDate: el('jExportStart') ? el('jExportStart').value : null,
        endDate: el('jExportEnd') ? el('jExportEnd').value : null,
        format: 'csv'
      });

      downloadFile(res.text, res.filename, 'text/csv');
      var conf = el('jExportConfirmation');
      if (conf) {
        conf.style.display = 'block';
        conf.innerHTML = '✓ Exported <b>' + res.recordCount + '</b> trade records to CSV (' + escapeHtml(res.filename) + '). All formula characters sanitized.';
        setTimeout(function () { if (conf) conf.style.display = 'none'; }, 6000);
      }
    });
  }

  // Export JSON
  if (el('jExportJson')) {
    el('jExportJson').addEventListener('click', function () {
      var journal = (currentState && currentState.journal) || { version: 2, months: {} };
      var scope = el('jExportScope') ? el('jExportScope').value : 'month';
      var res = R.exportJournalData(journal, {
        scope: scope,
        month: selectedMonthKey,
        date: R.todayIST(),
        startDate: el('jExportStart') ? el('jExportStart').value : null,
        endDate: el('jExportEnd') ? el('jExportEnd').value : null,
        format: 'json'
      });

      downloadFile(res.text, res.filename, 'application/json');
      var conf = el('jExportConfirmation');
      if (conf) {
        conf.style.display = 'block';
        conf.innerHTML = '✓ Exported <b>' + res.recordCount + '</b> trade records to JSON (' + escapeHtml(res.filename) + ').';
        setTimeout(function () { if (conf) conf.style.display = 'none'; }, 6000);
      }
    });
  }

  // Print Monthly / Daily Report
  if (el('jPrintReport')) {
    el('jPrintReport').addEventListener('click', function () {
      window.print();
    });
  }

  function downloadFile(content, filename, type) {
    var blob = new Blob([content], { type: type });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }

  // ----------------------------------------------------------- actions ----

  if (el('save')) el('save').addEventListener('click', save);
  if (el('headerSaveBtn')) el('headerSaveBtn').addEventListener('click', save);

  NUM.concat(BOOL).forEach(function (k) {
    if (el(k)) {
      el(k).addEventListener('input', markDirty);
      el(k).addEventListener('change', markDirty);
    }
  });
  ['marketOpen', 'holidays', 'blockedHosts'].forEach(function (k) {
    if (el(k)) el(k).addEventListener('input', function () {
      markDirty();
      if (k === 'holidays') renderCalendarStatus(read());
    });
  });
  ['totalCapital', 'dailyRiskPercent', 'perTradeRiskPercent', 'planTradesMirror'].forEach(function (k) {
    if (el(k)) el(k).addEventListener('input', function () { markDirty(); updatePlanSummary(); });
  });

  window.addEventListener('beforeunload', function (e) {
    if (dirty) { e.preventDefault(); e.returnValue = ''; }
  });



  if (el('lockNow')) {
    el('lockNow').addEventListener('click', function () {
      var settings = read();
      chrome.storage.local.get('tlState', function (res) {
        var state = res.tlState ? R.syncSession(res.tlState, settings, Date.now()) : R.defaultState(Date.now());
        if (state.lock && state.lock.active && !state.lock.manual) {
          alert('A rule-triggered discipline lock is active and cannot be converted to a manual focus lock.');
          return;
        }
        if (!confirm('Lock the trading screen until the next market open?')) return;
        R.lockNow(state, settings, Date.now());
        chrome.storage.local.set({ tlState: state, tlSavedAt: Date.now() }, function () {
          chrome.runtime.sendMessage({ type: 'TL_REFRESH' });
          chrome.tabs.query({}, function (tabs) {
            tabs.forEach(function (t) {
              try {
                chrome.tabs.sendMessage(t.id, { type: 'TL_LOCK_NOW' }, function () { void chrome.runtime.lastError; });
              } catch (e) {}
            });
          });
          renderToday(state, settings);
          toast('Locked');
        });
      });
    });
  }

  if (el('testLock')) {
    el('testLock').addEventListener('click', function () {
      var settings = read();
      chrome.storage.local.get('tlState', function (res) {
        var state = res.tlState ? R.syncSession(res.tlState, settings, Date.now()) : R.defaultState(Date.now());
        if (state.lock && state.lock.active && state.lock.reason !== 'preview') {
          alert('Cannot preview lock while an authoritative active trading lock is in effect.');
          return;
        }
        state.lock = {
          active: true, reason: 'preview', since: Date.now(),
          until: Date.now() + 10000, manual: false
        };
        chrome.storage.local.set({ tlState: state }, function () {
          chrome.runtime.sendMessage({ type: 'TL_REFRESH' });
          loadAll();
          setTimeout(function () {
            chrome.storage.local.get('tlState', function (r2) {
              var st = r2.tlState || state;
              if (st.lock && st.lock.reason === 'preview') {
                var v = R.evaluate(st, settings);
                if (v) {
                  st.lock.reason = v.rule;
                  st.lock.until = R.nextMarketOpen(Date.now(), settings);
                } else {
                  st.lock = { active: false, reason: null, since: null, until: null, manual: false };
                }
                chrome.storage.local.set({ tlState: st }, function () {
                  chrome.runtime.sendMessage({ type: 'TL_REFRESH' });
                });
              }
              loadAll();
            });
          }, 10000);
          toast('Preview for 10s');
        });
      });
    });
  }

  if (el('exportBtn')) {
    el('exportBtn').addEventListener('click', function () {
      chrome.storage.local.get(['tlSettings'], function (res) {
        downloadFile(JSON.stringify(res.tlSettings || {}, null, 2), 'trade-lock-rules.json', 'application/json');
      });
    });
  }

  if (el('importBtn')) el('importBtn').addEventListener('click', function () { el('importFile').click(); });
  if (el('importFile')) {
    el('importFile').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      var fr = new FileReader();
      fr.onload = function () {
        try {
          var parsed = JSON.parse(String(fr.result));
          var merged = Object.assign({}, R.DEFAULT_SETTINGS, parsed);
          fill(merged);
          markDirty();
          toast('Loaded — press Save');
        } catch (err) {
          alert('That file is not valid Trade Lock JSON.');
        }
      };
      fr.readAsText(f);
    });
  }

  if (el('exportLogBtn')) el('exportLogBtn').addEventListener('click', function () {
    var rows = (currentState && currentState.log) || [];
    if (!rows.length) { alert('No trades logged today yet.'); return; }
    var csv = 'time,symbol,side,qty,pnl,risk,source\n' + rows.map(function (e) {
      return [new Date(e.at).toISOString(), e.symbol || '', e.side || '', e.qty || 0, e.pnl || 0, e.risk || 0, e.source || ''].map(csvCell).join(',');
    }).join('\n');
    downloadFile(csv, 'trade-lock-log-' + ((currentState.session && currentState.session.date) || 'today') + '.csv', 'text/csv');
  });

  if (el('reportBtn')) el('reportBtn').addEventListener('click', function () {
    var plan = planState(currentSettings, currentLicense);
    if (plan.free) { alert('AI Coach reports are a Pro feature.'); return; }
    var text = globalThis.TLInsights.dailyReport(
      currentState && currentState.log, currentState && currentState.session, currentSettings);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('Report copied'); });
    } else {
      prompt('Copy your day report:', text);
    }
  });

  if (el('enforcementMode')) {
    el('enforcementMode').addEventListener('change', function () {
      toggleFullSiteAckBox(el('enforcementMode').value);
      markDirty();
    });
  }

  // ------------------------------------------------------------- init ----

  initTabs();
  loadAll();
  renderMarketAndOiDashboard();
  renderOptionsChainView();
  setInterval(loadAll, 3000);
})();
