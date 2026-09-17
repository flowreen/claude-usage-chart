// node dev/test_pace.js : zone, streak, projection and grade maths.
const assert = require('assert');
const P = require('../extension/pace.js');

const H = P.PACE_HOUR, end = 1_000_000 * H, start = end - P.PACE_WEEK;
const at = (hours, pct) => ({ t: start + hours * H, pct });
const near = (a, b, eps = 1e-6) => assert(Math.abs(a - b) < eps, `${a} != ${b}`);

// ideal line: half the week = 50%
near(P.idealAt(start + 84 * H, end), 50);
// zone: 36 h of pace either side of the line, 21.4 points on a week and about 5 on a month
const Z = P.zonePts(end);
near(Z, 36 / 168 * 100);
near(P.zonePts(Date.UTC(2026, 5, 1), Date.UTC(2026, 4, 1)), 36 / (31 * 24) * 100);
assert.strictEqual(P.zoneOf(21, Z), 'zone');
assert.strictEqual(P.zoneOf(-Z, Z), 'zone');
assert.strictEqual(P.zoneOf(-21.5, Z), 'under');
assert.strictEqual(P.zoneOf(22, Z), 'over');
// on the line at 84h, then no use: still in the zone 35 h later, out after two days
assert.strictEqual(P.sampleZone(at(84 + 35, 50), end), 'zone');
assert.strictEqual(P.sampleZone(at(84 + 48, 50), end), 'under');

// streaks: in zone at 84h and 90h, out at 96h, back in at 102h and 114h
const s = P.streaks([at(84, 50), at(90, 54), at(96, 30), at(102, 60), at(114, 67)], end);
assert.strictEqual(s.best, 12 * H);
assert.strictEqual(s.current, 12 * H);
assert.strictEqual(P.streaks([at(84, 50), at(96, 20)], end).current, null);
// 0% at the week start is inside the band but is not a streak
assert.strictEqual(P.sampleZone(at(2, 0), end), 'under');
assert.strictEqual(P.streaks([at(1, 0), at(6, 0), at(12, 0)], end).best, 0);
// 100% on the final day is the goal, not "over"; 100% two days early is over
assert.strictEqual(P.sampleZone(at(150, 100), end), 'zone');
assert.strictEqual(P.sampleZone(at(120, 100), end), 'over');
// 100% 33 h before the reset sits inside the band (19.6 over) but the limit blocks use: over
assert.strictEqual(P.sampleZone(at(135, 100), end), 'over');

// projection: steady 1%/h over the last day, 84h left after 84h at 50% => lands at 134, hits 100 after 50 more hours
const pts = [];
for (let h = 60; h <= 84; h += 2) pts.push(at(h, 50 - (84 - h)));
const pr = P.projection(pts, end);
near(pr.rate * H, 1);
near(pr.projected, 134);
near(pr.hitAt, start + 134 * H);

// grades: 100% anywhere on the final day is S, whether 23 h or 10 min before the reset
const done = hitHour => P.weekResult([at(84, 50), at(hitHour, 100), at(167.9, 100)], end, end + H);
assert.strictEqual(done(145).grade, 'S');      // 23h before reset
assert.strictEqual(done(167.8).grade, 'S');    // 12 min before reset
assert.strictEqual(done(144).grade, 'S');      // exactly 24h
assert.strictEqual(done(143).grade, 'A');      // 25h
assert.strictEqual(done(120).grade, 'A');      // 48h
assert.strictEqual(done(119).grade, 'B');      // 49h
assert.strictEqual(done(97).grade, 'B');       // 71h
assert.strictEqual(done(95).grade, 'C');       // 73h
assert.strictEqual(done(40).grade, 'C');
assert.strictEqual(done(145).onFinalDay, true);
assert.strictEqual(done(143).onFinalDay, false);
// never reached 100%: by final usage, and 99% is below any week that reached 100%
const ended = pct => P.weekResult([at(84, 40), at(167, pct)], end, end + H).grade;
assert.strictEqual(ended(99), 'A');
assert.strictEqual(ended(80), 'B');
assert.strictEqual(ended(60), 'C');
assert.strictEqual(ended(20), 'D');
// live week: projection 1%/h from 50% at 84h reaches 100% at 134h, 34h before reset => A
const live = P.weekResult(pts, end, start + 84 * H);
assert.strictEqual(live.live, true);
assert.strictEqual(live.grade, 'A');

