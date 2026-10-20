// Bundles the dashboard into a single self-contained index.html (no CDN),
// then embeds it into the firmware (WebUi.gen.h).
import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";

const watch = process.argv.includes("--no-embed");
const res = await build({
  entryPoints: ["src/main.tsx"],
  bundle: true,
  minify: true,
  format: "iife",
  target: ["safari15", "chrome100", "firefox100"],
  jsx: "automatic",
  jsxImportSource: "preact",
  write: false,
  outdir: "dist",
  loader: { ".css": "css" },
  legalComments: "none",
  define: { "process.env.NODE_ENV": '"production"' },
});

let js = "", css = "";
for (const f of res.outputFiles) {
  if (f.path.endsWith(".js")) js = f.text;
  if (f.path.endsWith(".css")) css = f.text;
}
const tpl = readFileSync("src/index.html", "utf8");
const html = tpl
  .replace("/*CSS*/", () => css)
  .replace("/*JS*/", () => js.replace(/<\/script/gi, "<\\/script"));
mkdirSync("dist", { recursive: true });
writeFileSync("dist/index.html", html);
const gz = gzipSync(html, { level: 9 }).length;
console.log(`dist/index.html: ${(html.length / 1024).toFixed(1)} KiB raw, ${(gz / 1024).toFixed(1)} KiB gzip`);
if (!watch) execFileSync("python3", ["../tools/embed_web.py", "dist/index.html"], { stdio: "inherit" });
