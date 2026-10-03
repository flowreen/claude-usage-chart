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
// the two triangles are summed.
function meanDeviation(pts, end, start) {
  let area = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = deviation(pts[i - 1], end, start), b = deviation(pts[i], end, start);
    const mean = a * b < 0 ? (a * a + b * b) / (2 * (Math.abs(a) + Math.abs(b))) : (Math.abs(a) + Math.abs(b)) / 2;
    area += mean * (pts[i].t - pts[i - 1].t);
  }
  const span = pts[pts.length - 1].t - pts[0].t;
  return span > 0 ? area / span : Math.abs(deviation(pts[0], end, start));
}

// Longest and current run of consecutive in-zone samples, in ms. pts sorted by t.
function streaks(pts, end, start) {
  let best = 0, runStart = null, current = 0;
  for (const p of filled(pts)) {
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
  let first = filled(pts).find(p => p.t >= last.t - 24 * PACE_HOUR);
  if (!first || last.t - first.t < 3 * PACE_HOUR) first = { t: start, pct: 0 };
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
const PACE_RANK_S = 95;
const PACE_BLOCK_WEIGHT = 0.5;
function weekResult(pts, end, now, start) {
  if (!pts.length) return null;
  const live = end > now;
  const avgDev = meanDeviation(pts, end, start);
  const proj = projection(pts, end, start);
  const hitAt = proj.hitAt && proj.hitAt <= end ? proj.hitAt : null;
  const final = hitAt ? 100 : Math.min(100, live ? proj.projected : pts[pts.length - 1].pct);
  const earlyMs = hitAt ? end - hitAt : 0;
  const fin = finishWindow(end, start);
  const blockedMs = hitAt ? Math.max(0, fin.start - hitAt) : 0;
  const score = final - PACE_BLOCK_WEIGHT * blockedMs / (end - (start ?? end - PACE_WEEK)) * 100;
  let grade = score >= PACE_RANK_S ? 'S' : score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 50 ? 'C' : 'D';
  if (grade === 'S' && blockedMs > 0) grade = 'A';
  const onFinalDay = !!hitAt && hitAt >= fin.start && hitAt <= fin.end;
  return { grade, score, final, avgDev, hitAt, earlyMs, blockedMs, onFinalDay, live };
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
  const used = pts[pts.length - 1].pct - from.pct;
  return used > 0 ? { from: from.t, used, perMin: used / Math.max(6e4, now - from.t) * 6e4 } : null;
}

// The fastest climb between two neighbouring moves that are both timed to the minute, in percent per minute,
// with the time it reached the second one. The latest wins a tie.
function burnPeak(pts) {
  const ms = rises(pts);
  let best = null;
  for (let i = 1; i < ms.length; i++) {
    if (!timed(ms[i - 1]) || !timed(ms[i])) continue;
    const perMin = (ms[i].p.pct - ms[i - 1].p.pct) / (ms[i].p.t - ms[i - 1].p.t) * 6e4;
    if (!best || perMin >= best.perMin) best = { perMin, from: ms[i - 1].p.t, at: ms[i].p.t };
  }
  return best;
}

// What 1% of a weekly limit is worth at API list prices, measured from imported Claude Code dollars per minute
// (sorted [minute, usd] pairs, see minuteTotals) against one period of a weekly series: each stretch between two
// neighbouring moves inside the imported span gives the dollars logged in it for the percent it climbed. Logs miss
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
  const ms = rises(pts);
  for (let i = 1; i < ms.length; i++) {
    const a = ms[i - 1].p, b = ms[i].p;
    if (a.t < span.from || b.t > span.to) continue;
    const spent = upTo(b.t) - upTo(a.t);
    climbed += b.pct - a.pct;
    if (spent > 0) { covered += b.pct - a.pct; usd += spent; }
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
  module.exports = { PACE_WEEK, PACE_HOUR, PACE_ZONE_MS, PACE_FINAL_DAY, idealAt, deviation, zonePts, zoneOf, finishWindow, sampleZone,
                     filled, meanDeviation, streaks, projection, weekResult, burnSession, burnPeak, measuredRate, periodStart,
                     formatMoney };
}