// monthly period: UTC calendar month like the product. Run this file under several TZ values.
// May 2026: May 31 is a Sunday, so the last working day is Friday May 29, covered in local time.
const mStart = Date.UTC(2026, 4, 1), mEnd = Date.UTC(2026, 5, 1);
const local = (d, h = 12) => new Date(2026, 4, d, h).getTime();
const fin = P.finishWindow(mEnd, mStart);
assert.strictEqual(fin.start, new Date(2026, 4, 29).getTime());
assert.strictEqual(fin.end, new Date(2026, 4, 30).getTime());
// August 2026 ends on Monday the 31st: the window is the full 24 h before the UTC reset, whatever the local clock
const augEnd = Date.UTC(2026, 8, 1), augStart = Date.UTC(2026, 7, 1);
const aug = P.finishWindow(augEnd, augStart);
assert.deepStrictEqual(aug, { start: augEnd - 24 * H, end: augEnd });
const augRank = hitT => P.weekResult([{ t: augStart + 10 * 864e5, pct: 30 }, { t: hitT, pct: 100 }], augEnd, augEnd + H, augStart).grade;
assert.strictEqual(augRank(augEnd - 2 * H), 'S');    // 2 h before the reset, even where that is 02:00 local
assert.strictEqual(augRank(augEnd - 23 * H), 'S');
assert.strictEqual(augRank(augEnd - 25 * H), 'A');
// weekly: a 00:20 reset still gives the whole previous 24 h, not 20 minutes
const w020 = new Date(2026, 8, 21, 0, 20).getTime();
assert.deepStrictEqual(P.finishWindow(w020), { start: w020 - 24 * H, end: w020 });
assert.strictEqual(P.weekResult([{ t: w020 - 100 * H, pct: 40 }, { t: w020 - 23 * H, pct: 100 }], w020, w020 + H).grade, 'S');
near(P.idealAt(mStart + (mEnd - mStart) / 2, mEnd, mStart), 50);
const mRank = hitT => P.weekResult([{ t: local(10), pct: 30 }, { t: hitT, pct: 100 }], mEnd, mEnd + H, mStart);
assert.strictEqual(mRank(local(29, 9)).grade, 'S');        // Friday morning
assert.strictEqual(mRank(local(29, 23)).grade, 'S');       // Friday late
assert.strictEqual(mRank(local(29, 9)).onFinalDay, true);
assert.strictEqual(mRank(local(30, 10)).grade, 'A');       // Saturday: after the last working day
assert.strictEqual(mRank(local(30, 10)).afterFinish, true);
assert.strictEqual(mRank(local(31, 10)).grade, 'A');       // Sunday
assert.strictEqual(mRank(local(28, 15)).grade, 'A');       // Thursday
assert.strictEqual(mRank(local(27, 15)).grade, 'B');       // Wednesday
assert.strictEqual(mRank(local(25, 15)).grade, 'C');       // Monday
assert.strictEqual(P.sampleZone({ t: local(29), pct: 100 }, mEnd, mStart), 'zone');
assert.strictEqual(P.sampleZone({ t: local(16), pct: 52 }, mEnd, mStart), 'zone');
// weekly finish window is still the last 24 h
assert.deepStrictEqual(P.finishWindow(end), { start: end - 24 * H, end });
const mAt = (day, pct) => ({ t: mStart + day * 864e5, pct });
assert.strictEqual(P.sampleZone(mAt(15, 52), mEnd, mStart), 'zone');
assert.strictEqual(P.sampleZone({ t: end - 3 * 864e5, pct: 90 }, end), 'over'); // weekly: 4 days in, ideal 57
assert.strictEqual(P.periodStart({ reset: end }), end - P.PACE_WEEK);
assert.strictEqual(P.periodStart({ reset: end, start: mStart }), mStart);

console.log('pace tests passed');
