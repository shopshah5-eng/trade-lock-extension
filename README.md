# Trade Lock — daily trading discipline for Chrome

Trade Lock is a Manifest V3 browser extension that records a trading session and locks supported web terminals when a configured discipline limit is reached. It includes manual journaling, generic order-table detection, session rollover, recurring/lifetime license validation with legacy prepaid compatibility, and optional market analytics.

**Safety boundary:** Trade Lock is a browser discipline aid, not a broker-side risk control or a guarantee that an order cannot be placed. It cannot stop orders from another browser, device, API, or mobile app. DOM detection and order-button interception depend on each broker's current UI. Always keep an independent way to manage or exit open positions.

## Rules and session behavior

Available rules are:

- maximum completed rows/fills per day;
- maximum realised daily loss;
- realised profit target;
- maximum consecutive losing entries;
- maximum estimated risk per entry and cumulative daily risk.

A trading session starts at **09:15 IST** by default. Rule locks release at the next configured market open, skipping configured weekends and holidays. The built-in calendar covers 2025–2026 and can be supplemented with custom holidays.

Automatic rule locks cannot be converted into manual locks, released through the ordinary popup release action, or cleared with a reset-day shortcut. A separately created **manual focus lock** can be released only after explicit confirmation. Journal rollover is automatic; archived records are not erased at rollover.

### Lock-after-exit behavior

When a rule trips, Trade Lock defers the screen lock while its current evidence says a position is open:

- a positions table with a `Net qty` column is authoritative, including an explicitly empty table or zero-quantity rows;
- without a positions table, completed BUY/SELL rows are netted by symbol;
- if neither source is available, open-position state is unknown rather than being described as broker-verified.

Manually entered journal trades are treated as completed records. Detection is best-effort: hidden, virtualized, shadow-DOM, canvas, or changed broker tables may not be read. Do not rely on deferral as the only way to protect an open position.

## Enforcement modes

| Mode | Implemented behavior | Important limitation |
|---|---|---|
| **A — Full-screen discipline lock** | Opaque extension overlay blocks mouse and keyboard access to the locked broker tab. | It can also prevent exits in that tab. It does not intercept an order at the broker. |
| **B — New-order restriction** | Uses click interception only when an adapter is marked both restriction-tested and exit-behavior-tested. | As shipped, only the synthetic test adapter is marked tested. Unverified real-broker adapters fall back to the full-screen lock. |
| **C — Full-site restriction** | Optional Chrome DNR redirect for blocked broker hosts. | Requires both Mode C and explicit informed-risk acknowledgement. Can prevent position management in the browser. |
| **D — Chart-only restriction** | Applies the overlay on recognized chart hosts or chart paths. | Separate broker order-entry tabs are not covered by this mode. |

Removing the overlay can trigger a tab reload when tamper reload is enabled. This is deterrence against casual interaction, not protection against a user who modifies or disables the extension.

## Supported pages and detection

`manifest.json` lists the HTTPS broker and chart origins on which the content script may run, including Kite, Upstox, Angel One, Dhan, 5paisa, Fyers, Groww, Sahi, Shoonya, Kotak Neo, Paytm Money, ICICI Direct, HDFC Sky, Alice Blue, Sharekhan, Espresso, and Motilal Oswal.

**Host matching is not a compatibility guarantee.** The generic detector looks for tables with quantity and price columns, classifies common statuses, and de-duplicates completed rows. Rejected/cancelled rows are ignored; pending and partial rows are not counted as completed fills. Each completed row increments the entry count, so this is not necessarily the broker's order count. Real broker layouts and enforcement behavior still require live verification.

Automatic imports are labelled **Broker table**, not “broker-verified.” Manual and imported provenance remains visible in the journal and CSV export.

## Risk and accounting

- With `Risk per unit = 0`, detected risk is quantity × price (**notional**, not true stop-loss risk).
- Set `Risk per unit` to risk-per-point × lot size before enabling risk limits. Both risk limits default to disabled.
- Planned risk is retained separately on manual journal entries.
- Gross P&L, charges, and net P&L are stored. Session realised P&L uses net P&L when available.
- Deleting or undoing a record rebuilds session counters and updates the nested journal and legacy journal view together.
- Duplicate record IDs are not counted twice. Broker-table imports cannot be removed with the one-click Undo action; deliberate journal deletion has separate confirmation.

## Plans and entitlements

Current Pro and Pro+ monthly/yearly plans are **auto-renewing Razorpay subscriptions**. Cancellation stops future renewals at the provider cycle end and preserves access through the paid period. Founder Lifetime is a one-time purchase. Already-issued legacy prepaid licenses remain honored for their original 30/365-day periods and are not reclassified as recurring.

| Plan | Price | Devices | Entitlements |
|---|---:|---:|---|
| Free | ₹0 | No server key required | Manual journal, trade-count rule, Mode A lock, journal/CSV export |
| Pro Monthly Subscription | ₹199/month | 3 | Free + automatic table detection, loss/profit/streak/risk rules, journal analytics, paid enforcement modes |
| Pro Yearly Subscription | ₹1,499/year | 3 | Same Pro entitlements with yearly renewal |
| Pro+ Monthly Subscription | ₹399/month | 5 | Pro + live market/options workspace, authorized live-market routes and discipline coach |
| Pro+ Yearly Subscription | ₹3,999/year | 5 | Same Pro+ entitlements with yearly renewal |
| Founder Lifetime | ₹2,999 once | 5 | Pro+ entitlements without a time expiry |

