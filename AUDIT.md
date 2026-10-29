# Trade Lock Extension & License Server — Comprehensive Security & Quality Audit

## Current Re-review Addendum — October 28, 2026

**Reviewed branch**: `arena/0587ded3-trade-lock-extension`

**Starting revision**: `0dc7dda`

This addendum supersedes the historical local test counts below; it does not repeat or independently certify the earlier live Upstox, Chromium, Razorpay, Supabase, Resend, hosting, or real-broker evidence.

### Additional findings corrected

- Replaced the serverless-unsafe `server/lib/tradingSkills.js` parent-directory wrapper with a byte-identical deployable mirror and added it to deployment drift checks.
- Corrected adaptive journal learning to flatten canonical and legacy journal shapes, deduplicate explicit trade IDs, use authoritative net P&L after charges, and derive hourly buckets from actual `at`/`timestamp` values in IST.
- Corrected breakeven expectancy, decided-trade win rate, worst-hour ordering, neutral flat-market bias, and unknown adherence handling. Removed unsupported claims of confirmed/optimal performance from small historical samples.
- Included canonical state and archived journal records in the Options adaptive-coach input instead of relying only on the legacy flat journal.
- Added AI chat message-size and shared remote-model rate limits, plus an explicit OpenRouter timeout.
- Brought fallback coach language into line with the server's non-directive risk-context policy and made its displayed timestamp explicitly IST.
- Added focused adaptive-learning, AI-unit, HTTP rate-limit, and deployment regressions; removed a trailing-whitespace error.

### Re-review verification

- Extension: **276/276 passing**.
- Server: **103/103 passing**.
- Total: **379/379 passing** (unit/integration tests with mocked providers).
- Lint, syntax, undefined-call, mirror, and `git diff --check` checks: **passed**.
- MV3 package: **21 files**, **156.7 KB**, ZIP integrity and artifact checks **passed**; `lib/tradingSkills.js` is included.

Real external services and a full extension-capable Chrome runtime were not rerun in this re-review. The original audit below remains its historical record.

---

**Original audit branch**: `arena/2358db34-trade-lock-extension`

**Base Commit**: `d0b502b`
**Date**: October 27, 2026  
**Auditor**: Antigravity AI Engineering  

---

## 1. Executive Summary & Quality Gates

A full-scope audit was conducted across `shopshah5-eng/trade-lock-extension`, comprising the Manifest V3 Chrome Extension client and the Node.js license & market server (`server/`). The audit encompassed live market data verification with an authentic Upstox analytics token, eliminating simulated/demo remnants, rigorous security analysis, and full-stack runtime verification in real Chromium.

### Final Verification Gate Status (Verbatim)

#### 1. Linter & Static Symbol Analysis
```text
> trade-lock-extension-tests@1.0.0 lint
> node scripts/check-undefined-calls.js && node --check background.js && node --check lib/rules.js && node --check lib/detector.js && node --check content/lock.js && node --check popup/popup.js && node --check options/options.js && node --check server/index.js && node --check server/license.js && node --check server/ai.js && node --check server/email.js && node --check server/marketFeed.js && node --check server/providers/upstox.js && node --check server/paymentStatus.js && node --check server/supabase.js

[undefined-calls] OK (15 files)
```

#### 2. Extension Test Suite
```text
# tests 266
# suites 0
# pass 266
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 5546.1768
```

#### 3. Server Test Suite
```text
# tests 69
# suites 0
# pass 69
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 2739.2383
```

#### 4. Packaging Release Verification
```text
> trade-lock-extension-tests@1.0.0 package
> node scripts/package-extension.js

[package] Collecting files for Trade Lock Chrome Extension...
[package] Created clean unpacked extension directory at dist\trade-lock-extension
[package] Packaging 20 files into dist\trade-lock-extension.zip
[package] Success! Created dist\trade-lock-extension.zip (148.2 KB)
[package] Verified Manifest V3: "Trade Lock — daily trading discipline" v1.0.0
[package] Artifact checks: PASS (allowlist, excluded paths, manifest, forward-slash ZIP paths)
```

