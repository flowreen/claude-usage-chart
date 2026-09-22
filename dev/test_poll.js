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

// Cookie stores ('0' = normal window, '1' = incognito) and the server's live session keys: sk-a sees the orgs
// above, sk-2 is a second person's account with one org.
const jars = { 0: { sessionKey: 'sk-a', cf_clearance: 'cf', lastActiveOrg: 'org-a' } };
const live = { 'sk-a': 'a', 'sk-a2': 'a', 'sk-2': 'two' };
let rules = [];
let dynRules = [];
const seen = []; // cookie header of every saved-account request
const web = {}; // webRequest listeners
let reqId = 0;
let rotate = null; // { from, to }: the server reissues `from` on its next request, and `from` then dies
let botCheck = false; // every request gets an HTML 403, like a Cloudflare challenge
let loginTo = null; // the browser signs in to this key right before the next plain request (a login landing mid-poll)
const tabs = { reloaded: 0, created: [], updated: [] };
const logouts = []; // keys the server was asked to log out
const sessionOf = opts => {
  if (opts?.credentials !== 'omit') return jars[0].sessionKey;
  const r = rules.find(x => x.id === 1);
  const cookie = r?.action.requestHeaders[0].value || '';
  seen.push(cookie);
  return /(?:^|; )sessionKey=([^;]+)/.exec(cookie)?.[1];
};

