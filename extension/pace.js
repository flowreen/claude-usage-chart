// Pace maths shared by the chart page and the toolbar badge.
// A period runs from start to end (the reset). Weekly limits default start to end minus 7 days;
// monthly spend limits pass the month start explicitly.
const PACE_WEEK = 7 * 864e5;
const PACE_HOUR = 36e5;
const PACE_ZONE_MS = 36 * PACE_HOUR; // this much ideal pace either side of the line counts as "in the zone"
const PACE_FINAL_DAY = PACE_ZONE_MS; // finish window length: where the zone band reaches 100%
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

// The window where reaching 100% earns the top rank: from where the zone band reaches 100% (36 h before the
// reset, so finishing needs no night shift) to the reset, whatever the clock says (a 00:20 reset still gets it all).
// Monthly spend (Enterprise): the same when the billing month's last day (UTC, like the reset) is a working day.
// When it is a Saturday or Sunday the window starts on the Friday before it, as a local calendar day, and runs
// through the weekend to the reset.
function finishWindow(end, start = end - PACE_WEEK) {
  if (end - start <= 8 * 864e5) return { start: end - PACE_FINAL_DAY, end };
  const last = new Date(end - 1);
  const wd = last.getUTCDay();
  if (wd !== 0 && wd !== 6) return { start: end - PACE_FINAL_DAY, end };
  const fri = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), last.getUTCDate() - (wd === 0 ? 2 : 1)));
  return { start: new Date(fri.getUTCFullYear(), fri.getUTCMonth(), fri.getUTCDate()).getTime(), end };
}

// Zone of a sample. Nothing used yet never counts as in the zone, or every period would start with a free streak.
// At 100% inside the finish window the goal is reached, so it is not "over" even though the line is below 100.
// At 100% before it the limit blocks use, so it is "over".
function sampleZone(p, end, start) {
  if (p.pct <= 0) return 'under';
  const fin = finishWindow(end, start);
  if (p.pct >= 100 && p.t >= fin.start && p.t <= fin.end) return 'zone';
  if (p.pct >= 100 && p.t < fin.start) return 'over';
  return zoneOf(deviation(p, end, start), zonePts(end, start));
}

// claude.ai can set a weekly limit back to 0% before its reset time: from then on the week holds a new limit, with
// its own ideal line from 0% to 100% at the reset. A fall to half or less inside one period starts one. Monthly
// spend is never split: its percent falls when the limit is raised, while the money spent stays. Returns each
// limit's start (the period start, then the first sample after the fall) and its samples; pts sorted by t.
function limits(pts, start) {
  if (pts.length && Number.isFinite(pts[pts.length - 1].limit)) return [{ start, pts }];
  const out = [{ start, pts: [] }];
  for (const p of pts) {
    const cur = out[out.length - 1].pts, prev = cur[cur.length - 1];
    if (prev && p.pct < prev.pct && p.pct <= prev.pct / 2) out.push({ start: p.t, pts: [p] });
    else cur.push(p);
  }
  return out;
}

// Start of the limit holding time t.
function limitStart(lims, t) {
  let s = lims[0].start;
  for (const l of lims) if (l.start <= t) s = l.start;
  return s;
}

// Only the polls where the value moved are stored, with the last poll before each move: two neighbours of the
// same value are the ends of a stretch where usage stood still. For the streaks and the projection that stretch
// gets a sample every 10 minutes, so they read time and not the number of stored points.
const PACE_FILL_MS = 10 * 6e4;
function filled(pts) {
  const out = [];
  for (const p of pts) {
    const a = out[out.length - 1];
    if (a && a.pct === p.pct) for (let t = a.t + PACE_FILL_MS; t < p.t; t += PACE_FILL_MS) out.push({ ...a, t });
    out.push(p);
  }
  return out;
}

// Mean distance from the ideal line over time, along the line the chart draws through the samples, so it does
// not depend on how many of them are stored. Between two samples the distance is linear; where it changes sign
// the two triangles are summed. Each limit is read against its own line; the fall between two is left out.
function meanDeviation(pts, end, start) {
  let area = 0, span = 0;
  for (const lim of limits(pts, start)) {
    const ps = lim.pts;
    for (let i = 1; i < ps.length; i++) {
      const a = deviation(ps[i - 1], end, lim.start), b = deviation(ps[i], end, lim.start);
      const mean = a * b < 0 ? (a * a + b * b) / (2 * (Math.abs(a) + Math.abs(b))) : (Math.abs(a) + Math.abs(b)) / 2;
      area += mean * (ps[i].t - ps[i - 1].t);
    }
    span += ps[ps.length - 1].t - ps[0].t;
  }
  return span > 0 ? area / span : Math.abs(deviation(pts[0], end, start));
}