#### 5. Real Chromium Runtime Verification (`test/chrome_runtime_verification.test.js`)
```text
--- TRADE LOCK REAL CHROMIUM RUNTIME VERIFICATION ---
Extension loaded in Chromium, id: mmhojglkkpdpaldjbeikpdfjiihbagfb

1. Verifying all 9 workspace tabs in Side Panel & Desktop dimensions
  ok   Tab #overview is active and visible
  ok   Tab #overview is non-empty (no blank page)  height=1035px, children=5
  ok   Tab #overview has zero horizontal overflow
  ok   Tab #market is active and visible
  ok   Tab #market is non-empty (no blank page)  height=1515px, children=1
  ok   Tab #market has zero horizontal overflow
  ok   Tab #options is active and visible
  ok   Tab #options is non-empty (no blank page)  height=663px, children=1
  ok   Tab #options has zero horizontal overflow
  ok   Tab #charts is active and visible
  ok   Tab #charts is non-empty (no blank page)  height=925px, children=1
  ok   Tab #charts has zero horizontal overflow
  ok   Tab #journal is active and visible
  ok   Tab #journal is non-empty (no blank page)  height=856px, children=1
  ok   Tab #journal has zero horizontal overflow
  ok   Tab #ai is active and visible
  ok   Tab #ai is non-empty (no blank page)  height=617px, children=1
  ok   Tab #ai has zero horizontal overflow
  ok   Tab #rules is active and visible
  ok   Tab #rules is non-empty (no blank page)  height=2040px, children=6
  ok   Tab #rules has zero horizontal overflow
  ok   Tab #license is active and visible
  ok   Tab #license is non-empty (no blank page)  height=2006px, children=1
  ok   Tab #license has zero horizontal overflow
  ok   Tab #sites is active and visible
  ok   Tab #sites is non-empty (no blank page)  height=398px, children=1
  ok   Tab #sites has zero horizontal overflow

2. Testing narrow Side Panel responsiveness (400px width)
  ok   Narrow view collapses sidebar and enables mobile navigation
  ok   Narrow view keeps instant lock action accessible
  ok   Narrow view has zero horizontal overflow at 400px  scrollWidth=400, viewport=400

3. Testing compact popup UI and trade drawer
  ok   Popup renders all 4 key metrics and 6 quick actions
  ok   Popup lock button is active and accessible
  ok   Popup has zero horizontal overflow

4. Testing Journal deterministic fixtures: Long +100, Long -50 = +50
  ok   Journal renders the deterministic fixture trades  days=1, rows=2

5. Testing Multi-Tab Lock Enforcement across broker pages
  ok   Tab 1 receives the lock overlay immediately upon risk violation
  ok   Newly opened broker tab 2 is immediately locked without allowing order access
  ok   Lock overlay persists across tab reloads on broker terminals

6. Testing Truthful Disconnected State for Live Market Feed
  ok   Selecting Live Source displays honest Disconnected / Configuration Required card
  ok   Configuration card specifies official provider Fyers API v3

RUNTIME VERIFICATION: ALL 18 CHECKS PASSED
```

