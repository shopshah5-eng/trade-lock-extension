'use strict';

/*
 * Entitlement integrity.
 *
 * The free tier silently zeroes paid rules inside effectiveSettings(). That is
 * correct for enforcement, but it makes two mistakes very easy:
 *
 *   1. Rendering those zeroed values into the settings form, then reading the
 *      form back on Save - which permanently erases a lapsed Pro user's limits.
 *   2. Offering a control on Free whose output is force-zeroed, so the user
 *      configures a limit that can never fire.
 *
 * Both shipped. These tests pin the fixes.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OPTIONS_JS = fs.readFileSync(path.join(ROOT, 'options', 'options.js'), 'utf8');
const OPTIONS_HTML = fs.readFileSync(path.join(ROOT, 'options', 'options.html'), 'utf8');
const RULES = require(path.join(ROOT, 'lib', 'rules.js'));

const FREE_LICENCE = { key: null, plan: 'free', expiresAt: null };

test('Free tier really does zero the paid rules', () => {
  const free = RULES.effectiveSettings({ maxDailyLoss: 5000, maxRiskPerTrade: 1000 }, FREE_LICENCE, Date.now());
  assert.strictEqual(free.maxDailyLoss, 0, 'this is the behaviour the UI must not contradict');
  assert.strictEqual(free.maxRiskPerTrade, 0);
  assert.strictEqual(free.autoDetect, false);
  assert.strictEqual(free.freeTier, true);
  // Free still gets the one rule that works: the daily trade count.
  assert.ok(free.maxTradesPerDay > 0);
});

test('The settings form renders stored values, not entitlement-filtered ones', () => {
  // fill(effectiveSettings(...)) would put zeros in the DOM, and read() copies
  // the DOM straight back into storage on Save.
  const loadAll = OPTIONS_JS.slice(OPTIONS_JS.indexOf('function loadAll()'));
  const body = loadAll.slice(0, 2500);
  assert.ok(body.includes('fill(stored)'),
    'loadAll must render stored settings, or a lapsed Pro user loses their limits');
  assert.ok(!/fill\(\s*eff\./.test(body),
    'never fill the form from effectiveSettings()');
  // The merged object must keep the saved values.
  assert.ok(/Object\.assign\(\{\},\s*R\.DEFAULT_SETTINGS,\s*res\.tlSettings/.test(body),
    'stored settings must be merged over the defaults');
});

test('Every control whose output is force-zeroed on Free is disabled on Free', () => {
  const free = RULES.effectiveSettings({}, FREE_LICENCE, Date.now());
  const defaults = RULES.DEFAULT_SETTINGS;

  // Find the gated id list in applyPlanGating.
  const gate = OPTIONS_JS.slice(OPTIONS_JS.indexOf('function applyPlanGating'));
  const listMatch = gate.match(/var proIds = \[([\s\S]*?)\];/);
  assert.ok(listMatch, 'applyPlanGating must declare the pro-only ids');
  const gated = [...listMatch[1].matchAll(/'([A-Za-z0-9_]+)'/g)].map((m) => m[1]);

  // The paid rule fields the free tier zeroes must all be gated.
  for (const id of ['maxDailyLoss', 'profitTarget', 'maxConsecutiveLosses',
    'maxRiskPerTrade', 'maxDailyRisk', 'riskPerUnit', 'autoDetect']) {
    assert.ok(gated.includes(id), `${id} is zeroed on Free and must be disabled on Free`);
  }

  // The capital-plan inputs feed maxDailyRisk / maxRiskPerTrade, so they are
  // inert on Free too. They used to be editable, which is how a free user could
  // configure a budget that never enforced.
  for (const id of ['totalCapital', 'dailyRiskPercent', 'perTradeRiskPercent']) {
    assert.ok(gated.includes(id), `${id} produces a Free-zeroed limit and must be gated`);
    assert.ok(OPTIONS_HTML.includes(`id="${id}"`), `${id} must exist in the markup`);
  }

  // Sanity: those controls do drive paid rules.
  assert.strictEqual(typeof defaults.maxDailyLoss, 'number');
  assert.strictEqual(free.maxDailyRisk, 0);
});

test('The capital plan never promises enforcement on Free', () => {
  const summary = OPTIONS_JS.slice(OPTIONS_JS.indexOf('function updatePlanSummary'));
  const body = summary.slice(0, 2200);
  assert.ok(body.includes('Not enforced on the Free plan'),
    'the free-tier summary must say the plan is not enforced');
  // The Pro branch may promise the lock; the free branch must return before it.
  const freeBranch = body.indexOf('Not enforced on the Free plan');
  const promise = body.indexOf("The screen locks when the day");
  assert.ok(freeBranch > 0 && promise > freeBranch,
    'the free branch must return before the enforcement promise is rendered');
  assert.ok(/if \(!onPro\) \{[\s\S]*?return;/.test(body),
    'the free branch must return rather than fall through');
});

test('The capital-plan section is visibly marked Pro', () => {
  assert.ok(OPTIONS_HTML.includes('id="capitalPlanProBadge"'),
    'the risk-budget card must show a Pro badge');
});

test('Lapsing a licence does not rewrite stored limits', () => {
  // Round-trip: a Pro user's plan saved, then the licence lapses.
  const stored = { maxDailyLoss: 5000, maxRiskPerTrade: 1500, totalCapital: 100000 };
  const proLicence = { key: 'TL-TEST', plan: 'pro_monthly', expiresAt: Date.now() + 86400000 };

  const whilePro = RULES.effectiveSettings(stored, proLicence, Date.now());
  assert.strictEqual(whilePro.maxDailyLoss, 5000, 'Pro keeps the limit');

  const afterLapse = RULES.effectiveSettings(stored, FREE_LICENCE, Date.now());
  assert.strictEqual(afterLapse.maxDailyLoss, 0, 'enforcement stops when the licence lapses');

  // But the stored object is untouched: enforcement filters a copy.
  assert.strictEqual(stored.maxDailyLoss, 5000,
    'effectiveSettings must not mutate the stored settings object');
});