// Longest and current run of consecutive in-zone samples, in ms, each read against its limit's line. pts sorted by t.
function streaks(pts, end, start) {
  let best = 0, runStart = null, current = 0;
  for (const lim of limits(pts, start)) {
    for (const p of filled(lim.pts)) {
      if (sampleZone(p, end, lim.start) === 'zone') {
        if (runStart === null) runStart = p.t;
        current = p.t - runStart;
        best = Math.max(best, current);
      } else {
        runStart = null;
        current = 0;
      }
    }
  }
  return { current: runStart === null ? null : current, best };
}

// Linear projection of the current limit (see limits) to the reset from its last 24 h of samples (or its start when
// that is too short).
function projection(pts, end, start = end - PACE_WEEK) {
  if (!pts.length) return null;
  const lims = limits(pts, start);
  const { start: from, pts: ps } = lims[lims.length - 1];
  const last = ps[ps.length - 1];
  const reached = ps.find(p => p.pct >= 100);
  let first = filled(ps).find(p => p.t >= last.t - 24 * PACE_HOUR);
  if (!first || last.t - first.t < 3 * PACE_HOUR) first = { t: from, pct: 0 };
  const span = last.t - first.t;
  const rate = span > 0 ? Math.max(0, (last.pct - first.pct) / span) : 0;
  const projected = last.pct + rate * Math.max(0, end - last.t);
  let hitAt = null;
  if (reached) hitAt = reached.t;
  else if (rate > 0 && projected >= 100) hitAt = last.t + (100 - last.pct) / rate;
  return { from: last, rate, projected, hitAt };
}

// Rank S..D from one score: final usage minus half the share of the period the limit blocked before the finish
// window (see finishWindow). Leaving quota unused wastes it; hitting the limit early wastes none of it but blocks
// work, so a blocked stretch costs half its share. S 95+, A 90+, B 75+, C 50+, else D. S also needs no block
// before the finish window (every window runs to the reset).
// Distance from the line is reported but does not affect the rank.
// Several limits in one period (see limits): the usage is the share of all of them used, final being the current
// one's, and an earlier limit blocked from its 100% to its early reset, unless that took under PACE_RESET_GRACE
// (a reset taken on reaching the limit).
const PACE_RANK_S = 95;
const PACE_BLOCK_WEIGHT = 0.5;
const PACE_RESET_GRACE = 10 * 6e4;
function weekResult(pts, end, now, start) {
  if (!pts.length) return null;
  const live = end > now;
  const avgDev = meanDeviation(pts, end, start);
  const proj = projection(pts, end, start);
  const hitAt = proj.hitAt && proj.hitAt <= end ? proj.hitAt : null;
  const final = hitAt ? 100 : Math.min(100, live ? proj.projected : proj.from.pct);
  const earlyMs = hitAt ? end - hitAt : 0;
  const fin = finishWindow(end, start);
  let blockedMs = hitAt ? Math.max(0, fin.start - hitAt) : 0;
  // earlier = percent used of the limits before the current one; resets = when each early reset was seen, and at what
  const lims = limits(pts, start);
  let earlier = 0;
  const resets = [];
  for (let i = 0; i + 1 < lims.length; i++) {
    const ps = lims[i].pts, next = lims[i + 1].start;
    earlier += Math.min(100, ps[ps.length - 1].pct);
    resets.push({ t: next, from: ps[ps.length - 1].pct, to: lims[i + 1].pts[0].pct });
    const full = ps.find(p => p.pct >= 100);
    if (full && next - full.t >= PACE_RESET_GRACE) blockedMs += Math.max(0, Math.min(next, fin.start) - full.t);
  }
  const usage = (earlier + final) / lims.length;
  const score = usage - PACE_BLOCK_WEIGHT * blockedMs / (end - (start ?? end - PACE_WEEK)) * 100;
  let grade = score >= PACE_RANK_S ? 'S' : score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 50 ? 'C' : 'D';
  if (grade === 'S' && blockedMs > 0) grade = 'A';
  const onFinalDay = !!hitAt && hitAt >= fin.start && hitAt <= fin.end;
  return { grade, score, final, avgDev, hitAt, earlyMs, blockedMs, onFinalDay, live, limits: lims.length, earlier, resets };
}

// Burn: how fast usage climbs. Weekly usage moves in whole percent, so it is read between the moves. A move is
// timed to the minute when the poll before it, stored with it, is at most BURN_TIMED_MS back (points from before
// 1-minute polling, or after the browser was closed, are not).
const BURN_TIMED_MS = 1.5 * 6e4;
// A session starts after the longest gap between moves of the last BURN_LOOKBACK_MS: for a regular day that is the
// night, and a short night still counts, where a fixed length would split a slow workday (whole-percent moves can be
// hours apart) or swallow a short night. It ends after BURN_IDLE_MS without a move.
const BURN_LOOKBACK_MS = 24 * PACE_HOUR;
const BURN_IDLE_MS = 4 * PACE_HOUR;