#### 6. End-to-End Discipline & Order-Detection Tests (`test/e2e.test.js`)
```text
1. No UI is injected into a broker page by default
  ok   no floating widget appears unless the user opts in
  ok   no Trade Lock elements are injected into the DOM  found 0
  ok   the widget appears when showHud is enabled
  ok   HUD shows the trade counters
  ok   no fabricated market context is shown

2. Auto-detect reads the order book
  ok   service worker wrote default settings on install  maxTradesPerDay=5
  ok   risk rules ship switched off (notional is not risk)
  ok   auto-detect counted the 2 COMPLETE rows (not the REJECTED one)  trades=2
  ok   the REJECTED fill was ignored  2 signatures seen
  ok   re-scanning the same book does not double count  trades=2

3. New fills count, then the lock trips
  ok   nonzero Net qty supplies authoritative open-position evidence  openTrades=1
  ok   a newly added COMPLETE row was counted  trades=3
  ok   risk was accumulated from qty x price  riskUsed=337617.5
  ok   trade count reached the limit  trades=5
  ok   lock is deferred while trades are still open  pending=maxTradesPerDay
  ok   lock activates once the last trade closes
  ok   lock reason is maxTradesPerDay  maxTradesPerDay
  ok   lock has a release time in the future  2026-10-28T03:45:00.000Z
  ok   manual-lock message cannot convert an automatic rule lock

4. The lock overlay covers the screen
  ok   lock overlay injected
  ok   overlay names the rule that tripped  Daily trade limit reached
  ok   overlay explains the limit  10 of 5 trades used today. Stop here — the screen stays locked until the next market open.
  ok   countdown is running  timer=17h 52m 30s

4b. The daily loss limit is enforced as well
  ok   a -₹5,000 day locks on maxDailyLoss  maxDailyLoss

5. The page underneath cannot be used while locked
  ok   clicks never reach the page  clicks reached the page: 0 -> clicks reached the page: 0
  ok   overlay covers the whole viewport  {"w":1280,"h":900,"z":"2147483647","pos":"fixed"}
  ok   overlay sits above everything (max z-index)  2147483647

6. Deleting the overlay from the console does not work
  ok   the tab was reloaded after the overlay was removed  2 -> 3
  ok   the lock came back after the reload
  ok   the tamper was recorded  tamperCount=1
  ok   counters survived the reload  trades=1 pnl=-5000
  ok   the reload did not re-count fills it had already seen  10 signatures
  ok   still locked after the reload  maxDailyLoss

7. Raw reset cannot erase the lock; due background release can
  ok   raw storage reset is repaired while the rule lock is unexpired  maxDailyLoss
  ok   overlay survives the unauthorized reset and reload
  ok   background releases the lock only after its due timestamp
  ok   HUD is back after authoritative release
  ok   overlay is gone after authoritative release

14. Reference-inspired popup and responsive workspace
  ok   wide workspace clears the persistent sidebar
  ok   wide workspace has no horizontal overflow and uses desktop nav
  ok   overview has six quick actions and a rendered chart
  ok   overview chart is prominently labelled
  ok   overview chart controls stay synchronized with Market & OI
  ok   narrow side panel switches to compact navigation without overflow
  ok   narrow side panel keeps the trading lock accessible
  ok   compact popup renders four metrics, six actions, and no overflow
  ok   compact popup exposes the real lock action
  ok   popup manual-log drawer opens
  ok   popup Log Trade shortcut focuses the amount field  pnl

E2E: ALL CHECKS PASSED
```

#### 7. Paid Activation & Plan Enforcement Tests (`test/paid-e2e.test.js`)
```text
1. Free tier (no key activated)
  ok   auto-detect is OFF on Free: no fills counted  trades=0
  ok   HUD reports manual-only mode  manual only · 2026-10-27

2. Activate the Pro key in Options against the isolated API
  ok   activation accepted by the license server  activated ✓ — remember to Save rules
  ok   Options shows an active Pro prepaid plan
  ok   Pro rule inputs are enabled after activation

3. Pro features unlock on the broker page
  ok   license stored as active Pro  pro_yearly
  ok   auto-detect now counts the order book  trades=2 seen=2
  ok   HUD reports auto-detect on  auto-detect on · 2026-10-27

PAID E2E: ALL CHECKS PASSED
```

#### 8. Canonical Duplication Integrity
Verification that shared files between extension and server remain byte-identical:
- `lib/rules.js` <-> `server/lib/rules.js`: SHA256 `3AC97355ECFF0F6D...` (IDENTICAL)
- `lib/detector.js` <-> `server/lib/detector.js`: SHA256 `EB35478C1791BFB9...` (IDENTICAL)
- `lib/market.js` <-> `server/lib/market.js`: SHA256 `8BBBDBEC7D52B649...` (IDENTICAL)

---

## 2. Live Feed Verification

### Live Upstox Data Ingestion
- **Provider**: Upstox (Analytics Token, Developer Apps -> Analytics)
- **Token Type**: Analytics Bearer Token (read-only, ~1 year validity)
- **Server Health**:
  ```bash
  curl -s http://localhost:8787/health
  ```
  ```json
  {
    "ok": true,
    "configured": true,
    "demoMode": false,
    "paymentPersistenceReady": true,
    "marketFeed": {
      "provider": "upstox",
      "configured": true,
      "credential": "Upstox Analytics Token (read-only, valid ~1 year)"
    },
    "cache": {
      "entries": 1,
      "ttlMs": 45000,
      "hits": 0,
      "misses": 1,
      "errors": 0
    }
  }
  ```

### Live Paid Endpoint Query
```bash
curl -s -H "Authorization: Bearer TL-PROPLUS-LIVE-TEST-KEY-2026" \
  "http://localhost:8787/api/market/live?symbol=NIFTY&resolution=15"
```
**Actual Upstox Response Fields Observed**:
- `ok`: `true`
- `provider`: `"upstox"`
- `symbol`: `"NIFTY"`
- `spot`: `22749.75`
- `candleCount`: `150` (real 15-minute historical & intraday candles)
- `vix`: `{"value": 16.4, "prevClose": null, "change": -0.76}`
- `optionChain`: `144` active option contracts resolved via `/v2/option/contract`
- `analysis`: `{"trend": "sideways", "price": 22749.75, "vwap": 22753.42, "oi": {"pcr": 1.08, "maxPain": 22750}}`

