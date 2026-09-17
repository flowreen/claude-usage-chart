const HOUR = 36e5;
const UNUSED_WARN = 5; // projected % left unused at the reset above which the line turns red
const NS = 'http://www.w3.org/2000/svg';
// orgNames, orgPlans and orgUsers (the signed-in person's name) come from claude.ai; orgAliases are names the
// user typed and win over everything.
const ORG_MAPS = ['orgNames', 'orgPlans', 'orgUsers', 'orgAliases'];
// week = the reset time of the period on screen (null = the newest), so a new period arriving while the page is
// open does not move an older one out from under the reader.
const state = { points: [], orgNames: {}, orgPlans: {}, orgUsers: {}, orgAliases: {}, org: null, week: null, weeks: [], fit: false, allMarkers: false };
const $ = id => document.getElementById(id);

async function load() {
  const stored = await chrome.storage.local.get(['points', 'status', 'selectedOrg', ...ORG_MAPS]);
  // Every point carries its account (org); anything without one is ignored.
  state.points = (stored.points || []).filter(p => p && p.org);
  for (const k of ORG_MAPS) state[k] = stored[k] || {};
  if (state.org === null && stored.selectedOrg) state.org = stored.selectedOrg;
  showStatus(stored.status);
  render();
}

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

// Accounts ordered by most recent sample, so the one polled last is the default.
function orgs() {
  const latest = new Map();
  for (const p of state.points) latest.set(p.org, Math.max(latest.get(p.org) || 0, p.t));
  return [...latest.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
}

function showStatus(s) {
  const el = $('status');
  if (!s) { el.textContent = 'no poll yet'; return; }
  el.textContent = `last poll ${new Date(s.t).toLocaleString()}: ${s.msg}`;
  el.classList.toggle('bad', !s.ok);
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
    o.textContent = orgLabel(id);
    acct.appendChild(o);
  }
  acct.value = state.org;
  acct.hidden = !os.length;
  $('rename').hidden = !os.length;

  const orgPts = state.points.filter(p => p.org === state.org);
  const ws = weeks(orgPts);
  // Current = the reset reported by this account's newest sample, if still ahead.
  const newest = orgPts.reduce((a, p) => (!a || p.t > a.t ? p : a), null);
  const isCurrent = r => newest && Math.abs(r - newest.reset) < 6 * HOUR && r > Date.now();
  state.weeks = ws;
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
    o.textContent = `${periodLabel(start, r)}${isCurrent(r) ? ' (current)' : ''}${res ? ` · rank ${res.grade}` : ''}`;
    sel.appendChild(o);
  });
  sel.value = weekIdx;
  $('count').textContent = `${state.points.length} points stored`;
  $('view').value = state.fit ? 'fit' : 'full';
  $('markers').setAttribute('aria-pressed', state.allMarkers);

  const charts = $('charts');
  charts.innerHTML = '';
  if (!ws.length) {
    charts.innerHTML = '<div class="empty" style="flex:1">No samples yet. Stay logged in to claude.ai in this browser; the extension polls every 10 minutes.</div>';
    return;
  }
  const reset = ws[weekIdx];
  const inWeek = orgPts.filter(p => Math.abs(p.reset - reset) < 6 * HOUR);
  const keys = [...new Set(inWeek.map(p => p.key))]
    .sort((a, b) => (a === 'All models' ? -1 : b === 'All models' ? 1 : a.localeCompare(b)));
  for (const k of keys) {
    const pts = inWeek.filter(p => p.key === k).sort((a, b) => a.t - b.t);
    charts.appendChild(panel(k, pts, reset, periodStart(pts[pts.length - 1])));
  }
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
  let x0 = start, x1 = end, y1 = Math.max(100, ...pts.map(p => p.pct));
  if (state.fit && pts.length) {
    x0 = pts[0].t; x1 = pts[pts.length - 1].t;
    const pad = Math.max((x1 - x0) * 0.05, HOUR);
    x0 -= pad; x1 += pad;
    y1 = Math.min(y1, Math.max(10, Math.ceil((Math.max(...pts.map(p => p.pct)) + 5) / 10) * 10));
  }
  const X = t => L + (t - x0) / (x1 - x0) * (W - L - R);
  const Y = v => H - B - v / y1 * (H - T - B);

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${name} usage chart` });
  const clipId = 'c' + Math.random().toString(36).slice(2);
  el('rect', { x: L, y: T, width: W - L - R, height: H - T - B }, el('clipPath', { id: clipId }, el('defs', {}, svg)));

  const yStep = y1 > 100 ? 20 : y1 <= 30 ? 5 : 10;
  for (let v = 0; v <= y1 + 1e-9; v += yStep) {
    el('line', { x1: L, x2: W - R, y1: Y(v), y2: Y(v), stroke: 'var(--grid)' }, svg);
    el('text', { x: L - 8, y: Y(v) + 4, 'text-anchor': 'end' }, svg).textContent = money
      ? formatMoney(Math.round(v / 100 * money.limit), money.currency).replace(/\.00$/, '') : `${v}%`;
  }
  // Day gridlines for a week (weekday labels); weekly gridlines for a month (date labels), plus the end line.
  const days = Math.round((end - start) / 864e5);
  const step = days <= 8 ? 1 : 7;
  const ticks = [];
  for (let d = 0; d < days; d += step) ticks.push(start + d * 864e5);
  ticks.push(end);
  for (const t of ticks) {
    if (t < x0 - 1 || t > x1 + 1) continue;
    el('line', { x1: X(t), x2: X(t), y1: T, y2: H - B, stroke: 'var(--grid)' }, svg);
    // Month ticks are dated in UTC like the period itself, else a UTC-minus reader sees "Aug 31" under "September".
    if (t < end) el('text', { x: X(t), y: H - B + 22, 'text-anchor': 'middle' }, svg).textContent = step === 1
      ? new Date(t).toLocaleDateString(undefined, { weekday: 'short' })
      : new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  }
  el('line', { x1: L, x2: L, y1: T, y2: H - B, stroke: 'var(--axis)' }, svg);
  el('line', { x1: L, x2: W - R, y1: H - B, y2: H - B, stroke: 'var(--axis)' }, svg);

  const g = el('g', { 'clip-path': `url(#${clipId})` }, svg);
  // Finish window: reaching 100% anywhere in it is the top result (last 24 h, or the month's last working day).
  const fin = finishWindow(end, start);
  const finName = money ? 'last working day' : 'finish day';
  const fx = X(fin.start);
  el('rect', { class: 'finish', x: fx, y: T, width: Math.max(0, X(fin.end) - fx), height: H - T - B }, g);
  // bottom of the window, clear of the 100% dots
  el('text', { class: 'finish-label', x: (fx + X(fin.end)) / 2, y: H - B - 10, 'text-anchor': money ? 'end' : 'middle' }, g)
    .textContent = `🏁 ${finName}`;
  if (money) g.lastChild.setAttribute('x', X(fin.end) - 4); // a one-day column in a month is narrow
  const Z = zonePts(end, start);
  el('polygon', { class: 'zone-band', points: [[start, -Z], [end, 100 - Z], [end, 100 + Z], [start, Z]]
    .map(([t, v]) => `${X(t)},${Y(v)}`).join(' ') }, g);
  el('line', { x1: X(start), y1: Y(0), x2: X(end), y2: Y(100), stroke: 'var(--ideal)',
               'stroke-width': 2, 'stroke-dasharray': '7 6' }, g);

  const live = end > Date.now();
  const last = pts[pts.length - 1];
  const lastZone = last && sampleZone(last, end, start);
  const proj = projection(pts, end, start);
  const period = money ? 'month' : 'week';
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
    const shown = state.allMarkers ? pts : hourly(pts);
    for (const p of shown) el('circle', { class: `dot dot-${sampleZone(p, end, start)}`, cx: X(p.t), cy: Y(p.pct), r: 5 }, g);
    if (start >= x0) el('circle', anchor, svg); // on the clip edge; drawn unclipped
    if (live) {
      el('circle', { class: `pulse pulse-${lastZone}`, cx: X(last.t), cy: Y(last.pct), r: 8 }, g);
      el('circle', { class: `now now-${lastZone}`, cx: X(last.t), cy: Y(last.pct), r: 8 }, g);
    }
  }
  div.appendChild(svg);
  if (pts.length) {
    hover(div, svg, [{ t: start, pct: 0, anchor: true }, ...pts], X, Y, { L, R, T, B, W, H }, end, start, money && cash);
  }

  if (!pts.length) return div;
  const result = weekResult(pts, end, Date.now(), start);
  // "40%" on weekly charts, "$200 of $500" on monthly spend.
  const amount = pct => (money ? cash(pct) : `${pct.toFixed(0)}%`);
  const limitTxt = money ? `the ${cash(100)} limit` : '100%';
  const chip = document.createElement('span');
  chip.className = `grade grade-${result.grade}`;
  chip.textContent = result.grade;
  chip.title = `${result.live ? 'Rank if this pace holds' : 'Final rank'}. `
    + `S = 100% on the ${finName}${money ? ' (after it: A)' : ''}; each day earlier drops a rank. `
    + 'Not reaching 100%: A 90%+, B 75%+, C 50%+, else D.';
  div.querySelector('h2').append(' ', chip);
  const hint = document.createElement('span');
  hint.className = 'grade-hint';
  hint.textContent = result.live ? 'on track for' : 'final rank';
  chip.before(hint);

  const d = deviation(last, end, start);
  const pace = document.createElement('div');
  const tag = document.createElement('span');
  tag.className = 'zone-tag';
  if (live) {
    pace.className = `pace pace-${lastZone}`;
    pace.textContent = `${money ? `${cash(last.pct)} of ${cash(100)} · ` : ''}Pace: ${d > 0 ? '▲ +' : '▼ '}${d.toFixed(1)}%`;
    tag.textContent = lastZone === 'zone' ? 'IN THE ZONE' : lastZone === 'over' ? 'over' : 'under';
  } else {
    // Finished period: the result, not a live pace.
    if (result.hitAt) {
      pace.className = `pace result ${result.onFinalDay ? 'pace-zone' : 'pace-early'}`;
      pace.textContent = result.onFinalDay ? `🏁 Used it all on the ${finName}` : 'Used it all';
      tag.textContent = `${money ? cash(100) : '100%'} ${fmtWhen(result.hitAt)}, ${fmtDur(result.earlyMs)} before reset`;
    } else {
      pace.className = 'pace result';
      pace.textContent = `Final: ${amount(result.final)}${money ? ` of ${cash(100)}` : ''} used`;
      tag.textContent = `${amount(100 - result.final)} unused`;
    }
  }
  pace.append(' ', tag);
  div.appendChild(pace);

  const stats = document.createElement('div');
  stats.className = 'stats';
  const st = streaks(pts, end, start);
  const line1 = document.createElement('div');
  if (!live) {
    line1.textContent = `${st.best >= HOUR ? `best streak ${fmtDur(st.best)}` : 'no streak'} · ${result.avgDev.toFixed(1)}% off the ideal line on average`;
    stats.appendChild(line1);
    div.appendChild(stats);
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = `x: ${period} time · y: ${money ? 'spend' : 'usage'} · dashed = ideal · band = zone · ${sampleCount(pts)}`;
    div.appendChild(sub);
    return div;
  }
  const best = st.best >= HOUR ? ` · best ${fmtDur(st.best)}` : '';
  if (st.current !== null && live) {
    line1.textContent = st.current < HOUR ? `🔥 In the zone: streak starts now${best}` : `🔥 ${fmtDur(st.current)} in the zone${best}`;
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
      line2.textContent = `🏁 Hits ${limitTxt} ${fmtWhen(proj.hitAt)}, on the ${finName}`;
    } else if (proj.hitAt && proj.hitAt < fin.start) {
      line2.className = 'warn';
      line2.textContent = `Hits ${limitTxt} ${fmtWhen(proj.hitAt)} · ${fmtDur(fin.start - proj.hitAt)} before the ${finName}`;
    } else if (proj.hitAt && proj.hitAt < end) {
      line2.className = 'loss';
      line2.textContent = `Hits ${limitTxt} ${fmtWhen(proj.hitAt)}, after the ${finName}: aim for ${fmtWhen(fin.start)} or later that day`;
    } else {
      const left = 100 - Math.min(100, proj.projected);
      line2.textContent = `Projected ${amount(Math.min(100, proj.projected))} at reset · ${amount(left)} left unused`;
      if (left > UNUSED_WARN) line2.className = 'loss';
    }
    stats.appendChild(line2);
  }
  div.appendChild(stats);
  if (live && lastZone === 'zone') div.classList.add('in-zone');

  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = `x: ${period} time · y: ${money ? 'spend' : 'usage'} · dashed = ideal · band = zone · ${sampleCount(pts)}`;
  div.appendChild(sub);
  return div;
}

