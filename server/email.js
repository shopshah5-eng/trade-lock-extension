'use strict';
/*
 * Transactional email sender for Trade Lock license delivery via Resend API.
 * Uses native fetch (Node >= 18) with zero third-party dependencies.
 */

const RESEND_API_URL = 'https://api.resend.com/emails';

function formatPlanName(planId) {
  const names = {
    pro_monthly: 'Pro — Monthly (₹199/mo)',
    pro_yearly: 'Pro — Yearly (₹1,499/yr)',
    pro_plus_ai: 'Pro+ AI Markets — Monthly (₹399/mo)',
    pro_plus_ai_monthly: 'Pro+ AI Markets — Monthly (₹399/mo)',
    pro_plus_ai_yearly: 'Pro+ AI Markets — Yearly (₹3,999/yr)',
    lifetime: 'Founder Lifetime (₹2,999 one-time)',
    founder_lifetime: 'Founder Lifetime (₹2,999 one-time)',
    free: 'Free'
  };
  return names[planId] || planId || 'Pro';
}

function buildHtmlTemplate({ licenseKey, plan, email, expiresAt }) {
  const planLabel = formatPlanName(plan);
  const expiryText = expiresAt
    ? 'Valid until ' + new Date(expiresAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    : 'Perpetual Lifetime Access (Never Expires)';

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your Trade Lock License Key</title>
</head>
<body style="margin:0;padding:0;background-color:#07090f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#e2e8f0;">
  <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color:#07090f;padding:30px 10px;">
    <tr>
      <td align="center">
        <!-- Main Card Container -->
        <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width:560px;background-color:#0f1422;border:1px solid #1e2638;border-radius:16px;overflow:hidden;box-shadow:0 12px 30px rgba(0,0,0,0.5);">
          
          <!-- Brand Header -->
          <tr>
            <td style="padding:28px 32px 20px;border-bottom:1px solid #1a2234;background:linear-gradient(180deg, #161e31 0%, #0f1422 100%);">
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td>
                    <span style="font-size:20px;font-weight:800;letter-spacing:-0.03em;color:#ffffff;display:inline-flex;align-items:center;">
                      🔒 Trade Lock
                    </span>
                  </td>
                  <td align="right">
                    <span style="background:rgba(55,211,155,0.12);color:#37d39b;border:1px solid rgba(55,211,155,0.3);font-size:11px;font-weight:700;padding:4px 10px;border-radius:99px;text-transform:uppercase;letter-spacing:0.05em;">
                      ${planLabel.split('—')[0].trim()}
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body Content -->
          <tr>
            <td style="padding:32px 32px 24px;">
              <h1 style="margin:0 0 10px;font-size:22px;font-weight:800;color:#ffffff;line-height:1.3;">
                Welcome to Trade Lock Pro! 🎉
              </h1>
              <p style="margin:0 0 24px;font-size:14px;color:#94a3b8;line-height:1.6;">
                Thank you for your purchase. Your payment was verified successfully. Here is your official license key to activate your subscription on up to 3 devices:
              </p>

              <!-- License Key Display Box -->
              <div style="background-color:#07090f;border:1px dashed #37d39b;border-radius:12px;padding:20px;text-align:center;margin:0 0 24px;">
                <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.1em;color:#64748b;margin-bottom:8px;font-weight:700;">
                  Your License Key
                </div>
                <div style="font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,Courier,monospace;font-size:20px;font-weight:800;color:#37d39b;letter-spacing:0.05em;word-break:break-all;user-select:all;">
                  ${licenseKey}
                </div>
                <div style="font-size:12px;color:#64748b;margin-top:10px;">
                  Plan: <span style="color:#cbd5e1;font-weight:600;">${planLabel}</span> · <span style="color:#37d39b;">${expiryText}</span>
                </div>
              </div>

              <!-- Quick Setup Guide -->
              <h2 style="margin:0 0 14px;font-size:15px;font-weight:700;color:#ffffff;">
                How to activate in 30 seconds:
              </h2>
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="margin:0 0 24px;">
                <tr>
                  <td style="padding:8px 0;vertical-align:top;width:24px;color:#37d39b;font-weight:700;font-size:14px;">1.</td>
                  <td style="padding:8px 0;font-size:13.5px;color:#cbd5e1;line-height:1.5;">
                    Open Chrome, click the <b>Trade Lock</b> extension icon in your toolbar, and open <b>Rules & settings</b>.
                  </td>
                </tr>
                <tr>
                  <td style="padding:8px 0;vertical-align:top;width:24px;color:#37d39b;font-weight:700;font-size:14px;">2.</td>
                  <td style="padding:8px 0;font-size:13.5px;color:#cbd5e1;line-height:1.5;">
                    Scroll down to the <b>License</b> card.
                  </td>
                </tr>
                <tr>
                  <td style="padding:8px 0;vertical-align:top;width:24px;color:#37d39b;font-weight:700;font-size:14px;">3.</td>
                  <td style="padding:8px 0;font-size:13.5px;color:#cbd5e1;line-height:1.5;">
                    Paste your key <code style="background:#161e31;padding:2px 6px;border-radius:4px;color:#37d39b;font-family:monospace;">${licenseKey}</code> and click <b>Activate key</b>.
                  </td>
                </tr>
              </table>

              <!-- Highlights Callout -->
              <div style="background-color:rgba(76,141,255,0.08);border:1px solid rgba(76,141,255,0.25);border-radius:10px;padding:14px 16px;margin:0 0 24px;">
                <p style="margin:0;font-size:12.5px;color:#93c5fd;line-height:1.5;">
                  💡 <b>Remember:</b> The lock only triggers <i>after</i> you exit your trade. If a limit is hit mid-trade, the system enters pending mode so you can safely square off without being frozen.
                </p>
              </div>

              <p style="margin:0;font-size:13px;color:#64748b;line-height:1.5;">
                Need help or moving to a new computer? Simply reply to this email or contact support with your key.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:20px 32px;background-color:#07090f;border-top:1px solid #1a2234;text-align:center;">
              <p style="margin:0;font-size:11.5px;color:#475569;">
                Trade Lock · Daily Discipline & Risk Protection for Indian Traders<br>
                Purchased by ${email || 'Customer'} · Valid on up to 3 devices
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
}

function buildPlainText({ licenseKey, plan, expiresAt }) {
  const planLabel = formatPlanName(plan);
  const expiryText = expiresAt
    ? 'Valid until ' + new Date(expiresAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    : 'Perpetual Lifetime Access (Never Expires)';

  return [
    'TRADE LOCK — YOUR LICENSE KEY',
    '================================',
    '',
    `Plan: ${planLabel}`,
    `Validity: ${expiryText}`,
    '',
    `YOUR LICENSE KEY:`,
    licenseKey,
    '',
    'HOW TO ACTIVATE IN CHROME:',
    '1. Open Chrome and click the Trade Lock extension icon in your toolbar.',
    '2. Click "Rules & settings".',
    '3. Scroll down to the License card.',
    `4. Paste your key: ${licenseKey}`,
    '5. Click "Activate key".',
    '',
    'NOTE:',
    'Trade Lock only locks after you square off your position, ensuring you are never locked out during an open trade.',
    '',
    'Need support? Reply to this email.',
    'Trade Lock — Indian Markets Discipline & Risk Management'
  ].join('\n');
}

/**
 * Sends a transactional license email via Resend REST API.
 * Never throws — failures are logged to prevent interrupting checkout flows.
 */
async function sendLicenseEmail({ to, licenseKey, plan, expiresAt, apiKey, resendApiKey, from, fetchImpl }) {
  const key = apiKey || resendApiKey || process.env.RESEND_API_KEY;
  if (!key) {
    console.warn('[email] RESEND_API_KEY not configured — email not sent.');
    return { ok: false, skipped: true, reason: 'missing_resend_api_key', error: 'no_api_key' };
  }

  const sender = from || process.env.RESEND_FROM || 'Trade Lock <onboarding@resend.dev>';
  const recipient = String(to || '').trim().toLowerCase();
  if (!recipient || !recipient.includes('@') || !licenseKey) {
    console.warn('[email] Invalid recipient email or missing key:', to);
    return { ok: false, skipped: true, reason: 'missing_recipient_or_key', error: 'invalid_email' };
  }

  const subject = `Your Trade Lock ${formatPlanName(plan).split('—')[0].trim()} License Key: ${licenseKey.slice(0, 8)}…`;
  const html = buildHtmlTemplate({ licenseKey, plan, email: recipient, expiresAt });
  const text = buildPlainText({ licenseKey, plan, expiresAt });
  const f = fetchImpl || fetch;

  try {
    const res = await f(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: sender,
        to: recipient,
        subject,
        html,
        text
      })
    });

    const data = await res.json().catch(() => null);
    if (!res.ok) {
      console.error('[email] Resend delivery error:', res.status, data);
      const errMsg = (data && (data.message || data.name)) || String(res.status);
      return { ok: false, status: res.status, error: errMsg };
    }

    console.log(`[email] License email successfully dispatched to ${recipient} (id: ${data && data.id})`);
    return { ok: true, id: data && data.id };
  } catch (err) {
    console.error('[email] Network error sending email:', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = {
  buildHtmlTemplate,
  buildPlainText,
  formatPlanName,
  sendLicenseEmail,
  RESEND_API_URL
};

