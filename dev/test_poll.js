// node dev/test_poll.js : runs background.js against a fake claude.ai with two weekly orgs and one monthly-spend org.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', 'extension');
const store = {};
const listeners = {};
const ev = name => ({ addListener: fn => { listeners[name] = fn; } });
let usageFail = new Set();
let accountFails = false;
let orgAPct = 30; // 27 under the ideal, outside the 21.4 point zone
let orgADays = 3;
const badge = {};

// resets relative to now so the badge sees live weeks: org-a is 4 days in (ideal 57%), org-b 1 day in (ideal 14%)
const DAY = 864e5;
const reset = id => new Date(Date.now() + (id === 'org-a' ? orgADays : 6) * DAY).toISOString();
const orgs = [
  { uuid: 'org-a', name: 'Work', capabilities: ['chat', 'claude_max'] },
  { uuid: 'org-b', name: 'Personal', capabilities: ['chat', 'claude_pro'] },
  { uuid: 'org-api', name: 'API console', capabilities: ['api'] },
  { uuid: 'org-c', name: 'Acme', rate_limit_tier: 'default_claude_enterprise', capabilities: ['chat'] },
];

const ctx = {
  console,
  importScripts: (...files) => files.forEach(f => vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx)),
  fetch: async url => {
    const json = body => ({ ok: true, status: 200, json: async () => body });
    if (url.endsWith('/api/organizations')) return json(orgs);
    if (url.endsWith('/api/account')) {
      if (accountFails) return { ok: false, status: 404, json: async () => ({}) };
      return json({ display_name: 'Flo', full_name: 'Florin N', email_address: 'f@x.com',
                    memberships: [{ organization: { uuid: 'org-a' } }, { organization: { uuid: 'org-b' } }] });
    }
    const m = url.match(/organizations\/([^/]+)\/usage$/);
    assert(m, `unexpected url ${url}`);
    assert.notStrictEqual(m[1], 'org-api', 'non-chat org must not be polled');
    if (usageFail.has(m[1])) return { ok: false, status: 500, json: async () => ({}) };
    // org-c: Enterprise seat with only a monthly $ limit ($250 of $500)
    if (m[1] === 'org-c') {
      return json({ limits: [], extra_usage: { is_enabled: true, used_credits: 25000, monthly_limit: 50000, currency: 'USD' } });
    }
    const pct = m[1] === 'org-a' ? orgAPct : 12;
    // org-b also has extra usage credits: weekly limits exist, so no monthly series
    const extra = m[1] === 'org-b' ? { extra_usage: { is_enabled: true, used_credits: 100, monthly_limit: 2000 } } : {};
    return json({ limits: [{ kind: 'weekly_all', percent: pct, resets_at: reset(m[1]) }], ...extra });
  },
  chrome: {
    storage: {
      local: {
        get: async keys => Object.fromEntries([].concat(keys).map(k => [k, structuredClone(store[k])])),
        set: async o => Object.assign(store, structuredClone(o)),
      },
      onChanged: ev('changed'),
    },
    runtime: { onInstalled: ev('installed'), onStartup: ev('startup'), onMessage: ev('message') },
    alarms: { onAlarm: ev('alarm'), create() {} },
    action: {
      onClicked: ev('clicked'),
      setBadgeText: async o => { badge.text = o.text; },
      setBadgeBackgroundColor: async o => { badge.color = o.color; },
      setBadgeTextColor: async () => {},
      setTitle: async o => { badge.title = o.title; },
    },
    tabs: { create() {} },
  },
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), ctx);

const poll = () => new Promise(res => listeners.message('poll', {}, res));

