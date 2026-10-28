# Supabase + Razorpay setup (make checkout work)

Without this, `POST /api/create-order` returns **503 `payment_persistence_not_configured`** on
Netlify/Vercel and **nobody can buy anything**. Takes about 15 minutes.

You need three accounts/keys:

| What | Where | Cost |
|---|---|---|
| Supabase project | [supabase.com](https://supabase.com) | Free tier is plenty |
| Razorpay account (live) | [dashboard.razorpay.com](https://dashboard.razorpay.com) | Per-transaction fee |
| Your own server URL | Netlify/Vercel | Already deployed |

---

## 1. Create the Supabase project

1. Sign in at [supabase.com](https://supabase.com) → **New project**.
2. Pick a region close to your users (**Mumbai / `ap-south-1`** for India — it matters
   for licence-check latency).
3. Save the database password somewhere safe. You will not need it for this app
   (the app talks over HTTPS, not Postgres), but you cannot recover it later.

## 2. Create the tables

1. In your project, open **SQL Editor** → **New query**.
2. Paste the entire contents of [`server/schema.sql`](../server/schema.sql).
3. Click **Run**.

That creates `licenses`, `orders`, `processed_webhooks`, `payment_history`, the RPC functions
(`fulfill_order`, `register_device`, `reissue_license`, `record_payment`, `mark_payment_refunded`) and row-level security
policies. The script is idempotent — safe to re-run after an update. It also backfills legacy billing fields without converting old prepaid monthly/yearly keys into subscriptions. Back up and de-duplicate legacy rows before migration.

Expected result: **"Success. No rows returned."**

## 3. Copy the two credentials

In Supabase: **Project Settings → API**.

| Copy this | Into this env var | Notes |
|---|---|---|
| **Project URL** (`https://xxxx.supabase.co`) | `SUPABASE_URL` | No trailing slash |
| **`service_role` secret** (`eyJ…`) | `SUPABASE_SERVICE_KEY` | ⚠️ **Not** the `anon` key |

> **The service_role key bypasses row-level security.** It must only ever exist as a
> server environment variable. Never put it in the extension, never commit it, never
> paste it into a chat. If it leaks, rotate it immediately (Settings → API → Reset).

## 4. Set every environment variable

On **Netlify**: Site configuration → Environment variables → *Add a variable*.
On **Vercel**: Project → Settings → Environment Variables.

```
# --- Mandatory: payments ---
SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
SUPABASE_SERVICE_KEY=eyJhbGciOi...        # service_role, NOT anon
RAZORPAY_KEY_ID=rzp_live_xxxxxxxx
RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxx
RAZORPAY_WEBHOOK_SECRET=xxxxxxxxxxxxxxxx
RAZORPAY_PLAN_PRO_MONTHLY=plan_xxxxxxxxxxxxxx
RAZORPAY_PLAN_PRO_YEARLY=plan_xxxxxxxxxxxxxx
RAZORPAY_PLAN_PRO_PLUS_AI_MONTHLY=plan_xxxxxxxxxxxxxx
RAZORPAY_PLAN_PRO_PLUS_AI_YEARLY=plan_xxxxxxxxxxxxxx

# --- Mandatory: market data (Pro+) ---
UPSTOX_ANALYTICS_TOKEN=xxxxxxxx-xxxx-xxxx    # 1 year, read-only, free

# --- Mandatory: admin endpoints ---
FYERS_ADMIN_TOKEN=<output of: openssl rand -hex 32>

# --- Recommended ---
PUBLIC_BASE_URL=https://your-site.netlify.app
RESEND_API_KEY=re_xxxxxxxx                   # required for unattended webhook email delivery
RESEND_FROM=Trade Lock <licenses@your-domain.com>
```

Optional tuning:

```
MARKET_CACHE_TTL_MS=45000     # how long a market snapshot is reused
PROVIDER_TIMEOUT_MS=15000     # upstream request timeout
TL_DATA_FILE=/path/to/db.json # self-hosted JSON store location
```

Do **not** set `TL_DEMO_MODE` in production. It is a local test flag that issues
licences without payment, and it now refuses to activate on any hosted platform.

## 5. Add the Razorpay webhook

This is what recovers a purchase when the buyer closes the tab before the browser
confirms payment. Without it, an interrupted checkout means a charged customer with
no licence.

1. Razorpay Dashboard → **Account & Settings → Webhooks → Add New Webhook**.
2. **Webhook URL**: `https://your-site.netlify.app/api/webhook`
3. **Secret**: the exact value you put in `RAZORPAY_WEBHOOK_SECRET`.
4. **Active events**: `payment.captured`, `payment.failed`, `payment.refunded`, `refund.processed`, `subscription.activated`, `subscription.charged`, `subscription.pending`, `subscription.cancelled`, `subscription.completed`, `subscription.halted`, `subscription.paused`, and `subscription.resumed`.
5. Save, then use Razorpay's **Test** button — you should see a `2xx` response.

## 6. Verify before you tell anyone

Locally, one command checks everything and prints what to fix:

```bash
cp server/.env.example server/.env   # then fill in the values
npm run doctor
```

It exits `0` only when a real payment would succeed, so it doubles as a deploy
gate. Sample output while something is still missing:

```
  FAIL  razorpay        Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET
  WARN  supabase        Optional here: the local JSON store is used. Set SUPABASE_URL
                        + SUPABASE_SERVICE_KEY for backups or multiple instances
  PASS  platform        Long-lived host: the local JSON store is also usable
  WARN  schema          Skipped: Supabase not configured
```

Against the deployed server, use the same checks over HTTP:

```bash
curl -s https://your-site.netlify.app/api/admin/payment-status \
  -H "x-admin-token: $FYERS_ADMIN_TOKEN" | jq
```

You want:

```json
{
  "ok": true,
  "paymentPersistenceReady": true,
  "checks": {
    "razorpay":       { "ok": true },
    "razorpayPlans":  { "ok": true },
    "webhookSecret":  { "ok": true },
    "supabase":       { "ok": true },
    "schema":         { "ok": true, "detail": "Required tables, billing columns and payment RPC signatures are reachable" }
  }
}
```

If it returns **503**, the failing check tells you exactly what is wrong:

| Detail | Fix |
|---|---|
| `Set SUPABASE_URL and SUPABASE_SERVICE_KEY` | Env vars missing, or you redeployed before saving them |
| `Key rejected (401)` | You used the `anon` key — switch to `service_role` |
| `Missing tables: orders` | Step 2 not applied to *this* project |
| `required fulfill_order() function/signature is missing` (or another RPC) | Re-run `server/schema.sql` and verify the service-role grants |
| `Supabase unreachable` | Wrong URL, or the project is paused (free tier pauses after a week idle) |

Also confirm the app agrees:

```bash
curl -s https://your-site.netlify.app/health | jq
# → "paymentPersistenceReady": true
```

## 7. Do an authorized real test purchase

A green self-test does not prove the money path. Use Razorpay test mode first, then make one authorized live purchase at the actual listed catalog price:

1. Buy the cheapest plan with a real card/UPI.
2. Confirm you receive the licence key (email or on-screen).
3. Paste it into the extension → License → Activate. It should show **Pro**.
4. Check the Supabase **Table Editor**: one row in `orders` (`status = paid`),
   one row in `licenses`.
5. Refund that test purchase in the Razorpay dashboard and confirm the license is revoked and `payment_history.refunded` is set.

## 8. After it works

- **Back up.** Supabase free tier has no point-in-time recovery. In **Database →
  Backups**, enable a weekly backup, or `pg_dump` on a schedule.
- **Watch the free-tier limits.** 500 MB storage / 5 GB egress. Licence rows are
  tiny; you will hit neither until you have tens of thousands of customers.
- **Rotate `RAZORPAY_KEY_SECRET` and `SUPABASE_SERVICE_KEY`** if they were ever
  pasted into a chat, ticket, or screenshot.

---

## Troubleshooting

**Checkout says "Payment Gateway Offline / Not Configured"**
`RAZORPAY_KEY_ID`/`SECRET` are missing on the host. The UI is reporting the server
truthfully — fix step 4.

**Payment succeeds but no licence is issued**
Open the Razorpay webhook log. A `4xx` means `RAZORPAY_WEBHOOK_SECRET` does not
match. A `5xx` means Supabase failed — re-run step 6.

**Licence issued but the extension says "not active"**
The extension stores `licenseApiBase`. If you moved the server, update it in
Options → License → Server URL; Chrome will prompt for the new origin.

**Customer paid twice for one order**
`fulfill_order()` is idempotent per `payment_id` and per `order_id`, so a retried
webhook cannot mint a second licence. If two *distinct* payments exist, refund one —
that is a Razorpay-side duplicate, not an app bug.

**"Self-hosted, not serverless"**
On a long-lived host (VPS, Render, Railway) Supabase is optional — the JSON store at
`TL_DATA_FILE` is used instead. Supabase is mandatory on Netlify/Vercel because the
filesystem is ephemeral.
