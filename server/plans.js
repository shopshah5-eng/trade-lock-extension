'use strict';
/* Single source of truth for prepaid pricing. Amounts are in paise (₹1 = 100). */
const PLANS = {
  pro_monthly: {
    id: 'pro_monthly', name: 'Pro — Monthly', amount: 19900, currency: 'INR',
    durationDays: 30, tagline: '30-day prepaid access. No auto-renewal.',
    maxDevices: 3, proPlus: false, billingModel: 'prepaid', available: true,
  },
  pro_yearly: {
    id: 'pro_yearly', name: 'Pro — Yearly', amount: 149900, currency: 'INR',
    durationDays: 365, tagline: '365-day prepaid access — about ₹125/month.',
    badge: 'Most popular · Save 37%', maxDevices: 3, proPlus: false, billingModel: 'prepaid', available: true,
  },
  pro_plus_ai_monthly: {
    id: 'pro_plus_ai_monthly', name: 'Pro+ AI Markets — Monthly', amount: 39900, currency: 'INR',
    durationDays: 30, tagline: '30-day prepaid Pro+ access. No auto-renewal.',
    badge: 'Pro+', maxDevices: 5, proPlus: true, billingModel: 'prepaid', available: true,
  },
  pro_plus_ai_yearly: {
    id: 'pro_plus_ai_yearly', name: 'Pro+ AI Markets — Yearly', amount: 399900, currency: 'INR',
    durationDays: 365, tagline: '365-day prepaid Pro+ access with market analytics and coaching.',
    badge: 'Save 16%', maxDevices: 5, proPlus: true, billingModel: 'prepaid', available: true,
  },
  founder_lifetime: {
    id: 'founder_lifetime', name: 'Founder Lifetime', amount: 299900, currency: 'INR',
    durationDays: null, tagline: 'One payment. Lifetime access.',
    badge: 'Founder access', maxDevices: 5, proPlus: true, billingModel: 'lifetime', available: true,
  },
  pro_monthly_recurring: {
    id: 'pro_monthly_recurring', name: 'Pro — Monthly Subscription', amount: 19900, currency: 'INR',
    durationDays: 30, tagline: '₹199/month auto-renewing subscription. Cancel anytime.',
    badge: 'Recurring', maxDevices: 3, proPlus: false, billingModel: 'recurring', available: true,
  },
  pro_plus_ai_monthly_recurring: {
    id: 'pro_plus_ai_monthly_recurring', name: 'Pro+ AI Markets — Monthly Subscription', amount: 39900, currency: 'INR',
    durationDays: 30, tagline: '₹399/month auto-renewing Pro+ access with live options & AI Coach.',
    badge: 'Recurring · Pro+', maxDevices: 5, proPlus: true, billingModel: 'recurring', available: true,
  },
  free: {
    id: 'free', name: 'Free', amount: 0, currency: 'INR', durationDays: null,
    tagline: 'Manual lock, trade-count rule and journal.', maxDevices: 0,
    proPlus: false, billingModel: 'free', available: true,
  },
};


const ALIASES = {
  pro_plus_ai: 'pro_plus_ai_monthly',
  lifetime: 'founder_lifetime',
  pro_sub: 'pro_monthly_recurring',
  plus_sub: 'pro_plus_ai_monthly_recurring',
};
const PRO_PLANS = Object.keys(PLANS).filter(k => k !== 'free').concat(Object.keys(ALIASES));
function getPlan(id) {
  const canonical = ALIASES[id] || id;
  return PLANS[canonical] || null;
}
function canonicalPlanId(id) {
  return ALIASES[id] || id || 'free';
}
/**
 * `available: false` withdraws a plan from sale without removing it, so
 * already-issued licenses keep validating. All plans are on sale again; the
 * `available` flag stays as the kill-switch if the market feed goes dark.
 */
function isAvailable(id) {
  const plan = getPlan(id);
  return Boolean(plan && plan.available !== false);
}
function purchasablePlans() {
  return Object.values(PLANS).filter(p => p.id !== 'free' && p.available !== false && p.billingModel !== 'recurring');
}

function subscriptionPlans() {
  return Object.values(PLANS).filter(p => p.id !== 'free' && p.available !== false && p.billingModel === 'recurring');
}

module.exports = { PLANS, PRO_PLANS, getPlan, canonicalPlanId, isAvailable, purchasablePlans, subscriptionPlans };
