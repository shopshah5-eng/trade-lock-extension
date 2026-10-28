# Razorpay, licensing, and deployment guide

The extension never creates Razorpay orders or stores payment-provider secrets. The server creates an order for a canonical paid plan, verifies Razorpay's signature, fulfills the order idempotently, and returns a license key when one can safely be shown.

```text
Pricing page → Razorpay Checkout → payment_id + signature
                     │                     │
                     │                     └→ POST /api/verify-payment → HMAC check
                     │                                                    → fulfill → key/email
                     └→ signed webhooks → recover fulfillment / revoke refunds

Extension → POST /api/validate { key, deviceId } → plan, expiry, device entitlement
```

Trade Lock uses Razorpay Subscriptions for monthly and yearly plans (`pro_monthly`, `pro_yearly`, `pro_plus_ai_monthly`, `pro_plus_ai_yearly`) with automatic renewal and cancel-at-cycle-end, and one-time orders for Founder Lifetime (`founder_lifetime`). Pro allows 3 devices; Pro+ and Founder Lifetime allow 5.

## 1. Configuration and secrets

Copy `server/.env.example` to `server/.env` for local use, or configure the same names in the host's secret manager. The placeholders in `.env.example` are intentional; real credentials belong only in the external deployment environment. Never commit them or put service-role, Razorpay-secret, Fyers-secret, or AI keys in extension files.

Important groups:

| Variables | Purpose |
|---|---|
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | Order creation and checkout signature verification |
| `RAZORPAY_WEBHOOK_SECRET` | Raw-body webhook HMAC verification |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | Durable orders, licenses, devices, fulfillment and webhook receipts |
| `RESEND_API_KEY`, `RESEND_FROM` | License email handoff; use a verified sender/domain in production |
| `PUBLIC_BASE_URL` | Public HTTPS origin used by CORS and AI provider referer metadata |
| `TL_DATA_FILE` | Optional absolute JSON path for a single long-running Node instance |
| `FYERS_*` | Optional live market provider and protected OAuth administration |
| `OPENROUTER_API_KEY`, `GEMINI_API_KEY` | Optional remote narration; deterministic local briefs are the fallback |
| `PROVIDER_TIMEOUT_MS` | Outbound provider/Supabase timeout, default 15000 ms |

The Supabase service key is server-only. An anon key is not needed by this server. Never expose the service key in the pricing page or extension.

## 2. Run the no-payment demo locally

Demo checkout is enabled only when all of these are true:

1. `TL_DEMO_MODE=1`;
2. `NODE_ENV` is not `production`;
3. Razorpay key ID/secret are not configured.

```bash
cd server
TL_DEMO_MODE=1 NODE_ENV=development TL_DATA_FILE=/tmp/trade-lock-demo.json node index.js
```

Open `http://localhost:8787`, choose a paid-plan fixture, and complete the demo flow. No Razorpay payment occurs. Demo orders and keys are clearly marked by the API response. Unset real Razorpay keys when intending to use demo mode.

The repository's paid browser E2E starts its own isolated demo server and temporary data file; it does not use this persistent demo file.

## 3. Apply the Supabase schema

For Netlify, Vercel, multiple Node instances, or any production deployment that needs durable recovery:

1. Create/open the Supabase project.
2. Back up and de-duplicate legacy license/order rows if migrating an existing database. The schema adds unique indexes for payment and order fulfillment.
3. Run the **entire** `server/schema.sql` in the SQL editor.
4. Confirm these tables exist: `licenses`, `orders`, `processed_webhooks`.
5. Confirm these RPC functions exist and are executable only by `service_role`: `fulfill_order`, `register_device`, `reissue_license`.
6. Set `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` in the deployment environment.
7. Restart/redeploy and check `/health` and `/api/config`.

The SQL is not applied by application startup. The mocked tests do not prove that it was run successfully in the real project.

`fulfill_order` performs the database-side idempotent order/license transition without overwriting an existing order/payment linkage. `register_device` serializes device registration and enforces the plan-derived limit supplied by the server. `reissue_license` revokes the old key and creates the replacement atomically.

