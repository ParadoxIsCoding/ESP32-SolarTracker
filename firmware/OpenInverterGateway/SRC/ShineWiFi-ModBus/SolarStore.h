#pragma once
// LittleFS persistence for the standalone history engine.
//
//   /h1/DDDDD.bin    1-minute records, one file per Brisbane day (day number)
//   /h15/YYYYMM.bin  15-minute records, one file per month
//   /d/YYYY.bin      finalised daily summaries, one file per year
//   /d/today.bin     checkpoint of the day in progress (temp file + rename)
//   /ev.bin          event log (rotates to /ev.old)
//   /cfg/settings.json
//
// Each history file starts with a sc::FileHeader that lists its columns, so
// files written by older firmware stay readable after the catalogue grows.
#include <Arduino.h>

#include "SolarCore.h"

namespace store {

// Byte budgets per tier (see docs/ESP8266_BUDGET.md). Oldest files go first.
// Weighted toward daily summaries (generation + grid totals): ~22 years.
const uint32_t kBudgetH1 = 736UL * 1024;    // ~18 days of 1-minute detail
const uint32_t kBudgetH15 = 448UL * 1024;   // ~4 months of 15-minute data
const uint32_t kBudgetDays = 512UL * 1024;  // ~22 years of 64-byte days

enum EventType : uint8_t {
  EV_BOOT = 1,
  EV_TIME_SYNC = 2,
  EV_LINK_UP = 3,
  EV_LINK_DOWN = 4,
  EV_STATUS = 5,
  EV_FAULT = 6,
  EV_WARN = 7,
  EV_COUNTER = 8,
  EV_DAY_CLOSED = 9,
  EV_SETTINGS = 10,
  EV_STORAGE = 11,
};

struct Usage {
  uint32_t fsTotal, fsUsed;
  uint32_t h1Bytes, h15Bytes, dayBytes;
  uint16_t h1Files, h15Files, dayFiles;
  uint32_t oldestH1Day;  // yyyymmdd, 0 if none
};

bool begin();
bool appendH1(int32_t day, const uint8_t* recs, uint8_t count);
bool appendH15(uint32_t yyyymm, const uint8_t* rec);
bool saveToday(const sc::DaySummary& d);
bool loadToday(sc::DaySummary& d);
bool finalizeDay(const sc::DaySummary& d);
void logEvent(uint32_t ts, uint8_t type, uint16_t code, uint32_t val);
Usage usage();

// Streams records of one tier between [from, to] (UTC epoch) for the
// requested column codes (catalogue index | agg << 6). For every record the
// callback receives the timestamp and one int16 per requested column
// (sc::kMissing where a file lacks that column).
typedef void (*RowFn)(void* ctx, uint32_t ts, const int16_t* vals, uint8_t n);
uint32_t readSeries(uint8_t tier, uint32_t from, uint32_t to,
                    const uint8_t* cols, uint8_t ncols, RowFn fn, void* ctx);

typedef void (*DayFn)(void* ctx, const sc::DaySummary& d, bool partial);
uint32_t readDays(uint32_t fromYmd, uint32_t toYmd, DayFn fn, void* ctx);

typedef void (*EventFn)(void* ctx, uint32_t ts, uint8_t type, uint16_t code,
                        uint32_t val);
void readEvents(EventFn fn, void* ctx);

// Read-only backup access: list and stream history files.
typedef void (*FileFn)(void* ctx, const String& path, uint32_t size);
void listFiles(FileFn fn, void* ctx);
bool isBackupPath(const String& path);

String readText(const char* path);
bool writeTextAtomic(const char* path, const String& text);

}  // namespace store