function fmtDur(ms) {
  const h = ms / HOUR;
  if (h < 1) return `${Math.round(ms / 6e4)}m`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

const fmtWhen = t => new Date(t).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

// Hovering anywhere over the plot snaps to the nearest sample and shows its exact value.
function hover(div, svg, pts, X, Y, box, end, start, cash) {
  const ring = el('circle', { r: 9, fill: 'none', stroke: 'var(--fg)', 'stroke-width': 2, visibility: 'hidden',
                              'pointer-events': 'none' }, svg);
  const guide = el('line', { y1: box.T, y2: box.H - box.B, stroke: 'var(--axis)', 'stroke-dasharray': '3 4',
                             visibility: 'hidden', 'pointer-events': 'none' }, svg);
  const tip = document.createElement('div');
  tip.className = 'tip';
  div.appendChild(tip);
  const area = el('rect', { x: box.L, y: box.T, width: box.W - box.L - box.R, height: box.H - box.T - box.B,
                            fill: 'transparent' }, svg);

  const hide = () => { ring.setAttribute('visibility', 'hidden'); guide.setAttribute('visibility', 'hidden'); tip.style.display = 'none'; };
  area.addEventListener('pointerleave', hide);
  area.addEventListener('pointermove', e => {
    const m = svg.getScreenCTM();
    if (!m) return;
    const sx = (e.clientX - m.e) / m.a, sy = (e.clientY - m.f) / m.d;
    let best = pts[0], bd = Infinity;
    for (const p of pts) {
      const d = (X(p.t) - sx) ** 2 + ((Y(p.pct) - sy) * 0.3) ** 2; // mostly by time
      if (d < bd) { bd = d; best = p; }
    }
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
      { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    tip.children[2].textContent = best.anchor ? `${cash ? 'month' : 'week'} start: usage resets to 0`
      : `ideal ${ideal.toFixed(1)}% · ${d > 0 ? '+' : ''}${d.toFixed(1)}%` + (z === 'zone' ? ' · in the zone' : '');
    tip.style.display = 'block';

    const host = div.getBoundingClientRect();
    const px = cx * m.a + m.e - host.left, py = cy * m.d + m.f - host.top;
    const flip = px + tip.offsetWidth + 16 > host.width;
    tip.style.left = `${flip ? px - tip.offsetWidth - 14 : px + 14}px`;
    tip.style.top = `${Math.max(0, py - tip.offsetHeight - 10)}px`;
  });
}

// One marker per hour (the last sample in it) unless "All markers" is on.
function hourly(pts) {
  const byHour = new Map();
  for (const p of pts) byHour.set(Math.floor(p.t / HOUR), p);
  return [...byHour.values()];
}

$('account').onchange = e => {
  state.org = e.target.value;
  state.week = null;
  chrome.storage.local.set({ selectedOrg: state.org }); // the toolbar badge follows this account
  render();
};
// Rename: swap the picker for a text box. Enter saves, Escape cancels, an empty name restores the claude.ai one.
$('rename').onclick = () => {
  const input = $('rename-input');
  input.value = orgName(state.org);
  $('account').hidden = $('rename').hidden = true;
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
$('week').onchange = e => { state.week = state.weeks[Number(e.target.value)] ?? null; render(); };
$('view').onchange = e => { state.fit = e.target.value === 'fit'; render(); };
$('markers').onclick = () => { state.allMarkers = !state.allMarkers; render(); };
$('export').onclick = () => {
  const maps = Object.fromEntries(ORG_MAPS.map(k => [k, state[k]]));
  const blob = new Blob([JSON.stringify({ version: 4, ...maps, points: state.points }, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `claude-usage-${new Date().toISOString().slice(0, 10)}.json`;
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
$('pollnow').onclick = async () => {
  try {
    showStatus(await chrome.runtime.sendMessage('poll'));
  } catch (err) {
    showStatus({ t: Date.now(), ok: false, msg: `poll failed: ${err.message}` });
  }
  load();
};
chrome.storage.onChanged.addListener(ch => { if ((ch.points || ch.orgPlans || ch.orgUsers) && $('rename-input').hidden) load(); });

load();
