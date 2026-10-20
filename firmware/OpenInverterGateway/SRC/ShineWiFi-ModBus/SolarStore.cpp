#include "SolarStore.h"

#include <LittleFS.h>

#include <algorithm>
#include <vector>

namespace store {

namespace {

struct Entry {
  String name;
  uint32_t size;
};

std::vector<Entry> listDir(const char* dir) {
  std::vector<Entry> out;
  Dir d = LittleFS.openDir(dir);
  while (d.next()) {
    if (d.isFile()) out.push_back({d.fileName(), (uint32_t)d.fileSize()});
  }
  std::sort(out.begin(), out.end(),
            [](const Entry& a, const Entry& b) { return a.name < b.name; });
  return out;
}

void enforceBudget(const char* dir, uint32_t budget) {
  std::vector<Entry> files = listDir(dir);
  std::vector<uint32_t> sizes;
  for (auto& f : files) sizes.push_back(f.size);
  size_t del = sc::filesToDelete(sizes.data(), sizes.size(), budget);
  for (size_t i = 0; i < del; i++) {
    LittleFS.remove(String(dir) + "/" + files[i].name);
    logEvent((uint32_t)time(nullptr), EV_STORAGE, 1, 0);
  }
}

bool appendWithHeader(const String& path, uint8_t tier, const uint8_t* data,
                      size_t len) {
  File f = LittleFS.open(path, "a");
  if (!f) return false;
  if (f.size() == 0) {
    sc::FileHeader h{};
    h.tier = tier;
    h.nch = tier == 1 ? CAT_H1 : CAT_H15;
    for (uint8_t i = 0; i < h.nch; i++)
      h.ch[i] = tier == 1 ? kTierH1[i].ch
                          : (uint8_t)(kTierH15[i].ch | (kTierH15[i].agg << 6));
    uint8_t hb[48];
    size_t hs = sc::packHeader(hb, h);
    if (f.write(hb, hs) != hs) {
      f.close();
      return false;
    }
  }
  bool ok = f.write(data, len) == len;
  f.close();  // LittleFS commits metadata on close
  return ok;
}

String h1Path(int32_t day) {
  char b[20];
  snprintf(b, sizeof(b), "/h1/%05ld.bin", (long)day);
  return b;
}
String h15Path(uint32_t yyyymm) {
  char b[20];
  snprintf(b, sizeof(b), "/h15/%06lu.bin", (unsigned long)yyyymm);
  return b;
}
String dayPath(uint32_t year) {
  char b[20];
  snprintf(b, sizeof(b), "/d/%04lu.bin", (unsigned long)year);
  return b;
}

uint32_t dirBytes(const char* dir, uint16_t& files) {
  uint32_t total = 0;
  files = 0;
  Dir d = LittleFS.openDir(dir);
  while (d.next())
    if (d.isFile()) {
      total += d.fileSize();
      files++;
    }
  return total;
}

}  // namespace

bool begin() {
  if (!LittleFS.begin()) return false;
  LittleFS.mkdir("/h1");
  LittleFS.mkdir("/h15");
  LittleFS.mkdir("/d");
  LittleFS.mkdir("/cfg");
  return true;
}

bool appendH1(int32_t day, const uint8_t* recs, uint8_t count) {
  bool ok = appendWithHeader(h1Path(day), 1, recs,
                             (size_t)count * sc::recordSize(CAT_H1));
  enforceBudget("/h1", kBudgetH1);
  return ok;
}

bool appendH15(uint32_t yyyymm, const uint8_t* rec) {
  bool ok = appendWithHeader(h15Path(yyyymm), 15, rec, sc::recordSize(CAT_H15));
  enforceBudget("/h15", kBudgetH15);
  return ok;
}

bool saveToday(const sc::DaySummary& d) {
  uint8_t b[sc::kDaySummarySize];
  sc::packDay(b, d);
  File f = LittleFS.open("/d/today.tmp", "w");
  if (!f) return false;
  bool ok = f.write(b, sizeof(b)) == sizeof(b);
  f.close();
  if (!ok) return false;
  LittleFS.remove("/d/today.bin");
  return LittleFS.rename("/d/today.tmp", "/d/today.bin");
}

bool loadToday(sc::DaySummary& d) {
  const char* paths[] = {"/d/today.bin", "/d/today.tmp"};
  for (const char* p : paths) {
    File f = LittleFS.open(p, "r");
    if (!f) continue;
    uint8_t b[sc::kDaySummarySize];
    bool ok = f.read(b, sizeof(b)) == sizeof(b) && sc::unpackDay(b, d);
    f.close();
    if (ok) return true;
  }
  return false;
}

bool finalizeDay(const sc::DaySummary& d) {
  const String path = dayPath(d.date / 10000);
  // Skip if this date was already appended (power loss between the append
  // and removing today.bin).
  File r = LittleFS.open(path, "r");
  if (r) {
    if (r.size() >= sc::kDaySummarySize) {
      r.seek(r.size() - sc::kDaySummarySize);
      uint8_t b[sc::kDaySummarySize];
      sc::DaySummary last;
      if (r.read(b, sizeof(b)) == sizeof(b) && sc::unpackDay(b, last) &&
          last.date >= d.date) {
        r.close();
        LittleFS.remove("/d/today.bin");
        return true;
      }
    }
    r.close();
  }
  uint8_t b[sc::kDaySummarySize];
  sc::packDay(b, d);
  File f = LittleFS.open(path, "a");
  if (!f) return false;
  bool ok = f.write(b, sizeof(b)) == sizeof(b);
  f.close();
  if (ok) LittleFS.remove("/d/today.bin");
  enforceBudget("/d", kBudgetDays + sc::kDaySummarySize);
  return ok;
}

void logEvent(uint32_t ts, uint8_t type, uint16_t code, uint32_t val) {
  uint8_t b[12] = {0};
  for (int i = 0; i < 4; i++) b[i] = (ts >> (8 * i)) & 0xFF;
  b[4] = type;
  b[6] = code & 0xFF;
  b[7] = code >> 8;
  for (int i = 0; i < 4; i++) b[8 + i] = (val >> (8 * i)) & 0xFF;
  File f = LittleFS.open("/ev.bin", "a");
  if (!f) return;
  f.write(b, sizeof(b));
  size_t sz = f.size();
  f.close();
  if (sz >= 12 * 200) {
    LittleFS.remove("/ev.old");
    LittleFS.rename("/ev.bin", "/ev.old");
  }
}

void readEvents(EventFn fn, void* ctx) {
  const char* paths[] = {"/ev.old", "/ev.bin"};
  for (const char* p : paths) {
    File f = LittleFS.open(p, "r");
    if (!f) continue;
    uint8_t b[12];
    while (f.read(b, 12) == 12) {
      uint32_t ts = b[0] | (b[1] << 8) | ((uint32_t)b[2] << 16) |
                    ((uint32_t)b[3] << 24);
      uint32_t val = b[8] | (b[9] << 8) | ((uint32_t)b[10] << 16) |
                     ((uint32_t)b[11] << 24);
      fn(ctx, ts, b[4], (uint16_t)(b[6] | (b[7] << 8)), val);
    }
    f.close();
  }
}

Usage usage() {
  Usage u{};
  FSInfo info;
  if (LittleFS.info(info)) {
    u.fsTotal = info.totalBytes;
    u.fsUsed = info.usedBytes;
  }
  u.h1Bytes = dirBytes("/h1", u.h1Files);
  u.h15Bytes = dirBytes("/h15", u.h15Files);
  u.dayBytes = dirBytes("/d", u.dayFiles);
  std::vector<Entry> h1 = listDir("/h1");
  if (!h1.empty()) u.oldestH1Day = sc::yyyymmdd(h1.front().name.toInt());
  return u;
}

namespace {
// Streams one history file, mapping its columns onto the requested ones.
uint32_t streamFile(const String& path, uint32_t from, uint32_t to,
                    const uint8_t* cols, uint8_t ncols, RowFn fn, void* ctx) {
  File f = LittleFS.open(path, "r");
  if (!f) return 0;
  uint8_t hb[48];
  size_t got = f.read(hb, sizeof(hb));
  sc::FileHeader h{};
  if (!sc::unpackHeader(hb, got, h)) {
    f.close();
    return 0;
  }
  int8_t map[40];
  for (uint8_t i = 0; i < ncols; i++) {
    map[i] = -1;
    for (uint8_t j = 0; j < h.nch; j++)
      if (h.ch[j] == cols[i]) map[i] = (int8_t)j;
  }
  const size_t rs = sc::recordSize(h.nch);
  f.seek(sc::headerSize(h.nch));
  uint8_t rb[96];
  int16_t vals[40], out[40];
  uint32_t rows = 0;
  while (f.read(rb, rs) == rs) {
    uint32_t ts;
    uint8_t n, fl;
    if (!sc::unpackRecord(rb, h.nch, ts, n, fl, vals)) continue;  // torn record
    if (ts < from || ts > to) continue;
    for (uint8_t i = 0; i < ncols; i++)
      out[i] = map[i] >= 0 ? vals[map[i]] : sc::kMissing;
    fn(ctx, ts, out, ncols);
    if ((++rows & 31) == 0) yield();
  }
  f.close();
  return rows;
}
}  // namespace

uint32_t readSeries(uint8_t tier, uint32_t from, uint32_t to,
                    const uint8_t* cols, uint8_t ncols, RowFn fn, void* ctx) {
  if (ncols == 0 || ncols > 40 || to < from) return 0;
  uint32_t rows = 0;
  if (tier == 1) {
    for (int32_t day = sc::localDay(from); day <= sc::localDay(to); day++)
      rows += streamFile(h1Path(day), from, to, cols, ncols, fn, ctx);
  } else {
    int y;
    unsigned m, d;
    sc::civilFromDays(sc::localDay(from), y, m, d);
    const uint32_t last = sc::yyyymmdd(sc::localDay(to)) / 100;
    for (uint32_t ym = (uint32_t)y * 100 + m; ym <= last;) {
      rows += streamFile(h15Path(ym), from, to, cols, ncols, fn, ctx);
      ym = (ym % 100 == 12) ? (ym / 100 + 1) * 100 + 1 : ym + 1;
    }
  }
  return rows;
}

uint32_t readDays(uint32_t fromYmd, uint32_t toYmd, DayFn fn, void* ctx) {
  uint32_t rows = 0;
  for (uint32_t y = fromYmd / 10000; y <= toYmd / 10000; y++) {
    File f = LittleFS.open(dayPath(y), "r");
    if (!f) continue;
    uint8_t b[sc::kDaySummarySize];
    sc::DaySummary d;
    while (f.read(b, sizeof(b)) == sizeof(b)) {
      if (!sc::unpackDay(b, d)) continue;
      if (d.date < fromYmd || d.date > toYmd) continue;
      fn(ctx, d, false);
      rows++;
    }
    f.close();
    yield();
  }
  return rows;
}

void listFiles(FileFn fn, void* ctx) {
  const char* dirs[] = {"/h1", "/h15", "/d"};
  for (const char* dir : dirs)
    for (auto& e : listDir(dir)) fn(ctx, String(dir) + "/" + e.name, e.size);
}

bool isBackupPath(const String& p) {
  if (p.indexOf("..") >= 0) return false;
  return (p.startsWith("/h1/") || p.startsWith("/h15/") || p.startsWith("/d/")) &&
         p.endsWith(".bin");
}

String readText(const char* path) {
  File f = LittleFS.open(path, "r");
  if (!f) return String();
  String s = f.readString();
  f.close();
  return s;
}

bool writeTextAtomic(const char* path, const String& text) {
  String tmp = String(path) + ".tmp";
  File f = LittleFS.open(tmp, "w");
  if (!f) return false;
  bool ok = f.print(text) == text.length();
  f.close();
  if (!ok) return false;
  LittleFS.remove(path);
  return LittleFS.rename(tmp, path);
}

}  // namespace store