`server/plans.js` is the payment server's canonical plan catalogue. `lib/rules.js` applies extension entitlements. Pro does **not** inherit Pro+ market authorization.

The Market, Options and Charts tabs have exactly one data source: `GET /api/market/live` on the licence server, which needs a Pro+ key. There is no second source and no simulated fallback — with no feed every panel shows an em-dash and says what is missing. Set the market credential (`UPSTOX_ANALYTICS_TOKEN`, or `FYERS_APP_ID` + `FYERS_ACCESS_TOKEN`) on the server and the tabs fill in; if the extension is pointed at the hosted default while you run the server locally, the market tab offers a one-click switch to `http://localhost:8787`. Local briefs remain available if an AI provider is not configured or fails.

## Install a release candidate

1. Run `npm run package`, or obtain `dist/trade-lock-extension.zip` from the CI artifact.
2. Unzip it. Open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**.
3. Select the folder containing `manifest.json` (or use `dist/trade-lock-extension/`).
4. Open Trade Lock → **Rules & settings**, configure limits and enforcement mode, then save.
5. For a paid plan, open **License**, enter the deployed HTTPS license-server URL and key, activate, and save.

The package builder uses an allowlist and emits only extension runtime files. Server code, tests, deployment files, dependencies, `.env`, and data files are not included.

## Payment and license server

The Node server in `server/` provides the pricing page, Razorpay order/signature verification, idempotent fulfillment, webhook recovery, Resend email handoff, hash-only server-side license storage, device registration, support reissue, and Fyers/AI market routes.

- **Shortest path to real money:** run one long-lived Node process with `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, and all four `RAZORPAY_PLAN_*` IDs for the recurring catalog. Orders, licenses, payment history, and webhook receipts persist to the local JSON store; no database is required. Set `FYERS_ADMIN_TOKEN` as well for the protected diagnostics and a fully green `npm run doctor`.
- **Serverless production payments require Supabase.** Netlify/Vercel payments fail closed if durable storage is not configured — `npm run doctor` only blocks on `supabase`/`schema` when it detects a serverless host.
- A single-process, long-running Node deployment can use its local JSON store. Do not run multiple writers on that file; use Supabase for backups, serverless, and multiple instances.
- Plain license keys are not stored by the server. The extension must retain the activated key locally for revalidation.
- Email success means the provider accepted the request, not that inbox delivery is guaranteed.
- Email-only recovery does not disclose subscription metadata or reissue a key. Verified support uses the admin reissue flow.

See **[SUPABASE_SETUP.md](SUPABASE_SETUP.md)** for the end-to-end payment setup (Supabase project, schema, env vars, webhook, self-test). See **[RAZORPAY_SETUP.md](RAZORPAY_SETUP.md)** for local demo, deployment, provider, and support procedures. See **[RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md)** for verified versus externally required checks.

### Is checkout actually working? Is live data working?

```bash
cp server/.env.example server/.env   # fill in your keys; .env is gitignored
npm start                             # licence server + pricing page on :8787
npm run doctor                        # can a customer pay? will the tabs have data?
```

`npm start` is plain `node server/index.js`; it reads `server/.env`, serves the
pricing page at `/`, and exposes `/health`. Set `PORT` to move it.

`npm run doctor` runs the same checks as `GET /api/admin/payment-status` and
exits non-zero until a real payment would succeed, so it can gate a deploy.
Every failing row names the variable to set.

It also reports the market feed as advisory rows, because "the tabs are empty"
and "nobody can pay" are the two things worth knowing before launch. A missing
`UPSTOX_ANALYTICS_TOKEN` shows as `WARN marketProvider` without failing the run -
a dark feed must never stop someone buying a licence. If Fyers is the provider it
adds `WARN marketToken`: those tokens expire every day at 06:30 IST.

## Tests and packaging

Requires Node 22.12+ for the root development dependencies.

```bash
npm ci
npm run lint
npm test
npm run package
```

Unit/integration tests use Node's native test runner and mocked providers; no real credentials or network access is required. Browser tests are separate and require a full Chrome/Chromium executable with extension support (not `chrome-headless-shell`):

```bash
CHROME_PATH=/path/to/chrome npm run test:e2e
CHROME_PATH=/path/to/chrome npm run test:paid-e2e
```

The paid E2E starts an isolated demo license server and does not contact real payment, email, Supabase, or market providers. GitHub Actions runs unit/package checks and both Chrome E2E scripts. Browser and real-broker results must not be inferred from unit-test success.

## Repository map

| Path | Purpose |
|---|---|
| `manifest.json` | MV3 permissions, HTTPS host access, content scripts, side panel |
| `background.js` | Authoritative lock transitions, badge, release alarm, DNR, market refresh |
| `lib/rules.js` | Pure session, rules, journal, accounting, export, entitlement logic |
| `lib/detector.js` | Generic table parser, open-position resolution, adapter capabilities |
| `lib/market.js` | Deterministic indicators, chart windows, Greeks, OI and VIX calculations |
| `content/lock.js` | HUD, detector polling, overlay, tamper handling, input policy |
| `popup/` | Accessible session controls and Side Panel/Full Tab launchers |
| `options/` | Rules, journal, analytics, live market workspace, licensing |
| `server/` | Checkout, webhooks, persistence, support, market and email providers |
| `test/`, `server/test/` | Pure, mocked API, real-background and browser regression harnesses |
| `scripts/package-extension.js` | Allowlisted unpacked/ZIP release-candidate builder |
| `demo/fake-broker.html` | Synthetic browser fixture; not a live broker integration |
