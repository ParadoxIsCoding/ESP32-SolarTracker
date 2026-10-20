// Host unit tests for SolarCore (time handling, decoding, aggregation,
// record integrity, counter resets, retention). Build & run: make -C firmware/test/host
#include <math.h>
#include <stdio.h>
#include <string.h>

#include "SolarCore.h"

static int failures = 0, checks = 0;
#define CHECK(cond)                                                   \
  do {                                                                \
    checks++;                                                         \
    if (!(cond)) {                                                    \
      failures++;                                                     \
      printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond);          \
    }                                                                 \
  } while (0)
#define CHECK_NEAR(a, b, eps) CHECK(fabs((double)(a) - (double)(b)) <= (eps))

using namespace sc;

static void setU32(RegBlock& b, uint16_t reg, uint32_t v) {
  b.r[reg - CAT_REG_BASE] = v >> 16;
  b.r[reg - CAT_REG_BASE + 1] = v & 0xFFFF;
}
static void setU16(RegBlock& b, uint16_t reg, uint16_t v) { b.r[reg - CAT_REG_BASE] = v; }

// The real 2026-10-20 16:40 snapshot from the user's MIN 8000TL-X.
static RegBlock realSnapshot() {
  RegBlock b;
  memset(&b, 0, sizeof(b));
  b.valid = true;
  setU16(b, 3000, 1);
  setU32(b, 3001, 11656);
  setU16(b, 3003, 2850); setU16(b, 3004, 34); setU32(b, 3005, 9711);
  setU16(b, 3007, 2814); setU16(b, 3008, 6); setU32(b, 3009, 1934);
  setU16(b, 3011, 72); setU16(b, 3012, 1); setU32(b, 3013, 11);
  setU32(b, 3023, 10898);
  setU16(b, 3025, 4995); setU16(b, 3026, 2410); setU16(b, 3027, 45);
  setU32(b, 3043, 7853); setU32(b, 3045, 4020);
  setU32(b, 3047, (2026u << 16) | 13427);
  setU32(b, 3049, 438); setU32(b, 3051, (8u << 16) | 51112);
  setU32(b, 3053, (9u << 16) | 23861);
  setU32(b, 3055, 288); setU32(b, 3059, 178);
  setU32(b, 3083, 466);
  setU16(b, 3093, 344);
  return b;
}

static void testTime() {
  // 2026-10-20 00:00 Brisbane == 2026-10-19 14:00 UTC
  const uint32_t midnight = 1792418400UL;
  CHECK(epochFromLocal(2026, 10, 20, 0, 0, 0) == midnight);
  CHECK(yyyymmdd(localDay(midnight)) == 20261020);
  CHECK(yyyymmdd(localDay(midnight - 1)) == 20261019);
  CHECK(minuteOfDay(midnight + 16 * 3600 + 40 * 60 + 25) == 16 * 60 + 40);
  CHECK(dayStartEpoch(localDay(midnight + 5000)) == midnight);
  CHECK(yyyymmdd(daysFromCivil(2028, 2, 29)) == 20280229);  // leap day
  CHECK(epochFromLocal(2026, 13, 1, 0, 0, 0) == 0);          // invalid month
  CHECK(epochFromLocal(2019, 1, 1, 0, 0, 0) == 0);           // implausible year
}

static void testDecode() {
  RegBlock b = realSnapshot();
  CHECK_NEAR(decode(b, CH_PPV), 1165.6, 1e-6);
  CHECK_NEAR(decode(b, CH_PPV1) + decode(b, CH_PPV2) + decode(b, CH_PPV3),
             decode(b, CH_PPV), 1e-6);
  CHECK_NEAR(decode(b, CH_PAC), 1089.8, 1e-6);
  CHECK_NEAR(decode(b, CH_FAC), 49.95, 1e-6);
  CHECK_NEAR(decode(b, CH_EAC_TOTAL), 57540.0, 1e-3);
  CHECK_NEAR(decode(b, CH_EPV_TOTAL), 61368.5, 1e-3);
  CHECK_NEAR(decode(b, CH_WORKTIME), 18441.0, 2.0);  // ~18 443 h
  CHECK(decode(b, CH_STATUS) == 1);
  // signed 32-bit power
  setU32(b, 3021, (uint32_t)-1234);
  CHECK_NEAR(decode(b, CH_QAC), -123.4, 1e-6);
  // storage conversion and clamping
  CHECK(toStored(1089.8, 1) == 1090);
  CHECK(toStored(-0.6, 1) == -1);
  CHECK(toStored(240.96, 0.1f) == 2410);
  CHECK(toStored(99999.0, 1) == kMissing);
}

static void testAccum() {
  Accum<2> a;
  a.reset();
  CHECK(a.mean(0) == kMissing);  // no data is "missing", never zero
  a.add(0, 10); a.add(0, 11); a.add(0, kMissing);
  CHECK(a.mean(0) == 11);  // (21/2 = 10.5) rounds half away from zero
  CHECK(a.n[0] == 2);
  CHECK(a.extreme[0] == 11);
  a.add(1, -5); a.add(1, -6);
  CHECK(a.mean(1) == -6);
}

