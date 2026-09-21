importScripts('parse.js', 'pace.js');

const API = 'https://claude.ai/api';
const POLL_MIN = 10;
const MINUTE = 6e4;
const MONTHLY_KEY = 'Monthly spend';
// Per-account labels kept next to the points (see chart.js).
const ORG_MAPS = ['orgNames', 'orgPlans', 'orgUsers', 'orgAliases'];
const SESSION_COOKIE = 'sessionKey';
const CLAUDE = 'https://claude.ai/';
const RULE_ID = 1;
const LOGOUT_RULE_ID = 2;
const LOGOUT_URL = 'https://claude.ai/api/auth/logout';

chrome.runtime.onInstalled.addListener(setup);
chrome.runtime.onStartup.addListener(setup);
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'poll') poll(); });
chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: 'chart.html' }));
chrome.runtime.onMessage.addListener((msg, _s, reply) => {
  if (msg === 'poll') { poll().then(reply); return true; }
  if (msg?.type === 'import') { importData(msg.data).then(reply); return true; }
  if (msg?.type === 'accounts') { accountList().then(reply); return true; }
  if (msg?.type === 'forget') { serial(() => forgetOnce(msg.org)).then(reply); return true; }
  if (msg?.type === 'add') {
    serial(addAccountOnce).then(reply, e => reply({ t: Date.now(), ok: false, msg: String(e.message || e) }));
    return true;
  }
});

function setup() {
  chrome.alarms.create('poll', { periodInMinutes: POLL_MIN, delayInMinutes: 0.1 });
  // claude.ai's own "Log out" (its page's POST, never this extension's) is blocked; see switchOnce.
  chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [LOGOUT_RULE_ID], addRules: [{
    id: LOGOUT_RULE_ID, priority: 1, action: { type: 'block' },
    condition: { urlFilter: `|${LOGOUT_URL}`, initiatorDomains: ['claude.ai'], requestMethods: ['post'], resourceTypes: ['xmlhttprequest'] },
  }] });
}

// credentials 'omit' = a saved account's request: its cookie comes from the session rule below, and whatever
// claude.ai answers with Set-Cookie never reaches the browser's own login.
async function getJson(url, credentials = 'include') {
  const r = await fetch(url, { credentials, headers: { Accept: 'application/json' } });
  if (r.status === 401 || r.status === 403) {
    // Only a JSON answer is claude.ai refusing the login; an HTML 403 is a bot check in front of it.
    if (!/json/i.test(r.headers?.get?.('content-type') || '')) throw new Error(`HTTP ${r.status} from claude.ai, not a login answer (bot check?)`);
    const body = await r.json().catch(() => null);
    const why = body?.error?.type || body?.error?.message || body?.detail || '';
    throw Object.assign(new Error(`not logged in to claude.ai (HTTP ${r.status}${why ? `, ${String(why).slice(0, 60)}` : ''})`), { auth: true });
  }
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
  return r.json();
}

// Several accounts: the browser holds one claude.ai login at a time, so the session key of every account seen
// here (normal or incognito window) is kept and polled on its own, and an account keeps updating after the
// browser signs in to another. Keys stay in local extension storage and are never exported.

// A login in any window is polled right away, so its key is saved before the browser moves to another account.
chrome.cookies?.onChanged.addListener(({ cookie, removed }) => {
  if (!removed && cookie.name === SESSION_COOKIE && /(^|\.)claude\.ai$/.test(cookie.domain)) poll();
});

// Which saved accounts claude.ai refuses, for "(signed out)" in the chart's account menu (no keys leave the worker).
async function accountList() {
  const { sessions = [] } = await chrome.storage.local.get('sessions');
  return sessions.map(s => ({ orgIds: s.orgIds || [], signedOut: !!s.failedSince }));
}

// Saves the claude.ai login of one cookie store, then clears it in that store only: the session stays alive on
// claude.ai, so the account keeps updating from its saved key.
async function releaseLogin(storeId) {
  const { sessions = [] } = await chrome.storage.local.get('sessions');
  const old = await chrome.cookies.get({ url: CLAUDE, name: SESSION_COOKIE, storeId });
  if (old?.value && !sessions.some(s => s.key === old.value)) {
    sessions.push({ key: old.value, name: '', orgIds: [] });
    await chrome.storage.local.set({ sessions });
  }
  // The org picked by the previous account would not belong to the next one.
  await chrome.cookies.remove({ url: CLAUDE, name: 'lastActiveOrg', storeId });
  if (old) await chrome.cookies.remove({ url: CLAUDE, name: SESSION_COOKIE, storeId });
}