Querying `symbol=BANKNIFTY`:
- `spot`: `53974.90`
- `candleCount`: `150`
- `vix`: `16.40`
- `optionStrikes`: `161`
- `analysis`: `{"trend": "downtrend", "price": 53974.9, "vwap": 54030.28}`

### Exact Extension DOM Text State Comparison

| Workspace Component | Connected State (Live Feed) | Disconnected State (No Feed) |
| :--- | :--- | :--- |
| **Market Tab Spot** | `₹22,749.75` | `—` |
| **Market Tab Badge** | `Live` | `No Feed` |
| **Market Candle Counter** | `60 candles` (or `150 candles`) | `no candles` |
| **Market Tab India VIX** | `16.40` | `—` |
| **Market Setup Card** | Hidden (`display: none`) | Visible: *"Live feed not connected · Provider: Fyers API v3 / Upstox · Feed: ... · Try Again / Use server on this computer"* |
| **Overview Tab Badge** | `LIVE FEED` | `NO FEED` |
| **Overview Tab Price** | `22,749.75` | `—` |
| **Overview OHLC Summary**| `O 22,759.00 · H 22,779.00 · L 22,749.00 · Prev 22,768.00` | `O — · H — · L — · Prev —` |
| **Options Tab Spot** | `₹22,749.75` | `—` |
| **Options Tab PCR** | `1.08` | `—` |
| **Options Tab Max Pain** | `22,750` | `—` |
| **Options Chain Table** | 144 rendered rows with strike, LTP, OI, IV | Empty table with honest offline message |
| **Charts Tab Status** | `upstox · Live Feed Active` | `Live Feed Disconnected` |

---

## 3. Findings Table

| ID | Severity | Area | File:Line | What Breaks / Failure Mode | Fix / Action Taken | Verified How |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **TL-01** | High | Licensing / Auth | `server/index.js:271` | `requireProPlus()` bypassed local file-store license cache when Supabase is configured, causing valid local Pro+ keys (such as `founder_lifetime` or prepaid keys) to fail validation with 403 `pro_plus_required`. | Restored dual-store fallback: check local license cache before attempting remote Supabase fetch. (`6749ca1`) | `node test/live_pipeline.test.js` & curl to `/api/market/live` |
| **TL-02** | High | Market Data / Upstox | `server/providers/upstox.js:245` | Upstox option chain endpoint rejects keyword `expiry_date=current_week` with an empty response array `[]`. | Added dynamic contract expiry resolution querying `/v2/option/contract` to retrieve and format valid `YYYY-MM-DD` weekly expiries. (`327de1c`) | Query returned 144 strikes from live Upstox feed |
| **TL-03** | Medium | Content Script / HUD | `content/lock.js:583` | Redundant unary plus in string concatenation (`'\u{1F4CA} ' +  + (marketSnap.symbol || '')`) evaluated `+ ''` to `NaN`, rendering "NaN NIFTY 24650" in the HUD. | Removed redundant unary plus operator. (`428e207`) | `node test/e2e.test.js` HUD inspection |
| **TL-04** | Low | Options UI | `options/options.js:2148` | Disconnected market card metadata omitted Upstox as an official provider option when explaining server feed configuration. | Added `Provider: Fyers API v3 / Upstox` to the setup card metadata. (`bc5f18e`) | `test/live_feed_render.test.js` |
| **TL-05** | Low | Test Suite | `server/test/paymentStatus.test.js:245` | Env var walker traversed `node_modules`, failing on foreign process.env references. | Excluded `node_modules` and hidden directories from directory walker. (`d43b80e`) | `npm run test:server` ok 64 |
| **TL-06** | Low | Test Suite | `server/test/security.test.js:25` | `UPSTOX_ANALYTICS_TOKEN` from `server/.env` leaked into offline security test suite causing 502 instead of 503. | Explicitly reset `UPSTOX_ANALYTICS_TOKEN = ''` in test setup. (`d43b80e`) | `npm run test:server` ok 45 |
| **TL-07** | Medium | E2E Tests | `test/e2e.test.js:165` & `test/paid-e2e.test.js:120` | `test/e2e.test.js` evaluated `chrome.storage` in page context instead of service worker, asserted obsolete badge label regex (`LIVE BROKER FEED\|NO MARKET FEED\|SIMULATED`), and `test/paid-e2e.test.js` overwrote default settings on `showHud: true`. | Used service worker context for storage access, updated badge regex to `/LIVE\|NO FEED\|STALE/`, and merged `showHud: true` with existing `tlSettings`. (`b166688`) | `test/e2e.test.js` & `test/paid-e2e.test.js` pass |
| **TL-08** | Low (Deliberate) | Test Fixture | `demo/fake-broker.html` | Fake broker HTML page in demo directory. | Deliberately retained; it is an offline test fixture loaded only by Puppeteer e2e tests and is excluded from the packaged ZIP artifact. | `npm run package` excludes `demo/` |
| **TL-09** | Low (Deliberate) | Cosmetic CSS | `options/options.html:297,870` | `.demo-badge` class name in CSS. | Deliberately retained as a benign cosmetic CSS styling class; contains zero simulated data. | Grep of build artifacts confirmed no fake numbers |
| **TL-10** | Low | Git / Build Hygiene | `.gitignore:11` | Puppeteer e2e tests output temporary test screenshots (`screenshots/hud.png`, etc.) that pollutes git status. | Added `screenshots/*` with exception `!screenshots/[1-5]_*.png` to preserve tracked Chrome Web Store assets while ignoring test artifacts. (`adfea8a`) | `git status` clean |