static void testRecords() {
  FileHeader h{};
  h.tier = 1;
  h.nch = CAT_H1;
  for (int i = 0; i < CAT_H1; i++) h.ch[i] = kTierH1[i].ch;
  uint8_t buf[128];
  size_t hs = packHeader(buf, h);
  CHECK(hs == headerSize(CAT_H1));
  FileHeader h2{};
  CHECK(unpackHeader(buf, hs, h2) && h2.nch == CAT_H1 && h2.ch[3] == h.ch[3]);
  buf[0] = 'X';
  CHECK(!unpackHeader(buf, hs, h2));

  int16_t v[CAT_H1], out[CAT_H1];
  for (int i = 0; i < CAT_H1; i++) v[i] = (int16_t)(i * 100 - 700);
  v[5] = kMissing;
  size_t rs = packRecord(buf, 1792478400UL, 6, 0, v, CAT_H1);
  CHECK(rs == recordSize(CAT_H1));
  CHECK(rs == 56);  // matches the storage budget
  uint32_t ts; uint8_t n, fl;
  CHECK(unpackRecord(buf, CAT_H1, ts, n, fl, out));
  CHECK(ts == 1792478400UL && n == 6 && out[5] == kMissing && out[0] == -700);
  // A torn / corrupted record (power loss mid-write) must be rejected.
  buf[10] ^= 0x40;
  CHECK(!unpackRecord(buf, CAT_H1, ts, n, fl, out));
  // Erased flash (all 0xFF) must be rejected too.
  memset(buf, 0xFF, rs);
  CHECK(!unpackRecord(buf, CAT_H1, ts, n, fl, out));
}

static void testDay() {
  DaySummary d;
  initDay(d, 20261020);
  uint32_t onl = 0, gen = 0;
  RegBlock b = realSnapshot();
  const uint32_t t = epochFromLocal(2026, 10, 20, 12, 18, 0);
  updateDay(d, b, t, 10, onl, gen);
  CHECK(d.eac == 438 && d.epv[0] == 288 && d.epv[1] == 178);
  CHECK(d.pacPeak == 1090 && d.pacPeakMin == 12 * 60 + 18);
  CHECK(d.eacTotalFirst == 575400 && d.eacTotalLast == 575400);
  CHECK(d.firstGenMin == 738 && d.vacMin == 2410 && d.facMax == 4995);

  // Lifetime counter must never decrease (glitch) - flagged, not applied.
  setU32(b, 3051, 575000);
  updateDay(d, b, t + 10, 10, onl, gen);
  CHECK(d.eacTotalLast == 575400 && (d.flags & 2));

  // After 10+ minutes of generation, a drop of the day counter is an
  // anomaly: keep the max and flag it.
  for (int i = 0; i < 60; i++) updateDay(d, b, t + 20 + i * 10, 10, onl, gen);
  setU32(b, 3049, 12);
  updateDay(d, b, t + 620, 10, onl, gen);
  CHECK(d.eac == 438 && (d.flags & 1));
  CHECK(d.genMin == 10 && d.onlineMin == 10);

  // Dawn carry-over: yesterday's value first, then the reset -> follow reset.
  DaySummary e;
  initDay(e, 20261021);
  uint32_t o2 = 0, g2 = 0;
  RegBlock c = realSnapshot();
  setU32(c, 3023, 0);  // not generating yet
  updateDay(e, c, epochFromLocal(2026, 10, 21, 5, 30, 0), 10, o2, g2);
  CHECK(e.eac == 438);
  setU32(c, 3049, 1);
  setU32(c, 3023, 250);
  updateDay(e, c, epochFromLocal(2026, 10, 21, 5, 31, 0), 10, o2, g2);
  CHECK(e.eac == 1 && !(e.flags & 1));

  uint8_t buf[kDaySummarySize];
  CHECK(packDay(buf, d) == kDaySummarySize);
  DaySummary r;
  CHECK(unpackDay(buf, r) && r.eac == d.eac && r.pacPeakMin == d.pacPeakMin &&
        r.eacTotalLast == d.eacTotalLast && r.tinvMax == d.tinvMax);
  buf[3] ^= 1;
  CHECK(!unpackDay(buf, r));
}

static void testRetention() {
  uint32_t s[5] = {40, 40, 40, 40, 40};
  CHECK(filesToDelete(s, 5, 200) == 0);
  CHECK(filesToDelete(s, 5, 160) == 1);
  CHECK(filesToDelete(s, 5, 50) == 4);   // never deletes the newest file
  CHECK(filesToDelete(s, 5, 0) == 4);
  CHECK(filesToDelete(s, 0, 0) == 0);
}

int main() {
  testTime();
  testDecode();
  testAccum();
  testRecords();
  testDay();
  testRetention();
  printf("%d/%d checks passed\n", checks - failures, checks);
  return failures ? 1 : 0;
}