// "+ Add account": the browser's claude.ai login is released and a login tab opens for the next account.
async function addAccountOnce() {
  await releaseLogin('0');
  for (const t of await chrome.tabs.query({ url: 'https://claude.ai/*' })) chrome.tabs.reload(t.id);
  chrome.tabs.create({ url: 'https://claude.ai/login' });
  return { t: Date.now(), ok: true, msg: 'log in to the other account in the new tab; the saved accounts keep updating' };
}

// claude.ai's own "Log out" would end the session on the server and stop that account's chart, so its request is
// blocked (LOGOUT_RULE_ID) and the button becomes an account switch: the key stays saved and alive, the login is
// cleared in that window's cookie store only, and the tab goes to claude.ai's login page for the next account.
chrome.webRequest?.onErrorOccurred.addListener(d => {
  if (d.method === 'POST' && d.initiator === 'https://claude.ai' && d.error === 'net::ERR_BLOCKED_BY_CLIENT') {
    serial(() => switchOnce(d.tabId));
  }
}, { urls: [LOGOUT_URL] });

async function switchOnce(tabId) {
  const stores = await chrome.cookies.getAllCookieStores().catch(() => []);
  const storeId = stores.find(s => s.tabIds?.includes(tabId))?.id ?? '0';
  await releaseLogin(storeId);
  // Other claude.ai tabs of that window kind still show the old login.
  const same = new Set(stores.find(s => s.id === storeId)?.tabIds || []);
  for (const t of await chrome.tabs.query({ url: 'https://claude.ai/*' })) {
    if (t.id !== tabId && same.has(t.id)) chrome.tabs.reload(t.id);
  }
  if (tabId >= 0) chrome.tabs.update(tabId, { url: 'https://claude.ai/login' });
}

// "Log out" on the chart page: the account showing `org` stops updating and leaves the account list. Its key is
// forgotten, its session is ended on claude.ai (the real logout the site's own button no longer does) and, where a
// window is signed in to it, that login is cleared. Stored points stay; logging in to the account again brings it back.
async function forgetOnce(org) {
  const { sessions = [], hiddenOrgs = [] } = await chrome.storage.local.get(['sessions', 'hiddenOrgs']);
  const gone = sessions.filter(s => (s.orgIds || []).includes(org));
  const orgIds = new Set([org, ...gone.flatMap(s => s.orgIds || [])]);
  const keys = new Set(gone.map(s => s.key));
  const stores = await chrome.cookies.getAllCookieStores().catch(() => []);
  let cleared = false;
  for (const { id } of stores) {
    const c = await chrome.cookies.get({ url: CLAUDE, name: SESSION_COOKIE, storeId: id });
    if (c && keys.has(c.value)) {
      await chrome.cookies.remove({ url: CLAUDE, name: SESSION_COOKIE, storeId: id });
      await chrome.cookies.remove({ url: CLAUDE, name: 'lastActiveOrg', storeId: id });
      cleared = true;
    }
  }
  await chrome.storage.local.set({
    sessions: sessions.filter(s => !keys.has(s.key)),
    hiddenOrgs: [...new Set([...hiddenOrgs, ...orgIds])],
  });
  for (const key of keys) {
    await withSession(key, () => fetch(LOGOUT_URL, { method: 'POST', credentials: 'omit' })).catch(() => {});
  }
  if (cleared) for (const t of await chrome.tabs.query({ url: 'https://claude.ai/*' })) chrome.tabs.reload(t.id);
  return { t: Date.now(), ok: true, msg: `logged out${cleared ? ', claude.ai tabs signed out' : ''}; log in to it again to bring it back` };
}

// The browser's own key (the one plain fetches send) and the keys of any other cookie store (incognito).
async function browserKeys() {
  try {
    const stores = await chrome.cookies.getAllCookieStores();
    const keys = [];
    for (const s of stores) {
      const c = await chrome.cookies.get({ url: CLAUDE, name: SESSION_COOKIE, storeId: s.id });
      keys.push({ key: c?.value || null, main: s.id === '0' });
    }
    return { main: keys.find(k => k.main)?.key || null, others: keys.filter(k => !k.main && k.key).map(k => k.key) };
  } catch {
    return { main: null, others: [] };
  }
}

