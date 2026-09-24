// The public replay app: rendered replay pages and their videos, nothing else. It runs on its own
// port (PUBLIC_PORT), which is the only one Caddy and the tunnel ever reach. It shares the
// database with the private app but never mounts its routes, and shows only replays that have a
// finished render.

import fs from "node:fs";
import path from "node:path";
import { Hono, type Context } from "hono";
import { html } from "hono/html";
import type { Sql } from "../db/index.ts";
import type { MediaPaths } from "../media.ts";
import { displayPp, playSummary, publicReplayUrl, replayTitle } from "../render/notify.ts";
import { getReplay, type ReplayView } from "../replays/store.ts";
import { sendFile } from "./files.ts";
import { fmt, modChips, rankClass, rankLabel } from "./views.ts";

type Html = ReturnType<typeof html>;

export interface PublicAppDeps {
  sql: Sql;
  media: MediaPaths;
  /** Absolute links in og tags; falls back to the request's own origin. */
  publicUrl?: string | undefined;
}

const CSS = fs.readFileSync(new URL("./assets/app.css", import.meta.url), "utf8");
const PAGE_CACHE = "public, max-age=60";
const VIDEO_CACHE = "public, max-age=86400";
const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; style-src 'self'; img-src 'self' https://assets.ppy.sh; media-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
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
    <span><strong>${replayTitle(r)}</strong><br><span class="muted small">${playSummary(r)} · ${r.player_name}</span></span>
  </a>`;
}

function homePage(replays: readonly ReplayView[]): Html {
  return layout(
    "Replays",
    "",
    html`<section class="card"><h1>Replays</h1>
      ${replays.length ? html`<div class="replaylist">${replays.map(card)}</div>` : html`<p class="muted">Nothing rendered yet.</p>`}
    </section>`,
  );
}

function replayPage(r: ReplayView, origin: string): Html {
  const url = publicReplayUrl(origin, r.id);
  const video = `${url}/video.mp4?v=${r.render?.id ?? 0}`;
  const title = replayTitle(r);
  const summary = `${playSummary(r)} · played by ${r.player_name}${r.devserver ? ` on ${r.devserver}` : ""}`;
  const a = r.attributes;
  const pp = displayPp(r);
  const row = (label: string, value: unknown) => html`<tr><th>${label}</th><td>${value}</td></tr>`;
  const head = html`<meta name="description" content="${summary}">
<meta property="og:type" content="video.other">
<meta property="og:site_name" content="kiai">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${summary}">
<meta property="og:url" content="${url}">
${r.beatmap?.cover_url ? html`<meta property="og:image" content="${r.beatmap.cover_url}">` : ""}
<meta property="og:video" content="${video}">
<meta property="og:video:secure_url" content="${video}">
<meta property="og:video:type" content="video/mp4">
<meta property="og:video:width" content="1920">
<meta property="og:video:height" content="1080">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#ff66aa">`;
  return layout(
    title,
    head,
    html`<section class="card"><video src="/r/${r.id}/video.mp4?v=${r.render?.id ?? 0}" controls preload="metadata" class="video"></video></section>
    <section class="card">
      <div class="row wrap">
        <span class="${rankClass(r.rank)} big">${rankLabel(r.rank)}</span>
        <div class="grow">
          <h1>${title}</h1>
          <p>${modChips(r.mods)}</p>
        </div>
      </div>
      <table class="kv">
        ${row("Player", r.player_name + (r.devserver ? ` (${r.devserver})` : ""))}
        ${row("Accuracy", fmt.acc(r.accuracy))}
        ${row("Combo", html`${fmt.number(r.max_combo)}${a ? html`<span class="muted"> / ${fmt.number(a.max_combo)}</span>` : ""}${r.perfect ? html` <span class="badge">FC</span>` : ""}`)}
        ${row("Hits", `${fmt.number(r.count300)} / ${fmt.number(r.count100)} / ${fmt.number(r.count50)} / ${fmt.number(r.countmiss)} miss`)}
        ${pp ? row("PP", `${Math.round(pp.pp)}pp${pp.estimate ? " (estimate)" : ""}`) : ""}
        ${a ? row("Map", `${a.stars.toFixed(2)}★ · AR ${a.ar} · OD ${a.od} · CS ${a.cs} · HP ${a.hp} · ${Math.round(a.bpm)} BPM · ${fmt.duration(a.length)}`) : ""}
        ${row("Played", fmt.dateTime(r.played_at))}
      </table>
      ${r.beatmap?.id && r.beatmap.beatmapset_id
        ? html`<p><a href="https://osu.ppy.sh/beatmapsets/${r.beatmap.beatmapset_id}#osu/${r.beatmap.id}" rel="noopener noreferrer">Beatmap on osu! ↗</a></p>`
        : ""}
    </section>`,
  );
}

/** Replays with a finished render, newest first. */
async function renderedReplays(sql: Sql, limit: number): Promise<ReplayView[]> {
  const rows = await sql<{ id: string }[]>`
    select r.id from replays r
    where exists (select 1 from render_jobs j where j.replay_id = r.id and j.status = 'success')
    order by r.uploaded_at desc limit ${limit}`;
  const views = await Promise.all(rows.map((row) => getReplay(sql, row.id)));
  return views.filter((view): view is ReplayView => view !== null);
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
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.header(name, value);
  });

  app.get("/healthz", (c) => c.text("ok"));
  app.get("/assets/app.css", (c) => c.body(CSS, 200, { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "public, max-age=3600" }));

  app.get("/", async (c) => c.html(homePage(await renderedReplays(sql, 30)), 200, { "Cache-Control": PAGE_CACHE }));

  /** The replay, if it has a finished render; otherwise it doesn't exist as far as the public knows. */
  const rendered = async (id: string) => {
    const replay = await getReplay(sql, id);
    return replay?.render?.status === "success" ? replay : null;
  };

  app.get("/r/:id", async (c) => {
    const replay = await rendered(c.req.param("id"));
    if (!replay) return c.text("No such replay.", 404);
    return c.html(replayPage(replay, origin(c)), 200, { "Cache-Control": PAGE_CACHE });
  });

  app.on(["GET", "HEAD"], "/r/:id/video.mp4", async (c) => {
    const replay = await rendered(c.req.param("id"));
    if (!replay) return c.text("No such replay.", 404);
    const [job] = await sql<{ video_path: string }[]>`
      select video_path from render_jobs where replay_id = ${replay.id} and status = 'success' order by id desc limit 1`;
    if (!job) return c.text("No such replay.", 404);
    return sendFile(c, path.join(media.root, job.video_path), "video/mp4", VIDEO_CACHE);
  });

  app.notFound((c) => c.text("Not found.", 404));
  return app;
}
