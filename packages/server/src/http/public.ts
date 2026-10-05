// The public replay app: rendered replay pages, their videos, clips made with the Discord bot, and
// a gallery searched with the score library's filters, nothing else. It runs on its own port (PUBLIC_PORT), which is the only one
// Caddy and the tunnel ever reach. It shares the database with the private app but never mounts its
// routes, and shows only replays that have a finished render.

import fs from "node:fs";
import path from "node:path";
import { Hono, type Context } from "hono";
import { html } from "hono/html";
import { getClip } from "../clips/store.ts";
import type { Sql } from "../db/index.ts";
import type { MediaPaths } from "../media.ts";
import { playSummary, replayTitle } from "../render/notify.ts";
import { listGallery, type GalleryPage } from "../replays/gallery.ts";
import { getReplay, type ReplayView } from "../replays/store.ts";
import { DEFAULT_FILTERS, filtersToParams, parseScoreFilters, type ScoreFilters } from "../scores/query.ts";
import { sendFile } from "./files.ts";
import { replayPage } from "./replay-page.ts";
import { filterForm, fmt } from "./views.ts";

type Html = ReturnType<typeof html>;

export interface PublicAppDeps {
  sql: Sql;
  media: MediaPaths;
  /** Absolute links in og tags; falls back to the request's own origin. */
  publicUrl?: string | undefined;
}

const CSS = fs.readFileSync(new URL("./assets/app.css", import.meta.url), "utf8");
// Only the gallery's mod filter buttons use it; its other parts need elements this app never shows.
const JS = fs.readFileSync(new URL("./assets/app.js", import.meta.url), "utf8");
const PAGE_CACHE = "public, max-age=60";
const VIDEO_CACHE = "public, max-age=86400";
/** `styleSrc` adds to style-src: a replay page allows its own style block by hash. */
const csp = (styleSrc = "") =>
  `default-src 'none'; script-src 'self'; style-src 'self'${styleSrc ? ` ${styleSrc}` : ""}; img-src 'self' https://assets.ppy.sh; media-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`;
const SECURITY_HEADERS = {
  "Content-Security-Policy": csp(),
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

function layout(title: string, head: Html | string, body: Html): Html {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · kiai</title>
<link rel="stylesheet" href="/assets/app.css">
<script src="/assets/app.js" defer></script>
${head}
</head>
<body>
<header class="topbar"><a class="brand" href="/">kiai replays</a></header>
<main>${body}</main>
</body>
</html>`;
}

function card(r: ReplayView): Html {
  return html`<a class="card replaycard" href="/r/${r.id}">
    ${r.beatmap?.cover_url ? html`<img src="${r.beatmap.cover_url.replace("cover.jpg", "list@2x.jpg")}" alt="" loading="lazy">` : ""}
    <span><strong>${replayTitle(r)}</strong><br><span class="muted small">${playSummary(r)} · ${r.player_name} · ${fmt.date(r.played_at)}</span></span>
  </a>`;
}

function galleryPage(f: ScoreFilters, page: GalleryPage): Html {
  const { replays, pagination } = page;
  const { sort, order, pageSize } = DEFAULT_FILTERS;
  const filtered = filtersToParams(f, { page: 1, sort, order, pageSize }).size > 0;
  const link = (p: number) => `/?${filtersToParams(f, { page: p }).toString()}`;
  return layout(
    "Replays",
    "",
    html`${filterForm(f, { action: "/" })}
    <section class="card" aria-label="Replays">
      <h1>Replays <span class="muted small">${fmt.number(pagination.total_count)}${filtered ? " match" : ""}</span></h1>
      ${replays.length
        ? html`<div class="replaylist">${replays.map(card)}</div>
          ${replays.some((r) => r.score_pp === null && r.attributes) ? html`<p class="muted small">* pp estimated with rosu-pp.</p>` : ""}`
        : html`<p class="muted">${filtered ? "No replays match these filters." : "Nothing rendered yet."}</p>`}
      ${pagination.total_pages > 1
        ? html`<nav class="pager">
            ${pagination.page > 1 ? html`<a href="${link(pagination.page - 1)}">← Previous</a>` : html`<span></span>`}
            <span>Page ${pagination.page} of ${fmt.number(pagination.total_pages)}</span>
            ${pagination.page < pagination.total_pages ? html`<a href="${link(pagination.page + 1)}">Next →</a>` : html`<span></span>`}
          </nav>`
        : ""}
    </section>`,
  );
}

export function createPublicApp(deps: PublicAppDeps): Hono {
  const { sql, media } = deps;
  const app = new Hono();
  const origin = (c: Context) => deps.publicUrl ?? new URL(c.req.url).origin;

  app.onError((error, c) => {
    console.error(error);
    return c.text("Something went wrong.", 500);
  });
  app.use("*", async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return c.text("Method not allowed.", 405, { Allow: "GET, HEAD" });
    await next();
    // A route may send its own, stricter-or-equal CSP.
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) if (!c.res.headers.has(name)) c.header(name, value);
  });

  app.get("/healthz", (c) => c.text("ok"));
  app.get("/assets/app.css", (c) => c.body(CSS, 200, { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "public, max-age=3600" }));
  app.get("/assets/app.js", (c) => c.body(JS, 200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=3600" }));

  app.get("/", async (c) => {
    const filters = parseScoreFilters(new URL(c.req.url).searchParams);
    return c.html(galleryPage(filters, await listGallery(sql, filters)), 200, { "Cache-Control": PAGE_CACHE });
  });

  /** The replay, if it has a finished render; otherwise it doesn't exist as far as the public knows. */
  const rendered = async (id: string) => {
    const replay = await getReplay(sql, id);
    return replay?.render?.status === "success" ? replay : null;
  };

  app.get("/r/:id", async (c) => {
    const replay = await rendered(c.req.param("id"));
    if (!replay) return c.text("No such replay.", 404);
    const page = replayPage(replay, origin(c));
    return c.html(page.body, 200, { "Cache-Control": PAGE_CACHE, "Content-Security-Policy": csp(page.styleSrc) });
  });

  // video.mp4 is the full render; embed.mp4 is the copy small enough for Discord, or the full
  // render when it's small enough already.
  app.on(["GET", "HEAD"], "/r/:id/:file{video\\.mp4|embed\\.mp4}", async (c) => {
    const replay = await rendered(c.req.param("id"));
    if (!replay) return c.text("No such replay.", 404);
    const [job] = await sql<{ video_path: string; embed_path: string | null }[]>`
      select video_path, embed_path from render_jobs where replay_id = ${replay.id} and status = 'success' order by id desc limit 1`;
    if (!job) return c.text("No such replay.", 404);
    const file = c.req.param("file") === "embed.mp4" ? (job.embed_path ?? job.video_path) : job.video_path;
    return sendFile(c, path.join(media.root, file), "video/mp4", VIDEO_CACHE);
  });

  app.on(["GET", "HEAD"], "/c/:id/video.mp4", async (c) => {
    const clip = await getClip(sql, c.req.param("id"));
    if (clip?.status !== "success" || !clip.video_path) return c.text("No such clip.", 404);
    return sendFile(c, path.join(media.root, clip.video_path), "video/mp4", VIDEO_CACHE);
  });

  app.notFound((c) => c.text("Not found.", 404));
  return app;
}
