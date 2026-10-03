const HOUR = 36e5;
const UNUSED_WARN = 5; // projected % left unused at the reset above which the line turns red
const NS = 'http://www.w3.org/2000/svg';
const PANEL_W = 796; // design width of one chart: .panel max-width plus its side padding
// Series still polled and stored but not drawn (case-insensitive). Remove a name to bring its chart back with its
// full history; the frontier look in panel() and chart.html stays for that.
const HIDDEN_SERIES = ['Fable'];
// What 1% of the "All models" weekly limit is worth at API list prices, by plan, until the user's own Claude Code logs
// measure it (apiRate). claude.ai reports plan usage only in percent. Max 20x: Reddit audits that priced usage logs at
// list against the meter after the September 2026 limit change (about $1,900 a week; cache-heavy Opus 4.6 mixes
// $23.50 to $25). Max 5x: the same over the 2.2x weekly ratio measured between the two plans. Other plans: percent.
const API_USD_PER_PCT = { 'Max 20x': 19, 'Max 5x': 8.6 };
const API_SOURCE = 'Reddit audits of usage logs against the meter, September 2026';
// orgNames, orgPlans and orgUsers (the signed-in person's name) come from claude.ai; orgAliases are names the
// user typed and win over everything.
const ORG_MAPS = ['orgNames', 'orgPlans', 'orgUsers', 'orgAliases'];
// week = the reset time of the period on screen (null = the newest), so a new period arriving while the page is
// open does not move an older one out from under the reader.
// view = the zoom shared by every chart on the page (see setView); viewOf = the account and period it belongs to.
// logMinutes / logSpan = imported Claude Code dollars per minute and the time they cover (see the logs button).
const state = { points: [], held: [], orgNames: {}, orgPlans: {}, orgUsers: {}, orgAliases: {}, hiddenOrgs: [], signedOut: new Set(), org: null, week: null, weeks: [], weekNames: [], allMarkers: false, drawn: 0,
                view: { k: 1, x: 0, y: 0 }, viewOf: null, redraws: [], refreshes: [], drag: null, logMinutes: [], logSpan: null };
const $ = id => document.getElementById(id);

async function load() {
  const stored = await chrome.storage.local.get(['points', 'held', 'status', 'selectedOrg', 'hiddenOrgs', 'logMinutes', 'logSpan', 'logState', ...ORG_MAPS]);
  state.logMinutes = Array.isArray(stored.logMinutes) ? stored.logMinutes : [];
  state.logSpan = stored.logSpan || null;
  await syncButton(stored.logState); // before render: the first-run card shows the sync link only when it is needed
  // Every point carries its account (org); anything without one is ignored.
  state.points = (stored.points || []).filter(p => p && p.org);
  // The newest sample of each series while its value stands still: drawn as the last point, not stored as one.
  state.held = Object.values(stored.held || {}).filter(p => p && p.org);
  for (const k of ORG_MAPS) state[k] = stored[k] || {};
  state.hiddenOrgs = Array.isArray(stored.hiddenOrgs) ? stored.hiddenOrgs : [];
  if (state.org === null && stored.selectedOrg) state.org = stored.selectedOrg;
  state.status = stored.status || null; // the last poll's result, for the first-run card (welcome)
  showStatus(stored.status);
  render();
  markSignedOut();
}

// Accounts whose saved login claude.ai refuses get "(signed out)" in the account menu. The worker keeps the keys
// and only reports which orgs they cover.
async function markSignedOut() {
  const list = await chrome.runtime.sendMessage({ type: 'accounts' }).catch(() => []);
  if (!Array.isArray(list)) return;
  const ok = new Set(list.filter(a => !a.signedOut).flatMap(a => a.orgIds));
  state.signedOut = new Set(list.filter(a => a.signedOut).flatMap(a => a.orgIds).filter(id => !ok.has(id)));
  for (const o of $('account').options) {
    if (o.value !== ADD) o.textContent = acctLabel(o.value);
  }
}

const ADD = '+add';

