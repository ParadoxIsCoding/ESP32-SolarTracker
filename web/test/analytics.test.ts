import { test } from "node:test";
import assert from "node:assert/strict";
import {
  combine, correlation, dayValue, feedInValue, efficiency, indexed, integrateKWh, minMaxDownsample, normalise,
  pctChange, rolling, shares, stats, sumDays,
} from "../src/analytics.ts";
import { decodeSeries } from "../src/proto.ts";
import { dayStart, weekStart, ymd, ymdToEpoch } from "../src/time.ts";

test("stats ignores nulls and reports peak time", () => {
  const s = stats([10, 20, 30, 40], [5, null, 9, 1]);
  assert.equal(s.n, 3);
  assert.equal(s.max, 9);
  assert.equal(s.maxAt, 30);
  assert.equal(s.min, 1);
  assert.equal(s.mean, 5);
  assert.equal(stats([1], [null]).mean, null);
});

test("integrateKWh: constant 1 kW for 1 h = 1 kWh", () => {
  const t = Array.from({ length: 61 }, (_, i) => i * 60);
  assert.ok(Math.abs((integrateKWh(t, t.map(() => 1000)) as number) - 1) < 1e-9);
});

test("integrateKWh does not bridge offline gaps", () => {
  const t = [0, 60, 120, 7200, 7260];
  const w = [1000, 1000, 1000, 1000, 1000];
  // only 0-120 and 7200-7260 count: 3 minutes at 1 kW = 0.05 kWh
  assert.ok(Math.abs((integrateKWh(t, w) as number) - 0.05) < 1e-9);
  assert.equal(integrateKWh([0, 60], [null, 5]), null);
});

test("correlation needs enough paired points", () => {
  const a = Array.from({ length: 20 }, (_, i) => i);
  assert.ok(Math.abs((correlation(a, a.map((x) => 2 * x + 1)).r as number) - 1) < 1e-12);
  assert.ok(Math.abs((correlation(a, a.map((x) => -x)).r as number) + 1) < 1e-12);
  assert.equal(correlation([1, 2, 3], [1, 2, 3]).r, null);
  assert.equal(correlation(a, a.map(() => 4)).r, null); // zero variance
});

test("normalise / indexed / combine", () => {
  assert.deepEqual(normalise([0, 5, 10, null]), [0, 50, 100, null]);
  assert.deepEqual(indexed([null, 4, 8]), [null, 100, 200]);
  assert.deepEqual(combine([10, 5, null], [4, 0, 1], "ratio"), [2.5, null, null]);
  assert.deepEqual(combine([10, 5], [4, 5], "diff"), [6, 0]);
  assert.deepEqual(combine([110], [100], "pctdiff"), [10]);
});

test("efficiency is guarded at low power", () => {
  assert.equal(efficiency(100, 120), null);
  assert.ok(Math.abs((efficiency(1089.8, 1165.6) as number) - 93.497) < 0.01);
  assert.equal(efficiency(500, 400), null); // >100 % is a timing artefact, not real
  assert.equal(efficiency(null, 1000), null);
});

test("shares and pctChange", () => {
  const s = shares([971.1, 193.4, 1.1]);
  assert.ok(Math.abs((s[0] as number) + (s[1] as number) + (s[2] as number) - 100) < 1e-9);
  assert.deepEqual(shares([10, 5, 0]), [null, null, null]);
  assert.equal(pctChange(110, 100), 10);
  assert.equal(pctChange(5, 0), null);
});

test("sumDays sums inverter day counters (0.1 kWh units)", () => {
  const d = [{ date: 20261019, eac: 400 }, { date: 20261020, eac: 438 }, { date: 20261101, eac: 10 }];
  assert.deepEqual(sumDays(d, 20261001, 20261031), { kwh: 83.8, days: 2 });
  assert.deepEqual(sumDays(d, 20250101, 20250102), { kwh: null, days: 0 });
});

test("rolling mean skips nulls", () => {
  assert.deepEqual(rolling([2, null, 4, 6], 2), [2, 2, 4, 5]);
});

test("min/max downsampling keeps the peak", () => {
  const t = Array.from({ length: 10000 }, (_, i) => i);
  const v: (number | null)[] = t.map((i) => (i === 7777 ? 9999 : Math.sin(i / 50)));
  const d = minMaxDownsample(t, [v], 400);
  assert.ok(d.t.length <= 800);
  assert.ok(d.cols[0].includes(9999));
});

test("Brisbane day boundaries (UTC+10, no DST)", () => {
  const midnight = 1792418400; // 2026-10-20 00:00 AEST
  assert.equal(dayStart(midnight + 3600), midnight);
  assert.equal(ymd(midnight - 1), 20261019);
  assert.equal(ymdToEpoch(20261020), midnight);
  assert.equal(ymd(weekStart(midnight)), 20261019); // Tuesday -> Monday
});

test("binary series decoding with missing values", () => {
  const n = 2, row = 4 + 2 * n, buf = new ArrayBuffer(8 + 2 * row), dv = new DataView(buf);
  dv.setUint32(0, 0x53455231, false); dv.setUint8(4, n); dv.setUint8(5, 1); dv.setUint16(6, row, true);
  dv.setUint32(8, 1792478400, true); dv.setInt16(12, 1090, true); dv.setInt16(14, -32768, true);
  dv.setUint32(16, 1792478460, true); dv.setInt16(20, -5, true); dv.setInt16(22, 7, true);
  const s = decodeSeries(buf);
  assert.deepEqual(s.t, [1792478400, 1792478460]);
  assert.deepEqual(s.cols, [[1090, -5], [null, 7]]);
});

test("two-tier feed-in value per day", () => {
  // 25 kWh day: 10 x 0.08 + 15 x 0.03 = 1.25 ; 6 kWh day: 6 x 0.08 = 0.48
  assert.ok(Math.abs(feedInValue([25, 6], 0.08, 0.03, 10) - 1.73) < 1e-9);
  assert.ok(Math.abs(feedInValue([25], 0.08, 0.03, 0) - 2) < 1e-9); // single rate
  assert.equal(feedInValue([0, -1], 0.08, 0.03, 10), 0);
});

test("day value from meter export: self-use at usage rate, tiered feed-in", () => {
  const r = { usage: 0.27974, feed1: 0.08, feed2: 0.03, tierKwh: 8 };
  // 44 kWh generated, 31.7 exported -> 12.3 self-used
  const v = dayValue(44, 31.7, 0.4, 15.3, r)!;
  assert.ok(Math.abs(v.selfUsed - 12.3) < 1e-9);
  assert.ok(Math.abs(v.feedIn - (8 * 0.08 + 23.7 * 0.03)) < 1e-9); // 1.351
  assert.ok(Math.abs(v.avoided - 12.3 * 0.27974) < 1e-9);
  assert.ok(Math.abs((v.selfUsePct as number) - (12.3 / 44) * 100) < 1e-9);
  // export can't exceed generation (meter/inverter timing) and is clamped
  assert.equal(dayValue(5, 7, 0, 0, r)!.selfUsed, 0);
  // no meter data at all while generating -> null (caller falls back)
  assert.equal(dayValue(30, 0, 0, 0, r), null);
  // a dull day with everything used at home is valid meter data
  assert.equal(dayValue(3, 0, 2, 5, r)!.feedIn, 0);
});