const ctx = {
  console,
  setTimeout,
  importScripts: (...files) => files.forEach(f => vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx)),
  fetch: async (url, opts) => {
    const JSON_TYPE = { get: h => (h.toLowerCase() === 'content-type' ? 'application/json' : null) };
    const json = body => ({ ok: true, status: 200, headers: JSON_TYPE, json: async () => body });
    if (botCheck) return { ok: false, status: 403, headers: { get: () => 'text/html' }, json: async () => { throw new Error('html'); } };
    if (loginTo && opts?.credentials !== 'omit') {
      jars[0].sessionKey = loginTo;
      listeners.cookie({ removed: false, cookie: { name: 'sessionKey', domain: '.claude.ai', value: loginTo } });
      loginTo = null;
    }
    const requestId = String(++reqId);
    const initiator = 'chrome-extension://extid';
    web.before({ requestId, initiator, url });
    const key = sessionOf(opts);
    const who = live[key];
    const headers = [];
    if (who && rotate?.from === key) {
      live[rotate.to] = who;
      delete live[key];
      headers.push({ name: 'Set-Cookie', value: `sessionKey=${rotate.to}; Path=/; HttpOnly` });
      rotate = null;
    }
    web.headers({ requestId, initiator, url, responseHeaders: headers });
    if (url.endsWith('/api/auth/logout')) {
      assert.strictEqual(opts.method, 'POST');
      logouts.push(key);
      delete live[key];
      return json({});
    }
    if (!who) return { ok: false, status: 401, headers: JSON_TYPE, json: async () => ({ error: { type: 'account_session_invalid' } }) };
    if (who === 'two') {
      if (url.endsWith('/api/organizations')) return json([{ uuid: 'org-d', name: 'Second', capabilities: ['chat', 'claude_max'] }]);
      if (url.endsWith('/api/account')) return json({ display_name: 'Alt', memberships: [{ organization: { uuid: 'org-d' } }] });
      assert(url.endsWith('/organizations/org-d/usage'), `account two asked for ${url}`);
      return json({ limits: [{ kind: 'weekly_all', percent: 5, resets_at: reset('org-d') }] });
    }
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
    runtime: { id: 'extid', onInstalled: ev('installed'), onStartup: ev('startup'), onMessage: ev('message') },
    webRequest: {
      onBeforeRequest: { addListener: fn => { web.before = fn; } },
      onHeadersReceived: { addListener: (fn, filter, extra) => { assert(extra.includes('extraHeaders')); web.headers = fn; } },
      onErrorOccurred: { addListener: (fn, filter) => { if (filter.urls.includes('https://claude.ai/api/auth/logout')) web.logoutError = fn; } },
    },
    alarms: { onAlarm: ev('alarm'), create() {} },
    action: {
      onClicked: ev('clicked'),
      setBadgeText: async o => { badge.text = o.text; },
      setBadgeBackgroundColor: async o => { badge.color = o.color; },
      setBadgeTextColor: async () => {},
      setTitle: async o => { badge.title = o.title; },
    },
    tabs: {
      create: o => { tabs.created.push(o.url); },
      query: async () => [{ id: 7 }],
      reload: () => { tabs.reloaded++; },
      update: (id, o) => { tabs.updated.push([id, o.url]); },
    },
    cookies: {
      onChanged: ev('cookie'),
      set: async ({ name, value, storeId = '0' }) => { (jars[storeId] ||= {})[name] = value; },
      remove: async ({ name, storeId = '0' }) => { if (jars[storeId]) delete jars[storeId][name]; },
      getAllCookieStores: async () => Object.keys(jars).map(id => ({ id })),
      get: async ({ name, storeId }) => (jars[storeId]?.[name] ? { name, value: jars[storeId][name] } : null),
      getAll: async ({ storeId }) => Object.entries(jars[storeId] || {}).map(([name, value]) => ({ name, value })),
    },
    declarativeNetRequest: {
      updateDynamicRules: async ({ removeRuleIds = [], addRules = [] }) => {
        dynRules = dynRules.filter(r => !removeRuleIds.includes(r.id)).concat(structuredClone(addRules));
      },
      updateSessionRules: async ({ removeRuleIds = [], addRules = [] }) => {
        rules = rules.filter(r => !removeRuleIds.includes(r.id)).concat(structuredClone(addRules));
      },
    },
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

  // Second account: the browser signs in to sk-2. The first account keeps updating from its saved key, sent only
  // through the session rule with credentials omitted, and the rule is gone after the poll.
  usageFail = new Set();
  assert.deepStrictEqual(store.sessions.map(s => s.key), ['sk-a']);
  let clock = Date.now();
  const tick = () => { clock += 6e4; vm.runInContext(`Date.now = () => ${clock}`, ctx); return poll(); };
  jars[0].sessionKey = 'sk-2';
  const m1 = await tick();
  assert(m1.ok, m1.msg);
  const polled = () => store.points.filter(p => p.t === store.status.t).map(p => p.org).sort();
  assert.deepStrictEqual(polled(), ['org-a', 'org-b', 'org-c', 'org-d']);
  assert.deepStrictEqual(store.sessions.map(s => s.key), ['sk-2', 'sk-a']);
  assert.strictEqual(store.orgUsers['org-d'], 'Alt');
  assert.strictEqual(rules.length, 0, 'session rule removed after the poll');
  const sent = seen[seen.length - 1];
  assert(/sessionKey=sk-a$/.test(sent) && /cf_clearance=cf/.test(sent) && !/lastActiveOrg|sk-2/.test(sent), sent);

  // the saved key stops working (logged out on claude.ai): reported and kept, the other account still polled
  delete live['sk-a'];
  const m2 = await tick();
  assert(!m2.ok && /Flo: signed out/.test(m2.msg), m2.msg);
  assert.deepStrictEqual(polled(), ['org-d']);
  assert.deepStrictEqual(store.sessions.map(s => s.key), ['sk-2', 'sk-a']);
  assert.strictEqual(store.sessions[1].failedSince, clock);

  // logged in again in an incognito window: that store's key is picked up
  live['sk-a'] = 'a';
  jars[1] = { sessionKey: 'sk-a' };
  const m3 = await tick();
  assert(m3.ok, m3.msg);
  assert.deepStrictEqual(store.sessions.map(s => s.key), ['sk-2', 'sk-a']);
  assert(!store.sessions[1].failedSince, 'working again: no longer marked');
  delete jars[1];

  // the same account under a newer key in the browser: the older saved key stays while it works (only a refusal or
  // "Log out" removes a key), and once claude.ai refuses it, it is dropped silently as an older key of a working one
  jars[0].sessionKey = 'sk-a2';
  const m4 = await tick();
  assert(m4.ok, m4.msg);
  assert.deepStrictEqual(store.sessions.map(s => s.key), ['sk-a2', 'sk-2', 'sk-a']);
  delete live['sk-a'];
  const m4b = await tick();
  assert(m4b.ok && m4b.msg === 'ok', m4b.msg);
  assert.deepStrictEqual(store.sessions.map(s => s.key), ['sk-a2', 'sk-2']);

  // claude.ai reissues the saved key during a poll: the new key replaces it and keeps working
  rotate = { from: 'sk-2', to: 'sk-2b' };
  const r1 = await tick();
  assert(r1.ok, r1.msg);
  assert.deepStrictEqual(store.sessions.map(s => s.key), ['sk-a2', 'sk-2b']);
  const r2 = await tick();
  assert(r2.ok, r2.msg);
  assert(/sessionKey=sk-2b$/.test(seen[seen.length - 1]));
  assert.strictEqual(jars[0].sessionKey, 'sk-a2', 'browser login untouched');

  // a login in any window polls at once: the new account's points arrive without waiting for the alarm
  clock += 6e4;
  vm.runInContext(`Date.now = () => ${clock}`, ctx);
  listeners.cookie({ removed: false, cookie: { name: 'other', domain: '.claude.ai', value: 'x' } });
  await new Promise(r => setTimeout(r, 20));
  assert(store.status.t < clock, 'other cookies do not poll');
  listeners.cookie({ removed: false, cookie: { name: 'sessionKey', domain: '.claude.ai', value: 'sk-a2' } });
  await new Promise(r => setTimeout(r, 20));
  assert.strictEqual(store.status.t, clock);

  // browser signed out, saved accounts still read: not an error
  jars[0].sessionKey = undefined;
  const m5 = await tick();
  assert(m5.ok && m5.msg === 'ok', m5.msg);
  assert.deepStrictEqual(store.sessions.map(s => s.key), ['sk-a2', 'sk-2b']);

  // an HTML 403 (bot check) is not a sign-out: nothing marked or forgotten
  botCheck = true;
  const b1 = await tick();
  botCheck = false;
  assert(!b1.ok && /not a login answer/.test(b1.msg), b1.msg);
  assert.deepStrictEqual(store.sessions.map(s => [s.key, !!s.failedSince]), [['sk-a2', false], ['sk-2b', false]]);

  // refused for a month: still on the list and retried every poll (only "Log out" removes it), resumes when valid
  delete live['sk-2b'];
  await tick();
  const since = store.sessions.find(s => s.key === 'sk-2b').failedSince;
  assert(since);
  clock += 30 * 864e5;
  const g1 = await tick();
  assert(/Alt: signed out/.test(g1.msg), g1.msg);
  assert.deepStrictEqual(store.sessions.map(s => [s.key, s.failedSince]), [['sk-a2', undefined], ['sk-2b', since]]);
  live['sk-2b'] = 'two';
  const g2 = await tick();
  assert(g2.ok, g2.msg);
  assert(!store.sessions.find(s => s.key === 'sk-2b').failedSince);

  const send = msg => new Promise(res => listeners.message(msg, {}, res));
  // Add account: the browser's login is cleared here only (its key stays saved) and a login tab opens
  jars[0].sessionKey = 'sk-2b';
  jars[0].lastActiveOrg = 'org-d';
  await tick();
  assert.deepStrictEqual(store.sessions.map(s => s.key), ['sk-2b', 'sk-a2']);
  const add = await send({ type: 'add' });
  assert(add.ok, add.msg);
  assert.strictEqual(jars[0].sessionKey, undefined);
  assert.strictEqual(jars[0].lastActiveOrg, undefined);
  assert.deepStrictEqual(tabs.created, ['https://claude.ai/login']);
  await poll();
  assert.deepStrictEqual(store.sessions.map(s => s.key), ['sk-2b', 'sk-a2'], 'both accounts still polled');

  // the account menu learns which saved logins are refused, never the keys
  delete live['sk-2b'];
  await tick();
  const list = await send({ type: 'accounts' });
  assert(list.every(a => !('key' in a)), 'no keys leave the worker');
  assert.deepStrictEqual(list.map(a => [a.orgIds.join(), a.signedOut]).sort(), [['org-a,org-b,org-c', false], ['org-d', true]]);
  live['sk-2b'] = 'two';
  await tick();

  // the user logs in to org-a's account again in the browser
  jars[0].sessionKey = 'sk-a2';
  await tick();

  // Log out (extension): the account showing org-a stops updating and is hidden; its session is ended on the
  // server and the browser's login to it is cleared; logging in to it again brings it back
  const out = await send({ type: 'forget', org: 'org-a' });
  assert(out.ok, out.msg);
  assert.deepStrictEqual(logouts, ['sk-a2']);
  assert(!live['sk-a2'], 'session ended on claude.ai');
  assert.strictEqual(rules.length, 0, 'session rule removed after the logout');
  assert.deepStrictEqual(store.sessions.map(s => s.key), ['sk-2b']);
  assert.deepStrictEqual([...store.hiddenOrgs].sort(), ['org-a', 'org-b', 'org-c']);
  assert.strictEqual(jars[0].sessionKey, undefined);
  const o1 = await tick();
  assert(o1.ok, o1.msg);
  assert.deepStrictEqual(polled(), ['org-d']);
  live['sk-a3'] = 'a';
  jars[0].sessionKey = 'sk-a3';
  await tick();
  assert.deepStrictEqual(store.hiddenOrgs, []);

  // claude.ai's own Log out, its request blocked: an account switch. The key stays saved and alive, the login is
  // cleared in that window only, the tab goes to the login page, and both accounts keep updating.
  listeners.installed();
  listeners.installed();
  assert.deepStrictEqual(dynRules.map(r => [r.id, r.action.type, r.condition.urlFilter, r.condition.initiatorDomains.join(), r.condition.requestMethods.join()]),
    [[2, 'block', '|https://claude.ai/api/auth/logout', 'claude.ai', 'post']], 'one block rule, only for the page\'s POST');
  const blocked = { method: 'POST', initiator: 'https://claude.ai', error: 'net::ERR_BLOCKED_BY_CLIENT', tabId: 7 };
  web.logoutError({ ...blocked, error: 'net::ERR_FAILED' });
  web.logoutError({ ...blocked, initiator: 'chrome-extension://extid' });
  await new Promise(r => setTimeout(r, 20));
  assert.strictEqual(jars[0].sessionKey, 'sk-a3', 'other errors and our own logout are not a switch');
  web.logoutError(blocked);
  await new Promise(r => setTimeout(r, 20));
  assert.strictEqual(jars[0].sessionKey, undefined);
  assert.strictEqual(jars[0].lastActiveOrg, undefined);
  assert.deepStrictEqual(tabs.updated, [[7, 'https://claude.ai/login']]);
  assert(live['sk-a3'], 'session not ended');
  assert.deepStrictEqual(store.sessions.map(s => s.key).sort(), ['sk-2b', 'sk-a3']);
  const w1 = await tick();
  assert(w1.ok, w1.msg);
  assert.deepStrictEqual(polled(), ['org-a', 'org-b', 'org-c', 'org-d']);

  // dead keys: older keys of a working account vanish silently; two dead keys of one signed-out account = one line
  store.sessions.push(
    { key: 'old1', name: 'Flo', orgIds: ['org-a', 'org-b', 'org-c'] }, { key: 'old2', name: 'Flo', orgIds: ['org-a', 'org-b', 'org-c'] },
    { key: 'bx1', name: 'Boss', orgIds: ['org-x'] }, { key: 'bx2', name: 'Boss', orgIds: ['org-x'] });
  const d1 = await tick();
  assert.strictEqual(d1.msg, 'ok; Boss: signed out (log in to it again, or Log out to hide it)');
  assert.deepStrictEqual(store.sessions.map(s => s.key).sort(), ['bx1', 'sk-2b', 'sk-a3']);

  // a login to another account landing mid-poll: the old login's key keeps its own orgs, the new login is polled
  // right after, and a later refusal of the old key is still reported, never dropped as an older key of the new one
  store.sessions = store.sessions.filter(s => s.key !== 'bx1');
  jars[0].sessionKey = 'sk-2b';
  await tick();
  loginTo = 'sk-a3';
  await tick();
  await new Promise(r => setTimeout(r, 20));
  const orgsOf = k => store.sessions.find(s => s.key === k)?.orgIds.join();
  assert.strictEqual(orgsOf('sk-2b'), 'org-d');
  assert.strictEqual(orgsOf('sk-a3'), 'org-a,org-b,org-c');
  delete live['sk-2b'];
  const f1 = await tick();
  assert(/Alt: signed out/.test(f1.msg), f1.msg);
  assert.strictEqual(orgsOf('sk-2b'), 'org-d');
  live['sk-2b'] = 'two';

  console.log('poll tests passed');
})().catch(e => { console.error(e); process.exit(1); });
