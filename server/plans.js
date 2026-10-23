'use strict';
/* Single source of truth for pricing. Amounts are in paise (₹1 = 100). */
const PLANS = {
  pro_monthly: {
    id: 'pro_monthly', name: 'Pro — Monthly', amount: 19900, currency: 'INR',
    durationDays: 30, tagline: 'Start small. Cancel anytime.',
  },
  pro_yearly: {
    id: 'pro_yearly', name: 'Pro — Yearly', amount: 149900, currency: 'INR',
    durationDays: 365, tagline: 'Best value — about ₹125/month.',
    badge: 'Most popular · Save 37%',
  },
  pro_plus_ai: {
    id: 'pro_plus_ai', name: 'Pro+ AI Markets — Monthly', amount: 39900, currency: 'INR',
    durationDays: 30, tagline: 'OI, zones, FVG + AI briefs & warnings.',
    badge: 'New',
  },
  lifetime: {
    id: 'lifetime', name: 'Founder Lifetime', amount: 299900, currency: 'INR',
    durationDays: null, tagline: 'One payment. Yours forever.',
    badge: 'First 500 users only',
  },
};
const PRO_PLANS = Object.keys(PLANS);
function getPlan(id) { return PLANS[id] || null; }
module.exports = { PLANS, PRO_PLANS, getPlan };