function orgName(id) {
  if (state.orgAliases[id]) return state.orgAliases[id];
  // claude.ai names personal orgs "<email or name>'s Organization". For those, show the person's name
  // (what Claude calls them, else full name, else email). A real org name such as "Acme Corp" stays.
  const raw = (state.orgNames[id] || '').trim();
  const personal = !raw || /['’]s?\s+Organization\s*$/i.test(raw) || /^[^\s@]+@[^\s@]+$/.test(raw);
  if (personal && state.orgUsers[id]) return state.orgUsers[id];
  const name = raw.replace(/\s*['’]s?\s+Organization\s*$/i, '').trim();
  return name || `Account ${id.slice(0, 8)}`;
}

const orgLabel = id => (state.orgPlans[id] ? `${orgName(id)} · ${state.orgPlans[id]}` : orgName(id));
const acctLabel = id => `${orgLabel(id)}${state.signedOut.has(id) ? ' (signed out)' : ''}`;

const samples = () => [...state.points, ...state.held];

// Accounts ordered by most recent sample, so the one polled last is the default.
function orgs() {
  const latest = new Map();
  for (const p of samples()) {
    if (!state.hiddenOrgs.includes(p.org)) latest.set(p.org, Math.max(latest.get(p.org) || 0, p.t));
  }
  return [...latest.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
}

// A poll that read nothing because no login works (background.js marks it auth).
const isAuth = s => !!s && !s.ok && (s.auth || /not logged in to claude\.ai/.test(s.msg || ''));

function showStatus(s) {
  const el = $('status');
  if (!s) { el.textContent = 'no poll yet'; el.title = ''; el.dataset.auth = ''; return; }
  // Not logged in: what to do, in plain words; claude.ai's own answer stays in the tooltip. With nothing charted
  // yet the first-run card says it already, so the line is hidden then (render).
  el.textContent = isAuth(s)
    ? `Not logged in to claude.ai (checked ${new Date(s.t).toLocaleTimeString(undefined, { hourCycle: 'h23' })}): log in to keep the chart updating`
    : `last poll ${new Date(s.t).toLocaleString(undefined, { hourCycle: 'h23' })}: ${s.msg}`;
  el.title = isAuth(s) ? s.msg : '';
  el.dataset.auth = isAuth(s) ? '1' : '';
  el.hidden = isAuth(s) && !state.weeks.length;
  el.classList.toggle('bad', !s.ok);
}

const openTab = url => (chrome.tabs?.create ? chrome.tabs.create({ url }) : window.open(url));

// First run, nothing charted yet: the next step, from the last poll's result, instead of an empty chart.
function welcome() {
  const s = state.status;
  const box = document.createElement('div');
  box.className = 'welcome';
  const h = document.createElement('h2');
  const lead = document.createElement('p');
  lead.className = 'lead';
  const go = document.createElement('button');
  go.className = 'primary';
  if (!s || isAuth(s)) {
    h.textContent = 'Log in to claude.ai to start';
    lead.textContent = 'Log in in this browser. The chart fills in by itself within a minute, with nothing else to set up.';
    go.textContent = 'Open claude.ai';
    go.onclick = () => openTab('https://claude.ai/login');
  } else {
    h.textContent = s.ok ? 'Reading your usage' : 'claude.ai did not answer';
    lead.textContent = s.ok ? 'You are logged in. The chart starts with the first weekly reading, checked every minute.'
      : `${s.msg}. The extension tries again every minute.`;
    go.textContent = 'Poll now';
    go.onclick = () => $('pollnow').click();
  }
  const opt = (before, label, after, act) => {
    const p = document.createElement('p');
    p.className = 'opt';
    const b = document.createElement('button');
    b.className = 'link';
    b.textContent = label;
    b.onclick = act;
    p.append(before, b, after);
    return p;
  };
  box.append(h, lead, go, opt('Reinstalling, or moving from another browser? ', 'Import', ' the file you exported.', () => $('import').click()));
  const sync = () => $('sync').click();
  if (state.syncWhy === 'connect') box.append(opt('Use Claude Code? ', 'Sync with Claude folder', ` to price your usage from your own logs: pick ${CLAUDE_HOME}.`, sync));
  if (state.syncWhy === 'allow') box.append(opt('The Claude folder sync paused while this tab was closed. ', 'Keep syncing', ' to resume it.', sync));
  if (state.syncWhy === 'fix') box.append(opt('The Claude folder can\'t be read. ', 'Sync with Claude folder', ` to pick it again: ${CLAUDE_HOME}.`, sync));
  return box;
}

// Weeks are identified by their reset time; resets within 6 h of each other are the same week.
function weeks(pts) {
  const resets = [...new Set(pts.map(p => p.reset))].sort((a, b) => b - a);
  const out = [];
  for (const r of resets) if (!out.some(w => Math.abs(w - r) < 6 * HOUR)) out.push(r);
  return out;
}

const fmtDay = t => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const MONTHLY_KEY = 'Monthly spend';
const fmtPct = v => `${Number.isInteger(v) ? v : v.toFixed(1)}%`;

function periodLabel(start, end) {
  // Monthly periods are UTC calendar months: name the month instead of two dates.
  if (end - start > 8 * 864e5) {
    return new Date(start).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
  }
  return `${fmtDay(start)} to ${fmtDay(end)}`;
}

function render() {
  const os = orgs();
  if (!os.includes(state.org)) { state.org = os[0] ?? null; state.week = null; }
  const acct = $('account');
  acct.innerHTML = '';
  for (const id of os) {
    const o = document.createElement('option');
    o.value = id;
    o.textContent = acctLabel(id);
    acct.appendChild(o);
  }
  // Adding an account clears claude.ai's login here only, so the accounts already saved keep updating.
  const add = document.createElement('option');
  add.value = ADD;
  add.textContent = '+ Add account';
  acct.appendChild(add);
  acct.value = state.org;
  // no account yet: hidden, the first-run card's login button is the way in
  acct.hidden = !os.length;
  $('rename').hidden = $('logout').hidden = !os.length;

  state.drawn = Date.now();
  const orgPts = samples().filter(p => p.org === state.org);
  const ws = weeks(orgPts);
  // Current = the reset reported by this account's newest sample, if still ahead.
  const newest = orgPts.reduce((a, p) => (!a || p.t > a.t ? p : a), null);
  const isCurrent = r => newest && Math.abs(r - newest.reset) < 6 * HOUR && r > Date.now();
  state.weeks = ws;
  state.weekNames = [];
  const weekIdx = Math.max(0, ws.findIndex(r => state.week !== null && Math.abs(r - state.week) < 6 * HOUR));
  const sel = $('week');
  sel.innerHTML = '';
  ws.forEach((r, i) => {
    const o = document.createElement('option');
    o.value = i;
    const group = orgPts.filter(p => Math.abs(p.reset - r) < 6 * HOUR);
    const start = periodStart(group[0]);
    const main = group.filter(p => p.key === 'All models' || p.key === MONTHLY_KEY).sort((a, b) => a.t - b.t);
    const res = r <= Date.now() && weekResult(main, r, Date.now(), start);
    state.weekNames[i] = periodLabel(start, r);
    o.textContent = `${state.weekNames[i]}${isCurrent(r) ? ' (current)' : ''}${res ? ` · rank ${res.grade}` : ''}`;
    sel.appendChild(o);
  });
  sel.value = weekIdx;
  // Nothing charted yet: only what helps get started stays (account menu, Import, Sync).
  // Nothing charted yet: the first-run card holds the next steps (welcome), so the bar below stays empty.
  sel.hidden = $('delete').hidden = $('markers').hidden = $('export').hidden = $('pollnow').hidden = $('count').hidden
    = $('import').hidden = !ws.length;
  $('sync').hidden = !state.syncNeeded || !ws.length;
  $('status').hidden = !ws.length && !!$('status').dataset.auth;
  $('count').textContent = `${state.points.length} points stored`;
  $('markers').setAttribute('aria-pressed', state.allMarkers);

  const charts = $('charts');
  charts.innerHTML = '';
  state.redraws = [];
  state.refreshes = [];
  if (!ws.length) {
    charts.appendChild(welcome());
    layout();
    return;
  }
  const reset = ws[weekIdx];
  // Another account or period opens on its whole period; a redraw for new samples keeps the zoom.
  if (!state.viewOf || state.viewOf.org !== state.org || Math.abs(state.viewOf.reset - reset) >= 6 * HOUR) {
    state.viewOf = { org: state.org, reset };
    state.view = { k: 1, x: 0, y: 0 };
  }
  const inWeek = orgPts.filter(p => Math.abs(p.reset - reset) < 6 * HOUR);
  const keys = [...new Set(inWeek.map(p => p.key))]
    .filter(k => !HIDDEN_SERIES.some(h => h.toLowerCase() === k.toLowerCase()))
    .sort((a, b) => (a === 'All models' ? -1 : b === 'All models' ? 1 : a.localeCompare(b)));
  for (const k of keys) {
    const pts = inWeek.filter(p => p.key === k).sort((a, b) => a.t - b.t);
    charts.appendChild(panel(k, pts, reset, periodStart(pts[pts.length - 1])));
  }
  layout();
}

// The page is one picture: laid out at a fixed design width (the charts side by side at full size), then scaled
// up or down as a whole to fit the window, centred, with nothing to scroll.
function layout() {
  const n = Math.max(1, document.querySelectorAll('.panel').length);
  $('stage').style.width = `${n * PANEL_W + 32}px`;
  fit();
}

// Only the transform: fit also runs from the ResizeObserver, where changing the stage's size would loop.
function fit() {
  const stage = $('stage');
  const w = stage.offsetWidth, h = stage.offsetHeight;
  const s = Math.min(innerWidth / w, innerHeight / h);
  stage.style.transform = `translate(${(innerWidth - w * s) / 2}px, ${(innerHeight - h * s) / 2}px) scale(${s})`;
}

const sampleCount = pts => `${pts.length} sample${pts.length === 1 ? '' : 's'}`;

function el(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

function panel(name, pts, end, start) {
  const div = document.createElement('div');
  // Fable is the frontier model: its chart gets its own color and a tag.
  const frontier = /fable/i.test(name);
  div.className = frontier ? 'panel model-frontier' : 'panel';
  div.innerHTML = '<h2><span class="model-name"></span></h2>';
  div.querySelector('.model-name').textContent = name;
  if (frontier) {
    const tag = document.createElement('span');
    tag.className = 'frontier-tag';
    tag.textContent = 'FRONTIER';
    div.querySelector('h2').append(' ', tag);
  }

  // Monthly spend charts are drawn in money: the y axis maps 0..100% to 0..the latest limit.
  const money = pts.length && Number.isFinite(pts[pts.length - 1].limit) ? pts[pts.length - 1] : null;
  const cash = pct => formatMoney(pct / 100 * money.limit, money.currency);
  const W = 820, H = 560, L = money ? 84 : 62, R = 16, T = 16, B = 40;
  const PW = W - L - R, PH = H - T - B;
  const y1 = Math.max(100, ...pts.map(p => p.pct));
  const days = Math.round((end - start) / 864e5);
  // Finish window: reaching 100% anywhere in it is the top result (the last 36 h, where the zone band reaches
  // 100%, or the month's last working day).
  const fin = finishWindow(end, start);
  const finName = money ? 'last working day' : 'finish zone';
  const finIn = `${money ? 'on' : 'in'} the ${finName}`;
  const Z = zonePts(end, start);
  const live = end > Date.now();
  const last = pts[pts.length - 1];
  const lastZone = last && sampleZone(last, end, start);
  const proj = projection(pts, end, start);
  const period = money ? 'month' : 'week';
  const legend = `x: ${period} time · y: ${money ? 'spend' : 'usage'} · dashed = ideal · band = zone · ${sampleCount(pts)}`;
  const edge = t => new Date(t).toLocaleString(undefined, { ...(money ? { month: 'short', day: 'numeric' } : { weekday: 'short' }),
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  // filled: a stretch where usage stood still is read every 10 minutes, not only at its two ends
  const hoverPts = pts.length ? [{ t: start, pct: 0, anchor: true }, ...filled(pts)] : [];

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${name} usage chart` });
  const clipId = 'c' + Math.random().toString(36).slice(2);
  const tip = document.createElement('div');
  tip.className = 'tip';
  const sub = document.createElement('div');
  sub.className = 'sub';

  // Drawn again on every zoom step. Zoom 1 is the whole period, so the ideal line and the finish zone are in view.
  const draw = () => {
    const { k, x: vx, y: vy } = state.view;
    const X = t => L + ((t - start) / (end - start) - vx) * k * PW;
    const Y = v => H - B - (v / y1 - vy) * k * PH;
    const t0 = start + vx * (end - start), t1 = t0 + (end - start) / k;
    const v0 = vy * y1, v1 = v0 + y1 / k;
    const inX = x => x >= L - 0.5 && x <= W - R + 0.5;
    svg.replaceChildren();
    svg.classList.toggle('zoomed', k > 1);
    el('rect', { x: L, y: T, width: PW, height: PH }, el('clipPath', { id: clipId }, el('defs', {}, svg)));

    // About ten value lines in view: every 10% on the whole period, every 20% above 100%.
    const yStep = Math.min(20, niceStep(y1 / k / 10));
    // Money labels in whole units when a line step is a whole amount or at least 10, else with cents ($27.50).
    const unit = money && yStep / 100 * money.limit;
    const whole = money && (unit >= 10 || Number.isInteger(+unit.toFixed(6)));
    // max: Math.ceil(-1e-9) is -0, which the money format prints as "-$0"
    for (let i = Math.max(0, Math.ceil(v0 / yStep - 1e-9)); i * yStep <= v1 + 1e-9; i++) {
      const v = i * yStep;
      el('line', { x1: L, x2: W - R, y1: Y(v), y2: Y(v), stroke: 'var(--grid)' }, svg);
      const amount = money && v / 100 * money.limit;
      el('text', { x: L - 8, y: Y(v) + 4, 'text-anchor': 'end' }, svg).textContent = money
        ? formatMoney(whole ? Math.round(amount) : amount, money.currency).replace(/\.00$/, '')
        : `${+v.toFixed(3)}%`;
    }
    for (const [t, label] of timeTicks(t0, t1, start, end, days)) {
      const x = X(t);
      if (!inX(x)) continue;
      el('line', { x1: x, x2: x, y1: T, y2: H - B, stroke: 'var(--grid)' }, svg);
      if (x <= W - R - 16) el('text', { x, y: H - B + 22, 'text-anchor': 'middle' }, svg).textContent = label;
    }
    if (inX(X(end))) el('line', { x1: X(end), x2: X(end), y1: T, y2: H - B, stroke: 'var(--grid)' }, svg);
    el('line', { x1: L, x2: L, y1: T, y2: H - B, stroke: 'var(--axis)' }, svg);
    el('line', { x1: L, x2: W - R, y1: H - B, y2: H - B, stroke: 'var(--axis)' }, svg);

    const g = el('g', { 'clip-path': `url(#${clipId})` }, svg);
    const fx = X(fin.start);
    el('rect', { class: 'finish', x: fx, y: T, width: Math.max(0, X(fin.end) - fx), height: PH }, g);
    // bottom of the window, clear of the 100% dots
    el('text', { class: 'finish-label', x: (fx + X(fin.end)) / 2, y: H - B - 10, 'text-anchor': money ? 'end' : 'middle' }, g)
      .textContent = `🏁 ${finName}`;
    if (money) g.lastChild.setAttribute('x', X(fin.end) - 4); // a one-day column in a month is narrow
    el('polygon', { class: 'zone-band', points: [[start, -Z], [end, 100 - Z], [end, 100 + Z], [start, Z]]
      .map(([t, v]) => `${X(t)},${Y(v)}`).join(' ') }, g);
    el('line', { x1: X(start), y1: Y(0), x2: X(end), y2: Y(100), stroke: 'var(--ideal)',
                 'stroke-width': 2, 'stroke-dasharray': '7 6' }, g);

    if (pts.length) {
      // Projection to the reset, stopping where it would hit 100%.
      if (live && proj.rate > 0) {
        const hits = proj.hitAt && proj.hitAt < end;
        const tx = hits ? proj.hitAt : end;
        const ty = hits ? 100 : proj.projected;
        const kind = !hits ? 'ok' : proj.hitAt < fin.start ? 'over' : 'goal';
        el('line', { class: `proj proj-${kind}`,
                     x1: X(last.t), y1: Y(last.pct), x2: X(tx), y2: Y(Math.min(ty, y1)) }, g);
        el('circle', { class: 'proj-end', cx: X(tx), cy: Y(Math.min(ty, y1)), r: 4 }, g);
      }
      // Usage is 0% at the reset, so the period start is a known point even before the first sample.
      // The stretch to the first sample was not observed: faint dashes.
      if (pts[0].t - start > HOUR) {
        el('line', { class: 'gap', x1: X(start), y1: Y(0), x2: X(pts[0].t), y2: Y(pts[0].pct) }, g);
      }
      const anchor = { class: 'anchor', cx: X(start), cy: Y(0), r: 7 };
      el('polyline', { points: pts.map(p => `${X(p.t)},${Y(p.pct)}`).join(' '), fill: 'none',
                       stroke: 'var(--line)', 'stroke-width': 2 }, g);
      const shown = state.allMarkers ? pts : moved(pts);
      for (const p of shown) el('circle', { class: `dot dot-${sampleZone(p, end, start)}`, cx: X(p.t), cy: Y(p.pct), r: 5 }, g);
      // On the clip edge at zoom 1, so drawn unclipped there; zoomed, the plot edge clips it like any point.
      el('circle', anchor, vx || vy ? g : svg);
      if (live) {
        el('circle', { class: `pulse pulse-${lastZone}`, cx: X(last.t), cy: Y(last.pct), r: 8 }, g);
        el('circle', { class: `now now-${lastZone}`, cx: X(last.t), cy: Y(last.pct), r: 8 }, g);
      }
      hover(div, svg, tip, hoverPts, X, Y, { L, R, T, B, W, H }, end, start, money && cash);
    }
    sub.textContent = k === 1 ? `${legend} · scroll to zoom`
      : `${edge(t0)} to ${edge(t1)} · ${k < 10 ? k.toFixed(1) : Math.round(k)}x · drag to move, double-click for the whole ${period}`;
  };
  draw();
  state.redraws.push(draw);
  zoomable(svg, { L, PW, PH, H, B });
  div.appendChild(svg);
  if (pts.length) div.appendChild(tip);

  if (!pts.length) return div;
  const result = weekResult(pts, end, Date.now(), start);
  // "40%" on weekly charts, "$200 of $500" on monthly spend.
  const amount = pct => (money ? cash(pct) : `${pct.toFixed(0)}%`);
  // Weekly "All models": what a share of the limit is worth at API list prices, an estimate in whole dollars.
  // read again by refresh() on every poll, as the synced Claude Code logs grow
  let rate = null;
  const apiUsd = pct => fmtWhole(pct * rate.usd);
  const atApi = pct => (rate ? ` (≈ ${apiUsd(pct)})` : '');
  // Text that changes with the rate or the clock: [element, text] pairs set by refresh(), now and on every poll.
  const texts = [];
  const limitTxt = money ? `the ${cash(100)} limit` : '100%';
  const chip = document.createElement('span');
  chip.className = `grade grade-${result.grade}`;
  chip.textContent = result.grade;
  chip.title = `${result.live ? 'Rank if this pace holds' : 'Final rank'}: score ${result.score.toFixed(1)}. `
    + `Score = ${period === 'month' ? 'spend' : 'usage'} at the reset, minus half the share of the ${period} the limit `
    + `blocks before the ${finName}. S 95+, A 90+, B 75+, C 50+, else D. Blocked early: at most A.`;
  div.querySelector('h2').append(' ', chip);
  const hint = document.createElement('span');
  hint.className = 'grade-hint';
  hint.textContent = result.live ? 'on track for' : 'final rank';
  chip.before(hint);

  const d = deviation(last, end, start);
  const pace = document.createElement('div');
  const paceText = document.createElement('span');
  const tag = document.createElement('span');
  tag.className = 'zone-tag';
  if (live) {
    pace.className = `pace pace-${lastZone}`;
    texts.push([paceText, () => `${money ? `${cash(last.pct)} of ${cash(100)} · ` : rate ? `≈ ${apiUsd(last.pct)} of ${apiUsd(100)} · ` : ''}`
      + `Pace: ${d > 0 ? '▲ +' : '▼ '}${d.toFixed(1)}%`]);
    tag.textContent = lastZone === 'zone' ? 'IN THE ZONE' : lastZone === 'over' ? 'over' : 'under';
  } else {
    // Finished period: the result, not a live pace.
    if (result.hitAt) {
      pace.className = `pace result ${result.onFinalDay ? 'pace-zone' : 'pace-early'}`;
      paceText.textContent = result.onFinalDay ? `🏁 Used it all ${finIn}` : 'Used it all';
      tag.textContent = `${money ? cash(100) : '100%'} ${fmtWhen(result.hitAt)}, ${fmtDur(result.earlyMs)} before reset`;
    } else {
      pace.className = 'pace result';
      texts.push([paceText, () => `Final: ${amount(result.final)}${money ? ` of ${cash(100)}` : ''} used`
        + (rate ? ` (≈ ${apiUsd(result.final)} of ${apiUsd(100)})` : '')]);
      texts.push([tag, () => `${amount(100 - result.final)} unused${atApi(100 - result.final)}`]);
    }
  }
  pace.append(paceText, ' ', tag);
  div.appendChild(pace);

  // 🔥 The session burning now (burnSession, to this minute) and the period's fastest climb timed to the minute
  // (burnPeak): money on monthly spend, API-price dollars on weekly limits with a rate, else percent.
  const pctText = pct => `${pct >= 10 ? Math.round(pct) : +pct.toPrecision(2)}%`;
  const used = pct => (money ? cash(pct) : rate ? `≈ ${apiUsd(pct)}` : pctText(pct));
  const perMin = pct => (money ? fmtRate(pct / 100 * money.limit, money.currency)
    : rate ? fmtRate(pct * rate.usd, 'USD') : pctText(pct));
  const peak = burnPeak(pts);
  const burn = document.createElement('div');
  texts.push([burn, () => {
    const session = live ? burnSession(pts, Date.now()) : null;
    const parts = [];
    if (session) parts.push(`This session burned ${used(session.used)} (${perMin(session.perMin)} / minute) since ${fmtSince(session.from)}`);
    if (peak) parts.push(`${session ? 'peak' : 'Peak'} ${perMin(peak.perMin)} / minute on ${fmtSec(peak.at)}`);
    burn.hidden = !parts.length;
    return parts.length ? `🔥 ${parts.join(' · ')}` : '';
  }]);
  const refresh = () => {
    rate = !money && name === 'All models' ? apiRate(pts) : null;
    for (const [node, text] of texts) node.textContent = text();
    pace.title = rate ? rate.note : '';
    burn.title = `A session starts after the longest break between moves of the last ${BURN_LOOKBACK_MS / HOUR} h (for most `
      + `people the night) and runs to now; ${BURN_IDLE_MS / HOUR} h without a move ends it. `
      + 'Peak = the fastest climb between two moves that are both timed to the minute.'
      + (money ? '' : ' Weekly usage moves in whole percent.') + (rate ? ` ${rate.note}` : '');
  };
  state.refreshes.push(refresh);

  const stats = document.createElement('div');
  stats.className = 'stats';
  const st = streaks(pts, end, start);
  const line1 = document.createElement('div');
  if (!live) {
    line1.textContent = `${st.best >= HOUR ? `best streak ${fmtDur(st.best)}` : 'no streak'} · ${result.avgDev.toFixed(1)}% off the ideal line on average`;
    stats.appendChild(line1);
    stats.appendChild(burn);
    refresh();
    div.appendChild(stats);
    div.appendChild(sub);
    return div;
  }
  const best = st.best >= HOUR ? ` · best ${fmtDur(st.best)}` : '';
  if (st.current !== null && live) {
    line1.textContent = st.current < HOUR ? `🎯 In the zone: streak starts now${best}` : `🎯 ${fmtDur(st.current)} in the zone${best}`;
  } else {
    line1.textContent = (st.best >= HOUR ? `best streak ${fmtDur(st.best)}` : 'no streak yet')
      + (live ? ` · get within ${Math.round(zonePts(end, start))}% of the line to start one` : '');
  }
  if (st.current !== null && live) line1.className = 'streak-on';
  stats.appendChild(line1);
  if (live) {
    const line2 = document.createElement('div');
    if (proj.hitAt && proj.hitAt < end && proj.hitAt >= fin.start && proj.hitAt <= fin.end) {
      line2.className = 'streak-on';
      line2.textContent = `🏁 Hits ${limitTxt} ${fmtWhen(proj.hitAt)}, ${finIn}`;
    } else if (proj.hitAt && proj.hitAt < fin.start) {
      line2.className = 'warn';
      line2.textContent = `Hits ${limitTxt} ${fmtWhen(proj.hitAt)} · ${fmtDur(fin.start - proj.hitAt)} before the ${finName}`;
    } else if (proj.hitAt && proj.hitAt < end) {
      line2.className = 'loss';
      line2.textContent = `Hits ${limitTxt} ${fmtWhen(proj.hitAt)}, after the ${finName}: aim for ${fmtWhen(fin.start)} or later that day`;
    } else {
      const left = 100 - Math.min(100, proj.projected);
      texts.push([line2, () => `Projected ${amount(Math.min(100, proj.projected))} at reset · ${amount(left)} left unused${atApi(left)}`]);
      if (left > UNUSED_WARN) line2.className = 'loss';
    }
    stats.appendChild(line2);
  }
  stats.appendChild(burn);
  refresh();
  div.appendChild(stats);
  if (live && lastZone === 'zone') div.classList.add('in-zone');
  div.appendChild(sub);
  return div;
}

function fmtDur(ms) {
  const h = ms / HOUR;
  if (h < 1) return `${Math.round(ms / 6e4)}m`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

const fmtWhen = t => new Date(t).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const fmtSec = t => new Date(t).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const fmtSince = t => new Date(t).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

// What 1% of the account's "All models" weekly limit is worth at API list prices, with where that comes from: the
// imported Claude Code logs where they cover the climb (the period on screen, else the newest period they cover, see
// measuredRate), else the plan's value in API_USD_PER_PCT, else null (the chart stays in percent).
function apiRate(pts) {
  const series = samples().filter(p => p.org === state.org && p.key === 'All models');
  const periods = [pts, ...weeks(series).map(r => series.filter(p => Math.abs(p.reset - r) < 6 * HOUR).sort((a, b) => a.t - b.t))];
  for (const ps of periods) {
    const m = measuredRate(ps, state.logMinutes, state.logSpan);
    if (m) {
      const when = ps === pts ? 'this period' : `the period to ${fmtDay(ps[ps.length - 1].reset)}`;
      return { usd: m.usdPerPct, note: `Dollars at API list prices: 1% ≈ ${formatMoney(m.usdPerPct)}, measured from your `
        + `synced Claude Code logs in ${when} (logged calls in stretches holding ${m.covered} of the ${m.climbed} points climbed).` };
    }
  }
  const plan = state.orgPlans[state.org];
  const usd = API_USD_PER_PCT[plan];
  return usd ? { usd, note: `Dollars at API list prices: 1% of the ${plan} weekly limit ≈ ${formatMoney(usd)}, from ${API_SOURCE}. `
    + (state.logSpan ? 'Your synced Claude Code logs do not cover enough of this account\'s climb yet to measure your own.'
      : 'Sync your Claude folder to measure your own.') } : null;
}

const fmtWhole = v => {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(v);
  } catch {
    return `$${Math.round(v)}`;
  }
};

// Money per minute: two significant digits below one unit, so a slow burn does not read "$0.00".
function fmtRate(v, currency) {
  if (v >= 1) return formatMoney(v, currency);
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, minimumSignificantDigits: 2, maximumSignificantDigits: 2 }).format(v);
  } catch {
    return `${v.toPrecision(2)} ${currency}`;
  }
}

// Time grid for the part of the period in view, about eight lines at most: whole days (a week) or weeks (a month)
// counted from the period start, as on the whole period; zoomed in to four days or less, local clock times.
const CLOCK_STEPS = [5, 10, 15, 30, 60, 120, 180, 360, 720]; // minutes
function timeTicks(t0, t1, start, end, days) {
  const out = [];
  const min = CLOCK_STEPS.find(m => t1 - t0 <= 8 * m * 6e4);
  if (!min) {
    const step = [1, 2, 7].find(s => t1 - t0 <= 8 * s * 864e5) ?? 7;
    for (let d = Math.ceil((t0 - start) / 864e5 / step - 1e-9) * step; d < days && start + d * 864e5 <= t1; d += step) {
      const t = start + d * 864e5;
      // Month ticks are dated in UTC like the period itself, else a UTC-minus reader sees "Aug 31" under "September".
      out.push([t, days > 8 ? new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
        : new Date(t).toLocaleDateString(undefined, { weekday: 'short' })]);
    }
    return out;
  }
  const c = new Date(t0);
  c.setHours(0, Math.floor((c.getHours() * 60 + c.getMinutes()) / min) * min, 0, 0);
  for (; c.getTime() <= t1; c.setMinutes(c.getMinutes() + min)) {
    const t = c.getTime();
    // Midnight is named by its day, every other line by its time.
    if (t >= t0 && t < end) out.push([t, c.getHours() || c.getMinutes()
      ? c.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      : c.toLocaleDateString(undefined, days > 8 ? { month: 'short', day: 'numeric' } : { weekday: 'short' })]);
  }
  return out;
}

// 1, 2 or 5 times a power of ten: the smallest one at least x.
function niceStep(x) {
  const p = 10 ** Math.floor(Math.log10(x));
  return [1, 2, 5, 10].map(m => m * p).find(s => s >= x * (1 - 1e-9));
}

// Zoom: k = magnification (1 = the whole period), x / y = the view's left / bottom edge as a share of the whole
// period / of the whole value range. Same in both directions, so the ideal line keeps its slope and 1% steps a
// minute apart move apart; kept inside the whole period. One view for every chart on the page.
const ZOOM_MAX = 50;
let redrawDue = false;
function setView(k, x, y) {
  // Snapped to 1: as many notches out as in can leave 1.0000000000000002.
  k = k < 1 + 1e-9 ? 1 : Math.min(ZOOM_MAX, k);
  const room = 1 - 1 / k;
  x = Math.min(room, Math.max(0, x));
  y = Math.min(room, Math.max(0, y));
  const v = state.view;
  if (v.k === k && v.x === x && v.y === y) return;
  state.view = { k, x, y };
  if (redrawDue) return;
  redrawDue = true;
  requestAnimationFrame(() => { redrawDue = false; for (const f of state.redraws) f(); });
}

// The wheel zooms around the pointer, a drag moves the zoomed view, a double-click returns to the whole period.
function zoomable(svg, b) {
  // The pointer as a share of the plot, from its left and from its bottom edge; null outside the plot.
  const at = e => {
    const m = svg.getScreenCTM();
    if (!m) return null;
    const a = ((e.clientX - m.e) / m.a - b.L) / b.PW, c = (b.H - b.B - (e.clientY - m.f) / m.d) / b.PH;
    return a >= 0 && a <= 1 && c >= 0 && c <= 1 ? { a, c, m } : null;
  };
  svg.addEventListener('wheel', e => {
    const p = at(e);
    if (!p) return;
    e.preventDefault();
    const { k, x, y } = state.view;
    const k2 = Math.min(ZOOM_MAX, Math.max(1, k * Math.exp(-e.deltaY / 300)));
    setView(k2, x + p.a / k - p.a / k2, y + p.c / k - p.c / k2);
  }, { passive: false });
  svg.addEventListener('pointerdown', e => {
    const p = e.button === 0 && state.view.k > 1 && at(e);
    if (!p) return;
    e.preventDefault();
    state.drag = { x: e.clientX, y: e.clientY, view: state.view, sx: 1 / (p.m.a * b.PW), sy: 1 / (p.m.d * b.PH) };
    document.body.classList.add('panning');
  });
  svg.addEventListener('dblclick', e => { if (at(e)) setView(1, 0, 0); });
}
// On the window, so a drag survives leaving the chart and a redraw for new samples.
addEventListener('pointermove', e => {
  const d = state.drag;
  if (d) setView(d.view.k, d.view.x - (e.clientX - d.x) * d.sx / d.view.k, d.view.y + (e.clientY - d.y) * d.sy / d.view.k);
});
const endDrag = () => { state.drag = null; document.body.classList.remove('panning'); };
addEventListener('pointerup', endDrag);
addEventListener('pointercancel', endDrag);

// Hovering anywhere over the plot snaps to the nearest sample in view and shows its exact value. Built again on
// every zoom step; pointer keeps the last position over a plot, so the tip follows the chart under a still pointer.
let pointer = null;
function hover(div, svg, tip, pts, X, Y, box, end, start, cash) {
  const ring = el('circle', { r: 9, fill: 'none', stroke: 'var(--fg)', 'stroke-width': 2, visibility: 'hidden',
                              'pointer-events': 'none' }, svg);
  const guide = el('line', { y1: box.T, y2: box.H - box.B, stroke: 'var(--axis)', 'stroke-dasharray': '3 4',
                             visibility: 'hidden', 'pointer-events': 'none' }, svg);
  const area = el('rect', { class: 'hit', x: box.L, y: box.T, width: box.W - box.L - box.R, height: box.H - box.T - box.B,
                            fill: 'transparent' }, svg);

  const hide = () => { ring.setAttribute('visibility', 'hidden'); guide.setAttribute('visibility', 'hidden'); tip.style.display = 'none'; };
  const inBox = (x, y) => x >= box.L - 0.5 && x <= box.W - box.R + 0.5 && y >= box.T - 0.5 && y <= box.H - box.B + 0.5;
  const show = (clientX, clientY) => {
    const m = svg.getScreenCTM();
    if (!m || state.drag) { hide(); return; }
    const sx = (clientX - m.e) / m.a, sy = (clientY - m.f) / m.d;
    let best = null, bd = Infinity;
    for (const p of pts) {
      const x = X(p.t), y = Y(p.pct);
      if (!inBox(x, y)) continue;
      const d = (x - sx) ** 2 + ((y - sy) * 0.3) ** 2; // mostly by time
      if (d < bd) { bd = d; best = p; }
    }
    if (!best) { hide(); return; }
    const cx = X(best.t), cy = Y(best.pct);
    ring.setAttribute('cx', cx); ring.setAttribute('cy', cy); ring.setAttribute('visibility', 'visible');
    guide.setAttribute('x1', cx); guide.setAttribute('x2', cx); guide.setAttribute('visibility', 'visible');

    const ideal = idealAt(best.t, end, start);
    const d = best.pct - ideal;
    const z = best.anchor ? 'under' : sampleZone(best, end, start);
    tip.innerHTML = '<b></b><span></span><span></span>';
    tip.children[0].textContent = cash ? `${cash(best.pct)} · ${fmtPct(best.pct)}` : fmtPct(best.pct);
    tip.children[0].className = `tip-${z}`;
    tip.children[1].textContent = new Date(best.t).toLocaleString(undefined,
      { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    tip.children[2].textContent = best.anchor ? `${cash ? 'month' : 'week'} start: usage resets to 0`
      : `ideal ${ideal.toFixed(1)}% · ${d > 0 ? '+' : ''}${d.toFixed(1)}%` + (z === 'zone' ? ' · in the zone' : '');
    tip.style.display = 'block';

    // Screen px to the panel's own px: the page is scaled (see fit).
    const host = div.getBoundingClientRect();
    const k = host.width / div.offsetWidth || 1;
    const px = (cx * m.a + m.e - host.left) / k, py = (cy * m.d + m.f - host.top) / k;
    const flip = px + tip.offsetWidth + 16 > div.offsetWidth;
    tip.style.left = `${flip ? px - tip.offsetWidth - 14 : px + 14}px`;
    tip.style.top = `${Math.max(0, py - tip.offsetHeight - 10)}px`;
  };
  area.addEventListener('pointerleave', () => { pointer = null; hide(); });
  area.addEventListener('pointermove', e => { pointer = { svg, x: e.clientX, y: e.clientY }; show(e.clientX, e.clientY); });
  hide();
  if (pointer && pointer.svg === svg) show(pointer.x, pointer.y);
}

// Markers sit where the value moved, plus the first and the newest sample: a stretch where it stood still is
// the line alone. Every move keeps its marker however close it lands to the last one (a series saves at most one
// point a minute), so a climb of 1% a minute shows each step. "All markers" adds the samples that did not move.
const moved = pts => pts.filter((p, i) => !i || i === pts.length - 1 || p.pct !== pts[i - 1].pct);

$('account').onchange = async e => {
  if (e.target.value === ADD) {
    e.target.value = state.org;
    showStatus(await chrome.runtime.sendMessage({ type: 'add' }).catch(err => ({ t: Date.now(), ok: false, msg: err.message })));
    return;
  }
  state.org = e.target.value;
  state.week = null;
  chrome.storage.local.set({ selectedOrg: state.org }); // the toolbar badge follows this account
  render();
};
// Rename: swap the picker for a text box. Enter saves, Escape cancels, an empty name restores the claude.ai one.
$('rename').onclick = () => {
  const input = $('rename-input');
  input.value = orgName(state.org);
  $('account').hidden = $('rename').hidden = $('logout').hidden = true;
  input.hidden = false;
  input.focus();
  input.select();
};
function endRename(save) {
  const input = $('rename-input');
  if (input.hidden) return;
  input.hidden = true;
  if (save) {
    const name = input.value.trim().slice(0, 60);
    if (name) state.orgAliases[state.org] = name;
    else delete state.orgAliases[state.org];
    chrome.storage.local.set({ orgAliases: state.orgAliases });
  }
  render();
}
$('rename-input').onkeydown = e => {
  if (e.key === 'Enter') endRename(true);
  else if (e.key === 'Escape') endRename(false);
};
$('rename-input').onblur = () => endRename(true);
$('logout').onclick = async () => {
  if (!confirm(`Log out ${orgName(state.org)}? Its claude.ai session ends, it stops updating and leaves this list; its stored points stay, and logging in to it again brings it back.`)) return;
  showStatus(await chrome.runtime.sendMessage({ type: 'forget', org: state.org }).catch(err => ({ t: Date.now(), ok: false, msg: err.message })));
  state.org = null;
  load();
};
$('week').onchange = e => { state.week = state.weeks[Number(e.target.value)] ?? null; render(); };
// ✕: the period on screen leaves the stored points, for this account only. The worker deletes, like every
// other change to the points.
$('delete').onclick = async () => {
  const i = Number($('week').value);
  const reset = state.weeks[i];
  if (reset === undefined) return;
  const n = state.points.filter(p => p.org === state.org && Math.abs(p.reset - reset) < 6 * HOUR).length;
  if (!confirm(`Delete the ${n} stored points of ${state.weekNames[i]} for ${orgName(state.org)}? This cannot be undone (Export JSON first to keep a copy).`)) return;
  showStatus(await chrome.runtime.sendMessage({ type: 'delete', org: state.org, reset }).catch(err => ({ t: Date.now(), ok: false, msg: err.message })));
  state.week = null;
  load();
};
$('markers').onclick = () => { state.allMarkers = !state.allMarkers; render(); };
// Saved logins go into the file only when asked for: whoever has such a file can use those accounts.
$('export').onclick = async () => {
  const maps = Object.fromEntries(ORG_MAPS.map(k => [k, state[k]]));
  const withLogins = confirm('Include the saved claude.ai logins?\n\nOK: importing this file later needs no new login (for '
    + 'reinstalling the extension or moving it to another browser), but anyone who has the file can use those accounts: '
    + 'keep it private and delete it after.\nCancel: chart data only.');
  const sessions = withLogins ? ((await chrome.storage.local.get('sessions')).sessions || [])
    .map(({ key, name, orgIds }) => ({ key, name, orgIds })) : undefined;
  const blob = new Blob([JSON.stringify({ version: 4, ...maps, points: state.points, ...(sessions && { sessions }) }, null, 1)],
    { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `claude-usage-${new Date().toISOString().slice(0, 10)}${withLogins ? '-with-logins' : ''}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$('import').onclick = () => $('file').click();
$('file').onchange = async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  // The background worker merges the file, so an import cannot race a poll that is rewriting the points.
  try {
    const data = JSON.parse(await f.text());
    showStatus(await chrome.runtime.sendMessage({ type: 'import', data }));
  } catch (err) {
    showStatus({ t: Date.now(), ok: false, msg: `import failed: ${err.message}` });
  }
  load();
};
// "Sync with Claude folder": one click (or dropping the folder on the page) connects the .claude folder, then the
// background worker reads its Claude Code logs on every poll (syncLogs) and only dollars per minute are kept. The
// button shows only while no folder is connected or the connected one can't be read: a lost permission comes back
// with one click, a moved or deleted folder is picked again. With nothing charted yet the first-run card links to it
// instead (welcome).
async function syncButton(logState) {
  const dir = await logHandle().catch(() => null);
  const perm = dir ? await dir.queryPermission({ mode: 'read' }).catch(() => 'error') : null;
  // Why the sync needs a click: no folder yet, Chrome's permission to give again (a picked folder stays readable
  // only while a chart tab is open; asked again later, Chrome may also offer "Allow on every visit", which lasts), or a
  // folder that can't be read (moved, deleted, refused).
  state.syncWhy = !dir ? 'connect' : perm === 'prompt' ? 'allow' : perm !== 'granted' || logState?.ok === false ? 'fix' : null;
  state.syncNeeded = !!state.syncWhy;
  const btn = $('sync');
  btn.textContent = state.syncWhy === 'allow' ? 'Keep syncing the Claude folder' : 'Sync with Claude folder';
  btn.classList.toggle('primary', state.syncWhy === 'allow');
  btn.hidden = !state.syncNeeded || !state.weeks.length;
  btn.title = state.syncWhy === 'allow'
    ? 'Chrome asks again for permission to read the Claude folder. If it offers "Allow on every visit", choosing it keeps the sync going while this tab is closed.'
    : logState?.ok === false ? `${logState.msg}. Click to fix.` : btn.dataset.title;
}
// Claude Code's logs live in the .claude folder of the user's home folder (it has a "projects" folder inside). Code
// projects have .claude folders too, with settings only: a pick of one is refused before it replaces a working one.
const CLAUDE_HOME = (() => {
  const p = navigator.userAgentData?.platform || navigator.platform || '';
  if (/win/i.test(p)) return 'C:\\Users\\<your name>\\.claude';
  if (/mac/i.test(p)) return '/Users/<your name>/.claude (Cmd+Shift+. shows it in the picker)';
  return '~/.claude';
})();
async function connectLogs(dir) {
  if (dir.name !== 'projects' && !(await dir.getDirectoryHandle('projects').then(() => true, () => false))) {
    showStatus({ t: Date.now(), ok: false, msg: `"${dir.name}" has no Claude Code logs`
      + `${dir.name === '.claude' ? ' (that .claude holds a project\'s settings)' : ''}: pick ${CLAUDE_HOME}` });
    return;
  }
  await logHandle(dir);
  showStatus({ t: Date.now(), ok: true, msg: `reading the Claude folder "${dir.name}"...` });
  showStatus(await chrome.runtime.sendMessage({ type: 'logs', reset: true })
    .catch(err => ({ t: Date.now(), ok: false, msg: err.message })) || { t: Date.now(), ok: false, msg: 'no folder' });
}
$('sync').dataset.title = `Pick (or drop on this page) ${CLAUDE_HOME}, the one in your user folder with a "projects" folder inside `
  + '(the .claude folders in code projects hold settings only). Its Claude Code logs are then read in your browser on every poll; '
  + 'only dollars per minute are kept, to measure what 1% of your weekly limit is worth.';
// The connected folder is asked for again while it only lacks Chrome's permission (a "Don't allow" leaves it at that,
// the button stays); the folder picker opens only with no folder yet or one that can't be read.
$('sync').onclick = async () => {
  try {
    const old = await logHandle().catch(() => null);
    const perm = old ? await old.queryPermission({ mode: 'read' }).catch(() => 'error') : null;
    if (perm === 'prompt') {
      if (await old.requestPermission({ mode: 'read' }) === 'granted') showStatus(await chrome.runtime.sendMessage({ type: 'logs' }));
      return;
    }
    if (perm === 'granted' && state.syncWhy !== 'fix') {
      showStatus(await chrome.runtime.sendMessage({ type: 'logs' }));
      return;
    }
    await connectLogs(await showDirectoryPicker({ id: 'claude-folder', mode: 'read' }));
  } catch (err) {
    if (err.name !== 'AbortError') showStatus({ t: Date.now(), ok: false, msg: `Claude folder: ${err.message}` });
  }
};
addEventListener('dragover', e => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
addEventListener('drop', e => {
  const item = [...(e.dataTransfer?.items || [])].find(i => i.kind === 'file');
  if (!item?.getAsFileSystemHandle) return;
  e.preventDefault();
  // asked for inside the event: the handle is gone after it
  item.getAsFileSystemHandle().then(h => (h?.kind === 'directory' ? connectLogs(h)
    : showStatus({ t: Date.now(), ok: false, msg: 'drop the .claude folder (in your user folder), not a file' })));
});
$('pollnow').onclick = async () => {
  try {
    showStatus(await chrome.runtime.sendMessage('poll'));
  } catch (err) {
    showStatus({ t: Date.now(), ok: false, msg: `poll failed: ${err.message}` });
  }
  load();
};
// A poll that found every value as it was only renews `held`: the status line follows each one, the charts
// every 10 minutes (a redraw closes an open menu). The dollar and 🔥 texts follow every poll and every log read.
chrome.storage.onChanged.addListener(ch => {
  const due = ch.held && Date.now() - state.drawn >= 10 * 6e4;
  if (ch.logMinutes) state.logMinutes = ch.logMinutes.newValue || [];
  if (ch.logSpan) state.logSpan = ch.logSpan.newValue || null;
  if (ch.logState) syncButton(ch.logState.newValue).then(() => { if (!state.weeks.length) render(); });
  if ((ch.points || due || ch.orgPlans || ch.orgUsers || ch.hiddenOrgs || ch.sessions) && $('rename-input').hidden) load();
  else {
    if (ch.status) {
      state.status = ch.status.newValue || null;
      showStatus(state.status);
      if (!state.weeks.length) render(); // the first-run card follows the poll (logged in or not)
    }
    if (ch.held || ch.logMinutes || ch.logSpan) for (const f of state.refreshes) f();
  }
});
// Status text or the rename box can change the page's height: refit then, and on every window resize.
new ResizeObserver(fit).observe($('stage'));
addEventListener('resize', fit);

load();
