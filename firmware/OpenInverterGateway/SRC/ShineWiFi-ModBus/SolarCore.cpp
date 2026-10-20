#include "SolarCore.h"

#include <math.h>
#include <string.h>

namespace sc {

// Howard Hinnant's civil date algorithms (public domain).
void civilFromDays(int32_t z, int& y, unsigned& m, unsigned& d) {
  z += 719468;
  const int32_t era = (z >= 0 ? z : z - 146096) / 146097;
  const unsigned doe = (unsigned)(z - era * 146097);
  const unsigned yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  const int32_t yy = (int32_t)yoe + era * 400;
  const unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  const unsigned mp = (5 * doy + 2) / 153;
  d = doy - (153 * mp + 2) / 5 + 1;
  m = mp < 10 ? mp + 3 : mp - 9;
  y = (int)(yy + (m <= 2));
}

int32_t daysFromCivil(int y, unsigned m, unsigned d) {
  y -= m <= 2;
  const int32_t era = (y >= 0 ? y : y - 399) / 400;
  const unsigned yoe = (unsigned)(y - era * 400);
  const unsigned doy = (153 * (m > 2 ? m - 3 : m + 9) + 2) / 5 + d - 1;
  const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + (int32_t)doe - 719468;
}

uint32_t yyyymmdd(int32_t day) {
  int y;
  unsigned m, d;
  civilFromDays(day, y, m, d);
  return (uint32_t)y * 10000 + m * 100 + d;
}

uint32_t epochFromLocal(int y, unsigned mo, unsigned d, unsigned h,
                        unsigned mi, unsigned s) {
  if (y < 2020 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31 ||
      h > 23 || mi > 59 || s > 59)
    return 0;
  int64_t e = (int64_t)daysFromCivil(y, mo, d) * 86400 + h * 3600 + mi * 60 +
              s - kTzOffsetS;
  return e > 0 ? (uint32_t)e : 0;
}

uint16_t crc16(const uint8_t* data, size_t len, uint16_t crc) {
  // CRC-16/CCITT-FALSE
  for (size_t i = 0; i < len; i++) {
    crc ^= (uint16_t)data[i] << 8;
    for (int b = 0; b < 8; b++)
      crc = (crc & 0x8000) ? (uint16_t)((crc << 1) ^ 0x1021) : (uint16_t)(crc << 1);
  }
  return crc;
}

double decode(const RegBlock& b, uint8_t ch) {
  const CatChannel& c = kCatalog[ch];
  const int i = c.reg - CAT_REG_BASE;
  double raw;
  switch (c.type) {
    case CT_U16: raw = b.r[i]; break;
    case CT_S16: raw = (int16_t)b.r[i]; break;
    case CT_U32: raw = ((uint32_t)b.r[i] << 16) | b.r[i + 1]; break;
    case CT_S32: raw = (int32_t)(((uint32_t)b.r[i] << 16) | b.r[i + 1]); break;
    case CT_LO8: raw = b.r[i] & 0xFF; break;
    case CT_HI8: raw = b.r[i] >> 8; break;
    default: raw = 0;
  }
  // Divide by the exact integer step (0.1f -> 10) so decimal values such as
  // 1165.6 W come out exact instead of 1165.6000172.
  const double inv = 1.0 / (double)c.scale;
  const double step = floor(inv + 0.5);
  if (step >= 1.0 && fabs(inv - step) < 1e-3 * step) return raw / step;
  return raw * (double)c.scale;
}

int16_t toStored(double value, float scale) {
  double s = value / scale;
  s = s >= 0 ? floor(s + 0.5) : ceil(s - 0.5);
  if (s <= -32767.0 || s > 32767.0) return kMissing;
  return (int16_t)s;
}

static void put16(uint8_t* p, uint16_t v) {
  p[0] = v & 0xFF;
  p[1] = v >> 8;
}
static void put32(uint8_t* p, uint32_t v) {
  for (int i = 0; i < 4; i++) p[i] = (v >> (8 * i)) & 0xFF;
}
static uint16_t get16(const uint8_t* p) { return p[0] | (p[1] << 8); }
static uint32_t get32(const uint8_t* p) {
  return p[0] | (p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

size_t packHeader(uint8_t* out, const FileHeader& h) {
  out[0] = 'G';
  out[1] = 'S';
  out[2] = 'H';
  out[3] = kFileVersion;
  out[4] = h.tier;
  out[5] = h.nch;
  put16(out + 6, (uint16_t)recordSize(h.nch));
  memcpy(out + 8, h.ch, h.nch);
  return headerSize(h.nch);
}

bool unpackHeader(const uint8_t* in, size_t len, FileHeader& h) {
  if (len < 8 || in[0] != 'G' || in[1] != 'S' || in[2] != 'H' ||
      in[3] != kFileVersion)
    return false;
  h.tier = in[4];
  h.nch = in[5];
  if (h.nch > sizeof(h.ch) || len < headerSize(h.nch) ||
      get16(in + 6) != recordSize(h.nch))
    return false;
  memcpy(h.ch, in + 8, h.nch);
  return true;
}

size_t packRecord(uint8_t* out, uint32_t ts, uint8_t samples, uint8_t flags,
                  const int16_t* v, uint8_t nch) {
  put32(out, ts);
  out[4] = samples;
  out[5] = flags;
  for (uint8_t i = 0; i < nch; i++) put16(out + 6 + 2 * i, (uint16_t)v[i]);
  size_t n = 6 + 2 * nch;
  put16(out + n, crc16(out, n));
  return n + 2;
}

bool unpackRecord(const uint8_t* in, uint8_t nch, uint32_t& ts,
                  uint8_t& samples, uint8_t& flags, int16_t* v) {
  size_t n = 6 + 2 * nch;
  if (get16(in + n) != crc16(in, n)) return false;
  ts = get32(in);
  if (ts < kMinValidEpoch) return false;
  samples = in[4];
  flags = in[5];
  for (uint8_t i = 0; i < nch; i++) v[i] = (int16_t)get16(in + 6 + 2 * i);
  return true;
}

// ------------------------------------------------------- daily summary ----
void initDay(DaySummary& d, uint32_t date) {
  memset(&d, 0, sizeof(d));
  d.date = date;
  d.pacPeakMin = d.firstGenMin = d.lastGenMin = 0xFFFF;
  d.vacMin = d.facMin = 0xFFFF;
  d.tinvMax = kMissing;
}

size_t packDay(uint8_t* out, const DaySummary& d) {
  uint8_t* p = out;
  put32(p, d.date); p += 4;
  put16(p, d.eac); p += 2;
  for (int i = 0; i < 3; i++) { put16(p, d.epv[i]); p += 2; }
  put32(p, d.eacTotalFirst); p += 4;
  put32(p, d.eacTotalLast); p += 4;
  put16(p, d.eimp); p += 2;
  put16(p, d.eexp); p += 2;
  put16(p, d.eload); p += 2;
  put16(p, d.pacPeak); p += 2;
  put16(p, d.pacPeakMin); p += 2;
  for (int i = 0; i < 3; i++) { put16(p, d.ppvPeak[i]); p += 2; }
  put16(p, (uint16_t)d.tinvMax); p += 2;
  put16(p, d.vacMin); p += 2;
  put16(p, d.vacMax); p += 2;
  put16(p, d.facMin); p += 2;
  put16(p, d.facMax); p += 2;
  put16(p, d.firstGenMin); p += 2;
  put16(p, d.lastGenMin); p += 2;
  put16(p, d.onlineMin); p += 2;
  put16(p, d.genMin); p += 2;
  put16(p, d.lastFault); p += 2;
  put16(p, d.lastWarn); p += 2;
  put16(p, d.flags); p += 2;
  put16(p, d.resv); p += 2;
  size_t n = (size_t)(p - out);  // 66
  put16(p, crc16(out, n));
  return n + 2;
}

bool unpackDay(const uint8_t* in, DaySummary& d) {
  const size_t n = kDaySummarySize - 2;
  if (get16(in + n) != crc16(in, n)) return false;
  const uint8_t* p = in;
  d.date = get32(p); p += 4;
  d.eac = get16(p); p += 2;
  for (int i = 0; i < 3; i++) { d.epv[i] = get16(p); p += 2; }
  d.eacTotalFirst = get32(p); p += 4;
  d.eacTotalLast = get32(p); p += 4;
  d.eimp = get16(p); p += 2;
  d.eexp = get16(p); p += 2;
  d.eload = get16(p); p += 2;
  d.pacPeak = get16(p); p += 2;
  d.pacPeakMin = get16(p); p += 2;
  for (int i = 0; i < 3; i++) { d.ppvPeak[i] = get16(p); p += 2; }
  d.tinvMax = (int16_t)get16(p); p += 2;
  d.vacMin = get16(p); p += 2;
  d.vacMax = get16(p); p += 2;
  d.facMin = get16(p); p += 2;
  d.facMax = get16(p); p += 2;
  d.firstGenMin = get16(p); p += 2;
  d.lastGenMin = get16(p); p += 2;
  d.onlineMin = get16(p); p += 2;
  d.genMin = get16(p); p += 2;
  d.lastFault = get16(p); p += 2;
  d.lastWarn = get16(p); p += 2;
  d.flags = get16(p); p += 2;
  d.resv = get16(p);
  return true;
}

static uint16_t u16clamp(double v) {
  if (v < 0) return 0;
  if (v > 65534) return 65534;
  return (uint16_t)(v + 0.5);
}

void updateDay(DaySummary& d, const RegBlock& b, uint32_t epoch,
               uint16_t creditSecs, uint32_t& onlineSecAcc,
               uint32_t& genSecAcc) {
  const uint16_t minute = minuteOfDay(epoch);
  const double pac = decode(b, CH_PAC);

  // Day counters (0.1 kWh) come from the inverter. A drop means the
  // inverter reset its counter. Before real generation has started this
  // Brisbane day the old value was yesterday's carry-over, so follow the
  // reset; later in the day keep the larger value and flag the anomaly.
  const bool early = d.genMin < 10;
  auto dayCounter = [&](uint16_t& slot, uint8_t ch) {
    uint16_t v = u16clamp(decode(b, ch) * 10);
    if (v >= slot || early) slot = v;
    else d.flags |= 1;
  };
  dayCounter(d.eac, CH_EAC_TODAY);
  dayCounter(d.epv[0], CH_EPV1_TODAY);
  dayCounter(d.epv[1], CH_EPV2_TODAY);
  dayCounter(d.epv[2], CH_EPV3_TODAY);
  dayCounter(d.eimp, CH_EIMP_TODAY);
  dayCounter(d.eexp, CH_EEXP_TODAY);
  dayCounter(d.eload, CH_ELOAD_TODAY);

  // Lifetime counter: never allowed to go backwards.
  const uint32_t tot = (uint32_t)(decode(b, CH_EAC_TOTAL) * 10 + 0.5);
  if (d.eacTotalFirst == 0) d.eacTotalFirst = tot;
  if (tot >= d.eacTotalLast) d.eacTotalLast = tot;
  else d.flags |= 2;

  // Peaks and extremes
  const uint16_t pacW = u16clamp(pac);
  if (pacW > d.pacPeak) {
    d.pacPeak = pacW;
    d.pacPeakMin = minute;
  }
  const uint8_t ppvCh[3] = {CH_PPV1, CH_PPV2, CH_PPV3};
  for (int i = 0; i < 3; i++) {
    uint16_t p = u16clamp(decode(b, ppvCh[i]));
    if (p > d.ppvPeak[i]) d.ppvPeak[i] = p;
  }
  const int16_t t = toStored(decode(b, CH_TINV), 0.1f);
  if (t != kMissing && (d.tinvMax == kMissing || t > d.tinvMax)) d.tinvMax = t;
  const uint16_t vac = u16clamp(decode(b, CH_VAC) * 10);
  const uint16_t fac = u16clamp(decode(b, CH_FAC) * 100);
  if (vac > 0) {
    if (vac < d.vacMin) d.vacMin = vac;
    if (vac > d.vacMax) d.vacMax = vac;
  }
  if (fac > 0) {
    if (fac < d.facMin) d.facMin = fac;
    if (fac > d.facMax) d.facMax = fac;
  }

  // Time accounting
  onlineSecAcc += creditSecs;
  d.onlineMin = (uint16_t)(onlineSecAcc / 60);
  if (pac > 0.5) {
    genSecAcc += creditSecs;
    d.genMin = (uint16_t)(genSecAcc / 60);
    if (d.firstGenMin == 0xFFFF) d.firstGenMin = minute;
    d.lastGenMin = minute;
  }
  d.lastFault = (uint16_t)decode(b, CH_FAULT);
  d.lastWarn = (uint16_t)decode(b, CH_WARN);
}

size_t filesToDelete(const uint32_t* sizes, size_t count, uint32_t budget) {
  uint64_t total = 0;
  for (size_t i = 0; i < count; i++) total += sizes[i];
  size_t del = 0;
  while (total > budget && del + 1 < count) total -= sizes[del++];
  return del;
}

}  // namespace sc