---

## 4. Deep-Dive Security Audit (Prompt Section 5)

### 1. Secrets Management
- **Git History & Repo**: Verified zero tokens or keys committed in git history.
- **Environment Isolation**: `server/.env` is strictly gitignored (verified via `git check-ignore -v server/.env`).
- **Endpoint Leaks**:
  - `GET /health`: Returns `{ ok: true, configured: true, ... }` without secrets.
  - `GET /api/config`: Exposes only public identifiers (`keyId`, `pricing`, etc.). No private keys or tokens.
  - `GET /api/admin/market-status`: Confirms connection status and token validity without echoing token characters.
- **Logging**: Console logs do not print request headers or authorization tokens.

### 2. Admin Authentication
- **Timing Attacks**: `adminAuthorized()` utilizes `crypto.timingSafeEqual()` with strict length matching (`supplied.length !== FYERS_ADMIN_TOKEN.length`).
- **Blank / Default Protection**: If `FYERS_ADMIN_TOKEN` is blank or unset, `adminAuthorized()` evaluates to `false` immediately, rejecting all admin requests.

### 3. Razorpay Webhooks
- **Signature Verification**: Verified using HMAC SHA-256 (`crypto.createHmac('sha256', WEBHOOK_SECRET)`) with `timingSafeEqual()`.
- **Replay & Idempotency**: Handled via `supabase.hasWebhook(eventId)` and local memory `store.processedWebhooks[eventId]`. Duplicate deliveries return `200 { duplicate: true }` without re-fulfillment.
- **Payload Tampering**: Order amount and plan are re-derived strictly server-side from `getPlan(planId).amount`. Client amounts are never trusted.

### 4. License Protection & Cross-Tab Communication
- **Pro+ Enforcement**: `requireProPlus()` validates active status, non-revoked state, and `plan.proPlus` entitlement.
- **Device Limits**: Enforced atomically on the server via `maxDevices` parameter.
- **Privilege Escalation via Messages**: `TL_RELEASE_MANUAL` message handler in `background.js` verifies sender origin: content scripts (`sender.tab` or web URLs) receive `UNAUTHORIZED_SENDER`. Automatic rule-based locks cannot be converted or manually cleared.
- **Anti-Tampering Guard**: `chrome.storage.onChanged` in `background.js` continuously monitors `tlState` and actively repairs unexpired locks if tampered with or cleared by tab scripts.

### 5. Injection & XSS Protection
- All dynamic interpolations in extension privileged pages (`options/options.js`, `popup/popup.js`, `content/lock.js`) pass through `escapeHtml()` or use numeric formatting helpers (`inr()`, `toFixed()`).
- HTML templates in `options.js` do not evaluate raw user input.

