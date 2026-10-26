# Trade Lock release verification checklist

**Current release verdict: release candidate only — do not call it publish-ready until the applicable external checks below pass.** Repository credentials are intentionally excluded; real credentials are expected to be supplied by the external deployment environment. Their absence from Git is not a defect, but deployment configuration and provider behavior still need verification.

## 1. Checks that can run in this repository

Run on a clean checkout:

```bash
npm ci
npm run lint
npm test
npm run package
unzip -t dist/trade-lock-extension.zip
```

The automated coverage includes:

- rule boundaries, IST session/holiday rollover, next-open calculations, and protected automatic locks;
- manual focus-lock release versus automatic rule-lock protection in the real background worker;
- DNR requiring full-site mode and explicit acknowledgement, direct storage-transition synchronization, and stale-tab lock erase/relock protection;
- content-script recovery that reapplies state without creating an unintended manual lock;
- empty versus missing positions tables, zero-quantity positions, duplicate fills, and open-position deferral;
- journal archive/rollover, duplicate IDs, undo/delete counter rebuilding, planned risk, charges and net P&L;
- Pro versus Pro+ aliases and entitlement gates;
- Wilder RSI, chart-window panning/clamping, and bounded weekly-candle generation;
- real background execution with mocked Chrome APIs;
- checkout plan/email binding, demo behavior, signature validation, cold starts, webhook replay, email/fulfillment failure retry, and refund-entity revocation with mocked providers;
- serverless fail-closed behavior without Supabase and transactional Supabase calls with a mocked REST/RPC backend;
- callable Vercel deployment adapter and raw-body configuration;
- malformed file-store failure, atomic private-permission writes, and static SQL lock/payment-identity invariants;
- support CLI authoritative payment lookup and one-time key visibility after a remote reissue commits despite local-cache failure;
- manifest permissions and allowlisted package contents.

These are code-level results, not evidence of real Chrome, broker, payment, email, database, or hosting behavior.

## 2. Chrome checks required on the packaged artifact

Use `dist/trade-lock-extension/` or the ZIP in a clean Chrome profile:

- [ ] Load unpacked with no manifest, CSP, service-worker, options, popup, side-panel, or content-script errors.
- [ ] Verify Free, Pro, Pro+, expired, revoked, offline-cached, and device-limit states.
- [ ] Verify automatic detection starts only for paid Pro/Pro+ and manual-only Free behavior remains usable.
- [ ] Trip every rule at, below, and above its boundary; confirm the correct reason and next-open unlock time.
- [ ] Confirm automatic locks cannot be converted/released through popup, HUD, content messages, reload, service-worker restart, or session rollover.
- [ ] Confirm a manual focus lock still requires confirmation for ordinary release.
- [ ] Test open positions, an explicitly empty positions table, a missing table, zero-quantity rows, and a lock deferred until flat.
- [ ] Test Mode A mouse/keyboard blocking, focus behavior, iframe behavior, overlay removal/tamper reload, and recovery after browser restart.
- [ ] Test Mode B only on an adapter actually marked tested; confirm all other adapters use the full-screen fallback.
- [ ] Test Mode C DNR only after acknowledgement, including rule cleanup after release. Keep an independent position-exit method available.
- [ ] Test Mode D on chart hosts/paths and confirm separate broker order-entry tabs are not overlaid.
- [ ] Exercise popup, HUD and Options journal add/undo/delete together across multiple tabs; check counters, archives, CSV and analytics remain synchronized. Deliberately write from a stale tab and confirm an unexpired lock is restored while an audited manual release stays released.
- [ ] Open the popup on a broker tab before its content script responds; recovery must not create a new manual lock.
- [ ] Complete keyboard-only navigation and a screen-reader pass for popup, settings, journal forms, confirmations and lock screen.
- [ ] Check light/dark/forced-colors, zoom, narrow popup, full-tab and side-panel layouts.
- [ ] Run `npm run test:e2e` and `npm run test:paid-e2e` with `CHROME_PATH`; inspect screenshots and console output rather than relying only on exit status.

## 3. Real broker verification required

Host permission does not prove adapter compatibility. Use safe/test accounts where available and never experiment with uncontrolled live exposure:

- [ ] Record the exact broker, hostname, UI version/date and test evidence for each claimed adapter.
- [ ] Verify completed, rejected, cancelled, pending and partial rows; ensure rescans do not double-count and partial fills are not misrepresented as complete.
- [ ] Verify symbol, side, quantity, price, P&L and timestamp parsing with Indian number formats and broker-specific columns.
- [ ] Verify positions with nonzero, zero, missing, virtualized and paginated rows; test lock deferral and activation only when evidenced flat.
- [ ] Verify risk-per-unit settings separately from notional quantity × price; do not describe notional as stop-loss risk.
- [ ] Test dynamic modals, SPA route changes, shadow DOM, iframes, canvas terminals and hidden tabs.
- [ ] Confirm all automatic imports say “Broker table,” not broker/API verified.
- [ ] Do not mark real-broker new-order restriction or exit preservation tested without separate new-order and risk-reducing-action evidence.
- [ ] Verify chart-only host/path recognition on actual broker/chart pages.
- [ ] Confirm traders can manage open positions from an independent approved channel if the browser locks.

