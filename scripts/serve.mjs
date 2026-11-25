import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat, readdir } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const port = Number(process.argv[3] ?? 8765);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

const server = createServer(async (req, res) => {
  try {
    const url = decodeURIComponent((req.url ?? "/").split("?")[0]);

    // Directory listing for the explorer's "latest export" loader.
    if (url === "/_list") {
      const q = new URL(req.url, "http://localhost").searchParams;
      const dir = normalize(join(root, q.get("dir") ?? ""));
      if (!dir.startsWith(root)) { res.writeHead(403).end("forbidden"); return; }
      const entries = await readdir(dir, { withFileTypes: true });
      const files = [];
      for (const e of entries) {
        if (!e.isFile()) continue;
        const p = join(dir, e.name);
        const s = await stat(p).catch(() => null);
        if (!s) continue;
        files.push({ name: e.name, size: s.size, mtime: s.mtimeMs });
      }
      files.sort((a, b) => b.mtime - a.mtime);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(files));
      return;
    }

    let path = normalize(join(root, url));
    if (!path.startsWith(root)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    let info = await stat(path).catch(() => null);
    if (info?.isDirectory()) {
      path = join(path, "index.html");
      info = await stat(path).catch(() => null);
    }
    if (!info) {
      res.writeHead(404, { "content-type": "text/plain" }).end("404");
      return;
    }

    const type = MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
    const range = req.headers.range;

    // Range support so the 86 MB source can be scrubbed without loading it whole.
    if (range && type.startsWith("video/")) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m && m[1] ? Number(m[1]) : 0;
      const end = m && m[2] ? Math.min(Number(m[2]), info.size - 1) : info.size - 1;
      if (start >= info.size || end < start) {
        res.writeHead(416, { "content-range": `bytes */${info.size}` }).end();
        return;
      }
      res.writeHead(206, {
        "content-type": type,
        "accept-ranges": "bytes",
        "content-range": `bytes ${start}-${end}/${info.size}`,
        "content-length": end - start + 1,
        "cache-control": "no-store",
      });
      createReadStream(path, { start, end }).pipe(res);
      return;
    }

    res.writeHead(200, {
      "content-type": type,
      "content-length": info.size,
      "accept-ranges": "bytes",
      "cache-control": "no-store",
    });
    createReadStream(path).pipe(res);
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain" }).end(String(e));
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`serving ${root}`);
  console.log(`explorer  http://127.0.0.1:${port}/explorer/`);
  console.log(`audit     http://127.0.0.1:${port}/artifacts/CVE-MASHUP-NOV-26.explorer.json`);
});