// claude.ai reissues sessionKey now and then (Set-Cookie) and the old value stops working. A saved account's
// requests omit credentials, so the browser drops that cookie: the new value is read here and replaces the saved
// key. Each request is tied to the key that was active when it started.
let activeKey = null;
const requestKeys = new Map();
const OWN = { urls: ['https://claude.ai/api/*'] };
const own = d => d.initiator === `chrome-extension://${chrome.runtime.id}`;
chrome.webRequest?.onBeforeRequest.addListener(d => { if (own(d) && activeKey) requestKeys.set(d.requestId, activeKey); }, OWN);
chrome.webRequest?.onHeadersReceived.addListener(d => {
  const old = requestKeys.get(d.requestId);
  requestKeys.delete(d.requestId);
  if (!old) return;
  for (const h of d.responseHeaders || []) {
    const m = h.name.toLowerCase() === 'set-cookie' && /^\s*sessionKey=([^;]+)/.exec(h.value || '');
    if (m && m[1] !== old) rotateKey(old, m[1]);
  }
}, OWN, ['responseHeaders', 'extraHeaders']);
chrome.webRequest?.onErrorOccurred.addListener(d => requestKeys.delete(d.requestId), OWN);

// old key -> the key claude.ai reissued it as. The storage update is queued behind the running poll, so it
// rewrites what that poll saved.
const rotated = new Map();
function rotateKey(old, key) {
  rotated.set(old, key);
  serial(async () => {
    const { sessions = [] } = await chrome.storage.local.get('sessions');
    for (const s of sessions) if (s.key === old) s.key = key;
    await chrome.storage.local.set({ sessions });
  });
}

// Runs fn with every request from this extension to claude.ai/api carrying `key` instead of the browser's login.
// Polls run one at a time, so one rule id is enough.
async function withSession(key, fn) {
  const jar = await chrome.cookies.getAll({ url: CLAUDE, storeId: '0' }).catch(() => []);
  const rest = jar.filter(c => c.name !== SESSION_COOKIE && c.name !== 'lastActiveOrg').map(c => `${c.name}=${c.value}`);
  let current;
  const use = async k => {
    current = activeKey = k;
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [RULE_ID], addRules: [{
      id: RULE_ID, priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'cookie', operation: 'set',
                                                          value: [...rest, `${SESSION_COOKIE}=${k}`].join('; ') }] },
      condition: { urlFilter: '|https://claude.ai/api/', initiatorDomains: [chrome.runtime.id], resourceTypes: ['xmlhttprequest'] },
    }] });
  };
  // A key reissued mid-poll is used from the next request on. Its header event can land after the response, so a
  // 401 waits briefly and retries once if a new key showed up.
  const get = async url => {
    if (rotated.has(current)) await use(rotated.get(current));
    try {
      return await getJson(url, 'omit');
    } catch (e) {
      if (!e.auth) throw e;
      await new Promise(r => setTimeout(r, 500));
      if (!rotated.has(current)) throw e;
      await use(rotated.get(current));
      return getJson(url, 'omit');
    }
  };
  await use(key);
  try { return await fn(get); }
  finally {
    activeKey = null;
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [RULE_ID] });
  }
}

// This worker is the only writer of the points list. Polls and imports run one at a time (each reads the list,
// changes it and writes it back), and the alarm and "Poll now" overlapping share one in-flight poll so points
// are not written twice.
let chain = Promise.resolve();
const serial = fn => { const r = chain.then(fn); chain = r.catch(() => {}); return r; };
let inFlight = null;
function poll() {
  inFlight ??= serial(pollOnce).finally(() => { inFlight = null; });
  return inFlight;
}
const importData = data => serial(() => importOnce(data));

