// Serves /opt/claustrum/public read-only on port 80: the files the website reads
// (enclosure.json, turns.jsonl, fees.jsonl, status.json, sim-*). Nothing else.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, normalize, extname } from "node:path";

const ROOT = process.env.PUBLIC_DIR ?? "/opt/claustrum/public";
const TYPES = { ".json": "application/json", ".jsonl": "application/x-ndjson", ".html": "text/html; charset=utf-8", ".txt": "text/plain; charset=utf-8" };

createServer(async (req, res) => {
  // Short shared-cache lifetimes so a CDN (Cloudflare) can absorb traffic; data is at most ~10 s stale.
  const cacheFor = (f) => /\.html$/.test(f) ? "public, max-age=60, s-maxage=300" : /status\.txt$/.test(f) ? "no-store" : "public, max-age=5, s-maxage=10";
  const headers = { "access-control-allow-origin": "*", "cache-control": "no-store", "x-content-type-options": "nosniff" };
  try {
    const url = new URL(req.url, "http://x");
    let rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
    if (rel === "" ) rel = "index.html";
    if (rel.includes("..") || rel.startsWith(".")) throw Object.assign(new Error("bad path"), { code: 400 });
    const file = join(ROOT, rel);
    if (!(await stat(file)).isFile()) throw Object.assign(new Error("not found"), { code: 404 });
    res.writeHead(200, { ...headers, "cache-control": cacheFor(file), "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(await readFile(file));
  } catch (e) {
    const code = e.code === 400 ? 400 : 404;
    res.writeHead(code, { ...headers, "content-type": "text/plain" });
    res.end(code === 400 ? "bad request" : "not found");
  }
}).listen(Number(process.env.PORT ?? 80), () => console.log("serving", ROOT));