(async () => {
  // concurrent polls share one run
  const [s1, s2] = await Promise.all([poll(), poll()]);
  assert.strictEqual(s1, s2);
  assert.strictEqual(store.points.length, 3, 'one point per chat org');
  assert.deepStrictEqual(store.points.map(p => `${p.org}:${p.key}`).sort(),
    ['org-a:All models', 'org-b:All models', 'org-c:Monthly spend']);
  assert.deepStrictEqual(store.orgNames, { 'org-a': 'Work', 'org-b': 'Personal', 'org-c': 'Acme' });
  assert.deepStrictEqual(store.orgPlans, { 'org-a': 'Max', 'org-b': 'Pro', 'org-c': 'Enterprise' });
  // the person's name goes to the orgs listed in their memberships only
  assert.deepStrictEqual(store.orgUsers, { 'org-a': 'Flo', 'org-b': 'Flo' });
  const monthly = store.points.find(p => p.org === 'org-c');
  assert.strictEqual(monthly.pct, 50);
  assert.strictEqual(monthly.used, 250);
  assert.strictEqual(monthly.limit, 500);
  assert.strictEqual(monthly.currency, 'USD');
  assert.strictEqual(new Date(monthly.start).getUTCDate(), 1);
  assert(monthly.start <= monthly.t && monthly.t < monthly.reset);
  assert(s1.ok, s1.msg);
  assert(/^[+-]?\d+%?$/.test(badge.text) && badge.text.length <= 4, `badge ${badge.text}`);

  // monthly badge: pace against the month, money in the hover title
  store.selectedOrg = 'org-c';
  await listeners.changed({ selectedOrg: { newValue: 'org-c' } });
  await new Promise(r => setTimeout(r, 10));
  const idealNow = (Date.now() - monthly.start) / (monthly.reset - monthly.start) * 100;
  assert(Math.abs(parseInt(badge.text, 10) - Math.round(50 - idealNow)) <= 1, `badge ${badge.text} vs ${50 - idealNow}`);
  assert(/vs ideal/.test(badge.title) && !/%%/.test(badge.title), badge.title);
  assert(/\$250(\.00)? of \$500(\.00)?/.test(badge.title), badge.title);

  // badge follows the selected account
  store.selectedOrg = 'org-b';
  await listeners.changed({ selectedOrg: { newValue: 'org-b' } });
  await new Promise(r => setTimeout(r, 10));
  assert.strictEqual(badge.text, '-2%');
  assert.strictEqual(badge.color, '#d99a00');
  store.selectedOrg = 'org-a';
  await listeners.changed({ selectedOrg: { newValue: 'org-a' } });
  await new Promise(r => setTimeout(r, 10));
  assert.strictEqual(badge.text, '-27%');
  assert.strictEqual(badge.color, '#3553b5');

  // one point per minute per series, driven by a fake clock inside background.js
  const minuteStart = Math.floor(Date.now() / 6e4) * 6e4;
  vm.runInContext('globalThis.__realNow = Date.now', ctx);
  const setClock = t => vm.runInContext(`Date.now = () => ${t}`, ctx);
  for (const p of store.points) p.t = minuteStart + 5e3;
  setClock(minuteStart + 40e3);
  // same minute, value changed (tokens used, then "Poll now"): the minute's point is replaced, not added.
  // A failing /api/account does not break the poll.
  accountFails = true;
  orgAPct = 47;
  const sAcct = await poll();
  assert(sAcct.ok, sAcct.msg);
  assert.deepStrictEqual(store.orgUsers, { 'org-a': 'Flo', 'org-b': 'Flo' });
  accountFails = false;
  assert.strictEqual(store.points.length, 3);
  const a1 = store.points.find(p => p.org === 'org-a');
  assert.strictEqual(a1.pct, 47);
  assert.strictEqual(a1.t, minuteStart + 40e3);
  // next minute, value unchanged: still a new point for every series
  setClock(minuteStart + 70e3);
  await poll();
  assert.strictEqual(store.points.length, 6);
  assert.deepStrictEqual(store.points.filter(p => p.org === 'org-a').map(p => p.pct), [47, 47]);
  // 100% inside the finish window (reset in 12 h) is the goal: badge gold like the chart's dot, not red "over"
  setClock(minuteStart + 130e3);
  orgADays = 0.5;
  orgAPct = 100;
  store.selectedOrg = 'org-a';
  await poll();
  assert.strictEqual(badge.color, '#d99a00', `badge ${badge.text} ${badge.color} ${badge.title}`);
  assert(/in the zone/.test(badge.title), badge.title);
  orgADays = 3;
  orgAPct = 30;
  vm.runInContext('Date.now = globalThis.__realNow', ctx);

  // one org failing keeps the other's point and reports the error
  usageFail = new Set(['org-b']);
  store.points = store.points.filter(p => p.org !== 'org-a');
  const s3 = await poll();
  assert.strictEqual(store.points.filter(p => p.org === 'org-a').length, 1);
  assert(!s3.ok && /Personal: HTTP 500/.test(s3.msg), s3.msg);

  // all orgs failing is an error with nothing written
  usageFail = new Set(['org-a', 'org-b', 'org-c']);
  const before = store.points.length;
  const s4 = await poll();
  assert(!s4.ok && store.points.length === before, s4.msg);
  assert.strictEqual(badge.text, '?');

  // import runs in the worker: duplicates dropped, labels only fill gaps, badge refreshed from the merged list
  const dup = store.points.find(p => p.org === 'org-a');
  const imp = await new Promise(res => listeners.message({ type: 'import', data: {
    points: [dup, { t: dup.t + 1, org: 'org-a', key: 'All models', pct: 55, reset: dup.reset }, { bad: true }],
    orgNames: { 'org-a': 'From file', 'org-z': 'Other' }, orgAliases: { 'org-a': 'My work' },
  } }, {}, res));
  assert(imp.ok && /imported 1 new/.test(imp.msg), imp.msg);
  assert.strictEqual(store.points.length, before + 1);
  assert.strictEqual(store.orgNames['org-a'], 'Work', 'local name wins');
  assert.strictEqual(store.orgNames['org-z'], 'Other');
  assert.strictEqual(store.orgAliases['org-a'], 'My work');
  assert.notStrictEqual(badge.text, '?');
  const bad = await new Promise(res => listeners.message({ type: 'import', data: 'nonsense' }, {}, res));
  assert(bad.ok && /imported 0/.test(bad.msg), bad.msg);

  console.log('poll tests passed');
})().catch(e => { console.error(e); process.exit(1); });
