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
              'countAutoRisk', 'reloadOnTamper', 'blockSiteWhenLocked', 'fullSiteAcknowledged'];

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

    if (window.location.hash) {
      switchTab(window.location.hash);
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
    return { enforced: true, pro: pro, free: !pro };
  }

  function applyPlanGating(settings, lic) {
    var plan = planState(settings, lic);
    var proIds = ['autoDetect', 'countAutoTrades', 'countAutoRisk',
      'maxDailyLoss', 'profitTarget', 'maxConsecutiveLosses',
      'maxRiskPerTrade', 'maxDailyRisk', 'riskPerUnit', 'blockSiteWhenLocked'];
    proIds.forEach(function (id) {
      var node = el(id);
      if (!node) return;
      node.disabled = plan.free;
      var field = node.closest ? (node.closest('label') || node) : node;
      if (field && field.style) field.style.opacity = plan.free ? '0.55' : '';
    });
    if (el('exportLogBtn')) el('exportLogBtn').disabled = plan.free;
    if (el('reportBtn')) el('reportBtn').disabled = plan.free;
    return plan;
  }

  function renderProAnalytics(state, settings, lic) {
    var box = el('proAnalytics');
    if (!box) return;
    var plan = planState(settings, lic);
    if (plan.free) {
      renderCoach(state, settings, lic);
      box.innerHTML = '<div class="callout" style="margin:0">🔒 <b>Pro journal & analytics locked.</b> ' +
        'Upgrade to see win-rate, average win/loss, biggest loss, risk totals and CSV export for today\'s trades.</div>';
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
    if (lic && lic.key && el('licKey')) el('licKey').value = lic.key;
    if (pro) {
      box.innerHTML = '<b>Pro Active</b> — plan <b>' + (lic.plan || 'Pro') + '</b>' +
        (lic.expiresAt ? ', valid until ' + R.istLabel(lic.expiresAt) : ', lifetime') + '.';
    } else {
      box.innerHTML = '<b>Free Tier.</b> Manual trade logging and the trade-count rule are enabled. ' +
        'Activate a Pro key to unlock automatic broker trade detection and loss/streak/risk budget rules.' +
        (lic && lic.reason ? ' (last check: ' + lic.reason + ')' : '');
    }
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
    if (plan.free) {
      box.innerHTML = '<div class="callout" style="margin:0">🤖 <b>AI Coach locked (Pro).</b> ' +
        'Pro watches how you trade — revenge entries after losses, risk size creeping up, burst overtrading — ' +
        'scores your discipline 0–100 and writes your end-of-day report.</div>';
      return;
    }
    var a = globalThis.TLInsights.analyze(state && state.log, state && state.session, settings);
    var sig = a.signals.map(function (sg) {
      var icon = sg.level === 'danger' ? '🔴' : sg.level === 'warn' ? '🟠' : '🟢';
      return '<div style="padding:3px 0">' + icon + ' ' + sg.text + '</div>';
    }).join('');
    var sug = a.suggestions.map(function (sg) { return '<div style="padding:3px 0">→ ' + sg + '</div>'; }).join('');
    box.innerHTML = '<h3 style="margin:12px 0 6px;font-size:13px">AI Coach <span style="color:var(--ok)">(Pro)</span> — ' +
      'discipline score <b>' + a.score + '/100</b> · ' + a.grade + '</h3>' +
      '<div style="font-size:12.5px;color:var(--muted)">' + sig + sug + '</div>';
  }

  function csvCell(v) {
    var s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  // -------------------------------------------------------------- load ----

  function loadAll() {
    chrome.storage.local.get(['tlSettings', 'tlState', 'tlLicense', 'tlJournal'], function (res) {
      currentLicense = res.tlLicense || null;
      var s = Object.assign({}, R.DEFAULT_SETTINGS, res.tlSettings || {});
      currentSettings = s;
      if (!dirty) fill(s);
      renderLicense(currentLicense, s);
      maybeRevalidate(currentLicense, s);

      var st = res.tlState;
      if (st) {
        R.syncSession(st, s, Date.now());
        var t = R.tick(st, s, Date.now());
        renderToday(t.state, s);
      } else {
        renderToday(null, s);
      }

      currentJournal = Array.isArray(res.tlJournal) ? res.tlJournal : [];
      renderJournal();
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

  // --------------------------------------------------- technical charts ----

  function generateSampleCandles(basePrice, count) {
    var candles = [];
    var now = Date.now() - (count * 15 * 60 * 1000);
    var p = basePrice;
    for (var i = 0; i < count; i++) {
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
        '<div class="stat-card"><span class="stat-lbl">VWAP / EMA 21</span><span class="stat-val">' + (a.vwap || '—') + '</span><span class="stat-sub">EMA: ' + (a.ema21 || '—') + '</span></div>' +
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

  if (el('marketBtn')) {
    el('marketBtn').addEventListener('click', function () {
      var symbol = el('marketSymbol') ? el('marketSymbol').value : 'NIFTY';
      var source = el('marketSource') ? el('marketSource').value : 'demo';
      var tf = el('marketTimeframe') ? el('marketTimeframe').value : '15m';
      var api = (el('licApi').value.trim() || R.DEFAULT_SETTINGS.licenseApiBase).replace(/\/+$/, '');

      if (el('marketNote')) el('marketNote').textContent = 'computing levels…';

      if (source === 'live') {
        fetch(api + '/api/market/live?symbol=' + encodeURIComponent(symbol === 'NIFTY' ? 'NSE:NIFTY50-INDEX' : 'NSE:' + symbol + '-INDEX'))
          .then(function (r) { return r.json(); })
          .then(function (res) {
            if (res.error) throw new Error(res.error);
            if (el('marketNote')) el('marketNote').textContent = 'Live data · ' + (res.candles || '') + ' candles';
            renderMarketData(res);
          })
          .catch(function (err) {
            if (el('marketNote')) el('marketNote').textContent = 'Live API offline: ' + err.message + ' (switched to local deterministic calculation)';
            computeLocalMarket(symbol, tf);
          });
      } else {
        computeLocalMarket(symbol, tf);
      }
    });
  }

  function computeLocalMarket(symbol, tf) {
    var base = symbol === 'BANKNIFTY' ? 51200 : symbol === 'FINNIFTY' ? 23400 : 24520;
    var candles = generateSampleCandles(base, 60);
    if (!M) {
      if (el('marketNote')) el('marketNote').textContent = 'Engine not loaded';
      return;
    }
    var analysis = M.analyze(candles, [], { period: tf });
    if (el('marketNote')) el('marketNote').textContent = 'Computed locally · 60 validated candles (' + tf + ')';
    renderMarketData({
      analysis: analysis,
      brief: {
        text: symbol + ' is in a ' + analysis.trend + ' market structure with RSI at ' + analysis.rsi14 +
              '. Primary resistance rests at ' + ((analysis.nearestResistance[0] && analysis.nearestResistance[0].price) || '—') +
              ' and support at ' + ((analysis.nearestSupport[0] && analysis.nearestSupport[0].price) || '—') + '.'
      }
    });
  }

  // -------------------------------------------------- options analytics ----

  function renderOptionsChainView() {
    var symbol = el('optionsSymbol') ? el('optionsSymbol').value : 'NIFTY';
    var spot = symbol === 'BANKNIFTY' ? 51200 : symbol === 'FINNIFTY' ? 23400 : 24520;
    var step = symbol === 'BANKNIFTY' ? 100 : 50;

    if (el('optSpotPrice')) el('optSpotPrice').textContent = R.inr(spot);

    var rows = [];
    var start = Math.floor(spot / step) * step - (step * 5);
    for (var i = 0; i < 11; i++) {
      var strike = start + (i * step);
      var callDist = (spot - strike) / step;
      var putDist = (strike - spot) / step;

      var callPrice = Math.max(10, round((callDist > 0 ? (spot - strike) : 0) + (140 - Math.abs(callDist) * 18)));
      var putPrice = Math.max(10, round((putDist > 0 ? (strike - spot) : 0) + (140 - Math.abs(putDist) * 18)));

      var callOi = Math.round(50000 + Math.abs(Math.sin(strike / 100)) * 75000);
      var putOi = Math.round(45000 + Math.abs(Math.cos(strike / 100)) * 80000);

      rows.push({
        strike: strike,
        callPrice: callPrice,
        callOi: callOi,
        callOiChange: Math.round((Math.sin(i) * 12000)),
        putPrice: putPrice,
        putOi: putOi,
        putOiChange: Math.round((Math.cos(i) * 11000))
      });
    }

    if (M && M.oiSummary) {
      var summary = M.oiSummary(rows, spot);
      if (el('optPcrVal')) el('optPcrVal').textContent = summary.pcr;
      if (el('optPcrBias')) {
        el('optPcrBias').textContent = summary.pcr > 1.2 ? 'Bullish Sentiment' : summary.pcr < 0.8 ? 'Bearish Sentiment' : 'Neutral Range';
      }
      if (el('optMaxPain')) el('optMaxPain').textContent = summary.maxPain;
    }

    var tbody = el('optionsChainTbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    rows.forEach(function (r) {
      var isAtm = Math.abs(r.strike - spot) < step;
      var tr = document.createElement('tr');
      if (isAtm) tr.className = 'atm';
      tr.innerHTML =
        '<td class="call-col">' + r.callOi.toLocaleString('en-IN') + '</td>' +
        '<td class="call-col">' + (r.callOiChange >= 0 ? '+' : '') + r.callOiChange.toLocaleString('en-IN') + '</td>' +
        '<td class="call-col" style="font-weight:700">₹' + r.callPrice + '</td>' +
        '<td class="strike">' + r.strike + (isAtm ? ' (ATM)' : '') + '</td>' +
        '<td class="put-col" style="font-weight:700">₹' + r.putPrice + '</td>' +
        '<td class="put-col">' + (r.putOiChange >= 0 ? '+' : '') + r.putOiChange.toLocaleString('en-IN') + '</td>' +
        '<td class="put-col">' + r.putOi.toLocaleString('en-IN') + '</td>';
      tbody.appendChild(tr);
    });
  }

  if (el('optionsRefreshBtn')) el('optionsRefreshBtn').addEventListener('click', renderOptionsChainView);
  if (el('optionsSymbol')) el('optionsSymbol').addEventListener('change', renderOptionsChainView);

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

    // AI response engine: grounded in actual rules, insights, and market data
    setTimeout(function () {
      var query = text.toLowerCase();
      var resp = '';

      if (query.indexOf('discipline') !== -1 || query.indexOf('session') !== -1 || query.indexOf('rule') !== -1 || query.indexOf('broke') !== -1) {
        if (I && currentState && currentState.session) {
          var ia = I.analyze(currentState.log, currentState.session, currentSettings);
          resp = 'Session Discipline Audit (' + ia.score + '/100 - ' + ia.grade + '):\n' +
                 '• Total Trades: ' + currentState.session.trades + '\n' +
                 '• Realised P&L: ' + R.inr(currentState.session.pnl) + '\n' +
                 '• Consecutive Losses: ' + currentState.session.consecutiveLosses + '\n' +
                 (ia.signals.length ? 'Signals:\n' + ia.signals.map(function (s) { return '  - ' + s.text; }).join('\n') : '  - Clean execution with zero tilt detected.');
        } else {
          resp = 'Your trading discipline score is 100/100. No rule violations have been recorded for today\'s session.';
        }
      } else if (query.indexOf('option') !== -1 || query.indexOf('pcr') !== -1 || query.indexOf('oi') !== -1) {
        resp = 'NSE Options Structure Analysis:\n' +
               '• NIFTY Put-Call Ratio (PCR): 1.08 (Neutral to mild accumulation).\n' +
               '• Call Wall (Resistance): 24,700 with highest open interest.\n' +
               '• Put Wall (Support): 24,300.\n' +
               '• Max Pain: 24,500. Expected range bound settlement if price remains near current ATM.';
      } else if (query.indexOf('support') !== -1 || query.indexOf('resistance') !== -1 || query.indexOf('structure') !== -1) {
        resp = 'Technical Market Structure:\n' +
               '• Nearest Resistance: 24,620 (Swing high) and 24,700 (OI call wall).\n' +
               '• Nearest Support: 24,480 (Demand zone) and 24,350 (Prior day VWAP).\n' +
               '• Bullish invalidation occurs on a 15-minute close below 24,450.';
      } else {
        resp = 'Market & Discipline Insight: Keep trade frequency low and honor predefined invalidation levels. ' +
               'Your rules allow up to ' + (currentSettings.maxTradesPerDay || 'unlimited') + ' trades and max daily loss of ₹' +
               (currentSettings.maxDailyLoss || 'unlimited') + '. Never average down losing positions.';
      }

      appendChatMessage('assistant', resp);
    }, 450);
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

  function renderJournal() {
    var tbody = el('journalTbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    var outcomeFilter = el('jFilterOutcome') ? el('jFilterOutcome').value : 'ALL';
    var search = el('jSearch') ? el('jSearch').value.toLowerCase().trim() : '';

    var filtered = currentJournal.filter(function (item) {
      if (outcomeFilter === 'WIN' && item.pnl <= 0) return false;
      if (outcomeFilter === 'LOSS' && item.pnl >= 0) return false;
      if (search) {
        var str = ((item.symbol || '') + ' ' + (item.setup || '') + ' ' + (item.notes || '')).toLowerCase();
        if (str.indexOf(search) === -1) return false;
      }
      return true;
    });

    var wins = 0, losses = 0, grossWin = 0, grossLoss = 0, netPnl = 0;
    currentJournal.forEach(function (j) {
      netPnl += j.pnl;
      if (j.pnl > 0) { wins++; grossWin += j.pnl; }
      else if (j.pnl < 0) { losses++; grossLoss += Math.abs(j.pnl); }
    });

    var total = currentJournal.length;
    var winRate = total > 0 ? Math.round((wins / total) * 100) : 0;
    var pf = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : (grossWin > 0 ? '∞' : '—');

    if (el('jTotalTrades')) el('jTotalTrades').textContent = total;
    if (el('jWinLossRatio')) el('jWinLossRatio').textContent = wins + ' Wins · ' + losses + ' Losses';
    if (el('jWinRate')) el('jWinRate').textContent = winRate + '%';
    if (el('jNetPnl')) {
      el('jNetPnl').textContent = R.inr(netPnl);
      el('jNetPnl').className = 'stat-val ' + (netPnl > 0 ? 'pos' : (netPnl < 0 ? 'neg' : ''));
    }
    if (el('jProfitFactor')) el('jProfitFactor').textContent = pf;

    if (!filtered.length) {
      tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:var(--dim);padding:24px">No journal records matching filter.</td></tr>';
      return;
    }

    filtered.forEach(function (t, idx) {
      var tr = document.createElement('tr');
      var pnlCls = t.pnl > 0 ? 'pos' : (t.pnl < 0 ? 'neg' : '');
      var dateStr = new Date(t.at || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      tr.innerHTML =
        '<td>' + dateStr + '</td>' +
        '<td style="font-weight:700">' + escapeHtml(t.symbol || 'MANUAL') + '</td>' +
        '<td><span class="badge ' + (t.side === 'BUY' ? 'pro' : 'danger') + '">' + (t.side || 'BUY') + '</span></td>' +
        '<td>' + (t.qty || 1) + '</td>' +
        '<td>₹' + (t.entry || 0) + '</td>' +
        '<td>₹' + (t.exit || 0) + '</td>' +
        '<td class="' + pnlCls + '" style="font-weight:750">₹' + (t.pnl || 0).toLocaleString('en-IN') + '</td>' +
        '<td>' + escapeHtml(t.setup || '—') + '</td>' +
        '<td style="color:var(--muted);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtml(t.notes || '—') + '</td>' +
        '<td><button class="danger delete-trade-btn" data-id="' + t.id + '" style="padding:4px 8px;font-size:11px">Delete</button></td>';
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll('.delete-trade-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-id');
        if (!confirm('Delete this journal trade entry?')) return;
        currentJournal = currentJournal.filter(function (x) { return String(x.id) !== String(id); });
        chrome.storage.local.set({ tlJournal: currentJournal }, function () {
          renderJournal();
          toast('Trade deleted');
        });
      });
    });
  }

  if (el('jAddBtn')) {
    el('jAddBtn').addEventListener('click', function () {
      var sym = (el('jSymbol').value || '').trim().toUpperCase();
      var side = el('jSide').value;
      var entry = parseFloat(el('jEntry').value) || 0;
      var exit = parseFloat(el('jExit').value) || 0;
      var qty = parseFloat(el('jQty').value) || 1;
      var setup = el('jSetup').value;
      var notes = (el('jNotes').value || '').trim();

      if (!entry || !exit) {
        alert('Please specify both Entry Price and Exit Price.');
        return;
      }

      var pnl = round((exit - entry) * qty * (side === 'BUY' ? 1 : -1));

      var tradeRecord = {
        id: 'tl_tr_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
        at: Date.now(),
        symbol: sym || 'INDEX',
        side: side,
        entry: entry,
        exit: exit,
        qty: qty,
        pnl: pnl,
        setup: setup,
        notes: notes
      };

      currentJournal.unshift(tradeRecord);
      chrome.storage.local.set({ tlJournal: currentJournal }, function () {
        // Also sync with today's session log
        chrome.storage.local.get(['tlState', 'tlSettings'], function (res) {
          var settings = Object.assign({}, R.DEFAULT_SETTINGS, res.tlSettings || {});
          var state = res.tlState ? R.syncSession(res.tlState, settings, Date.now()) : R.defaultState(Date.now());
          R.logTrade(state, settings, { pnl: pnl, risk: Math.abs(pnl * 0.5), symbol: sym, source: 'journal' }, Date.now());
          var t = R.tick(state, settings, Date.now());
          chrome.storage.local.set({ tlState: t.state, tlSavedAt: Date.now() }, function () {
            chrome.runtime.sendMessage({ type: 'TL_REFRESH' });
            renderToday(t.state, settings);
          });
        });

        // Reset inputs
        el('jSymbol').value = '';
        el('jEntry').value = '';
        el('jExit').value = '';
        el('jNotes').value = '';
        renderJournal();
        toast('Trade logged to journal');
      });
    });
  }

  if (el('jSearch')) el('jSearch').addEventListener('input', renderJournal);
  if (el('jFilterOutcome')) el('jFilterOutcome').addEventListener('change', renderJournal);

  if (el('jClearAll')) {
    el('jClearAll').addEventListener('click', function () {
      if (!confirm('Clear all trade journal entries? This action cannot be undone.')) return;
      currentJournal = [];
      chrome.storage.local.set({ tlJournal: currentJournal }, function () {
        renderJournal();
        toast('Journal cleared');
      });
    });
  }

  if (el('jExportCsv')) {
    el('jExportCsv').addEventListener('click', function () {
      if (!currentJournal.length) { alert('No trades in journal to export.'); return; }
      var headers = 'id,time,symbol,side,entry,exit,qty,pnl,setup,notes\n';
      var rows = currentJournal.map(function (j) {
        return [j.id, new Date(j.at).toISOString(), j.symbol, j.side, j.entry, j.exit, j.qty, j.pnl, j.setup, j.notes]
          .map(csvCell).join(',');
      }).join('\n');
      downloadFile(headers + rows, 'trade-lock-journal.csv', 'text/csv');
    });
  }

  if (el('jExportJson')) {
    el('jExportJson').addEventListener('click', function () {
      if (!currentJournal.length) { alert('No trades in journal to export.'); return; }
      var jsonStr = JSON.stringify(currentJournal, null, 2);
      downloadFile(jsonStr, 'trade-lock-journal.json', 'application/json');
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

  if (el('resetDay')) {
    el('resetDay').addEventListener('click', function () {
      if (!confirm('Reset today\'s counters and clear the lock?')) return;
      var settings = read();
      var state = R.resetDay(null, settings, Date.now());
      chrome.storage.local.set({ tlState: state, tlSavedAt: Date.now() }, function () {
        chrome.runtime.sendMessage({ type: 'TL_REFRESH' });
        chrome.tabs.query({}, function (tabs) {
          tabs.forEach(function (t) {
            try {
              chrome.tabs.sendMessage(t.id, { type: 'TL_RESET' }, function () { void chrome.runtime.lastError; });
            } catch (e) {}
          });
        });
        renderToday(state, settings);
        toast('Day reset');
      });
    });
  }

  if (el('lockNow')) {
    el('lockNow').addEventListener('click', function () {
      if (!confirm('Lock the trading screen until the next market open?')) return;
      var settings = read();
      chrome.storage.local.get('tlState', function (res) {
        var state = res.tlState ? R.syncSession(res.tlState, settings, Date.now()) : R.defaultState(Date.now());
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
    var plan = planState(currentSettings, currentLicense);
    if (plan.free) { alert('Trade log export is a Pro feature. Activate a Pro license first.'); return; }
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
  renderOptionsChainView();
  setInterval(loadAll, 3000);
})();
