import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
};

/** Serves files under `root` for URLs beginning with `prefix`. Returns false if not handled. */
export function serveStatic(req: IncomingMessage, res: ServerResponse, prefix: string, root: string): boolean {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith(prefix)) return false;
  let rel = decodeURIComponent(url.pathname.slice(prefix.length));
  if (rel === "" || rel.endsWith("/")) rel += "index.html";
  const file = resolve(root, normalize(rel).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(resolve(root))) {
    res.writeHead(403).end("forbidden");
    return true;
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    const fallback = join(root, "404.html");
    if (existsSync(fallback)) {
      res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      createReadStream(fallback).pipe(res);
    } else res.writeHead(404).end("not found");
    return true;
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
  createReadStream(file).pipe(res);
  return true;
}