// Every point carries its org id: one browser can see several accounts or orgs, each with its own week.
// The browser's own login is polled first, then every saved account; an org two accounts share is read once.
async function pollOnce() {
  const now = Date.now();
  try {
    const stored = await chrome.storage.local.get(['points', 'orgNames', 'orgPlans', 'orgUsers', 'sessions', 'hiddenOrgs']);
    const { points = [], orgNames = {}, orgPlans = {}, orgUsers = {} } = stored;
    let hiddenOrgs = Array.isArray(stored.hiddenOrgs) ? stored.hiddenOrgs : [];
    const saved = Array.isArray(stored.sessions) ? stored.sessions.filter(s => typeof s?.key === 'string') : [];
    const browser = await browserKeys();
    const runs = [{ key: browser.main, plain: true }];
    for (const key of [...browser.others, ...saved.map(s => s.key)]) {
      if (!runs.some(r => r.key === key)) runs.push({ key });
    }
    const data = { now, points, orgNames, orgPlans, orgUsers, done: new Set(), errors: [], read: 0 };
    const sessions = [];
    const fatal = [];
    const refused = [];
    for (const run of runs) {
      const old = saved.find(s => s.key === run.key);
      try {
        const acct = run.plain ? await pollAccount(getJson, data) : await withSession(run.key, get => pollAccount(get, data));
        // A saved key whose orgs were all read already is the same account under an older key: dropped.
        if (run.key && (run.plain || acct.tried)) {
          sessions.push({ key: run.key, name: acct.name || old?.name || '', orgIds: acct.orgIds });
        }
        // signed in again after "Log out": back in the list
        hiddenOrgs = hiddenOrgs.filter(id => !acct.orgIds.includes(id));
      } catch (e) {
        const who = old?.name || (old?.orgIds?.[0] && orgNames[old.orgIds[0]]) || 'saved account';
        // A saved key claude.ai refuses (logged out on claude.ai, expired) is kept and retried: an account on the
        // chart only leaves on the user's "Log out". The browser's own login being signed out is only an error when
        // nothing else could be read.
        const msg = e.message || String(e);
        if (run.plain) fatal.push(msg);
        if (!run.key) { if (!e.auth) data.errors.push(msg); continue; } // browser not signed in at all
        if (e.auth) {
          refused.push({ s: { ...(old || { key: run.key, name: '', orgIds: [] }), failedSince: old?.failedSince ?? now }, who });
        } else {
          data.errors.push(run.plain ? msg : `${who}: ${msg}`);
          sessions.push(old || { key: run.key, name: '', orgIds: [] });
        }
      }
    }
    // A refused key of an account that has a working login (an older key of it) is dropped, and of several
    // refused keys of one account only one is kept and reported.
    const working = new Set(sessions.filter(s => !s.failedSince).flatMap(s => s.orgIds || []));
    const reported = new Set();
    for (const { s, who } of refused) {
      const ids = s.orgIds || [];
      if (ids.length && ids.every(id => working.has(id))) continue;
      if (ids.length && reported.has(ids.join())) continue;
      reported.add(ids.join());
      sessions.push(s);
      data.errors.push(`${who}: signed out (log in to it again, or Log out to hide it)`);
    }
    if (!data.read) {
      // nothing read: points stay as they are, but refused keys are marked
      await chrome.storage.local.set({ sessions });
      throw new Error([...new Set([...fatal, ...data.errors])].join('; ') || 'no organization found');
    }
    const { errors } = data;
    const msg = errors.length ? `ok; ${errors.join('; ')}` : 'ok';
    const status = { t: now, ok: !errors.length, msg };
    await chrome.storage.local.set({ points, orgNames, orgPlans, orgUsers, sessions, hiddenOrgs, status });
    await updateBadge(points, now);
    return status;
  } catch (e) {
    const status = { t: now, ok: false, msg: String(e.message || e) };
    await chrome.storage.local.set({ status });
    await setBadge('?', '#8a8a8a', `Claude weekly usage: ${status.msg}`);
    return status;
  }
}

// Polls every chat org of one signed-in account (get = its fetcher) into data. Returns the account's name and orgs.
async function pollAccount(get, data) {
  const { now, points, orgNames, orgPlans, orgUsers, done, errors } = data;
  const orgs = await get(`${API}/organizations`);
  const list = (Array.isArray(orgs) ? orgs : (orgs?.organizations || [])).filter(o => o?.uuid || o?.id);
  const chat = list.filter(o => Array.isArray(o.capabilities) && o.capabilities.includes('chat'));
  const targets = chat.length ? chat : list.slice(0, 1);
  if (!targets.length) throw new Error('no organization found');

  // The signed-in person's name labels their personal orgs on the chart page. Optional: a failure here never
  // blocks the usage poll.
  let name = '';
  try {
    const who = accountLabel(await get(`${API}/account`));
    if (who) {
      name = who.name;
      const ids = who.orgIds.length ? who.orgIds : targets.map(o => o.uuid || o.id);
      for (const id of ids) orgUsers[id] = who.name;
    }
  } catch {}
  const failures = [];
  let tried = 0;
  for (const org of targets) {
    const orgId = org.uuid || org.id;
    if (done.has(orgId)) continue;
    tried++;
    if (org.name) orgNames[orgId] = String(org.name);
    const plan = planLabel(org);
    if (plan) orgPlans[orgId] = plan;
    try {
      const usage = await get(`${API}/organizations/${orgId}/usage`);
      const series = parseWeeklyUsage(usage);
      // Accounts with only a monthly $ spend limit get one monthly series instead.
      if (!Object.keys(series).length) {
        const m = parseMonthlySpend(usage, now);
        if (m) series[MONTHLY_KEY] = m;
      }
      for (const [key, v] of Object.entries(series)) {
        let last;
        for (let i = points.length - 1; i >= 0; i--) {
          if (points[i].key === key && points[i].org === orgId) { last = points[i]; break; }
        }
        // Every poll saves a point, changed or not, at most one per minute per series: a second poll in the same
        // minute (e.g. "Poll now" after using some tokens) replaces that minute's point with the newer value.
        const point = { t: now, org: orgId, key, pct: v.pct, reset: v.reset };
        if (key === MONTHLY_KEY) Object.assign(point, { start: v.start, used: v.used, limit: v.limit, currency: v.currency });
        if (last && Math.floor(last.t / MINUTE) === Math.floor(now / MINUTE)) points[points.lastIndexOf(last)] = point;
        else points.push(point);
      }
      done.add(orgId);
      data.read++;
    } catch (e) {
      failures.push(e);
      errors.push(`${orgNames[orgId] || orgId.slice(0, 8)}: ${e.message || e}`);
    }
  }
  // Every org of this account failed: the account itself failed (an auth failure marks a saved key signed out).
  if (tried && failures.length === tried) {
    const msgs = errors.splice(errors.length - failures.length);
    throw Object.assign(new Error(msgs.join('; ')), { auth: failures.every(e => e.auth) });
  }
  return { name, orgIds: targets.map(o => o.uuid || o.id), tried };
}

