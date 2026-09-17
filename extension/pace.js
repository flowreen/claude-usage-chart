// Pace maths shared by the chart page and the toolbar badge.
// A period runs from start to end (the reset). Weekly limits default start to end minus 7 days;
// monthly spend limits pass the month start explicitly.
const PACE_WEEK = 7 * 864e5;
const PACE_HOUR = 36e5;
const PACE_ZONE_MS = 36 * PACE_HOUR; // this much ideal pace either side of the line counts as "in the zone"
const PACE_FINAL_DAY = 24 * PACE_HOUR;
const clampPct = v => Math.min(100, Math.max(0, v));

function idealAt(t, end, start = end - PACE_WEEK) {
  return clampPct((t - start) / (end - start) * 100);
}

function deviation(p, end, start) {
  return p.pct - idealAt(p.t, end, start);
}

// Half height of the zone in percentage points. It is a time, so a day and a half without use starting on the
// line stays in the zone on every period: 21.4 points on a week, about 5 on a month.
function zonePts(end, start = end - PACE_WEEK) {
  return PACE_ZONE_MS / (end - start) * 100;
}

function zoneOf(d, z) {
  return Math.abs(d) <= z ? 'zone' : d > 0 ? 'over' : 'under';
}

// The window where reaching 100% earns the top rank. Always a full 24 h: a reset at 00:20 must not leave
// 20 minutes of "last day".
// Weekly limits: the 24 h before the reset, whatever the clock says.
// Monthly spend (Enterprise): the period's last day, taken from the billing month (UTC, like the reset). When
// it is a working day, the 24 h before the reset. When it is a Saturday or Sunday the weekend does not count:
// the Friday before it, as a local calendar day.
function finishWindow(end, start = end - PACE_WEEK) {
  if (end - start <= 8 * 864e5) return { start: end - PACE_FINAL_DAY, end };
  const last = new Date(end - 1);
  const wd = last.getUTCDay();
  if (wd !== 0 && wd !== 6) return { start: end - PACE_FINAL_DAY, end };
  const fri = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), last.getUTCDate() - (wd === 0 ? 2 : 1)));
  const y = fri.getUTCFullYear(), m = fri.getUTCMonth(), d = fri.getUTCDate();
  return { start: new Date(y, m, d).getTime(), end: new Date(y, m, d + 1).getTime() };
}

// Zone of a sample. Nothing used yet never counts as in the zone, or every period would start with a free streak.
// At 100% inside the finish window the goal is reached, so it is not "over" even though the line is below 100.
// At 100% before it the limit blocks use, so it is "over" even where the zone reaches up to 100.
function sampleZone(p, end, start) {
  if (p.pct <= 0) return 'under';
  const fin = finishWindow(end, start);
  if (p.pct >= 100 && p.t >= fin.start && p.t <= fin.end) return 'zone';
  if (p.pct >= 100 && p.t < fin.start) return 'over';
  return zoneOf(deviation(p, end, start), zonePts(end, start));
}

// Longest and current run of consecutive in-zone samples, in ms. pts sorted by t.
function streaks(pts, end, start) {
  let best = 0, runStart = null, current = 0;
  for (const p of pts) {
    if (sampleZone(p, end, start) === 'zone') {
      if (runStart === null) runStart = p.t;
      current = p.t - runStart;
      best = Math.max(best, current);
    } else {
      runStart = null;
      current = 0;
    }
  }
  return { current: runStart === null ? null : current, best };
}

// Linear projection to the reset from the last 24 h of samples (or the period start when that is too short).
function projection(pts, end, start = end - PACE_WEEK) {
  if (!pts.length) return null;
  const last = pts[pts.length - 1];
  const reached = pts.find(p => p.pct >= 100);
  let first = pts.find(p => p.t >= last.t - 24 * PACE_HOUR);
  if (!first || last.t - first.t < 3 * PACE_HOUR) first = { t: start, pct: 0 };
  const span = last.t - first.t;
  const rate = span > 0 ? Math.max(0, (last.pct - first.pct) / span) : 0;
  const projected = last.pct + rate * Math.max(0, end - last.t);
  let hitAt = null;
  if (reached) hitAt = reached.t;
  else if (rate > 0 && projected >= 100) hitAt = last.t + (100 - last.pct) / rate;
  return { from: last, rate, projected, hitAt };
}

// Rank S..D. The goal is 100% at any time inside the finish window (see finishWindow).
// Reaching 100% inside it = S; after it (monthly: the weekend) = A; each day before it drops one rank
// (A, B, then C), since the limit then blocks use for days. Never reaching 100% ranks by final usage:
// 90%+ A, 75%+ B, 50%+ C, else D. Distance from the line is reported but does not affect the rank.
function weekResult(pts, end, now, start) {
  if (!pts.length) return null;
  const live = end > now;
  const avgDev = pts.reduce((s, p) => s + Math.abs(deviation(p, end, start)), 0) / pts.length;
  const proj = projection(pts, end, start);
  const hitAt = proj.hitAt && proj.hitAt <= end ? proj.hitAt : null;
  const final = hitAt ? 100 : Math.min(100, live ? proj.projected : pts[pts.length - 1].pct);
  const earlyMs = hitAt ? end - hitAt : 0;
  const fin = finishWindow(end, start);
  let grade;
  if (hitAt) {
    if (hitAt > fin.end) grade = 'A';
    else grade = ['S', 'A', 'B'][Math.ceil(Math.max(0, fin.start - hitAt) / 864e5)] || 'C';
  } else {
    grade = final >= 90 ? 'A' : final >= 75 ? 'B' : final >= 50 ? 'C' : 'D';
  }
  const onFinalDay = !!hitAt && hitAt >= fin.start && hitAt <= fin.end;
  return { grade, final, avgDev, hitAt, earlyMs, onFinalDay, afterFinish: !!hitAt && hitAt > fin.end, live };
}

function formatMoney(v, currency = 'USD') {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: v >= 1000 ? 0 : 2 }).format(v);
  } catch {
    return `${v.toFixed(2)} ${currency}`;
  }
}

// Period start of a stored point: monthly points carry it, weekly ones are 7 days before the reset.
const periodStart = p => (Number.isFinite(p.start) ? p.start : p.reset - PACE_WEEK);

if (typeof module !== 'undefined') {
  module.exports = { PACE_WEEK, PACE_HOUR, PACE_ZONE_MS, PACE_FINAL_DAY, idealAt, deviation, zonePts, zoneOf, finishWindow, sampleZone,
                     streaks, projection, weekResult, periodStart, formatMoney };
}
