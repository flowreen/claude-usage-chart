// node dev/test_parse.js : checks parseWeeklyUsage on both payload shapes.
const assert = require('assert');
const { parseWeeklyUsage } = require('../extension/parse.js');

const reset = '2026-09-19T00:00:00.000Z';
const r = Date.parse(reset);

assert.deepStrictEqual(parseWeeklyUsage({
  five_hour: { utilization: 12, resets_at: reset },
  seven_day: { utilization: 99, resets_at: reset },
  limits: [
    { kind: 'session', percent: 12, resets_at: reset },
    { kind: 'weekly_all', percent: 32, resets_at: reset },
    { kind: 'weekly_scoped', percent: 45, resets_at: reset, scope: { model: { display_name: 'Fable' } } },
    { kind: 'weekly_scoped', percent: null, resets_at: null, scope: { model: { display_name: 'Opus' } } },
  ],
}), { 'All models': { pct: 32, reset: r }, Fable: { pct: 45, reset: r } });

assert.deepStrictEqual(parseWeeklyUsage({
  seven_day: { utilization: 44, resets_at: reset },
  seven_day_opus: { utilization: 5, resets_at: reset },
  seven_day_sonnet: null,
}), { 'All models': { pct: 44, reset: r }, Opus: { pct: 5, reset: r } });

assert.deepStrictEqual(parseWeeklyUsage(null), {});

const { planLabel, parseMonthlySpend, accountLabel } = require('../extension/parse.js');

// account name: what Claude calls you, else full name, else email
const members = { memberships: [{ organization: { uuid: 'org-a' } }, { organization: { uuid: 'org-b' } }] };
assert.deepStrictEqual(accountLabel({ display_name: 'Flo', full_name: 'Florin N', email_address: 'f@x.com', ...members }),
  { name: 'Flo', orgIds: ['org-a', 'org-b'] });
assert.strictEqual(accountLabel({ display_name: '  ', full_name: 'Florin N', email_address: 'f@x.com' }).name, 'Florin N');
assert.strictEqual(accountLabel({ display_name: null, full_name: '', email_address: 'f@x.com' }).name, 'f@x.com');
assert.deepStrictEqual(accountLabel({ email_address: 'f@x.com' }).orgIds, []);
assert.strictEqual(accountLabel({}), null);
assert.strictEqual(accountLabel(null), null);

// monthly spend: cents to units, UTC calendar month around "now"
const now = Date.UTC(2026, 8, 16, 21, 30);
assert.deepStrictEqual(parseMonthlySpend({ extra_usage: { is_enabled: true, used_credits: 12550, monthly_limit: 50000, currency: 'USD' } }, now),
  { pct: 25.1, used: 125.5, limit: 500, start: Date.UTC(2026, 8, 1), reset: Date.UTC(2026, 9, 1), currency: 'USD' });
assert.strictEqual(parseMonthlySpend({ extra_usage: { used_credits: 0, monthly_limit: 50000 } }, Date.UTC(2026, 11, 31)).reset, Date.UTC(2027, 0, 1));
assert.strictEqual(parseMonthlySpend({ extra_usage: { used_credits: null, monthly_limit: null } }, now), null);
assert.strictEqual(parseMonthlySpend({ extra_usage: { used_credits: 10, monthly_limit: 0 } }, now), null);
assert.strictEqual(parseMonthlySpend({}, now), null);
assert.strictEqual(planLabel({ rate_limit_tier: 'default_claude_max_20x', capabilities: ['chat', 'claude_max'] }), 'Max 20x');
assert.strictEqual(planLabel({ rate_limit_tier: 'default_claude_max_5x' }), 'Max 5x');
assert.strictEqual(planLabel({ rate_limit_tier: 'default_claude_ai', capabilities: ['chat', 'claude_pro'] }), 'Pro');
assert.strictEqual(planLabel({ rate_limit_tier: 'default', capabilities: ['chat'] }), 'Free');
assert.strictEqual(planLabel({ capabilities: ['api'] }), null);

// import merge: dedupe on account + series + time, drop malformed, keep monthly fields, end sorted
const { mergePoints } = require('../extension/parse.js');
const have = [{ t: 20, org: 'a', key: 'All models', pct: 5, reset: r }];
const n = mergePoints(have, [
  { t: 20, org: 'a', key: 'All models', pct: 5, reset: r },                       // duplicate
  { t: 10, org: 'a', key: 'All models', pct: 1, reset: r, extra: 'dropped' },
  { t: 15, key: 'All models', pct: 2, reset: r },                                 // no account: dropped
  { t: 30, org: 'c', key: 'Monthly spend', pct: 50, reset: r, start: 1, used: 250, limit: 500, currency: 'USD' },
  { t: 'x', org: 'a', key: 'All models', pct: 1, reset: r },                      // malformed
  null,
]);
assert.strictEqual(n, 2);
assert.deepStrictEqual(have.map(p => p.t), [10, 20, 30]);
assert.deepStrictEqual(have[0], { t: 10, org: 'a', key: 'All models', pct: 1, reset: r });
assert.deepStrictEqual(have[2], { t: 30, org: 'c', key: 'Monthly spend', pct: 50, reset: r, start: 1, used: 250, limit: 500, currency: 'USD' });
assert.strictEqual(mergePoints(have, 'nonsense'), 0);
console.log('parse tests passed');
