# Trade Lock — Daily Trading Discipline Extension

A Chrome (Manifest V3) extension that puts a **full-screen lock over your trading terminal** the moment you hit a limit you set for yourself:

- **Max trades per day**
- **Max daily loss (₹)**
- **Profit target (₹)** — locks to stop the give-back
- **Max consecutive losses**
- **Max risk per trade (₹)** and **daily risk budget (₹)**

The lock releases **automatically at the next market open (09:15 IST by default)**, skipping weekends and NSE holidays (built-in 2025–2026 calendar, or your own list). There is deliberately **no unlock button** — that is the point.

## Supported sites

Works on Kite (Zerodha), Upstox, Angel One, Dhan, and 5paisa. Detection is generic — it reads any order-book/positions table with a Quantity + Price column — so it usually works on other web terminals too.

## Daily plan & "lock after exit"

Set your plan in Options → **Your daily plan**: total capital, planned trades
today, daily risk % of capital, risk % per trade. Example: ₹1,00,000 capital,
2% daily risk, 0.5% per trade → ₹2,000 day budget, ₹500 planned risk/trade.
Manual (mobile) trade logs default to that planned risk.

**The lock never freezes a running trade.** When a rule trips while a position
is still open (seen in the positions table, or as a net open quantity across
today's fills), the lock stays *pending* — the HUD warns "limit reached — locks
when your open trade closes" — and the screen locks the moment the last trade
closes. Manually logged trades are already closed, so they lock immediately.

## How counting works

- **Auto-detect (default on):** polls the page's order book every 3 s. `COMPLETE`/`EXECUTED` rows count as trades; `REJECTED`/`CANCELLED`/`TRIGGER PENDING` rows are ignored. Each fill is de-duplicated by a signature, so re-scanning never double-counts. Positions tables (`Net qty` column) feed open-exposure/risk estimates.
- **Manual:** a small HUD sits in the corner of every broker tab with **+ Win / − Loss** buttons, Undo, and Lock-now. The toolbar popup has the same controls plus today's stats.
- Use both: auto-detect catches what it can read; manual logging covers mobile-app trades it can't see.

> **About the risk rules:** with `Risk per unit = 0`, auto-detect can only estimate *notional* (qty × price), not true risk — one lot of RELIANCE would read as ~₹1.8 lakh. So both risk limits ship **switched off**. Set **Risk per unit** in settings (your risk per point × lot size) before enabling them.

## Install (unpacked)

1. Unzip `trade-lock-extension.zip` (or use this folder as-is).
2. Open `chrome://extensions`, enable **Developer mode**.
3. Click **Load unpacked** and select the folder containing `manifest.json`.
4. Click the Trade Lock icon → **Rules & settings** → set your limits → **Save rules**.

## Lock strength

- The overlay is an extension iframe page scripts can't reach into; clicks/keys to the page underneath are swallowed.
- Deleting the lock frame from DevTools triggers a tab reload that re-locks it (toggleable).
- Optional **Hard block** in settings: while locked, the broker domain redirects to the lock page entirely.

> ⚠️ **Hard block warning:** while it's active you cannot load the broker in this browser at all — including to square off an open position — until the lock releases (or you use **Reset day** in the popup, which always works). Keep your broker's mobile app handy.

## Market Intelligence (Pro+ AI, ₹399/mo)

`lib/market.js` is a deterministic engine — swing/pivot support & resistance,
demand/supply zones, fair value gaps (ATR-filtered), VWAP/EMA/RSI/ATR, and
option-OI structure (PCR, OI walls, max pain). The server (`server/fyers.js`)
fetches candles/option chain from **Fyers API v3**; `server/ai.js` turns the
numbers into a plain-language brief via **OpenRouter**, with a local fallback
brief if no key is set. Options → Market Intelligence renders it all.
Try it key-free: `GET /api/market/demo?symbol=NIFTY` on the license server.

Keys live ONLY in `server/.env` (see `.env.example`): `FYERS_APP_ID`,
`FYERS_SECRET`, `FYERS_ACCESS_TOKEN`, `OPENROUTER_API_KEY`. Never put broker
or AI secrets in the extension.

## Monetisation (built in)

Pricing lives in `server/plans.js` — Free (manual + trade-count), **Pro ₹199/mo,
₹1,499/yr**, Founder Lifetime ₹2,999. The `server/` folder is a zero-dependency
Node license server: Razorpay checkout → HMAC signature verification → license
key (hash-only storage, 3-device limit, admin CLI in `server/admin.js`).
The extension's Options → License card activates keys; tick *Enforce licensing*
in the paid build to gate Pro features (see `effectiveSettings` in `lib/rules.js`).

Full walkthrough: **[RAZORPAY_SETUP.md](RAZORPAY_SETUP.md)** — account, test
keys, webhooks, deployment, going live, support ops.

## Testing & Reviewing Without API Keys

Reviewers and testers do **NOT** need any API keys or a running backend server to test all features. Trade Lock includes a deterministic demo model engine that simulates candles, order books, and option Greeks out of the box.

### Quick Review via Chrome
1. Clone the repository:
   ```bash
   git clone https://github.com/shopshah5-eng/trade-lock-extension.git
   cd trade-lock-extension
   ```
2. Open Chrome and go to `chrome://extensions/`.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the repository folder.
5. Click the Trade Lock icon in Chrome:
   - **Side Panel**: Opens Trade Lock inside Chrome's native right-hand side panel.
   - **Full Tab**: Opens the full workspace in a tab (deduplicating existing tabs).
   - **Charts & Indices**: Explore interactive candlestick & volume charts across 6 indices (NIFTY, BANK NIFTY, FIN NIFTY, MIDCPNIFTY, SENSEX, BANKEX) and 12 timeframes (1m to 1W) with EMA 9/20 and VWAP.
   - **Options Chain**: View Black-Scholes Greeks, separate Call vs Put Theta, and strike-by-strike time decay.
   - **India VIX**: Inspect real-time volatility regime, IV rank, and spike alert monitoring.
   - **Planning Mode**: On weekends or holidays, access Journal, Analytics, and Planning without lockout.

### Automated Test Suite
Run the 180 unit and integration tests:
```bash
npm install
npm test
```
All tests run locally using Node's native test runner with 0 external network dependencies.

## Files

| Path | What |
|---|---|
| `manifest.json` | MV3 manifest, side panel declaration, host permissions, content scripts |
| `background.js` | Service worker: badge, release alarm, side panel router, optional hard block |
| `lib/rules.js` | Pure rules engine — limits, IST session/holiday math, lock timing, planning mode |
| `lib/market.js` | Market analytics engine — 6 indices, 12 timeframes, Black-Scholes Greeks, India VIX |
| `lib/detector.js` | Generic order-book/positions table parser for Indian brokers |
| `content/lock.js` | Content script: HUD, detector poll, overlay, tamper watchdog |
| `content/lock.html` + `lockpage.js` | The lock screen itself |
| `popup/` | Toolbar popup: stats, manual logging, Side Panel & Full Tab launchers, lock controls |
| `options/` | Full settings & workspace: interactive charts, options chain, monthly journal, licensing |
| `demo/fake-broker.html` | Fake broker page used for testing and demonstrations |
