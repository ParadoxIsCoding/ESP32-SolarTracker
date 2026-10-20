#include "LocalApi.h"

#include <ArduinoJson.h>
#include <ESP8266HTTPUpdateServer.h>
#include <ESP8266WiFi.h>
#include <LittleFS.h>
#include <TLog.h>
#include <ModbusMaster.h>
#include <Updater.h>
#include <math.h>
#include <time.h>

#include "Catalog.gen.h"
#include "Config.h"
#include "Growatt.h"
#include "SolarCore.h"
#include "SolarStore.h"
#include "WebUi.gen.h"

extern ModbusMaster Modbus;  // owned by Growatt.cpp

namespace {

LocalWebServer* srv = nullptr;
Growatt* inv = nullptr;
ESP8266HTTPUpdateServer updater;

// ------------------------------------------------------------ settings ----
struct Settings {
  String name = "Growatt MIN 8000TL-X";
  uint16_t fastMs = 2000;   // power / PV / AC registers 3000-3046
  uint16_t slowMs = 10000;  // counters + diagnostics 3047-3124
  float tariffImport = 0;   // $/kWh, optional
  float tariffExport = 0;   // $/kWh feed-in, first tier
  float tariffExport2 = 0;  // $/kWh feed-in above the daily tier threshold
  float exportTier1Kwh = 0; // kWh/day paid at tariffExport (0 = single rate)
  float supplyPerDay = 0;   // $/day daily supply charge (informational)
  float co2PerKwh = 0.73f;  // kg CO2-e per kWh (QLD grid factor, editable)
} cfg;

void loadSettings() {
  String s = store::readText("/cfg/settings.json");
  if (!s.length()) return;
  StaticJsonDocument<640> d;
  if (deserializeJson(d, s)) return;
  cfg.name = d["name"] | cfg.name.c_str();
  cfg.fastMs = constrain((int)(d["fastMs"] | cfg.fastMs), 1000, 10000);
  cfg.slowMs = constrain((int)(d["slowMs"] | cfg.slowMs), 5000, 60000);
  if (cfg.slowMs < cfg.fastMs) cfg.slowMs = cfg.fastMs;
  cfg.tariffImport = d["tariffImport"] | cfg.tariffImport;
  cfg.tariffExport = d["tariffExport"] | cfg.tariffExport;
  cfg.tariffExport2 = d["tariffExport2"] | cfg.tariffExport2;
  cfg.exportTier1Kwh = d["exportTier1Kwh"] | cfg.exportTier1Kwh;
  cfg.supplyPerDay = d["supplyPerDay"] | cfg.supplyPerDay;
  cfg.co2PerKwh = d["co2PerKwh"] | cfg.co2PerKwh;
}

void settingsJson(JsonDocument& d) {
  d["name"] = cfg.name;
  d["fastMs"] = cfg.fastMs;
  d["slowMs"] = cfg.slowMs;
  d["tariffImport"] = cfg.tariffImport;
  d["tariffExport"] = cfg.tariffExport;
  d["tariffExport2"] = cfg.tariffExport2;
  d["exportTier1Kwh"] = cfg.exportTier1Kwh;
  d["supplyPerDay"] = cfg.supplyPerDay;
  d["co2PerKwh"] = cfg.co2PerKwh;
}

// -------------------------------------------------------- live register ---
sc::RegBlock blk;          // input registers 3000-3124
bool fastValid = false, slowValid = false;
uint32_t fastOkMs = 0, slowOkMs = 0, fastEpoch = 0;
uint16_t hold[125];        // holding registers 0-124 (identity, RTC)
bool holdValid = false;
uint32_t holdMs = 0;
uint32_t rtcEpochAtHold = 0;  // inverter RTC (as epoch) when hold was read

struct {
  uint32_t ok = 0, fail = 0, consecutiveFail = 0;
  uint16_t lastMs = 0, maxMs = 0;
  uint32_t lastFastPollMs = 0, lastSlowPollMs = 0;
  uint16_t curFastMs = 2000;
  bool linkUp = false;
} poll;

// --------------------------------------------------------------- time ----
enum TimeSrc : uint8_t { TS_NONE, TS_INVERTER, TS_NTP };
TimeSrc timeSrc = TS_NONE;
int32_t rtcOffset = 0;      // ntp - inverter RTC, seconds
bool rtcOffsetKnown = false;
int32_t rtcOffsetSaved = 0;
bool rtcOffsetSavedValid = false;
bool ntpLogged = false;

// The inverter clock drifts (62 min slow when first checked), so it is only
// usable as a fallback with the offset measured against NTP. The offset is
// persisted so a reboot without internet still gets correct timestamps.
void loadClockOffset() {
  String s = store::readText("/cfg/clock.json");
  StaticJsonDocument<96> d;
  if (s.length() && !deserializeJson(d, s) && d.containsKey("offset")) {
    rtcOffset = rtcOffsetSaved = d["offset"].as<int32_t>();
    rtcOffsetKnown = rtcOffsetSavedValid = true;
  }
}
void maybeSaveClockOffset() {
  if (rtcOffsetSavedValid && abs(rtcOffset - rtcOffsetSaved) < 60) return;
  String s = String(F("{\"offset\":")) + rtcOffset + '}';
  if (store::writeTextAtomic("/cfg/clock.json", s)) {
    rtcOffsetSaved = rtcOffset;
    rtcOffsetSavedValid = true;
  }
}

uint32_t nowEpoch() {
  time_t t = time(nullptr);
  if ((uint32_t)t > sc::kMinValidEpoch) {
    timeSrc = TS_NTP;
    if (!ntpLogged) {
      ntpLogged = true;
      store::logEvent((uint32_t)t, store::EV_TIME_SYNC, 0, 0);
    }
    if (holdValid && rtcEpochAtHold) {
      rtcOffset = (int32_t)((uint32_t)t - (rtcEpochAtHold +
                                            (millis() - holdMs) / 1000));
      rtcOffsetKnown = true;
      maybeSaveClockOffset();
    }
    return (uint32_t)t;
  }
  if (holdValid && rtcEpochAtHold && rtcOffsetKnown) {
    // No NTP (internet down): fall back to the inverter clock, corrected by
    // the drift measured earlier. Never written back to the inverter.
    timeSrc = TS_INVERTER;
    return rtcEpochAtHold + (millis() - holdMs) / 1000 + rtcOffset;
  }
  timeSrc = TS_NONE;
  return 0;
}

// --------------------------------------------------------- aggregation ---
sc::Accum<CAT_H1> a1;
uint32_t a1Minute = 0;
sc::Accum<CAT_H15> a15;
uint32_t a15Quarter = 0;
const uint8_t kH1Buffer = 5;  // minutes buffered before a flash write
uint8_t b1[kH1Buffer * 56];
uint8_t b1n = 0;
int32_t b1Day = 0;

sc::DaySummary today;
bool todayValid = false;
uint32_t onlineSec = 0, genSec = 0, creditMs = 0, lastSampleMs = 0;
uint8_t lastStatus = 0xFF;
uint16_t lastFault = 0, lastWarn = 0, lastDayFlags = 0;
bool duskFlushed = false;

bool isSlowReg(uint8_t ch) { return kCatalog[ch].reg > CAT_FAST_LAST + 2; }

bool chanAvailable(uint8_t ch) {
  if (!fastValid) return false;
  if (isSlowReg(ch))
    return slowValid && millis() - slowOkMs < 3UL * cfg.slowMs + 5000;
  return true;
}

void flushH1() {
  if (b1n == 0) return;
  if (!store::appendH1(b1Day, b1, b1n))
    store::logEvent(fastEpoch, store::EV_STORAGE, 2, b1n);
  b1n = 0;
}

void closeMinute() {
  if (a1.samples == 0) return;
  const uint32_t ts = a1Minute * 60;
  const int32_t day = sc::localDay(ts);
  if (b1n && day != b1Day) flushH1();
  int16_t v[CAT_H1];
  for (int i = 0; i < CAT_H1; i++) v[i] = a1.mean(i);
  b1Day = day;
  sc::packRecord(b1 + b1n * sc::recordSize(CAT_H1), ts,
                 (uint8_t)min<uint16_t>(a1.samples, 255), 0, v, CAT_H1);
  if (++b1n >= kH1Buffer) flushH1();
  a1.reset();
}

void closeQuarter() {
  if (a15.samples == 0) return;
  const uint32_t ts = a15Quarter * 900;
  int16_t v[CAT_H15];
  for (int i = 0; i < CAT_H15; i++) {
    switch (kTierH15[i].agg) {
      case CA_MAX: v[i] = a15.extreme[i]; break;
      case CA_LAST: v[i] = a15.last[i]; break;
      default: v[i] = a15.mean(i);
    }
  }
  uint8_t rec[96];
  sc::packRecord(rec, ts, (uint8_t)min<uint16_t>(a15.samples, 255), 0, v,
                 CAT_H15);
  store::appendH15(sc::yyyymmdd(sc::localDay(ts)) / 100, rec);
  a15.reset();
  if (todayValid) store::saveToday(today);  // checkpoint every 15 min
}

void startDay(uint32_t ymd) {
  sc::initDay(today, ymd);
  onlineSec = genSec = 0;
  todayValid = true;
  lastDayFlags = 0;
}

void rollDay(uint32_t ymd) {
  if (todayValid && today.date == ymd) return;
  if (!todayValid) {
    // First sample after boot: resume today's summary or close an old one.
    sc::DaySummary saved;
    if (store::loadToday(saved)) {
      if (saved.date == ymd) {
        today = saved;
        todayValid = true;
        onlineSec = (uint32_t)saved.onlineMin * 60;
        genSec = (uint32_t)saved.genMin * 60;
        return;
      }
      if (saved.date < ymd) store::finalizeDay(saved);
    }
    startDay(ymd);
    return;
  }
  flushH1();
  store::finalizeDay(today);
  store::logEvent(fastEpoch, store::EV_DAY_CLOSED, 0, today.date);
  startDay(ymd);
}

void onDusk() {
  // Inverter stopping or link lost: persist everything so a power cut
  // (the stick loses power when the inverter shuts down) loses nothing.
  if (duskFlushed) return;
  duskFlushed = true;
  closeMinute();
  flushH1();
  if (todayValid) store::saveToday(today);
}

void onSample() {
  const uint32_t epoch = nowEpoch();
  fastEpoch = epoch;
  const uint32_t ms = millis();
  uint32_t dt = lastSampleMs ? ms - lastSampleMs : cfg.fastMs;
  if (dt > 3UL * cfg.slowMs) dt = cfg.fastMs;  // gap: don't credit offline time
  lastSampleMs = ms;
  if (!epoch) return;  // no trustworthy time yet: live view only

  const uint8_t status = (uint8_t)sc::decode(blk, CH_STATUS);
  if (status != lastStatus) {
    store::logEvent(epoch, store::EV_STATUS, status, lastStatus);
    lastStatus = status;
  }
  if (slowValid) {
    uint16_t f = (uint16_t)sc::decode(blk, CH_FAULT);
    uint16_t w = (uint16_t)sc::decode(blk, CH_WARN);
    if (f != lastFault) store::logEvent(epoch, store::EV_FAULT, f, lastFault);
    if (w != lastWarn) store::logEvent(epoch, store::EV_WARN, w, lastWarn);
    lastFault = f;
    lastWarn = w;
  }

  const uint32_t minute = epoch / 60, quarter = epoch / 900;
  if (minute != a1Minute) {
    closeMinute();
    a1Minute = minute;
  }
  if (quarter != a15Quarter) {
    closeQuarter();
    a15Quarter = quarter;
  }
  rollDay(sc::yyyymmdd(sc::localDay(epoch)));

  // 1-minute tier
  for (int i = 0; i < CAT_H1; i++) {
    const uint8_t ch = kTierH1[i].ch;
    a1.add(i, chanAvailable(ch) ? sc::toStored(sc::decode(blk, ch), kTierH1[i].scale)
                                : sc::kMissing);
  }
  a1.samples++;
  // 15-minute tier
  for (int i = 0; i < CAT_H15; i++) {
    const uint8_t ch = kTierH15[i].ch;
    a15.add(i, chanAvailable(ch) ? sc::toStored(sc::decode(blk, ch), kTierH15[i].scale)
                                 : sc::kMissing);
  }
  a15.samples++;

  // Daily summary (needs the counters from the slow block)
  if (slowValid) {
    creditMs += dt;
    const uint16_t credit = (uint16_t)(creditMs / 1000);
    creditMs %= 1000;
    sc::updateDay(today, blk, epoch, credit, onlineSec, genSec);
    if (today.flags != lastDayFlags) {
      store::logEvent(epoch, store::EV_COUNTER, today.flags, today.eac);
      lastDayFlags = today.flags;
    }
  }

  if (status == 1) duskFlushed = false;
  else onDusk();
}

// ------------------------------------------------------------- polling ---
bool readInput(uint16_t start, uint8_t count) {
  for (int attempt = 0; attempt < 2; attempt++) {
    if (Modbus.readInputRegisters(start, count) == Modbus.ku8MBSuccess) {
      for (uint8_t i = 0; i < count; i++)
        blk.r[start - CAT_REG_BASE + i] = Modbus.getResponseBuffer(i);
      return true;
    }
    yield();
  }
  return false;
}

bool readHolding() {
  static const uint8_t win[][2] = {{0, 45}, {45, 45}, {90, 35}};
  for (auto& w : win) {
    if (Modbus.readHoldingRegisters(w[0], w[1]) != Modbus.ku8MBSuccess)
      return false;
    for (uint8_t i = 0; i < w[1]; i++) hold[w[0] + i] = Modbus.getResponseBuffer(i);
  }
  holdValid = true;
  holdMs = millis();
  rtcEpochAtHold = sc::epochFromLocal(hold[45], hold[46], hold[47], hold[48],
                                      hold[49], hold[50]);
  return true;
}

void setLink(bool up) {
  if (up == poll.linkUp) return;
  poll.linkUp = up;
  store::logEvent(nowEpoch(), up ? store::EV_LINK_UP : store::EV_LINK_DOWN, 0,
                  poll.consecutiveFail);
  if (!up) onDusk();
}

void pollOnce() {
  const uint32_t t0 = millis();
  bool ok = readInput(3000, 45) && readInput(3045, 2);
  bool slowDue = !slowValid || t0 - poll.lastSlowPollMs >= cfg.slowMs;
  if (ok && slowDue) {
    poll.lastSlowPollMs = t0;
    if (readInput(3047, 43) && readInput(3090, 35)) {
      slowValid = true;
      slowOkMs = millis();
    }
  }
  if (ok && (!holdValid || t0 - holdMs > 600000UL)) readHolding();

  const uint16_t dt = (uint16_t)min<uint32_t>(millis() - t0, 65535);
  poll.lastMs = dt;
  if (dt > poll.maxMs) poll.maxMs = dt;
  if (ok) {
    poll.ok++;
    poll.consecutiveFail = 0;
    poll.curFastMs = cfg.fastMs;
    fastValid = true;
    fastOkMs = millis();
    setLink(true);
    onSample();
  } else {
    poll.fail++;
    poll.consecutiveFail++;
    // Back off after repeated failures (inverter shutting down at dusk):
    // 2 s -> 4 -> 8 -> 16 -> 30 s max, so the bus is not hammered.
    if (poll.consecutiveFail >= 3)
      poll.curFastMs = (uint16_t)min<uint32_t>(poll.curFastMs * 2UL, 30000UL);
    if (poll.consecutiveFail >= 5) {
      fastValid = false;
      setLink(false);
    }
  }
}

// ------------------------------------------------------------ helpers ----
void noStore() { srv->sendHeader(F("Cache-Control"), F("no-store")); }

void sendDoc(JsonDocument& doc, int code = 200) {
  String out;
  serializeJson(doc, out);
  noStore();
  srv->send(code, F("application/json"), out);
}

void sendError(int code, const __FlashStringHelper* msg) {
  StaticJsonDocument<128> doc;
  doc["error"] = msg;
  sendDoc(doc, code);
}

uint8_t decimalsFor(float scale) {
  if (scale >= 1.0f) return 0;
  int d = (int)ceil(-log10((double)scale) - 1e-9);
  return (uint8_t)constrain(d, 0, 3);
}

void appendNum(String& s, double v, uint8_t dec) {
  char b[24];
  dtostrf(v, 1, dec, b);
  s += b;
}

String asciiRegs(uint8_t first, uint8_t n) {
  String s;
  for (uint8_t i = first; i < first + n; i++) {
    char c1 = hold[i] >> 8, c2 = hold[i] & 0xFF;
    if (c1 >= 32 && c1 < 127) s += c1;
    if (c2 >= 32 && c2 < 127) s += c2;
  }
  s.trim();
  return s;
}

const char* timeSrcName() {
  return timeSrc == TS_NTP ? "ntp" : timeSrc == TS_INVERTER ? "inverter" : "none";
}

// ----------------------------------------------------------- handlers ----
void handleRoot() {
  if (srv->header(F("If-None-Match")) == FPSTR(kWebUiEtag)) {
    srv->send(304);
    return;
  }
  srv->sendHeader(F("Content-Encoding"), F("gzip"));
  srv->sendHeader(F("ETag"), FPSTR(kWebUiEtag));
  srv->sendHeader(F("Cache-Control"), F("no-cache"));
  srv->send_P(200, PSTR("text/html; charset=utf-8"), (PGM_P)kWebUi, kWebUiLen);
}

void handleMeta() {
  srv->sendHeader(F("Cache-Control"), F("max-age=300"));
  srv->send_P(200, PSTR("application/json"), kMetaJson);
}

void handleLive() {
  String s;
  s.reserve(1400);
  s += F("{\"t\":");
  s += fastEpoch;
  s += F(",\"now\":");
  s += nowEpoch();
  s += F(",\"ageMs\":");
  s += fastValid ? (int32_t)(millis() - fastOkMs) : -1;
  s += F(",\"slowAgeMs\":");
  s += slowValid ? (int32_t)(millis() - slowOkMs) : -1;
  s += F(",\"link\":");
  s += poll.linkUp ? F("true") : F("false");
  s += F(",\"fastMs\":");
  s += poll.curFastMs;
  s += F(",\"time\":\"");
  s += timeSrcName();
  s += F("\",\"v\":[");
  for (uint8_t ch = 0; ch < CAT_CHANNELS; ch++) {
    if (ch) s += ',';
    if (chanAvailable(ch)) appendNum(s, sc::decode(blk, ch), decimalsFor(kCatalog[ch].scale));
    else s += F("null");
  }
  s += F("]}");
  noStore();
  srv->send(200, F("application/json"), s);
}

// Binary series stream: "SER1" u8 ncols u8 tier u16 rowBytes, then rows of
// u32 ts + ncols x i16 (little endian, INT16_MIN = missing).
struct SeriesCtx {
  uint8_t buf[1024];
  size_t len;
  size_t rowBytes;
};

void seriesFlush(SeriesCtx& c) {
  if (c.len) srv->sendContent((const char*)c.buf, c.len);
  c.len = 0;
}

void seriesRow(void* p, uint32_t ts, const int16_t* v, uint8_t n) {
  SeriesCtx& c = *(SeriesCtx*)p;
  if (c.len + c.rowBytes > sizeof(c.buf)) seriesFlush(c);
  uint8_t* o = c.buf + c.len;
  for (int i = 0; i < 4; i++) o[i] = (ts >> (8 * i)) & 0xFF;
  for (uint8_t i = 0; i < n; i++) {
    o[4 + 2 * i] = (uint16_t)v[i] & 0xFF;
    o[5 + 2 * i] = (uint16_t)v[i] >> 8;
  }
  c.len += c.rowBytes;
}

void handleSeries() {
  const uint8_t tier = (uint8_t)srv->arg(F("tier")).toInt();
  uint32_t from = (uint32_t)strtoul(srv->arg(F("from")).c_str(), nullptr, 10);
  uint32_t to = (uint32_t)strtoul(srv->arg(F("to")).c_str(), nullptr, 10);
  if ((tier != 1 && tier != 15) || to < from || from < sc::kMinValidEpoch) {
    sendError(400, F("need tier=1|15, from, to (epoch)"));
    return;
  }
  const uint32_t maxSpan = tier == 1 ? 32UL * 86400 : 400UL * 86400;
  if (to - from > maxSpan) from = to - maxSpan;
  uint8_t cols[40];
  uint8_t n = 0;
  String cs = srv->arg(F("cols"));
  int pos = 0;
  while (pos < (int)cs.length() && n < 40) {
    int comma = cs.indexOf(',', pos);
    if (comma < 0) comma = cs.length();
    long code = cs.substring(pos, comma).toInt();
    if (code < 0 || code > 255 || (code & 0x3F) >= CAT_CHANNELS) {
      sendError(400, F("bad column code"));
      return;
    }
    cols[n++] = (uint8_t)code;
    pos = comma + 1;
  }
  if (!n) {
    sendError(400, F("need cols"));
    return;
  }
  SeriesCtx* c = new SeriesCtx();
  c->rowBytes = 4 + 2 * n;
  noStore();
  srv->setContentLength(CONTENT_LENGTH_UNKNOWN);
  srv->send(200, F("application/octet-stream"), "");
  memcpy(c->buf, "SER1", 4);
  c->buf[4] = n;
  c->buf[5] = tier;
  c->buf[6] = c->rowBytes & 0xFF;
  c->buf[7] = c->rowBytes >> 8;
  c->len = 8;
  store::readSeries(tier, from, to, cols, n, seriesRow, c);
  if (tier == 1) {
    // Minutes still buffered in RAM (written to flash every 5 minutes) are
    // served from memory, so chart refreshes don't cause extra flash writes.
    int16_t vals[CAT_H1], out[40];
    for (uint8_t k = 0; k < b1n; k++) {
      uint32_t ts;
      uint8_t ns, fl;
      if (!sc::unpackRecord(b1 + k * sc::recordSize(CAT_H1), CAT_H1, ts, ns, fl, vals)) continue;
      if (ts < from || ts > to) continue;
      for (uint8_t i = 0; i < n; i++) {
        out[i] = sc::kMissing;
        for (uint8_t j = 0; j < CAT_H1; j++)
          if (kTierH1[j].ch == cols[i]) out[i] = vals[j];
      }
      seriesRow(c, ts, out, n);
    }
  }
  seriesFlush(*c);
  srv->sendContent("");
  delete c;
}

struct DaysCtx {
  String s;
  bool first;
};

void dayRow(void* p, const sc::DaySummary& d, bool partial) {
  DaysCtx& c = *(DaysCtx*)p;
  if (!c.first) c.s += ',';
  c.first = false;
  char b[256];
  snprintf(b, sizeof(b),
           "[%lu,%u,%u,%u,%u,%lu,%lu,%u,%u,%u,%u,%u,%u,%u,%u,%d,%u,%u,%u,%u,%u,%u,%u,%u,%u,%u,%u,%d]",
           (unsigned long)d.date, d.eac, d.epv[0], d.epv[1], d.epv[2],
           (unsigned long)d.eacTotalFirst, (unsigned long)d.eacTotalLast, d.eimp,
           d.eexp, d.eload, d.pacPeak, d.pacPeakMin, d.ppvPeak[0], d.ppvPeak[1],
           d.ppvPeak[2], d.tinvMax, d.vacMin, d.vacMax, d.facMin, d.facMax,
           d.firstGenMin, d.lastGenMin, d.onlineMin, d.genMin, d.lastFault,
           d.lastWarn, d.flags, partial ? 1 : 0);
  c.s += b;
  if (c.s.length() > 1200) {
    srv->sendContent(c.s);
    c.s = "";
  }
}

void handleDays() {
  uint32_t from = strtoul(srv->arg(F("from")).c_str(), nullptr, 10);
  uint32_t to = strtoul(srv->arg(F("to")).c_str(), nullptr, 10);
  if (from < 20200101 || to < from) {
    sendError(400, F("need from, to (YYYYMMDD)"));
    return;
  }
  noStore();
  srv->setContentLength(CONTENT_LENGTH_UNKNOWN);
  srv->send(200, F("application/json"), "");
  DaysCtx c{String(), true};
  c.s.reserve(1400);
  c.s = F("{\"cols\":[\"date\",\"eac\",\"epv1\",\"epv2\",\"epv3\",\"eacTotalFirst\","
          "\"eacTotalLast\",\"eimp\",\"eexp\",\"eload\",\"pacPeak\",\"pacPeakMin\","
          "\"ppv1Peak\",\"ppv2Peak\",\"ppv3Peak\",\"tinvMax\",\"vacMin\",\"vacMax\","
          "\"facMin\",\"facMax\",\"firstGenMin\",\"lastGenMin\",\"onlineMin\","
          "\"genMin\",\"fault\",\"warn\",\"flags\",\"partial\"],\"rows\":[");
  store::readDays(from, to, dayRow, &c);
  if (todayValid && today.date >= from && today.date <= to) dayRow(&c, today, true);
  c.s += F("]}");
  srv->sendContent(c.s);
  srv->sendContent("");
}

void handleDevice() {
  DynamicJsonDocument d(1536);
  d["name"] = cfg.name;
  d["valid"] = holdValid;
  if (holdValid) {
    d["serial"] = asciiRegs(23, 5);
    d["model"] = asciiRegs(34, 8);
    d["fw"] = asciiRegs(9, 3);
    d["controlFw"] = asciiRegs(12, 3);
    d["fwBuild"] = asciiRegs(82, 6);
    d["dtc"] = hold[43];
    d["trackers"] = hold[44] >> 8;
    d["phases"] = hold[44] & 0xFF;
    d["modbusVersion"] = hold[88];
    d["comAddress"] = hold[30];
    d["activePowerRate"] = hold[3];
    char rtc[32];
    snprintf(rtc, sizeof(rtc), "%04u-%02u-%02u %02u:%02u:%02u", hold[45], hold[46],
             hold[47], hold[48], hold[49], hold[50]);
    d["inverterClock"] = rtc;
    if (rtcOffsetKnown) d["clockDriftS"] = -rtcOffset;  // + = inverter ahead
    JsonArray prot = d.createNestedArray("protection");  // H52-H63, raw
    for (int i = 52; i <= 63; i++) prot.add(hold[i]);
    d["holdAgeS"] = (millis() - holdMs) / 1000;
  }
  d["protocol"] = F("Growatt Modbus v1.24 input block 3000-3124 (TL-X)");
  d["readOnly"] = INVERTER_READ_ONLY == 1;
  sendDoc(d);
}

void handleRegisters() {
  String s;
  s.reserve(1800);
  s += F("{\"inputBase\":3000,\"inputAgeMs\":");
  s += fastValid ? (int32_t)(millis() - fastOkMs) : -1;
  s += F(",\"input\":[");
  for (int i = 0; i < CAT_REG_COUNT; i++) {
    if (i) s += ',';
    s += blk.r[i];
  }
  s += F("],\"holdingAgeMs\":");
  s += holdValid ? (int32_t)(millis() - holdMs) : -1;
  s += F(",\"holding\":[");
  for (int i = 0; i < 125; i++) {
    if (i) s += ',';
    s += hold[i];
  }
  s += F("]}");
  noStore();
  srv->send(200, F("application/json"), s);
}

void handleHealth() {
  DynamicJsonDocument doc(1536);
  doc["fw"] = LOCAL_FW_VERSION;
  doc["readOnly"] = INVERTER_READ_ONLY == 1;
  doc["stick"] = (int)inv->GetWiFiStickType();
  doc["uptimeS"] = (uint32_t)(micros64() / 1000000ULL);
  doc["resetReason"] = ESP.getResetReason();
  doc["epoch"] = nowEpoch();
  doc["timeSource"] = timeSrcName();

  JsonObject mem = doc.createNestedObject("mem");
  mem["freeHeap"] = ESP.getFreeHeap();
  mem["maxBlock"] = ESP.getMaxFreeBlockSize();
  mem["fragPct"] = ESP.getHeapFragmentation();
  mem["sketch"] = ESP.getSketchSize();
  mem["freeSketch"] = ESP.getFreeSketchSpace();

  JsonObject wifi = doc.createNestedObject("wifi");
  wifi["rssi"] = WiFi.RSSI();
  wifi["ip"] = WiFi.localIP().toString();
  wifi["mac"] = WiFi.macAddress();
  wifi["channel"] = WiFi.channel();

  JsonObject m = doc.createNestedObject("modbus");
  m["link"] = poll.linkUp;
  m["ok"] = poll.ok;
  m["fail"] = poll.fail;
  m["consecutiveFail"] = poll.consecutiveFail;
  m["lastOkAgeS"] = fastValid ? (int32_t)((millis() - fastOkMs) / 1000) : -1;
  m["lastPollMs"] = poll.lastMs;
  m["maxPollMs"] = poll.maxMs;
  m["fastMs"] = cfg.fastMs;
  m["currentFastMs"] = poll.curFastMs;
  m["slowMs"] = cfg.slowMs;

  store::Usage u = store::usage();
  JsonObject fs = doc.createNestedObject("storage");
  fs["total"] = u.fsTotal;
  fs["used"] = u.fsUsed;
  fs["h1Bytes"] = u.h1Bytes;
  fs["h1Files"] = u.h1Files;
  fs["h1Budget"] = store::kBudgetH1;
  fs["h15Bytes"] = u.h15Bytes;
  fs["h15Files"] = u.h15Files;
  fs["h15Budget"] = store::kBudgetH15;
  fs["dayBytes"] = u.dayBytes;
  fs["dayFiles"] = u.dayFiles;
  fs["dayBudget"] = store::kBudgetDays;
  fs["oldestH1Day"] = u.oldestH1Day;
  fs["pendingMinutes"] = b1n;
  sendDoc(doc);
}

struct EvCtx {
  String s;
  bool first;
};

void handleEvents() {
  noStore();
  srv->setContentLength(CONTENT_LENGTH_UNKNOWN);
  srv->send(200, F("application/json"), "");
  EvCtx c{String(F("[")), true};
  store::readEvents(
      [](void* p, uint32_t ts, uint8_t type, uint16_t code, uint32_t val) {
        EvCtx& c = *(EvCtx*)p;
        char b[64];
        snprintf(b, sizeof(b), "%s[%lu,%u,%u,%lu]", c.first ? "" : ",",
                 (unsigned long)ts, type, code, (unsigned long)val);
        c.first = false;
        c.s += b;
        if (c.s.length() > 1200) {
          srv->sendContent(c.s);
          c.s = "";
        }
      },
      &c);
  c.s += ']';
  srv->sendContent(c.s);
  srv->sendContent("");
}

void handleFiles() {
  noStore();
  srv->setContentLength(CONTENT_LENGTH_UNKNOWN);
  srv->send(200, F("application/json"), "");
  EvCtx c{String(F("[")), true};
  store::listFiles(
      [](void* p, const String& path, uint32_t size) {
        EvCtx& c = *(EvCtx*)p;
        if (!c.first) c.s += ',';
        c.first = false;
        c.s += F("{\"path\":\"");
        c.s += path;
        c.s += F("\",\"size\":");
        c.s += size;
        c.s += '}';
        if (c.s.length() > 1200) {
          srv->sendContent(c.s);
          c.s = "";
        }
      },
      &c);
  c.s += ']';
  srv->sendContent(c.s);
  srv->sendContent("");
}

void handleFile() {
  String path = srv->arg(F("path"));
  if (!store::isBackupPath(path)) {
    sendError(403, F("only history files can be downloaded"));
    return;
  }
  flushH1();
  File f = LittleFS.open(path, "r");
  if (!f) {
    sendError(404, F("not found"));
    return;
  }
  String name = path.substring(1);
  name.replace('/', '_');
  srv->sendHeader(F("Content-Disposition"), "attachment; filename=\"" + name + "\"");
  srv->streamFile(f, F("application/octet-stream"));
  f.close();
}

// Documented, read-only register windows that /api/raw may touch.
struct Window {
  uint8_t fn;
  uint16_t first, last;
};
const Window kAllowed[] = {{4, 0, 124}, {4, 3000, 3124}, {3, 0, 124}};

void handleRaw() {
  long fn = srv->arg(F("fn")).toInt();
  long start = srv->arg(F("start")).toInt();
  long count = srv->arg(F("count")).toInt();
  bool ok = count > 0 && count <= 45 && start >= 0;
  bool inWin = false;
  for (const auto& w : kAllowed)
    if (ok && w.fn == fn && start >= w.first && start + count - 1 <= w.last) inWin = true;
  if (!inWin) {
    sendError(403, F("window not in documented read-only whitelist"));
    return;
  }
  if (inv->GetWiFiStickType() == Undef_stick) {
    sendError(503, F("inverter link not initialised"));
    return;
  }
  uint8_t res = fn == 4 ? Modbus.readInputRegisters(start, count)
                        : Modbus.readHoldingRegisters(start, count);
  DynamicJsonDocument doc(512 + count * 12);
  doc["fn"] = fn;
  doc["start"] = start;
  doc["count"] = count;
  doc["ok"] = res == Modbus.ku8MBSuccess;
  doc["code"] = res;
  if (res == Modbus.ku8MBSuccess) {
    JsonArray regs = doc.createNestedArray("regs");
    for (uint8_t i = 0; i < count; i++) regs.add(Modbus.getResponseBuffer(i));
  }
  sendDoc(doc);
}

void handleSettingsGet() {
  StaticJsonDocument<640> d;
  settingsJson(d);
  sendDoc(d);
}

void handleSettingsPost() {
  if (!localApiAuthorize()) return;
  StaticJsonDocument<640> in;
  if (deserializeJson(in, srv->arg(F("plain")))) {
    sendError(400, F("invalid JSON"));
    return;
  }
  if (in.containsKey("name")) {
    String n = in["name"].as<String>();
    n.trim();
    if (n.length() == 0 || n.length() > 40) {
      sendError(400, F("name must be 1-40 characters"));
      return;
    }
    cfg.name = n;
  }
  if (in.containsKey("fastMs")) cfg.fastMs = constrain(in["fastMs"].as<int>(), 1000, 10000);
  if (in.containsKey("slowMs")) cfg.slowMs = constrain(in["slowMs"].as<int>(), 5000, 60000);
  if (cfg.slowMs < cfg.fastMs) cfg.slowMs = cfg.fastMs;
  if (in.containsKey("tariffImport")) cfg.tariffImport = constrain(in["tariffImport"].as<float>(), 0.0f, 5.0f);
  if (in.containsKey("tariffExport")) cfg.tariffExport = constrain(in["tariffExport"].as<float>(), 0.0f, 5.0f);
  if (in.containsKey("tariffExport2")) cfg.tariffExport2 = constrain(in["tariffExport2"].as<float>(), 0.0f, 5.0f);
  if (in.containsKey("exportTier1Kwh")) cfg.exportTier1Kwh = constrain(in["exportTier1Kwh"].as<float>(), 0.0f, 200.0f);
  if (in.containsKey("supplyPerDay")) cfg.supplyPerDay = constrain(in["supplyPerDay"].as<float>(), 0.0f, 20.0f);
  if (in.containsKey("co2PerKwh")) cfg.co2PerKwh = constrain(in["co2PerKwh"].as<float>(), 0.0f, 2.0f);
  poll.curFastMs = cfg.fastMs;
  StaticJsonDocument<640> out;
  settingsJson(out);
  String s;
  serializeJson(out, s);
  if (!store::writeTextAtomic("/cfg/settings.json", s)) {
    sendError(500, F("could not save settings"));
    return;
  }
  store::logEvent(nowEpoch(), store::EV_SETTINGS, 0, 0);
  sendDoc(out);
}

}  // namespace