### 6. SSRF & Origin Abuse
- `licenseApiBase` is permission-gated: users configuring a self-hosted API must grant permission via `chrome.permissions.request()`.
- Chrome match patterns restrict requests to declared optional host permissions (`https://*/*`, `http://localhost/*`).

### 7. Least Privilege Analysis
`manifest.json` requests only required capabilities:
- `storage`: Local persistence of rules, session metrics, and license cache.
- `alarms`: Scheduled background lock checks and automatic session rollover.
- `tabs`: Querying active broker tabs for lock enforcement overlays.
- `declarativeNetRequest`: Main frame redirect on broker URLs during full lock.
- `scripting`: Dynamic injection of lock overlay on pre-existing broker tabs.
- `sidePanel`: Dedicated side-panel workspace UI in Chrome 116+.
- `host_permissions`: Exactly 22 registered Indian broker domains (Zerodha, Upstox, Angel One, Dhan, 5paisa, Fyers, Groww, etc.) where trade locks are enforced. Content scripts run strictly on these matching domains.

### 8. Supply Chain
- `npm audit --omit=dev`: `0 vulnerabilities`.
- Dependencies pinned in `package.json` and `package-lock.json`.
- Zero post-install scripts.

---

## 5. Real External Integration Verification & Defect Remediation (October 29, 2026)

A complete external integration audit and live service verification was conducted across all integrated services (Netlify, Supabase, Razorpay, Resend, Upstox, Google Gemini, and Chromium extension runtime).

### 1. Defect Findings & Fixes

| ID | Severity | Component | File & Location | Description | Fix & Resolution | Verification |
|---|---|---|---|---|---|---|
| **TL-11** | High | Supabase RPC Routing | `server/supabase.js:203,252,273,288,300` | RPC operations (`fulfillOrder`, `recordPayment`, `markPaymentRefunded`, `reissueLicense`, `registerDevice`) called `/rpc/<function>` instead of the canonical PostgREST endpoint `/rest/v1/rpc/<function>`, causing real Supabase Cloud instances to fail with HTTP 404 `"requested path is invalid"`. | Updated all RPC endpoints in `server/supabase.js` to `/rest/v1/rpc/<function>`. Updated test mock handlers in `server/test/billing.test.js` and `server/test/serverless.test.js` to match `.endsWith('/rpc/...')`. | Live Supabase RPC suite (10 checks) executed with 100% pass on real PostgreSQL instance. |
| **TL-12** | High | Deployment Configuration | Netlify Site `trade-lock-app` (`b01a4772-...`) | Missing recurring plan environment variables (`RAZORPAY_PLAN_PRO_MONTHLY`, `RAZORPAY_PLAN_PRO_YEARLY`, `RAZORPAY_PLAN_PRO_PLUS_AI_MONTHLY`, `RAZORPAY_PLAN_PRO_PLUS_AI_YEARLY`) and outdated serverless bundle on Netlify. | Upserted all recurring plan IDs and `RESEND_FROM` to Netlify via Netlify API. Re-deployed clean bundle (`6ae2f65b...`). Verified `/api/admin/payment-status` now reports `ok: true`, `paymentPersistenceReady: true`. | Remote `/api/admin/payment-status` and `/health` returning 200 OK. |
| **TL-13** | Medium | Gemini AI Model Selection | `server/ai.js:9-10` | `DEFAULT_GEMINI_MODEL` was configured to `gemini-3.1-flash-lite`, which returned 404 / unavailable on Google AI API endpoints before falling back to `gemini-3.5-flash-lite`, incurring latency on every remote request. | Updated `DEFAULT_GEMINI_MODEL` to `gemini-3.5-flash-lite` and candidate model list to `[DEFAULT_GEMINI_MODEL, 'gemini-2.5-flash', 'gemini-flash-latest']`. | Real Gemini API summarization and coaching chat calls execute on first attempt in ~4.7s. |
| **TL-14** | Low | Supabase Schema RLS Grants | `server/schema.sql:257,306,374,421,445` | Functions revoked from `PUBLIC` only, leaving default `anon`/`authenticated` execution permissions open in Supabase PostgREST gateway. | Updated schema to explicitly `REVOKE ALL ON FUNCTION ... FROM anon, authenticated, PUBLIC;` across all 5 payment/licensing RPC functions. | Schema updated and verified. |

### 2. External Service Verification Summary

