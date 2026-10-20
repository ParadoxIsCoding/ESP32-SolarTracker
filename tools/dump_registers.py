"""Read every whitelisted register window from the stick's /api/raw (read-only)
and save a timestamped JSON dump. Usage: python3 tools/dump_registers.py <ip> [outdir]"""
import json, sys, time, urllib.request, datetime, pathlib

ip = sys.argv[1]
out = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else "docs/register-dumps")
WINDOWS = [(4, 0, 45), (4, 45, 45), (4, 90, 35),
           (4, 3000, 45), (4, 3045, 45), (4, 3090, 35),
           (3, 0, 45), (3, 45, 45), (3, 90, 35)]

def get(path):
    for attempt in range(4):
        try:
            with urllib.request.urlopen(f"http://{ip}{path}", timeout=10) as r:
                return json.load(r)
        except Exception as e:
            err = e; time.sleep(2)
    return {"error": str(err)}

dump = {"taken": datetime.datetime.now().astimezone().isoformat(), "health": get("/api/health"), "blocks": []}
for fn, start, count in WINDOWS:
    b = get(f"/api/raw?fn={fn}&start={start}&count={count}")
    dump["blocks"].append(b)
    print(f"fn{fn} {start:>4}+{count:<3} ok={b.get('ok')} code={b.get('code')} ms={b.get('ms')} {b.get('error','')}")
out.mkdir(parents=True, exist_ok=True)
f = out / f"dump_{datetime.datetime.now():%Y%m%d_%H%M%S}.json"
f.write_text(json.dumps(dump, indent=1))
print("saved", f)