bool localApiAuthorize() {
  if (srv->authenticate(OTA_HTTP_USER, OTA_HTTP_PASSWORD)) return true;
  srv->requestAuthentication(BASIC_AUTH, "ShineWiFi-X");
  return false;
}

void setupLocalApi(LocalWebServer& server, Growatt& inverter) {
  srv = &server;
  inv = &inverter;
  memset(&blk, 0, sizeof(blk));
  memset(hold, 0, sizeof(hold));
  a1.reset();
  a15.reset();
  if (!store::begin()) Log.println(F("LittleFS mount failed"));
  loadSettings();
  loadClockOffset();
  poll.curFastMs = cfg.fastMs;
  store::logEvent((uint32_t)time(nullptr), store::EV_BOOT,
                  (uint16_t)ESP.getResetInfoPtr()->reason, 0);

  server.collectHeaders("If-None-Match");
  server.on(F("/"), HTTP_GET, handleRoot);
  server.on(F("/api/meta"), HTTP_GET, handleMeta);
  server.on(F("/api/live"), HTTP_GET, handleLive);
  server.on(F("/api/series"), HTTP_GET, handleSeries);
  server.on(F("/api/days"), HTTP_GET, handleDays);
  server.on(F("/api/device"), HTTP_GET, handleDevice);
  server.on(F("/api/registers"), HTTP_GET, handleRegisters);
  server.on(F("/api/health"), HTTP_GET, handleHealth);
  server.on(F("/api/events"), HTTP_GET, handleEvents);
  server.on(F("/api/files"), HTTP_GET, handleFiles);
  server.on(F("/api/file"), HTTP_GET, handleFile);
  server.on(F("/api/raw"), HTTP_GET, handleRaw);
  server.on(F("/api/settings"), HTTP_GET, handleSettingsGet);
  server.on(F("/api/settings"), HTTP_POST, handleSettingsPost);
  updater.setup(&server, "/update", OTA_HTTP_USER, OTA_HTTP_PASSWORD);
  // The whole upload runs inside one request, so solarLoop() never sees it.
  // The updater reports progress after each chunk it writes: save buffered
  // history on the first one, before the new image reboots the stick.
  Update.onProgress([](size_t, size_t) {
    static bool flushed = false;
    if (!flushed) {
      flushed = true;
      solarFlush();
    }
  });
}

void solarFlush() {
  duskFlushed = false;
  onDusk();
}

void solarLoop() {
  // A firmware upload is in progress: save buffered minutes before the
  // updater reboots the stick, and stop polling until it does.
  if (Update.isRunning()) {
    static bool flushed = false;
    if (!flushed) {
      flushed = true;
      solarFlush();
    }
    return;
  }
  if (inv->GetWiFiStickType() == Undef_stick) {
    if (poll.linkUp) setLink(false);
    return;
  }
  const uint32_t now = millis();
  if (now - poll.lastFastPollMs >= poll.curFastMs) {
    poll.lastFastPollMs = now;
    pollOnce();
  }
}

bool solarLinkOk() { return poll.linkUp; }