## 4. Configure Razorpay

1. In Razorpay Dashboard, use the intended test or live API key pair in the server environment.
2. (Optional) Set `RAZORPAY_PLAN_PRO_MONTHLY`, `RAZORPAY_PLAN_PRO_YEARLY`, `RAZORPAY_PLAN_PRO_PLUS_AI_MONTHLY`, and `RAZORPAY_PLAN_PRO_PLUS_AI_YEARLY` if you have pre-created plans in the Razorpay Dashboard. If unset, the server will auto-create them via the Razorpay Plans API.
3. Add a webhook pointing to `https://YOUR-SERVER/api/webhook`.
4. Use a long random webhook secret and set it as `RAZORPAY_WEBHOOK_SECRET`.
5. Enable these webhook events:
   - `subscription.activated`: Marks subscription active and records billing cycle bounds.
   - `subscription.charged`: Extends entitlement end-date (`currentPeriodEnd`/`expiresAt`) on renewals without issuing duplicate keys or emails.
   - `subscription.pending` / `payment.failed`: Flags billing status as `past_due` while preserving grace access.
   - `subscription.cancelled`: Sets `cancelAtPeriodEnd: true` and syncs provider cycle-end termination.
   - `subscription.completed` / `subscription.halted`: Marks subscription completed/halted.
   - `subscription.paused` / `subscription.resumed`: Syncs temporary hold and resumption.
   - `payment.captured`: One-time order recovery (Founder Lifetime).
   - `refund.processed` / `payment.refunded`: Revokes license immediately.
6. Auto-renewal cancellation (`POST /api/subscription/cancel`) calls the Razorpay API with `cancel_at_cycle_end: 1` so the subscriber retains access through their paid billing cycle.
7. Use Razorpay's current official test instruments for test-mode validation; do not use live card details in development.

### Checkout and fulfillment behavior

- Free/unknown plans cannot create orders.
- A valid email is required and is bound to the order. Verification also checks any supplied email/plan against that order.
- Amount, currency, plan, duration and device limit come from `server/plans.js`, not browser-supplied prices.
- `/api/verify-payment` requires `orderId`, `paymentId`, and the Razorpay signature outside demo mode. With Supabase configured, the remote order—not a stale local cache—is authoritative.
- An order already linked to a different payment returns HTTP 409 `order_payment_mismatch`; verification cannot overwrite that linkage or issue another key.
- Concurrent in-process fulfillment returns HTTP 409 so the checkout can retry instead of creating duplicate keys.
- A database/email failure does not mark webhook processing complete. Non-2xx responses leave the event retryable.
- A warm-process retry can re-show its cached key. A cold retry returns `licenseKey: null` for an already fulfilled order because the server stores hashes only; use the purchase email or verified support recovery.
- `emailSent: true` means Resend accepted the request, not guaranteed inbox delivery.

## 5. Deploy

### Long-running Node (Render/Railway/Fly/VPS)

Use `server/` as the application directory, install with `npm ci`, and start with `node index.js`. Put it behind HTTPS.

For a single instance without Supabase, set `TL_DATA_FILE` to a durable absolute path and back it up. Do not run multiple writers against one JSON file. Supabase is strongly recommended for production, scaling, and support operations.

### Netlify

Use `server/` as the base directory. `server/netlify.toml` publishes `public/`, packages `netlify/functions/`, includes the pricing HTML in the function bundle, and routes `/api/*` to the function.

Set all production environment variables, including Supabase. `NETLIFY` is detected automatically. **Live serverless checkout returns 503 instead of accepting payment if Supabase is not configured.** Deploy and test the actual function URL; a local Node test is not a Netlify integration test.

### Vercel

Use `server/` as the project root. `server/api/index.js` exposes a callable handler and disables body parsing for exact webhook signatures. `server/vercel.json` routes requests to it and includes the public pricing file.