// Every rise in a period's samples (sorted by t), with the sample before it.
function rises(pts) {
  const out = [];
  for (let i = 1; i < pts.length; i++) if (pts[i].pct > pts[i - 1].pct) out.push({ p: pts[i], before: pts[i - 1] });
  return out;
}
const timed = m => m.p.t - m.before.t <= BURN_TIMED_MS;

// The session burning now: from the last poll before its first move to now. Its first move is the one after the
// longest gap ending in the last BURN_LOOKBACK_MS (the period's first move: the gap since the period's first sample;
// the latest wins a tie). A first move that is not timed climbed at an unknown moment, so the session starts after
// it. Null after BURN_IDLE_MS without a move.
function burnSession(pts, now) {
  const ms = rises(pts);
  if (!ms.length || now - ms[ms.length - 1].p.t > BURN_IDLE_MS) return null;
  let i = ms.length - 1, longest = -1;
  for (let j = 0; j < ms.length; j++) {
    if (ms[j].p.t < now - BURN_LOOKBACK_MS) continue;
    const gap = ms[j].p.t - (j ? ms[j - 1].p.t : pts[0].t);
    if (gap >= longest) { longest = gap; i = j; }
  }
  const from = timed(ms[i]) ? ms[i].before : ms[i].p;
  // the climbs since from, so a session across an early reset (see limits) counts both sides of it
  const used = ms.reduce((sum, m) => sum + (m.before.t >= from.t ? m.p.pct - m.before.pct : 0), 0);
  return used > 0 ? { from: from.t, used, perMin: used / Math.max(6e4, now - from.t) * 6e4 } : null;
}

// The fastest climb between two neighbouring moves of one limit (see limits) that are both timed to the minute, in
// percent per minute, with the time it reached the second one. The latest wins a tie.
function burnPeak(pts) {
  let best = null;
  for (const lim of limits(pts)) {
    const ms = rises(lim.pts);
    for (let i = 1; i < ms.length; i++) {
      if (!timed(ms[i - 1]) || !timed(ms[i])) continue;
      const perMin = (ms[i].p.pct - ms[i - 1].p.pct) / (ms[i].p.t - ms[i - 1].p.t) * 6e4;
      if (!best || perMin >= best.perMin) best = { perMin, from: ms[i - 1].p.t, at: ms[i].p.t };
    }
  }
  return best;
}

// What 1% of a weekly limit is worth at API list prices, measured from imported Claude Code dollars per minute
// (sorted [minute, usd] pairs, see minuteTotals) against one period of a weekly series: each stretch between two
// neighbouring moves of one limit (see limits) inside the imported span gives the dollars logged in it for the
// percent it climbed. Logs miss
// other computers, chats and deleted transcripts, so a stretch with nothing logged is a gap; the figure counts only
// when stretches with logged calls hold at least LOG_COVER of the climb and at least LOG_MIN_PCT points. Else null.
const LOG_COVER = 0.8;
const LOG_MIN_PCT = 5;
function measuredRate(pts, minutes, span) {
  if (!Array.isArray(minutes) || !minutes.length || !span) return null;
  const keys = minutes.map(m => m[0]);
  const cum = [0];
  for (const [, v] of minutes) cum.push(cum[cum.length - 1] + v);
  // dollars of the minutes up to and including the one holding t
  const upTo = t => {
    const k = Math.floor(t / 6e4);
    let lo = 0, hi = keys.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (keys[mid] <= k) lo = mid + 1; else hi = mid; }
    return cum[lo];
  };
  let climbed = 0, covered = 0, usd = 0;
  for (const lim of limits(pts)) {
    const ms = rises(lim.pts);
    for (let i = 1; i < ms.length; i++) {
      const a = ms[i - 1].p, b = ms[i].p;
      if (a.t < span.from || b.t > span.to) continue;
      const spent = upTo(b.t) - upTo(a.t);
      climbed += b.pct - a.pct;
      if (spent > 0) { covered += b.pct - a.pct; usd += spent; }
    }
  }
  return covered >= LOG_MIN_PCT && covered >= LOG_COVER * climbed ? { usdPerPct: usd / covered, covered, climbed } : null;
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
  module.exports = { PACE_WEEK, PACE_HOUR, PACE_ZONE_MS, PACE_FINAL_DAY, PACE_RESET_GRACE, idealAt, deviation, zonePts, zoneOf,
                     finishWindow, sampleZone, limits, limitStart, filled, meanDeviation, streaks, projection, weekResult,
                     burnSession, burnPeak, measuredRate, periodStart, formatMoney };
}
