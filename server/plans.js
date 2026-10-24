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
  pro_plus_ai_yearly: {
    id: 'pro_plus_ai_yearly', name: 'Pro+ AI Markets — Yearly', amount: 399900, currency: 'INR',
    durationDays: 365, tagline: 'Pro plus AI coaching and reports with annual billing.',
    badge: 'Save 16%',
  },
  lifetime: {
    id: 'lifetime', name: 'Founder Lifetime', amount: 299900, currency: 'INR',
    durationDays: null, tagline: 'One payment. Yours forever.',
    badge: 'First 500 users only',
  },
  free: {
    id: 'free', name: 'Free', amount: 0, currency: 'INR',
    durationDays: null, tagline: 'Basic discipline rules and manual journal.'
  },
  pro_plus_ai_monthly: {
    id: 'pro_plus_ai_monthly', name: 'Pro+ AI Markets — Monthly', amount: 39900, currency: 'INR',
    durationDays: 30, tagline: 'OI, zones, FVG + AI briefs & warnings.',
    badge: 'New',
  },
  founder_lifetime: {
    id: 'founder_lifetime', name: 'Founder Lifetime', amount: 299900, currency: 'INR',
    durationDays: null, tagline: 'One payment. Yours forever.',
    badge: 'First 500 users only',
  },
};
const PRO_PLANS = Object.keys(PLANS).filter(k => k !== 'free');
function getPlan(id) { return PLANS[id] || (id === 'founder_lifetime' ? PLANS.lifetime : (id === 'pro_plus_ai_monthly' ? PLANS.pro_plus_ai : null)); }
module.exports = { PLANS, PRO_PLANS, getPlan };