Set `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` before enabling checkout. `VERCEL` is detected automatically, so live payments also fail closed without durable storage. Verify the deployed function and webhook raw-body behavior on Vercel itself.

## 6. Point the extension at the deployment

The release default is `https://trade-lock-app.netlify.app`. If using another origin:

1. Change `licenseApiBase` in `lib/rules.js`.
2. Add that exact HTTPS origin to `manifest.json` `host_permissions`.
3. Set `PUBLIC_BASE_URL` to the same public origin where appropriate.
4. Rebuild with `npm run package` and repeat browser activation tests.

The release manifest does not include localhost or wildcard Netlify access. Browser E2E adds localhost permissions only to a temporary test copy.

In the extension, open **Rules & settings → License**, enter the HTTPS server and key, choose **Activate**, then **Save rules**. The server stores license hashes; the extension stores the activated key locally for later Bearer validation. Clearing extension storage creates a new device ID and may consume another device slot.

## 7. Live market and AI configuration

Live/analyze market routes require an active Pro+ license. Pro keys receive `pro_plus_required`. Public demo analysis always uses a local brief and cannot invoke remote AI.

For single-user Fyers access, configure `FYERS_APP_ID` and a current `FYERS_ACCESS_TOKEN`. For the OAuth helper also configure:

```env
FYERS_APP_ID=
FYERS_SECRET=
FYERS_REDIRECT_URL=https://YOUR-SERVER/api/fyers/callback-page
FYERS_ADMIN_TOKEN=choose_a_separate_long_random_admin_secret
```

`/api/fyers/auth-url` and `/api/fyers/exchange` require `Authorization: Bearer FYERS_ADMIN_TOKEN` (or `X-Admin-Token`). OAuth state is signed and expires after 10 minutes. Do not put the admin token in the extension or pricing page. Fyers token expiry/refresh remains an operational task.

OpenRouter and Gemini keys are optional. Provider errors fall back to deterministic local briefs; this does not turn simulated data into live market data.

## 8. Support and recovery

Run commands with the same environment and durable store as production:

```bash
cd server
node admin.js list
node admin.js lookup trader@example.com
node admin.js reissue trader@example.com
node admin.js revoke TL-XXXXX-...
```

- With Supabase configured, `list` shows only the local cache; `lookup <email|paymentId>` also retrieves authoritative remote records, including support-reissue payment linkage.
- `reissue` selects the newest active, unexpired license for the email, revokes it, resets devices, preserves its expiry/plan, and prints the new plain key once. The operator must verify ownership and deliver it through a trusted support channel.
- `revoke` accepts the plain key to calculate its hash; it does not reveal an existing key.
- For file-only storage, stop the Node server before admin writes and restart afterward. Supabase transactions do not require stopping other instances.

`/api/restore-subscription` intentionally returns the same non-enumerating support guidance for every syntactically valid email. It does not disclose whether a purchase exists and never returns a key based on email alone.

## 9. Go-live verification

Complete these with the actual deployment and providers:

1. `NODE_ENV=production`, `TL_DEMO_MODE=0`, live Razorpay keys, webhook secret, Supabase, Resend, and a verified sender are configured.
2. `/health` reports payment persistence ready; `/api/config` reports expected booleans and no secret values.
3. Apply and inspect the full Supabase schema and RPC permissions.
4. Make a small real purchase for each plan family; verify amount, 30/365-day expiry, Pro versus Pro+ access, and 3/5-device limits.
5. Retry verification and deliver duplicate webhooks; confirm exactly one license per order/payment.
6. Simulate provider/email/database failure and confirm retries recover without duplicate fulfillment.
7. Confirm cold-start recovery from a fresh function instance and no key is exposed by email-only recovery.
8. Confirm refund webhooks revoke access and support reissue revokes the old key.
9. Activate on a fresh Chrome profile, then test real broker pages and position exits independently of Trade Lock.
10. Complete store, privacy, refund, legal, and production operational reviews in `RELEASE_CHECKLIST.md` before publishing.

A successful mocked test suite is not evidence that these external checks have passed.
