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
assert.deepStrictEqual(accountLabel({ display_name: 'User', full_name: 'User N', email_address: 'u@x.com', ...members }),
  { name: 'User', orgIds: ['org-a', 'org-b'] });
assert.strictEqual(accountLabel({ display_name: '  ', full_name: 'User N', email_address: 'u@x.com' }).name, 'User N');
assert.strictEqual(accountLabel({ display_name: null, full_name: '', email_address: 'u@x.com' }).name, 'u@x.com');
assert.deepStrictEqual(accountLabel({ email_address: 'u@x.com' }).orgIds, []);
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

// Claude Code transcripts priced at API list prices
const { logCallCost, readTranscript, scanLogs, mergeMinutes, addMinutes } = require('../extension/parse.js');
const near = (a, b) => assert(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
// a real Opus 5.5 call: 1 h cache writes cost 2x input, cache reads $0.20
const u55 = { input_tokens: 2, output_tokens: 282, cache_read_input_tokens: 35813, cache_creation_input_tokens: 30763,
              cache_creation: { ephemeral_1h_input_tokens: 30763, ephemeral_5m_input_tokens: 0 } };
near(logCallCost('claude-opus-5-5', u55), (2 * 4 + 282 * 20 + 35813 * 0.2 + 30763 * 8) / 1e6);
near(logCallCost('claude-opus-5', { output_tokens: 1e6 }), 25);             // not priced as Opus 5.5
near(logCallCost('claude-fable-5-1', { cache_creation_input_tokens: 1e6 }), 12.5); // 5 minute writes: 1.25x
near(logCallCost('claude-opus-5-5', { output_tokens: 1e6, speed: 'fast' }), 40);
assert.strictEqual(logCallCost('gpt-9', u55), null);
// a streamed reply repeats its call; the line with the most output counts, at the first line's time
const line = (id, out, ts, model = 'claude-opus-5-5') => JSON.stringify({ type: 'assistant', requestId: `r${id}`, timestamp: ts,
  message: { id: `m${id}`, model, usage: { output_tokens: out } } });
const calls = new Map();
readTranscript([line(1, 10, '2026-10-03T10:00:05Z'), line(1, 300, '2026-10-03T10:00:40Z'), 'not json "usage"',
  JSON.stringify({ type: 'user', message: { id: 'x', usage: {} } }), line(2, 100, '2026-10-03T10:00:50Z'),
  line(3, 50, '2026-10-03T10:02:00Z', 'gpt-9'), line(4, 1, '2026-10-03T10:03:00Z', '<synthetic>')].join('\n'), calls);
readTranscript(line(1, 300, '2026-10-03T10:00:40Z'), calls); // the same call in a resumed session's file
assert.strictEqual(calls.size, 4);
assert.strictEqual(calls.get('m1|r1').usage.output_tokens, 300);
assert.strictEqual(calls.get('m1|r1').t, Date.parse('2026-10-03T10:00:05Z'));
// a full read again keeps the larger total per minute: deleted transcripts do not lower it, a repeat does not double it
assert.deepStrictEqual(mergeMinutes([[1, 2], [2, 5]], [[2, 3], [3, 1]]), [[1, 2], [2, 5], [3, 1]]);
assert.deepStrictEqual(mergeMinutes(undefined, [[2, 3]]), [[2, 3]]);
assert.deepStrictEqual(addMinutes([[1, 2]], [[1, 3], [2, 1]]), [[1, 5], [2, 1]]);

// reading the synced folder: a fake folder handle over nested objects whose files are Blobs
const folder = (name, tree) => ({
  name, kind: 'directory',
  async getDirectoryHandle(n) { if (tree[n] && !(tree[n] instanceof Blob)) return folder(n, tree[n]); throw new Error(`${n} not found`); },
  async *entries() { for (const [n, v] of Object.entries(tree)) yield [n, v instanceof Blob ? { kind: 'file', getFile: async () => v } : folder(n, v)]; },
});
const T = Date.parse('2026-10-03T10:00:00Z'), MIN = Math.floor(T / 6e4);
const out20 = n => n * 20 / 1e6; // Opus 5.5 output price per token
const sess = {};
const claude = folder('.claude', { 'history.jsonl': new Blob(['x']), projects: { proj: sess } });
(async () => {
  // first read: everything; a half-written last line waits for the next read; offsets are bytes (é, ✓)
  sess['a.jsonl'] = new Blob([`${line(1, 100, '2026-10-03T10:00:05Z')}\n{"note":"café ✓"}\n${line(2, 50, '2026-10-03T10:04:00Z').slice(0, 30)}`]);
  const r1 = await scanLogs(claude, null, T + 5 * 6e4);
  assert(r1.full);
  assert.deepStrictEqual(r1.minutes.map(([k]) => k), [MIN]);
  near(r1.minutes[0][1], out20(100));
  // later: line 2 is finished, call 1 streamed more output, a resumed session copied call 1 and an older call 0
  sess['a.jsonl'] = new Blob([`${line(1, 100, '2026-10-03T10:00:05Z')}\n{"note":"café ✓"}\n${line(2, 50, '2026-10-03T10:04:00Z')}\n`
    + `${line(1, 300, '2026-10-03T10:00:50Z')}\n`]);
  sess['b.jsonl'] = new Blob([`${line(0, 999, '2026-10-03T08:00:00Z')}\n${line(1, 300, '2026-10-03T10:00:50Z')}\n`]);
  const r2 = await scanLogs(claude, r1.scan, T + 10 * 6e4);
  assert(!r2.full);
  // call 1 adds only its growth (300 - 100) once, call 2 is new, call 0 is history from before the last read
  assert.deepStrictEqual(r2.minutes.map(([k]) => k), [MIN, MIN + 4]);
  near(r2.minutes[0][1], out20(200));
  near(r2.minutes[1][1], out20(50));
  // nothing new: nothing added
  const r3 = await scanLogs(claude, r2.scan, T + 11 * 6e4);
  assert.deepStrictEqual(r3.minutes, []);
  // a rewritten, shorter file is read again from its start without counting its calls twice
  sess['a.jsonl'] = new Blob([`${line(2, 50, '2026-10-03T10:04:00Z')}\n`]);
  assert.deepStrictEqual((await scanLogs(claude, r3.scan, T + 12 * 6e4)).minutes, []);
  // the projects folder itself works; any other folder is refused before anything is read
  assert.strictEqual((await scanLogs(folder('projects', { proj: sess }), null, T)).full, true);
  await assert.rejects(scanLogs(folder('flori', { Documents: {} }), null, T), /not the Claude folder/);
  console.log('parse tests passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
