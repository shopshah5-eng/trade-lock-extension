# Razorpay Integration — Step by Step

The extension itself never touches money. A small server (`server/`) creates
Razorpay orders, **verifies the payment signature**, and only then issues a
license key. The extension validates that key against the server.

```
Pricing page ──► Razorpay Checkout (UPI/card) ──► Razorpay
     ▲                                                  │ payment_id + signature
     │ license key shown once                           ▼
     └──────────── License server ── verify HMAC ──► issue key (hash stored)
Extension ── paste key ──► POST /api/validate ──► Pro unlocked (max 3 devices)
```

## 1. Create the Razorpay account
1. Sign up at razorpay.com → complete KYC (PAN, bank account). Test mode works instantly; live payments need KYC approval.
2. Dashboard → **Settings → API Keys → Generate Test Key**. Note the **Key Id** (`rzp_test_…`) and **Key Secret** (shown once).
3. Dashboard → **Settings → Webhooks → Add New Webhook**
   - URL: `https://YOUR-SERVER/api/webhook`
   - Secret: any long random string (you'll reuse it below)
   - Active events: **payment.captured**

## 2. Run the server locally (test the whole flow first)
```bash
cd server
TL_DEMO_MODE=1 node index.js        # no Razorpay needed — issues demo keys
# open http://localhost:8787  → pick a plan → "Buy" → you get a demo key
```
Demo mode is for wiring tests only. **Never** enable it in production.

## 3. Configure real keys
Create `server/.env` (copy `.env.example`) or set environment variables:
```
RAZORPAY_KEY_ID=rzp_test_xxxxxxxx
RAZORPAY_KEY_SECRET=xxxxxxxxxxxx
RAZORPAY_WEBHOOK_SECRET=your_webhook_secret
PORT=8787
```
Start: `node index.js` → buy with Razorpay's test card **4111 1111 1111 1111** (any future expiry/CVV) or test UPI `success@razorpay`.

**How verification works** (already implemented in `server/index.js` + `server/license.js`):
- Checkout returns `razorpay_order_id`, `razorpay_payment_id`, `razorpay_signature`.
- Server computes `HMAC_SHA256(order_id + "|" + payment_id, KEY_SECRET)` and compares in constant time. **Mismatch = no key, ever.**
- Webhooks are verified the same way over the raw body with the webhook secret — use them as your audit trail (`payment.captured` marks the order paid in `server/data.json`).

## 4. Point the extension at your server
Extension → **Rules & settings → License**:
- **License server:** `https://your-server.example` (your deployed URL)
- Paste key → **Activate** → then **Save rules**.
- The release build already ships with `licenseRequired: true` in `lib/rules.js`, so Pro features stay locked until activation. (For a personal/dev build, untick **Enforce licensing** in Options.)

> Selling build checklist: change the default `licenseApiBase` in `lib/rules.js` to your production URL and add that origin to `host_permissions` in `manifest.json` (localhost is pre-added for dev).

## 5. Deploy (pick one)
- **Render / Railway / Fly.io:** new Web Service → root directory `server/` → start command `node index.js` → set the 4 env vars → they give you an HTTPS URL.
- **VPS:** `pm2 start index.js --name trade-lock` behind nginx/caddy for HTTPS.
- Razorpay requires the **webhook URL to be HTTPS**; checkout works from your HTTPS pricing page.

## 6. Going live
1. Razorpay Dashboard → switch Test → **Live**, generate **Live API keys**.
2. Replace env vars, recreate the webhook with the live secret.
3. Do one real ₹199 purchase yourself, activate the key, confirm Pro unlocks. Then refund yourself from the dashboard if you like.

## Free vs Pro (what the paywall actually gates)
| Feature | Free | Pro |
|---|---|---|
| Manual + Win/-Loss logging, HUD, popup | ✓ | ✓ |
| Trade-count rule + lock till next open | ✓ | ✓ |
| Auto-detect from order book | — | ✓ |
| Loss / profit-target / streak / risk rules | — (inputs disabled) | ✓ |
| Hard-block mode | — | ✓ |
| Journal analytics + CSV export | — | ✓ |
| AI Coach (tilt/revenge alerts, score, report) | — | ✓ |
| Devices per key | 1 install | 3 |

Enforcement lives in `effectiveSettings()` (`lib/rules.js`): with licensing on and
no valid key, Pro rules are zeroed before evaluation, and Pro inputs are disabled
in Options. The popup badge shows FREE / PRO. Keys are revalidated automatically
if the last check is older than 24 hours.

**Enabling paid plans, in order:** deploy server → set Razorpay env keys →
set the extension's License server URL → users buy on the pricing page →
paste key in Options → Activate → Save rules. That's it; no code change per user.

## Support operations
```bash
cd server
node admin.js list                      # all licenses (hints only — plain keys are never stored)
node admin.js lookup trader@email.com   # find a customer's license
node admin.js reissue trader@email.com  # lost key → revokes old, prints a new one
node admin.js revoke TL-XXXXX-...       # refunds / chargebacks
```
⚠️ Run admin commands with the server **stopped** (or restart it right after) — the running server holds the store in memory.

## Honest limitations of this setup
- Keys are shown **once** on the pricing page; there's no email delivery yet. Add Resend/SMTP in `/api/verify-payment` before real launch, or reissue becomes your support bottleneck.
- `data.json` is a single-file store — fine to a few thousand licenses. Back it up; it's your entire customer database. Move to SQLite/Postgres when volume grows.
- Validation happens at activation and when tabs load. A determined user can patch a local extension — licensing here stops casual sharing (3-device limit), not reverse engineering. That's the right level for a ₹199 tool.

## Going fully live (all providers)

The server auto-loads `server/.env` at startup (real environment variables
override it). Fill these in, restart the server, and check `GET /api/config` —
it reports `configured / fyersConfigured / openRouterConfigured` booleans
(never the secrets themselves).

```env
# Razorpay (Dashboard → Settings → API Keys / Webhooks)
RAZORPAY_KEY_ID=rzp_live_...
RAZORPAY_KEY_SECRET=...
RAZORPAY_WEBHOOK_SECRET=...

# Fyers (My APIs app → OAuth, see server/fyers.js header)
FYERS_APP_ID=...
FYERS_SECRET=...
FYERS_REDIRECT_URL=https://your-server/api/fyers/callback-page
FYERS_ACCESS_TOKEN=...        # from /api/fyers/auth-url → login → /api/fyers/exchange

# OpenRouter (optional, briefs fall back to local text without it)
OPENROUTER_API_KEY=...
[SECURITY_DATA]
TL_DEMO_MODE=0
```

Go-live checklist:
1. `TL_DEMO_MODE=0` (demo keys must be impossible in production).
2. Razorpay: complete KYC, submit your deployed server URL as the website,
   generate live keys, recreate the webhook against the live secret.
3. Fyers: create the API app with your redirect URL, run the auth flow once,
   store the returned access token in `.env` (re-run when it expires).
4. Extension release build: set `licenseApiBase` in `lib/rules.js` to your
   HTTPS server and add that origin to `host_permissions` in `manifest.json`.
5. Smoke test: buy Pro+ (₹399) with a real small payment, activate, open a
   broker tab — HUD should show market context within a minute.
