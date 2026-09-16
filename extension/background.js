importScripts('parse.js', 'pace.js');

const API = 'https://claude.ai/api';
const POLL_MIN = 10;
const MINUTE = 6e4;
const MONTHLY_KEY = 'Monthly spend';
// Per-account labels kept next to the points (see chart.js).
const ORG_MAPS = ['orgNames', 'orgPlans', 'orgUsers', 'orgAliases'];

chrome.runtime.onInstalled.addListener(setup);
chrome.runtime.onStartup.addListener(setup);
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'poll') poll(); });
chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: 'chart.html' }));
chrome.runtime.onMessage.addListener((msg, _s, reply) => {
  if (msg === 'poll') { poll().then(reply); return true; }
  if (msg?.type === 'import') { importData(msg.data).then(reply); return true; }
});

function setup() {
  chrome.alarms.create('poll', { periodInMinutes: POLL_MIN, delayInMinutes: 0.1 });
}

async function getJson(url) {
  const r = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
  if (r.status === 401 || r.status === 403) throw new Error(`not logged in to claude.ai (HTTP ${r.status})`);
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
  return r.json();
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
async function pollOnce() {
  const now = Date.now();
  try {
    const orgs = await getJson(`${API}/organizations`);
    const list = (Array.isArray(orgs) ? orgs : (orgs?.organizations || [])).filter(o => o?.uuid || o?.id);
    const chat = list.filter(o => Array.isArray(o.capabilities) && o.capabilities.includes('chat'));
    const targets = chat.length ? chat : list.slice(0, 1);
    if (!targets.length) throw new Error('no organization found');

    const { points = [], orgNames = {}, orgPlans = {}, orgUsers = {} } =
      await chrome.storage.local.get(['points', 'orgNames', 'orgPlans', 'orgUsers']);
    // The signed-in person's name labels their personal orgs on the chart page. Optional: a failure here never
    // blocks the usage poll.
    try {
      const who = accountLabel(await getJson(`${API}/account`));
      if (who) {
        const ids = who.orgIds.length ? who.orgIds : targets.map(o => o.uuid || o.id);
        for (const id of ids) orgUsers[id] = who.name;
      }
    } catch {}
    const errors = [];
    for (const org of targets) {
      const orgId = org.uuid || org.id;
      if (org.name) orgNames[orgId] = String(org.name);
      const plan = planLabel(org);
      if (plan) orgPlans[orgId] = plan;
      try {
        const usage = await getJson(`${API}/organizations/${orgId}/usage`);
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
      } catch (e) {
        errors.push(`${orgNames[orgId] || orgId.slice(0, 8)}: ${e.message || e}`);
      }
    }
    if (errors.length === targets.length) throw new Error(errors.join('; '));
    const msg = errors.length ? `ok; ${errors.join('; ')}` : 'ok';
    const status = { t: now, ok: !errors.length, msg };
    await chrome.storage.local.set({ points, orgNames, orgPlans, orgUsers, status });
    await updateBadge(points, now);
    return status;
  } catch (e) {
    const status = { t: now, ok: false, msg: String(e.message || e) };
    await chrome.storage.local.set({ status });
    await setBadge('?', '#8a8a8a', `Claude weekly usage: ${status.msg}`);
    return status;
  }
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
  const { selectedOrg } = await chrome.storage.local.get('selectedOrg');
  const main = points.filter(p => (p.key === 'All models' || p.key === MONTHLY_KEY) && p.reset > now);
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
  if (!ch.selectedOrg) return;
  const { points = [] } = await chrome.storage.local.get('points');
  updateBadge(points, Date.now());
});
