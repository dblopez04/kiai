import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { Readable } from "node:stream";
import type { Context } from "hono";

/** Serve a file with byte-range support, which browsers and Discord need to seek in videos. */
export async function sendFile(c: Context, file: string, type: string, cacheControl: string): Promise<Response> {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) return c.text("The video file is missing.", 404);
  const headers: Record<string, string> = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": cacheControl };
  const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header("range") ?? "");
  let start = 0;
  let end = stat.size - 1;
  let status = 200;
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(Number(range[2]), end);
    } else {
      start = Math.max(0, stat.size - Number(range[2]));
    }
    if (start > end || start >= stat.size) {
      return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${stat.size}` } });
    }
    status = 206;
    headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
  }
  headers["Content-Length"] = String(end - start + 1);
  if (c.req.method === "HEAD") return new Response(null, { status, headers });
  const stream = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream<Uint8Array>;
  return new Response(stream, { status, headers });
}
