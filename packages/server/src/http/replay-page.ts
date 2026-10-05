// The public page for one replay: a plain, static, monospace page in its map's colours. Its one
// <style> block carries the colours, so the page sends a CSP that allows that block by hash.

import { createHash } from "node:crypto";
import { html, raw } from "hono/html";
import { displayPp, playSummary, publicReplayUrl, replayTitle } from "../render/notify.ts";
import { mapPalette, type MapPalette } from "../replays/palette.ts";
import type { ReplayView } from "../replays/store.ts";
import { modLabel, modSettingLabels } from "../scores/mods.ts";
import { fmt, rankLabel } from "./views.ts";

type Html = ReturnType<typeof html>;

const HEX = /^#[0-9a-f]{6}$/;

/** The stored palette, if it's well-formed; otherwise one from the map's hash. */
function paletteOf(r: ReplayView): MapPalette {
  const p = r.palette;
  if (p && [p.paper, p.ink, p.muted, p.rule, p.accent, p.visited].every((c) => typeof c === "string" && HEX.test(c))) return p;
  return mapPalette({ seed: r.beatmap_md5 });
}

const BASE_CSS = `
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 ui-monospace,"DejaVu Sans Mono",Menlo,Consolas,monospace}
.page{max-width:76ch;margin:0 auto;padding:24px 16px 32px}
a{color:var(--accent)} a:visited{color:var(--visited)}
.path{color:var(--muted)} .path a,.path a:visited{color:inherit}
h1{font-size:inherit;margin:18px 0 0;overflow-wrap:anywhere} h1 span{color:var(--accent)}
.sub{margin:0;color:var(--muted)}
video{display:block;width:100%;aspect-ratio:16/9;background:#000;margin-top:16px}
h2{font-size:inherit;margin:20px 0 4px;text-transform:uppercase;letter-spacing:.1em;color:var(--accent)}
dl{margin:0} dl div{display:flex;flex-wrap:wrap;column-gap:1ch} dt,dd{margin:0}
dl div::after{content:"";order:1;flex:1 0 2ch;border-bottom:2px dotted var(--rule);margin-bottom:.4em;align-self:flex-end}
dd{order:2;margin-left:auto;text-align:right}
.rank{color:var(--accent);font-weight:bold}
hr{border:0;border-top:1px dashed var(--rule);margin:24px 0 8px}
footer{color:var(--muted);font-size:13px} footer p{margin:0}
@media (max-width:420px){body{font-size:13px}}`;

const styleFor = (p: MapPalette) =>
  `:root{--paper:${p.paper};--ink:${p.ink};--muted:${p.muted};--rule:${p.rule};--accent:${p.accent};--visited:${p.visited}}${BASE_CSS}`;

const modText = (r: ReplayView) =>
  r.mods.length ? r.mods.map((m) => [modLabel(m), ...modSettingLabels(m)].join(" ")).join(", ") : "none";

/** The page, and the CSP source that allows its style block. */
export function replayPage(r: ReplayView, origin: string): { body: Html; styleSrc: string } {
  const url = publicReplayUrl(origin, r.id);
  const video = `${url}/video.mp4?v=${r.render?.id ?? 0}`;
  const title = replayTitle(r);
  const summary = `${playSummary(r)} · played by ${r.player_name}${r.devserver ? ` on ${r.devserver}` : ""}`;
  const palette = paletteOf(r);
  const style = styleFor(palette);
  const a = r.attributes;
  const pp = displayPp(r);
  const b = r.beatmap;
  const row = (label: string, value: unknown) => html`<div><dt>${label}</dt><dd>${value}</dd></div>`;
  const width = r.render?.video_width ?? 1920;
  const height = r.render?.video_height ?? 1080;

  const body = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · kiai</title>
<meta name="description" content="${summary}">
<meta property="og:type" content="video.other">
<meta property="og:site_name" content="kiai">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${summary}">
<meta property="og:url" content="${url}">
${b?.cover_url ? html`<meta property="og:image" content="${b.cover_url}">` : ""}
<meta property="og:video" content="${video}">
<meta property="og:video:secure_url" content="${video}">
<meta property="og:video:type" content="video/mp4">
<meta property="og:video:width" content="${width}">
<meta property="og:video:height" content="${height}">
<meta name="twitter:card" content="player">
<meta name="twitter:title" content="${title}">
<meta name="twitter:player" content="${video}">
<meta name="twitter:player:stream" content="${video}">
<meta name="twitter:player:stream:content_type" content="video/mp4">
<meta name="twitter:player:width" content="${width}">
<meta name="twitter:player:height" content="${height}">
<meta name="theme-color" content="${palette.accent}">
<style>${raw(style)}</style>
</head>
<body>
<div class="page">
<div class="path"><a href="/">kiai</a> / <a href="/">replays</a> / ${r.id}</div>
<h1>${b?.title ? html`${b.artist ?? "Unknown artist"} - ${b.title}${b.version ? html` <span>[${b.version}]</span>` : ""}` : title}</h1>
${b?.creator ? html`<p class="sub">mapped by ${b.creator}</p>` : ""}
<video src="/r/${r.id}/video.mp4?v=${r.render?.id ?? 0}" controls preload="metadata"${b?.cover_url ? html` poster="${b.cover_url}"` : ""}></video>
<h2>Play</h2>
<dl>
${row("player", r.player_name + (r.devserver ? ` (${r.devserver})` : ""))}
${row("mods", modText(r))}
${row("rank", html`<span class="rank">${rankLabel(r.rank)}${r.rank === "SH" || r.rank === "XH" ? " (silver)" : ""}</span>`)}
${row("accuracy", fmt.acc(r.accuracy))}
${row("combo", `${fmt.number(r.max_combo)}x${a ? ` / ${fmt.number(a.max_combo)}x` : ""}${r.perfect ? " FC" : ""}`)}
${row("300 / 100 / 50 / miss", [r.count300, r.count100, r.count50, r.countmiss].map(fmt.number).join(" / "))}
${pp ? row("pp", `${Math.round(pp.pp)}${pp.estimate ? " (estimate)" : ""}`) : ""}
${row("played", fmt.dateTime(r.played_at))}
</dl>
${a || b?.id
  ? html`<h2>Map${a && r.mods.length ? " (with mods)" : ""}</h2>
<dl>
${a ? row("stars", a.stars.toFixed(2)) : ""}
${a ? row("ar / od / cs / hp", `${a.ar} / ${a.od} / ${a.cs} / ${a.hp}`) : ""}
${a ? row("bpm", Math.round(a.bpm)) : ""}
${a ? row("length", fmt.duration(a.length)) : ""}
${b?.id && b.beatmapset_id
  ? row("beatmap", html`<a href="https://osu.ppy.sh/beatmapsets/${b.beatmapset_id}#osu/${b.id}" rel="noopener noreferrer">osu.ppy.sh/b/${b.id}</a>`)
  : ""}
</dl>`
  : ""}
<hr>
<footer>
<p>rendered with danser · <a href="/">more replays</a></p>
<p>hosted with hate and malice from Dallas, Texas</p>
</footer>
</div>
</body>
</html>`;
  return { body, styleSrc: `'sha256-${createHash("sha256").update(style).digest("base64")}'` };
}
