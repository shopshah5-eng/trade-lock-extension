'use strict';
/* Single source of truth for prepaid pricing. Amounts are in paise (₹1 = 100). */
const PLANS = {
  pro_monthly: {
    id: 'pro_monthly', name: 'Pro — Monthly Subscription', amount: 19900, currency: 'INR',
    durationDays: 30, interval: 'monthly', tagline: 'Auto-renewing monthly Pro access. Cancel anytime.',
    badge: 'Monthly', maxDevices: 3, proPlus: false, billingModel: 'recurring', available: true,
  },
  pro_yearly: {
    id: 'pro_yearly', name: 'Pro — Yearly Subscription', amount: 149900, currency: 'INR',
    durationDays: 365, interval: 'yearly', tagline: 'Auto-renewing yearly Pro access — save 37%. Cancel anytime.',
    badge: 'Save 37%', maxDevices: 3, proPlus: false, billingModel: 'recurring', available: true,
  },
  pro_plus_ai_monthly: {
    id: 'pro_plus_ai_monthly', name: 'Pro+ AI Markets — Monthly Subscription', amount: 39900, currency: 'INR',
    durationDays: 30, interval: 'monthly', tagline: 'Auto-renewing monthly Pro+ access with live options & AI Coach.',
    badge: 'Pro+ Monthly', maxDevices: 5, proPlus: true, billingModel: 'recurring', available: true,
  },
  pro_plus_ai_yearly: {
    id: 'pro_plus_ai_yearly', name: 'Pro+ AI Markets — Yearly Subscription', amount: 399900, currency: 'INR',
    durationDays: 365, interval: 'yearly', tagline: 'Auto-renewing yearly Pro+ access with live options & AI Coach — save 16%.',
    badge: 'Save 16%', maxDevices: 5, proPlus: true, billingModel: 'recurring', available: true,
  },
  founder_lifetime: {
    id: 'founder_lifetime', name: 'Founder Lifetime', amount: 299900, currency: 'INR',
    durationDays: null, tagline: 'One payment. Lifetime access.',
    badge: 'Founder access', maxDevices: 5, proPlus: true, billingModel: 'lifetime', available: true,
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
  pro_sub: 'pro_monthly',
  plus_sub: 'pro_plus_ai_monthly',
  pro_monthly_recurring: 'pro_monthly',
  pro_plus_ai_monthly_recurring: 'pro_plus_ai_monthly',
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
  return Object.values(PLANS).filter(p => p.id !== 'free' && p.available !== false);
}

function subscriptionPlans() {
  return Object.values(PLANS).filter(p => p.id !== 'free' && p.available !== false && p.billingModel === 'recurring');
}

module.exports = { PLANS, PRO_PLANS, getPlan, canonicalPlanId, isAvailable, purchasablePlans, subscriptionPlans };
