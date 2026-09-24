// Replay uploads and renders on the private app. Uploads come from the kiai client on the gaming
// PC and need UPLOAD_TOKEN as a bearer token; reading and re-rendering follow the private app's
// usual rules (private network, same-origin writes). Public replay pages are a separate app.

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { Context, Hono } from "hono";
import type { Sql } from "../db/index.ts";
import { UserError } from "../errors.ts";
import type { MediaPaths } from "../media.ts";
import type { Player } from "../player.ts";
import { installOsz, MAX_OSZ_BYTES, writeStreamLimited } from "../render/maps.ts";
import { DEFAULT_PRESET } from "../render/preset.ts";
import { enqueueRender, requeueWaitingFor } from "../render/queue.ts";
import { getReplay, linkReplays, listReplays, normalizeDevserver, saveReplay } from "../replays/store.ts";
import { replayPage, replaysPage } from "./views.ts";

const MAX_OSR_BYTES = 32 * 1024 * 1024;
const PRIVATE = { "Cache-Control": "private, no-store" };

export interface ReplayRouteDeps {
  sql: Sql;
  player: Player;
  media: MediaPaths;
  uploadToken: string | undefined;
}

class HttpError extends Error {
  readonly status: 401 | 403 | 404 | 413 | 503;
  constructor(status: HttpError["status"], message: string) {
    super(message);
    this.status = status;
  }
}

const digest = (value: string) => createHash("sha256").update(value).digest();

function requireUploadToken(c: Context, token: string | undefined): void {
  if (!token) throw new HttpError(503, "Uploads are off: set UPLOAD_TOKEN in the server's .env and give the same token to the client (kiai server set).");
  const header = c.req.header("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!given) throw new HttpError(401, "Uploads need the server's UPLOAD_TOKEN as a bearer token.");
  if (!timingSafeEqual(digest(given), digest(token))) throw new HttpError(403, "That upload token is wrong.");
}

async function readBody(c: Context, limit: number, what: string): Promise<Buffer> {
  const declared = Number(c.req.header("content-length"));
  if (declared > limit) throw new HttpError(413, `${what} is larger than ${limit / 1024 / 1024} MB.`);
  const body = c.req.raw.body;
  if (!body) throw new UserError(`Send ${what.toLowerCase()} as the request body.`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, `${what} is larger than ${limit / 1024 / 1024} MB.`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Serve a file with byte-range support, which browsers and Discord need to seek in videos. */
async function sendFile(c: Context, file: string, type: string): Promise<Response> {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) return c.json({ error: "The video file is missing." }, 404);
  const headers: Record<string, string> = { "Content-Type": type, "Accept-Ranges": "bytes", ...PRIVATE };
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

export function registerReplayRoutes(app: Hono, deps: ReplayRouteDeps): void {
  const { sql, media, player } = deps;
  const isApi = (c: Context) => c.req.path.startsWith("/api/");

  // HTTP errors become responses here; anything else reaches the app's own error handler.
  const guard = async (c: Context, work: () => Promise<Response>): Promise<Response> => {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      return isApi(c) ? c.json({ error: error.message }, error.status) : c.text(error.message, error.status);
    }
  };

  const replayOr404 = async (c: Context) => {
    const replay = await getReplay(sql, c.req.param("id") ?? "");
    if (!replay) throw new HttpError(404, "No such replay.");
    return replay;
  };

  // ---------- API ----------

  /**
   * Upload a replay as the raw request body (`Content-Type: application/octet-stream`). Query:
   * `devserver` (the osu! server it was set on; omit for the official servers). Queues a render.
   */
  app.post("/api/replays", (c) =>
    guard(c, async () => {
      requireUploadToken(c, deps.uploadToken);
      const devserver = normalizeDevserver(c.req.query("devserver"));
      const data = await readBody(c, MAX_OSR_BYTES, "The replay");
      const saved = await saveReplay(sql, media, data, devserver);
      const existing = saved.created ? null : await getReplay(sql, saved.id);
      // A new replay, or an old one never rendered: queue it. Re-uploads don't re-render a finished one.
      if (saved.created || !existing?.render) await enqueueRender(sql, saved.id, DEFAULT_PRESET.name);
      if (saved.created) await linkReplays(sql, player.id);
      return c.json({ ...(await getReplay(sql, saved.id)), created: saved.created }, saved.created ? 201 : 200, PRIVATE);
    }),
  );

  app.get("/api/replays", async (c) => c.json({ replays: await listReplays(sql) }, 200, PRIVATE));

  app.get("/api/replays/:id", (c) => guard(c, async () => c.json(await replayOr404(c), 200, PRIVATE)));

  /**
   * Upload the beatmap set (.osz, raw body) a replay was played on, for maps no mirror has
   * (unsubmitted or edited). Refused if it doesn't contain that exact difficulty.
   */
  app.put("/api/replays/:id/beatmapset", (c) =>
    guard(c, async () => {
      requireUploadToken(c, deps.uploadToken);
      const replay = await replayOr404(c);
      const declared = Number(c.req.header("content-length"));
      if (declared > MAX_OSZ_BYTES) throw new HttpError(413, `The .osz is larger than ${MAX_OSZ_BYTES / 1024 / 1024} MB.`);
      if (!c.req.raw.body) throw new UserError("Send the .osz as the request body.");
      const upload = path.join(media.tmp, `upload-${randomUUID()}.osz`);
      try {
        await writeStreamLimited(c.req.raw.body, upload, MAX_OSZ_BYTES, "The .osz").catch((error: unknown) => {
          throw error instanceof UserError ? new HttpError(413, error.message) : error;
        });
        // Named by content, so uploading the same set twice reuses one folder.
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(upload)) hash.update(chunk as Buffer);
        const folder = `upload-${hash.digest("hex").slice(0, 16)}`;
        const files = await installOsz(sql, media, upload, folder, "upload", replay.beatmap_md5);
        const requeued = await requeueWaitingFor(sql, files.map((f) => f.md5));
        return c.json({ difficulties: files.length, requeued, replay: await getReplay(sql, replay.id) }, 200, PRIVATE);
      } finally {
        await fs.rm(upload, { force: true });
      }
    }),
  );

  /** Render again (after a failure, or once the map is available). */
  app.post("/api/replays/:id/render", (c) =>
    guard(c, async () => {
      const replay = await replayOr404(c);
      const result = await enqueueRender(sql, replay.id, DEFAULT_PRESET.name);
      return c.json({ render_id: result.job.id, already_queued: result.alreadyQueued }, result.alreadyQueued ? 200 : 202);
    }),
  );

  // ---------- pages ----------

  app.get("/replays", async (c) => c.html(replaysPage(await listReplays(sql), player, c.req.query("notice")), 200, PRIVATE));

  app.get("/replays/:id", (c) => guard(c, async () => c.html(replayPage(await replayOr404(c), player), 200, PRIVATE)));

  app.post("/replays/:id/render", (c) =>
    guard(c, async () => {
      const replay = await replayOr404(c);
      await enqueueRender(sql, replay.id, DEFAULT_PRESET.name);
      return c.redirect(`/replays/${replay.id}`, 303);
    }),
  );

  app.on(["GET", "HEAD"], "/replays/:id/video", (c) =>
    guard(c, async () => {
      const replay = await replayOr404(c);
      const [job] = await sql<{ video_path: string }[]>`
        select video_path from render_jobs where replay_id = ${replay.id} and status = 'success' order by id desc limit 1`;
      if (!job) throw new HttpError(404, "This replay hasn't been rendered yet.");
      return sendFile(c, path.join(media.root, job.video_path), "video/mp4");
    }),
  );
}
