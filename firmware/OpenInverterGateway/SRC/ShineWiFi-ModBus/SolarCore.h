#pragma once
// Portable (no Arduino) core of the standalone history engine: time maths,
// register decoding, aggregation, record format and daily summaries.
// Compiled into the firmware and into the host unit tests (test/host).
#include <stddef.h>
#include <stdint.h>

#include "Catalog.gen.h"

namespace sc {

// ---------------------------------------------------------------- time ----
// Australia/Brisbane is UTC+10 all year (no DST).
const int32_t kTzOffsetS = 10 * 3600;
const uint32_t kMinValidEpoch = 1700000000UL;  // 2023-11-14

inline int32_t localDay(uint32_t epoch) {
  return (int32_t)((epoch + kTzOffsetS) / 86400UL);
}
inline uint16_t minuteOfDay(uint32_t epoch) {
  return (uint16_t)(((epoch + kTzOffsetS) % 86400UL) / 60);
}
inline uint32_t dayStartEpoch(int32_t day) {
  return (uint32_t)day * 86400UL - kTzOffsetS;
}
void civilFromDays(int32_t z, int& y, unsigned& m, unsigned& d);
int32_t daysFromCivil(int y, unsigned m, unsigned d);
uint32_t yyyymmdd(int32_t day);
// Inverter RTC fields (local Brisbane time) -> UTC epoch, 0 if invalid.
uint32_t epochFromLocal(int y, unsigned mo, unsigned d, unsigned h, unsigned mi,
                        unsigned s);

uint16_t crc16(const uint8_t* data, size_t len, uint16_t crc = 0xFFFF);

// ------------------------------------------------------------- decoding ---
const int16_t kMissing = INT16_MIN;

// Raw input registers 3000..3124 as read from the inverter.
struct RegBlock {
  uint16_t r[CAT_REG_COUNT];
  bool valid;
};
// Engineering value of catalogue channel ch.
double decode(const RegBlock& b, uint8_t ch);
// Stored int16 (value / scale, rounded, clamped). kMissing if out of range.
int16_t toStored(double value, float scale);

// ---------------------------------------------------------- aggregation ---
// Accumulates samples for one tier window (1 min or 15 min).
template <int N>
struct Accum {
  int32_t sum[N];
  int16_t extreme[N];
  int16_t last[N];
  uint16_t n[N];
  uint16_t samples;
  void reset() {
    for (int i = 0; i < N; i++) {
      sum[i] = 0;
      extreme[i] = kMissing;
      last[i] = kMissing;
      n[i] = 0;
    }
    samples = 0;
  }
  void add(int i, int16_t v) {
    if (v == kMissing) return;
    sum[i] += v;
    n[i]++;
    if (extreme[i] == kMissing || v > extreme[i]) extreme[i] = v;
    last[i] = v;
  }
  int16_t mean(int i) const {
    if (!n[i]) return kMissing;
    int32_t s = sum[i];
    return (int16_t)((s >= 0 ? s + n[i] / 2 : s - (int32_t)n[i] / 2) / n[i]);
  }
};

// ------------------------------------------------------------- records ----
// File header: "GSH" + version, tier, channel count, record size, channel ids
struct FileHeader {
  uint8_t tier;  // 1 or 15
  uint8_t nch;
  uint8_t ch[40];
};
const uint8_t kFileVersion = 1;
inline size_t headerSize(uint8_t nch) { return 8 + nch; }
inline size_t recordSize(uint8_t nch) { return 4 + 1 + 1 + 2 * nch + 2; }
size_t packHeader(uint8_t* out, const FileHeader& h);
bool unpackHeader(const uint8_t* in, size_t len, FileHeader& h);
// record: u32 ts | u8 samples | u8 flags | nch x i16 | u16 crc (LE)
size_t packRecord(uint8_t* out, uint32_t ts, uint8_t samples, uint8_t flags,
                  const int16_t* v, uint8_t nch);
bool unpackRecord(const uint8_t* in, uint8_t nch, uint32_t& ts,
                  uint8_t& samples, uint8_t& flags, int16_t* v);

// ------------------------------------------------------- daily summary ----
// All energies in 0.1 kWh, powers in W, voltages 0.1 V, freq 0.01 Hz,
// temperatures 0.1 C, times in minute-of-day (0xFFFF = none).
struct DaySummary {
  uint32_t date;          // yyyymmdd (Brisbane)
  uint16_t eac;           // inverter AC-today counter, last value of the day
  uint16_t epv[3];        // per-MPPT today counters
  uint32_t eacTotalFirst; // lifetime counter at first sample of the day
  uint32_t eacTotalLast;  // ... and at last sample
  uint16_t eimp, eexp, eload;  // meter-derived today counters (unverified)
  uint16_t pacPeak, pacPeakMin;
  uint16_t ppvPeak[3];
  int16_t tinvMax;
  uint16_t vacMin, vacMax, facMin, facMax;
  uint16_t firstGenMin, lastGenMin;
  uint16_t onlineMin;     // minutes with a successful poll
  uint16_t genMin;        // minutes with pac > 0
  uint16_t lastFault, lastWarn;
  uint16_t flags;         // bit0 counter reset seen, bit1 lifetime decreased
  uint16_t resv;
};
const size_t kDaySummarySize = 64;
size_t packDay(uint8_t* out, const DaySummary& d);  // includes crc
bool unpackDay(const uint8_t* in, DaySummary& d);
void initDay(DaySummary& d, uint32_t date);

// Updates a DaySummary from one successful poll. `onlineSecs` is the time
// credited to this sample (poll interval), so minutes add up correctly.
void updateDay(DaySummary& d, const RegBlock& b, uint32_t epoch,
               uint16_t creditSecs, uint32_t& onlineSecAcc, uint32_t& genSecAcc);

// ---------------------------------------------------------- retention -----
// Given files sorted oldest-first with their sizes, how many of the oldest
// must be deleted so the total is <= budget (always keeps the newest file).
size_t filesToDelete(const uint32_t* sizes, size_t count, uint32_t budget);

}  // namespace sc
