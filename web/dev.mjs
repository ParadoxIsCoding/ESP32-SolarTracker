// Development server: serves web/dist/index.html and proxies /api/* to the
// stick, so the dashboard can be tested against real data before flashing.
// Usage: DEVICE=192.168.86.29 PORT=5173 node dev.mjs   (rebuild with npm run build -- --no-embed)
import http from "node:http";
import { readFileSync } from "node:fs";

const DEVICE = process.env.DEVICE || "192.168.86.29";
const PORT = Number(process.env.PORT || 5173);

http
  .createServer((req, res) => {
    if (req.url.startsWith("/api/")) {
      const up = http.request(
        { host: DEVICE, port: 80, path: req.url, method: req.method, headers: { ...req.headers, host: DEVICE } },
        (r) => {
          res.writeHead(r.statusCode, r.headers);
          r.pipe(res);
        },
      );
      up.on("error", (e) => {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `device unreachable: ${e.message}` }));
      });
      req.pipe(up);
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(readFileSync(new URL("./dist/index.html", import.meta.url)));
  })
  .listen(PORT, () => console.log(`dashboard on http://localhost:${PORT}  (api -> ${DEVICE})`));
