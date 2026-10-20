#pragma once
// Standalone solar analytics runtime for the ShineWiFi-X (read-only).
//
// Polls the documented MIN TL-X input block 3000-3124 (fast part every
// ~2 s, slow part every ~10 s), aggregates into LittleFS history tiers and
// serves the embedded dashboard plus a JSON/binary API:
//
//   GET  /                 dashboard (gzip, from flash)
//   GET  /api/meta         measurement catalogue (dynamic discovery)
//   GET  /api/live         latest values of every catalogue channel
//   GET  /api/series       tier=1|15&from=&to=&cols=  (binary, see docs/API.md)
//   GET  /api/days         from=YYYYMMDD&to=YYYYMMDD  daily summaries
//   GET  /api/device       inverter identity, clock, protection settings
//   GET  /api/registers    raw register cache (input 3000-3124, holding 0-124)
//   GET  /api/health       dongle + link + storage health
//   GET  /api/events       event log
//   GET  /api/files        history file list; /api/file?path= downloads one
//   GET  /api/raw          whitelisted read-only register probe
//   GET  /api/settings     settings;  POST (basic auth) to change them
//   POST /update           firmware upload (basic auth)
#include <Arduino.h>

#ifdef ESP8266
#include <ESP8266WebServer.h>
typedef ESP8266WebServer LocalWebServer;
#else
#error "LocalApi currently targets the ESP8266 (ShineWiFi-X) only"
#endif

#define LOCAL_FW_VERSION "mintlx-ro.3"

class Growatt;

void setupLocalApi(LocalWebServer& server, Growatt& inverter);
// Call every loop(): runs polling, aggregation and persistence.
void solarLoop();
bool solarLinkOk();
// Persist buffered history now (before a reboot or firmware update).
void solarFlush();
// Basic-auth guard for state-changing endpoints. Sends the 401 itself.
bool localApiAuthorize();