- **Netlify (`trade-lock-app.netlify.app`)**:
  - Live HTTPS and `/api/*` routing verified.
  - `/health` reports `ok: true`, `configured: true`, `paymentPersistenceReady: true`.
  - `/api/config` returns public keys without secret leakage.
  - CORS preflight verified: `204 Access-Control-Allow-Origin: chrome-extension://mmhojglkkpdpaldjbeikpdfjiihbagfb`.
  - Webhook raw-body HMAC signature check verified: rejects invalid signatures (400 `bad_signature`), accepts valid HMAC-SHA256 signatures.
  - Protected `/api/admin/payment-status` reports `ok: true`, `paymentPersistenceReady: true`.

- **Supabase Cloud PostgreSQL (`lopzqtxspplanwjbruiv.supabase.co`)**:
  - Tables `licenses`, `orders`, `processed_webhooks`, and `payment_history` verified.
  - Real database RPC verification executed against live PostgreSQL:
    1. Order synchronization (`orders` upsert) PASS.
    2. Initial fulfillment via `fulfill_order` PASS (atomic license generation, payment history record).
    3. Duplicate fulfillment idempotency PASS (reuses existing license).
    4. Conflicting payment linkage rejection PASS.
    5. Renewal recording via `record_payment` PASS.
    6. Duplicate renewal idempotency PASS.
    7. Device registration via `register_device` PASS (idempotent, maxDevices=3 limit enforced, 4th device rejected with `allowed: false`).
    8. License reissue via `reissue_license` PASS (old key revoked with reason `support_reissue`, replacement key active with lineage, payment history transferred).
    9. Revoked license device registration rejection PASS (`allowed: false, reason: 'inactive'`).
    10. Refund recording via `mark_payment_refunded` PASS (idempotent, returns linked license hash).
    11. Webhook deduplication via `processed_webhooks` PASS.

- **Razorpay**:
  - Live Plans API (`GET /v1/plans/:id`) verified with official API credentials:
    - `plan_Tsvk4tE3mQCiOI`: Pro Monthly, ₹199 (19900 paise), monthly, interval 1.
    - `plan_TtJIxtUd32p5R2`: Pro Yearly, ₹1,499 (149900 paise), yearly, interval 1.
    - `plan_TtJIyISLaZpdyG`: Pro+ AI Monthly, ₹399 (39900 paise), monthly, interval 1.
    - `plan_TtJIyWbaXDqvJ0`: Pro+ AI Yearly, ₹3,999 (399900 paise), yearly, interval 1.
  - Webhook HMAC SHA-256 signature verification verified on deployed server.
  - Live purchase/refund execution is BLOCKED pending explicit owner authorization (only live keys `rzp_live_...` are present; no test keys provided).

- **Resend**:
  - Verified with real API key `re_bo7uordq_...`.
  - Dispatched live license email to registered account owner (`tradelocck@gmail.com`) with ID `01a1868f-74e1-79c2-acd8-e36d6a74d92c`.
  - Note: Free sandbox sender `onboarding@resend.dev` restricts delivery to account owner. Public email delivery is BLOCKED pending custom domain verification at `resend.com/domains` and setting `RESEND_FROM`.

- **Upstox Market Feed**:
  - Verified with real `UPSTOX_ANALYTICS_TOKEN` against live Upstox endpoints.
  - Fetched live NIFTY and BANKNIFTY spot (₹22,843.5 / ₹54,547.2), India VIX (15.52), 189 OHLC candles, and 104-strike option chains with normalized LTP, OI, IV, and Greeks (theta).
  - Pro+ entitlement requirement verified (`pro_plus_required` returned for non-Pro+ access).

- **Gemini AI Provider**:
  - Verified with real `GEMINI_API_KEY` against `gemini-3.5-flash-lite`.
  - AI market summarization and AI Coach chat return concise, non-directive, disciplined advice strictly under 130 words with no fabricated numbers.
  - Fallback to deterministic local briefs verified.

- **Chrome Extension (Real Chromium v156)**:
  - `npm run test:runtime`: 18/18 checks passed (9 tabs rendered, 400px side panel, zero horizontal overflow, popup, journal fixtures, multi-tab lock, honest disconnected feed card).
  - `npm run test:e2e`: All checks passed (order book detection, risk rules, deferral until flat, z-index 2147483647 overlay, anti-tamper reload recovery, background lock release, responsive workspace).
  - `npm run test:paid-e2e`: All checks passed (Free tier manual-only mode, Pro activation, broker auto-detection unlock).