// An export file from the chart page: { points, orgNames, orgPlans, orgUsers, orgAliases } or a bare points array.
// New points are added, labels from the file only fill gaps (local values win).
async function importOnce(data) {
  const now = Date.now();
  try {
    const stored = await chrome.storage.local.get(['points', ...ORG_MAPS]);
    const points = stored.points || [];
    const n = mergePoints(points, Array.isArray(data) ? data : data?.points);
    const maps = {};
    for (const k of ORG_MAPS) {
      maps[k] = stored[k] || {};
      const m = data?.[k];
      if (!m || typeof m !== 'object' || Array.isArray(m)) continue;
      for (const [id, v] of Object.entries(m)) {
        if (typeof v === 'string' && v.trim() && !maps[k][id]) maps[k][id] = v.trim().slice(0, 60);
      }
    }
    const status = { t: now, ok: true, msg: `imported ${n} new point(s)` };
    await chrome.storage.local.set({ points, ...maps, status });
    await updateBadge(points, now);
    return status;
  } catch (e) {
    const status = { t: now, ok: false, msg: `import failed: ${e.message || e}` };
    await chrome.storage.local.set({ status });
    return status;
  }
}

const BADGE_COLORS = { zone: '#d99a00', under: '#3553b5', over: '#c0392b' };

// Toolbar badge = "All models" (or monthly spend) pace of the account picked on the chart page
// (else the newest one), e.g. "-3".
async function updateBadge(points, now) {
  const { selectedOrg, hiddenOrgs = [] } = await chrome.storage.local.get(['selectedOrg', 'hiddenOrgs']);
  const main = points.filter(p => (p.key === 'All models' || p.key === MONTHLY_KEY) && p.reset > now && !hiddenOrgs.includes(p.org));
  const inOrg = main.filter(p => p.org === selectedOrg);
  const pool = inOrg.length ? inOrg : main;
  if (!pool.length) return setBadge('', BADGE_COLORS.under, 'Open usage chart');
  const last = pool.reduce((a, p) => (p.t > a.t ? p : a));
  const d = last.pct - idealAt(now, last.reset, periodStart(last));
  // Same zone rule as the chart's dots: 0% is never in the zone, 100% inside the finish window is the goal.
  const zone = sampleZone({ ...last, t: now }, last.reset, periodStart(last));
  const r = Math.round(d);
  const pace = `${r > 0 ? '+' : ''}${r}%`;
  // Chrome shows about 4 badge characters: "-13%" fits, "-100%" does not, so the % is dropped only then.
  const text = pace.length <= 4 ? pace : pace.slice(0, -1);
  const label = zone === 'zone' ? 'in the zone' : zone === 'over' ? 'over pace' : 'under pace';
  const what = last.key === MONTHLY_KEY
    ? `Claude monthly spend ${formatMoney(last.used, last.currency)} of ${formatMoney(last.limit, last.currency)}`
    : `Claude weekly usage ${Math.round(last.pct)}%`;
  await setBadge(text, BADGE_COLORS[zone], `${what}, ${pace} vs ideal (${label})`);
}

async function setBadge(text, color, title) {
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeTextColor({ color: '#ffffff' });
  await chrome.action.setTitle({ title });
}

chrome.storage.onChanged.addListener(async ch => {
  if (!ch.selectedOrg && !ch.hiddenOrgs) return;
  const { points = [] } = await chrome.storage.local.get('points');
  updateBadge(points, Date.now());
});