## 4. Production infrastructure and provider checks required

### Supabase

- [ ] Apply all of `server/schema.sql`; inspect tables, unique indexes, RLS and `service_role`-only RPC grants.
- [ ] Test `fulfill_order`, `register_device`, and `reissue_license` against the real project, including concurrent calls, conflicting payment IDs for one order, and revocation/expiry racing device registration.
- [ ] Verify cold function instances recover orders, licenses, fulfillment and processed webhook IDs remotely.
- [ ] Test backup/restore and legacy-row migration/deduplication.

### Razorpay and Resend

- [ ] Validate test mode first, then a small authorized live transaction after KYC/website approval.
- [ ] Check exact plan amount/currency, checkout order reuse, signature rejection, email/plan mismatch rejection and free-plan rejection.
- [ ] Deliver `payment.captured` duplicates and out-of-order retries; verify one license per payment/order.
- [ ] Inject database/email failures and verify non-2xx retry behavior, later recovery and no premature processed receipt.
- [ ] Confirm a cold already-fulfilled verification does not invent or re-show a plain key; test support recovery.
- [ ] Confirm real inbox delivery, sender/domain authentication, expiry text and Pro versus Pro+ device wording.
- [ ] Deliver `refund.processed` and `payment.refunded`; confirm remote revocation and validation denial, including both original and support-reissued licenses linked to the original payment.

### Hosting and market providers

- [ ] Deploy the actual Netlify/Vercel/Node target; verify routing, included pricing assets, environment detection, HTTPS and raw webhook bodies.
- [ ] Verify live payments fail closed on serverless when Supabase is absent and recover after correct configuration.
- [ ] Choose the Pro+ market feed and set its credential on the host:
      - **Upstox Analytics Token (recommended)** — `UPSTOX_ANALYTICS_TOKEN`. Free, read-only,
        generated once per year at Developer Apps -> Analytics. No daily ritual.
      - **Fyers API v3** — `FYERS_APP_ID` + `FYERS_ACCESS_TOKEN`. This token expires **every day
        at 06:30 IST**, so Pro+ goes dark each morning until a human refreshes it. Only use this
        if you can commit to that daily step.
- [ ] Confirm `/health` reports `marketFeed.configured: true` and the expected provider.
- [ ] Rotate the credential without a redeploy if needed:
      `POST /api/admin/market-token` with `x-admin-token: $FYERS_ADMIN_TOKEN`,
      body `{"provider":"upstox","token":"..."}`. Check it with `GET /api/admin/market-status`.
- [ ] Verify Pro+ denial for Pro, live candle/option normalization, and that an expired or missing
      credential produces an honest offline state (never fabricated candles).
- [ ] Verify OpenRouter/Gemini timeout/failure fallback and that public demo analysis never invokes remote AI.
- [ ] Replace or supplement in-memory rate limiting if the deployment needs coordinated multi-instance limits.
- [ ] Set monitoring/alerts without logging license keys, payment signatures, raw keys or provider secrets.

## 5. Owner, legal, operational and Chrome Web Store decisions

These cannot be completed by code changes alone:

- [ ] Approve final prepaid pricing, plan names, refund policy, support SLA and ownership-verification procedure.
- [ ] Provide and review privacy policy, terms, financial-risk disclaimer, data retention/deletion policy and support contact.
- [ ] Confirm tax/KYC/Razorpay account and website requirements with the owner/providers.
- [ ] Review offline cached-license behavior: revocation cannot reach an offline installation until revalidation.
- [ ] Review operational risk of local extension key storage and the fact a determined user can modify/disable a client extension.
- [ ] Update the built-in holiday calendar and establish an ongoing calendar-maintenance process.
- [ ] Justify every Chrome permission and broad broker host access in the store listing/privacy disclosures.
- [ ] Prepare current, truthful screenshots and listing text; do not claim live broker restriction, live market data, or guaranteed order prevention without evidence.
- [ ] Check broker names/trademarks, store policies, remote-code rules, data-use certification and regional requirements.
- [ ] Complete a final secret scan, dependency review, packaged-artifact diff and clean-install smoke test.
- [ ] Establish backups, incident response, key rotation, support reissue, refund revocation and provider-outage procedures.

## 6. Known boundaries to retain in release notes

- Generic DOM detection is best-effort and can change when a broker changes its UI.
- Pending/partial rows are not counted as completed fills; completed-row counts may differ from broker order counts.
- Default detected risk can be notional, not true risk.
- Mode A and Mode C can block position management in the affected browser/tab.
- No real-broker adapter is marked new-order-restriction-tested in the shipped capability table; the synthetic fixture is not evidence for a real broker.
- Email-provider acceptance is not guaranteed inbox delivery.
- Server-side hash-only storage intentionally prevents cold recovery of a previously issued plain key.
- In-memory API rate limits are best-effort on serverless/multi-instance deployments.
- Client-side licensing and tamper resistance deter casual bypass; they are not DRM or a broker-side control.
