// Server-rendered pages. `html` escapes every interpolated value unless it is itself `html`.

import { html } from "hono/html";
import { MOD_CATEGORIES, STANDARD_MODS, modDescription, modLabel, modSettingLabels, type ScoreMod } from "../scores/mods.ts";
import { filtersToParams, SORT_KEYS, type ScoreFilters, type ScorePage, type ScoreStats, type ScoreView } from "../scores/query.ts";
import type { SyncOverview, SyncRun } from "../sync/queue.ts";
import type { Player } from "../player.ts";
import type { RenderPreset } from "../render/presets.ts";
import type { ReplayView } from "../replays/store.ts";

type Html = ReturnType<typeof html>;

// ---------- formatting ----------

const nf = new Intl.NumberFormat("en-US");
export const fmt = {
  number: (n: number | null | undefined) => (typeof n === "number" && Number.isFinite(n) ? nf.format(n) : "—"),
  acc: (a: number) => `${(a * 100).toFixed(2)}%`,
  pp: (pp: number | null) => (pp === null ? "—" : `${Math.round(pp)}pp`),
  date: (iso: string | Date | null) =>
    iso ? new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }) : "—",
  dateTime: (iso: string | Date | null) => (iso ? `${new Date(iso).toISOString().replace("T", " ").slice(0, 16)} UTC` : "—"),
  duration: (seconds: number | null) => {
    if (seconds === null || !Number.isFinite(seconds)) return "—";
    const s = Math.round(seconds);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  },
  hours: (seconds: number | null) => (seconds === null ? "—" : `${nf.format(Math.round(seconds / 3600))}h`),
  stars: (sr: number | null) => (sr === null ? "—" : `${sr.toFixed(2)}★`),
};

const RANK_LABEL: Record<string, string> = { XH: "SS", X: "SS", SH: "S" };
export const rankLabel = (rank: string) => RANK_LABEL[rank] ?? rank;
export const rankClass = (rank: string) => `rank rank-${rank.toLowerCase()}`;

const mapTitle = (s: ScoreView) => `${s.beatmap.artist ?? "Unknown artist"} - ${s.beatmap.title ?? "Unknown title"}`;

// ---------- layout ----------

export function layout(title: string, body: Html, player: Player): Html {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · kiai</title>
<link rel="stylesheet" href="/assets/app.css">
<script src="/assets/app.js" defer></script>
</head>
<body>
<header class="topbar">
  <nav class="sections"><a class="brand" href="/">kiai</a><a href="/">Scores</a><a href="/matches">Matches</a><a href="/matches/scores">Tournament scores</a><a href="/replays">Replays</a><a href="/render">Render settings</a></nav>
  <nav><a class="who" href="https://osu.ppy.sh/users/${player.id}" target="_blank" rel="noopener noreferrer">${player.username}</a></nav>
</header>
<main>${body}</main>
</body>
</html>`;
}

export function messagePage(title: string, message: string, player: Player): Html {
  return layout(title, html`<section class="card narrow"><h1>${title}</h1><p>${message}</p><p><a href="/">Back to scores</a></p></section>`, player);
}

// ---------- mods ----------

export function modChips(mods: readonly ScoreMod[]): Html {
  if (mods.length === 0) return html`<span class="muted">NM</span>`;
  return html`<span class="mods">${mods.map((mod) => {
    const settings = modSettingLabels(mod);
    return html`<span class="mod" title="${modDescription(mod)}">${modLabel(mod)}${settings.length ? html`<small> ${settings.join(" ")}</small>` : ""}</span>`;
  })}</span>`;
}

const COMMON_MODS = ["HD", "HR", "DT", "NC", "HT", "DC", "EZ", "NF", "FL", "CL", "DA"];

export function modFilter(f: ScoreFilters): Html {
  const state = (acronym: string) =>
    f.mods.includes(acronym) ? "required" : f.modsOptional.includes(acronym) ? "optional" : f.modsExcluded.includes(acronym) ? "excluded" : "off";
  const button = (mod: { acronym: string; name: string }) =>
    html`<button type="button" class="modbtn" data-mod="${mod.acronym}" data-state="${state(mod.acronym)}" title="${mod.name}">${mod.acronym}</button>`;
  const selected = new Set([...f.mods, ...f.modsOptional, ...f.modsExcluded]);
  const common = STANDARD_MODS.filter((mod) => COMMON_MODS.includes(mod.acronym) || selected.has(mod.acronym));
  return html`<fieldset class="modfilter" data-modfilter>
    <legend>Mods <small class="muted">click: off → required → optional → excluded</small></legend>
    <input type="hidden" name="mods" value="${f.mods.join(",")}">
    <input type="hidden" name="mods_optional" value="${f.modsOptional.join(",")}">
    <input type="hidden" name="mods_excluded" value="${f.modsExcluded.join(",")}">
    <div class="modrow" data-common>${common.map(button)}</div>
    <details data-allmods>
      <summary>All lazer mods</summary>
      <input type="search" placeholder="Find a mod by name…" aria-label="Find mod" data-modsearch>
      ${MOD_CATEGORIES.map(
        (category) => html`<div class="modgroup"><h4>${category.label}</h4><div class="modrow">${STANDARD_MODS.filter((m) => m.type === category.type).map(button)}</div></div>`,
      )}
    </details>
  </fieldset>`;
}

// ---------- dashboard ----------

const SORT_LABELS: Record<(typeof SORT_KEYS)[number], string> = {
  ended_at: "Date",
  pp: "PP",
  accuracy: "Accuracy",
  total_score: "Score",
  max_combo: "Combo",
};
const STATUSES = ["ranked", "approved", "loved", "qualified", "pending", "wip", "graveyard"];
const RANKS = ["SS", "S", "A", "B", "C", "D"];

export const checked = (on: boolean) => (on ? html`checked` : "");
export const numberValue = (n: number | null) => (n === null ? "" : String(n));

/**
 * The score filters. The tournament score search reuses it with its own action and extra fields
 * (player, match name).
 */
export function filterForm(f: ScoreFilters, options: { action?: string; extra?: Html } = {}): Html {
  const action = options.action ?? "/";
  return html`<form method="get" action="${action}" class="card filters" data-filters>
    <div class="row wrap">
      <input type="search" name="q" value="${f.q}" placeholder="Search title, artist or difficulty" aria-label="Search" class="grow">
      <label>Sort <select name="sort">${SORT_KEYS.map((key) => html`<option value="${key}" ${f.sort === key ? html`selected` : ""}>${SORT_LABELS[key]}</option>`)}</select></label>
      <label>Order <select name="order"><option value="desc">High → low</option><option value="asc" ${f.order === "asc" ? html`selected` : ""}>Low → high</option></select></label>
    </div>
    <div class="row wrap">
      <fieldset class="inline"><legend>Rank</legend>${RANKS.map(
        (rank) => html`<label class="check"><input type="checkbox" name="rank" value="${rank}" ${checked(f.rank.includes(rank))}> ${rank}</label>`,
      )}</fieldset>
      <fieldset class="inline"><legend>Map status</legend>${STATUSES.map(
        (status) => html`<label class="check"><input type="checkbox" name="status" value="${status}" ${checked(f.status.includes(status))}> ${status}</label>`,
      )}</fieldset>
    </div>
    <div class="row wrap">
      <label>PP <input type="number" name="min_pp" value="${numberValue(f.minPp)}" placeholder="min" step="any" class="num"> – <input type="number" name="max_pp" value="${numberValue(f.maxPp)}" placeholder="max" step="any" class="num"></label>
      <label>Stars <input type="number" name="min_stars" value="${numberValue(f.minStars)}" placeholder="min" step="0.1" class="num"> – <input type="number" name="max_stars" value="${numberValue(f.maxStars)}" placeholder="max" step="0.1" class="num"></label>
      <label>Speed × <input type="number" name="min_rate" value="${numberValue(f.minRate)}" placeholder="min" step="0.05" min="0.01" max="100" class="num"> – <input type="number" name="max_rate" value="${numberValue(f.maxRate)}" placeholder="max" step="0.05" min="0.01" max="100" class="num"></label>
    </div>
    ${options.extra ?? ""}
    ${modFilter(f)}
    <div class="row wrap">
      <label class="check"><input type="checkbox" name="best_only" value="true" ${checked(f.bestOnly)}> Best score per map</label>
      <label class="check" title="Only required and optional mods may be present"><input type="checkbox" name="mods_exact" value="true" ${checked(f.modsExact)}> Exact mods</label>
      <label class="check" title="No mods, or Classic only"><input type="checkbox" name="nomod" value="true" ${checked(f.nomod)}> NM only</label>
      <span class="grow"></span>
      <a href="${action}">Reset filters</a>
      <button class="primary">Apply</button>
    </div>
  </form>`;
}

function statsPanel(stats: ScoreStats): Html {
  const dist = stats.rank_distribution;
  const total = Object.values(dist).reduce((a, b) => a + b, 0) || 1;
  const topLink = (label: string, s: ScoreView | null, value: (s: ScoreView) => string) =>
    s
      ? html`<div class="stat"><span class="label">${label}</span><a href="/scores/${s.id}">${value(s)}</a><span class="muted small">${mapTitle(s)} [${s.beatmap.version ?? "?"}]</span></div>`
      : "";
  return html`<section class="card stats" aria-label="Library statistics">
    <div class="stat"><span class="label">Scores</span><strong>${fmt.number(stats.total_scores)}</strong></div>
    <div class="stat"><span class="label">Maps played</span><strong>${fmt.number(stats.unique_beatmaps_played)}</strong></div>
    <div class="stat"><span class="label">Last 24h</span><strong>${fmt.number(stats.recent_scores_24h)}</strong></div>
    <div class="stat"><span class="label">Profile</span><strong>${fmt.pp(stats.user_pp)}</strong><span class="muted small">#${fmt.number(stats.user_rank)} · ${fmt.hours(stats.user_play_time)} played</span></div>
    ${topLink("Top PP", stats.top_pp_score, (s) => fmt.pp(s.pp))}
    ${topLink("Top score", stats.top_total_score, (s) => fmt.number(s.total_score))}
    <div class="dist" aria-label="Rank distribution">${Object.entries(dist).map(
      ([rank, count]) => html`<span class="${rankClass(rank)}" style="flex-grow:${Math.max(count / total, 0.02)}" title="${rank}: ${count}">${rank} ${fmt.number(count)}</span>`,
    )}</div>
  </section>`;
}

const MODE_LABEL: Record<string, string> = {
  recent: "Syncing recent plays",
  history: "Importing history",
  refresh: "Refreshing PP and score links",
  reset: "Rebuilding library",
};

/** The live part of the import panel; also served alone for polling. */
export function syncStatus(overview: SyncOverview, now = Date.now()): Html {
  const active = overview.runs.find((run) => run.status === "running" || run.status === "queued");
  const latest = overview.runs[0];
  const cp = active?.checkpoint;
  const stale = active?.status === "running" && active.heartbeat_at && now - active.heartbeat_at.getTime() > 5 * 60 * 1000;
  const progress = (run: SyncRun) => {
    const c = run.checkpoint;
    return html`
      ${c.phase === "played-list" ? html`<p>Reading the profile's played-map list: ${fmt.number(c.playedListOffset ?? 0)} entries scanned.</p>` : ""}
      ${c.mapsTotal !== undefined ? html`<p>${fmt.number(c.mapsProcessed ?? 0)} / ${fmt.number(c.mapsTotal)} osu!standard maps checked.</p>` : ""}
      ${run.mode === "refresh"
        ? html`<p>${fmt.number(c.scoresRefreshed ?? 0)} / ${fmt.number(c.scoresTotal ?? overview.total_scores)} scores refreshed. ${fmt.number(c.ppUnavailable ?? 0)} could not be calculated.</p>`
        : html`<p>${fmt.number(run.scores_added)} scores saved in this run.</p>`}`;
  };
  return html`<div data-sync-status data-last-success="${overview.last_success?.toISOString() ?? ""}" data-active="${active ? "1" : ""}" role="status" aria-live="polite">
    <p class="muted small">Last successful sync: ${overview.last_success ? fmt.dateTime(overview.last_success) : "not synced yet"}</p>
    ${active
      ? html`<div class="progress">
          <p><strong>${active.status === "queued"
            ? "Queued — waiting for the worker."
            : stale
              ? "Worker interrupted — waiting to resume from saved progress."
              : `${MODE_LABEL[active.mode] ?? active.mode}: ${cp?.phase ?? "starting"}.`}</strong></p>
          ${progress(active)}
          ${active.status === "queued" && now - active.created_at.getTime() > 30_000 ? html`<p class="alert">Still waiting. Make sure the worker is running.</p>` : ""}
        </div>`
      : latest?.status === "success"
        ? html`<p>Sync completed. A CSV snapshot was saved on the server.</p>`
        : ""}
    ${latest?.status === "failed" && !active ? html`<p class="alert" role="alert">Import stopped: ${latest.error_text ?? "unknown error"} Saved scores are kept; resume to continue.</p>` : ""}
  </div>`;
}

function importPanel(overview: SyncOverview, f: ScoreFilters, osuConfigured: boolean): Html {
  const active = overview.runs.some((run) => run.status === "running" || run.status === "queued");
  const latest = overview.runs[0];
  const failed = (mode: string) => latest?.mode === mode && latest.status === "failed";
  const disabled = active || !osuConfigured ? html`disabled` : "";
  const syncButton = (mode: string, label: string) =>
    html`<form method="post" action="/sync"><input type="hidden" name="mode" value="${mode}"><button ${disabled}>${label}</button></form>`;
  const filtered = filtersToParams(f, { page: 1 });
  return html`<section class="card" aria-label="Import and export">
    <h2>Import and export</h2>
    ${overview.total_scores === 0 ? html`<p>The library is empty. Import history to get everything osu! still has, or sync recent plays for a quick first import.</p>` : ""}
    ${!osuConfigured ? html`<p class="alert">Imports need <code>OSU_CLIENT_ID</code> and <code>OSU_CLIENT_SECRET</code> in <code>.env</code>.</p>` : ""}
    <div class="row wrap">
      ${syncButton("history", failed("history") ? "Resume history import" : "Import history")}
      ${syncButton("recent", "Sync recent")}
      ${overview.total_scores > 0
        ? html`${syncButton("refresh", failed("refresh") ? "Resume PP refresh" : "Refresh all PP")}
            <a class="button" href="/api/scores/export" download>Export all CSV</a>
            <a class="button" href="/api/scores/export?${filtered.toString()}" download>Export filtered CSV</a>`
        : ""}
    </div>
    <div data-sync-slot>${syncStatus(overview)}</div>
    <details class="danger">
      <summary>${failed("reset") ? "Resume reset and reimport…" : "Reset and reimport…"}</summary>
      <p>This clears ${fmt.number(overview.total_scores)} saved scores and imports them again from the played-map list. Scores osu! no longer has (overwritten or deleted) won't come back. A CSV backup and a full database archive are saved first. This can take many hours.</p>
      <form method="post" action="/sync" class="row wrap">
        <input type="hidden" name="mode" value="reset">
        <label>Type RESET to confirm <input name="confirm" autocomplete="off" pattern="RESET" required class="num"></label>
        <button class="dangerous" ${disabled}>Reset and reimport</button>
      </form>
    </details>
    <p class="muted small">History imports check every osu!standard map on the profile's played-map list, plus maps from earlier imports. They can take hours and can't recover plays osu! no longer has. Recent sync looks back ${overview.runs[0]?.recent_window_hours ?? 24}h.</p>
  </section>`;
}

function scoreTable(f: ScoreFilters, page: ScorePage): Html {
  const { scores, pagination } = page;
  const link = (p: number) => `/?${filtersToParams(f, { page: p }).toString()}`;
  return html`<section class="card" aria-label="Scores">
    <div class="row">
      <h2 class="grow">Scores <span class="muted small">${fmt.number(pagination.total_count)} match</span></h2>
    </div>
    ${scores.length === 0
      ? html`<p class="muted">No scores match these filters.</p>`
      : html`<div class="tablewrap"><table class="scores">
          <thead><tr><th>Rank</th><th>Beatmap</th><th>Mods</th><th class="r">PP</th><th class="r">Acc</th><th class="r">Combo</th><th class="r">Miss</th><th class="r">Stars</th><th>Date</th></tr></thead>
          <tbody>${scores.map(
            (s) => html`<tr>
              <td><span class="${rankClass(s.rank)}">${rankLabel(s.rank)}</span></td>
              <td class="map"><a href="/scores/${s.id}">${mapTitle(s)}</a> <span class="muted">[${s.beatmap.version ?? "?"}]</span></td>
              <td>${modChips(s.mods)}</td>
              <td class="r" title="${s.pp_source === "local" ? `Local estimate (${s.pp_calculator ?? "rosu-pp"})` : s.pp_source}">${fmt.pp(s.pp)}${s.pp_source === "local" ? html`<sup>*</sup>` : ""}</td>
              <td class="r">${fmt.acc(s.accuracy)}</td>
              <td class="r">${fmt.number(s.max_combo)}${s.beatmap.max_combo ? html`<span class="muted">/${fmt.number(s.beatmap.max_combo)}</span>` : ""}</td>
              <td class="r">${fmt.number(s.countmiss)}</td>
              <td class="r">${fmt.stars(s.beatmap.difficulty_rating)}</td>
              <td class="nowrap">${fmt.date(s.ended_at)}</td>
            </tr>`,
          )}</tbody>
        </table></div>
        ${scores.some((s) => s.pp_source === "local") ? html`<p class="muted small">* PP calculated locally (loved, unranked or no longer on osu!).</p>` : ""}`}
    ${pagination.total_pages > 1
      ? html`<nav class="pager">
          ${pagination.page > 1 ? html`<a href="${link(pagination.page - 1)}">← Previous</a>` : html`<span></span>`}
          <span>Page ${pagination.page} of ${fmt.number(pagination.total_pages)}</span>
          ${pagination.page < pagination.total_pages ? html`<a href="${link(pagination.page + 1)}">Next →</a>` : html`<span></span>`}
        </nav>`
      : ""}
  </section>`;
}

export interface DashboardData {
  player: Player;
  filters: ScoreFilters;
  page: ScorePage;
  stats: ScoreStats;
  overview: SyncOverview;
  osuConfigured: boolean;
  notice?: string | undefined;
}

export function dashboardPage(d: DashboardData): Html {
  return layout(
    "Scores",
    html`${d.notice ? html`<p class="notice" role="status">${d.notice}</p>` : ""}
      ${statsPanel(d.stats)}
      ${importPanel(d.overview, d.filters, d.osuConfigured)}
      ${filterForm(d.filters)}
      ${scoreTable(d.filters, d.page)}`,
    d.player,
  );
}

// ---------- score detail ----------

export function scorePage(s: ScoreView, player: Player): Html {
  const b = s.beatmap;
  const rate = s.clock_rate;
  const row = (label: string, value: unknown) => html`<tr><th>${label}</th><td>${value}</td></tr>`;
  const withRate = (base: number | null, format: (n: number) => string) =>
    base === null ? "—" : rate && rate !== 1 ? `${format(base)} → ${format(base * rate)}` : format(base);
  const lengthWithRate = (seconds: number | null) =>
    seconds === null ? "—" : rate && rate !== 1 ? `${fmt.duration(seconds)} → ${fmt.duration(seconds / rate)}` : fmt.duration(seconds);
  return layout(
    `${mapTitle(s)} [${b.version ?? "?"}]`,
    html`<p><a href="/">← All scores</a></p>
    <section class="card cover" style="background-image:url('${b.cover_url}')">
      <div class="coverinner">
        <span class="${rankClass(s.rank)} big">${rankLabel(s.rank)}</span>
        <div>
          <h1>${b.title ?? "Unknown title"}</h1>
          <p>${b.artist ?? "Unknown artist"} · <strong>[${b.version ?? "?"}]</strong> · mapped by ${b.creator ?? "?"} · ${b.status ?? "unknown status"}</p>
          <p>${modChips(s.mods)}</p>
        </div>
      </div>
    </section>
    <div class="grid2">
      <section class="card">
        <h2>Play</h2>
        <table class="kv">
          ${row("PP", html`${fmt.pp(s.pp)} <span class="muted small">${s.pp_source === "local" ? `local estimate · ${s.pp_calculator ?? ""}` : s.pp_source}${s.pp_updated_at ? ` · updated ${fmt.date(s.pp_updated_at)}` : ""}</span>`)}
          ${row("Accuracy", fmt.acc(s.accuracy))}
          ${row("Score", html`${fmt.number(s.total_score)}${s.legacy_total_score ? html` <span class="muted small">(stable ${fmt.number(s.legacy_total_score)})</span>` : ""}`)}
          ${row("Combo", html`${fmt.number(s.max_combo)}${b.max_combo ? ` / ${fmt.number(b.max_combo)}` : ""}${s.perfect ? html` <span class="badge">FC</span>` : ""}`)}
          ${row("Hits", `${fmt.number(s.count300)} / ${fmt.number(s.count100)} / ${fmt.number(s.count50)} / ${fmt.number(s.countmiss)} miss`)}
          ${row("Played", fmt.dateTime(s.ended_at))}
          ${row("Client", s.is_lazer === null ? "unknown" : s.is_lazer ? "lazer" : "stable")}
          ${row("Replay", s.replay_available ? "available on osu!" : "not available")}
          ${row("Speed", rate === null ? "variable" : `${rate}×`)}
        </table>
        <div class="stack" data-scorelink data-score="${s.id}">
          ${s.score_url ? html`<a href="${s.score_url}" target="_blank" rel="noopener noreferrer" data-scorelink-url>View score on osu! ↗</a>` : ""}
          ${s.score_link_status === "unavailable" ? html`<p class="muted">This score is no longer on osu!. The saved copy is kept.</p>` : ""}
          <button type="button" data-scorelink-check>${s.score_url ? "Recheck link" : "Check online score"}</button>
          <p class="alert" role="alert" hidden data-scorelink-error></p>
        </div>
      </section>
      <section class="card">
        <h2>Beatmap</h2>
        <table class="kv">
          ${row("Stars", fmt.stars(b.difficulty_rating))}
          ${row("BPM", withRate(b.bpm, (n) => String(Math.round(n * 10) / 10)))}
          ${row("Length", lengthWithRate(b.total_length))}
          ${row("AR / OD / CS / HP", `${b.ar ?? "—"} / ${b.od ?? "—"} / ${b.cs ?? "—"} / ${b.drain ?? "—"}`)}
          ${row("Objects", `${fmt.number(b.count_circles)} circles · ${fmt.number(b.count_sliders)} sliders · ${fmt.number(b.count_spinners)} spinners`)}
        </table>
        <p><a href="${b.url}" target="_blank" rel="noopener noreferrer">Beatmap on osu! ↗</a></p>
        ${s.mods.some((mod) => mod.settings && Object.keys(mod.settings).length)
          ? html`<h3>Mod settings</h3><ul>${s.mods.map((mod) => html`<li>${modDescription(mod)}</li>`)}</ul>`
          : ""}
      </section>
    </div>`,
    player,
  );
}

// ---------- replays ----------

const RENDER_STATUS: Record<string, string> = {
  queued: "Queued",
  running: "Rendering",
  needs_map: "Needs the beatmap",
  success: "Rendered",
  failed: "Failed",
};

const replayTitle = (r: ReplayView) =>
  r.beatmap ? `${r.beatmap.artist ?? "Unknown artist"} - ${r.beatmap.title ?? "Unknown title"}` : `Beatmap ${r.beatmap_md5.slice(0, 8)}…`;

function renderState(r: ReplayView): Html {
  const job = r.render;
  if (!job) return html`<span class="muted">Not rendered</span>`;
  const label = RENDER_STATUS[job.status] ?? job.status;
  return job.status === "running" ? html`${label} ${job.progress}%` : job.status === "failed" || job.status === "needs_map" ? html`<span class="alert">${label}</span>` : html`${label}`;
}

export function replaysPage(replays: readonly ReplayView[], player: Player, notice?: string): Html {
  const active = replays.some((r) => r.render && ["queued", "running"].includes(r.render.status));
  return layout(
    "Replays",
    html`${notice ? html`<p class="notice" role="status">${notice}</p>` : ""}
    <section class="card" aria-label="Replays">
      <h2>Replays <span class="muted small">${fmt.number(replays.length)} most recent</span></h2>
      ${replays.length === 0
        ? html`<p>No replays yet. Upload one from the PC you play on with <code>kiai render &lt;file.osr&gt;</code>.</p>`
        : html`<div class="tablewrap"><table class="scores">
            <thead><tr><th>Rank</th><th>Beatmap</th><th>Mods</th><th class="r">Acc</th><th>Player</th><th>Server</th><th>Render</th><th>Uploaded</th></tr></thead>
            <tbody>${replays.map(
              (r) => html`<tr>
                <td><span class="${rankClass(r.rank)}">${rankLabel(r.rank)}</span></td>
                <td class="map"><a href="/replays/${r.id}">${replayTitle(r)}</a> ${r.beatmap?.version ? html`<span class="muted">[${r.beatmap.version}]</span>` : ""}</td>
                <td>${modChips(r.mods)}</td>
                <td class="r">${fmt.acc(r.accuracy)}</td>
                <td>${r.player_name}</td>
                <td>${r.devserver ?? "osu!"}</td>
                <td class="nowrap">${renderState(r)}</td>
                <td class="nowrap">${fmt.date(r.uploaded_at)}</td>
              </tr>`,
            )}</tbody>
          </table></div>`}
      ${active ? html`<p class="muted small">Renders in progress. Reload to see their status.</p>` : ""}
    </section>`,
    player,
  );
}

export function replayPage(r: ReplayView, player: Player, publicUrl?: string, presets: readonly RenderPreset[] = []): Html {
  const job = r.render;
  const row = (label: string, value: unknown) => html`<tr><th>${label}</th><td>${value}</td></tr>`;
  const canRetry = !job || job.status === "failed" || job.status === "needs_map" || job.status === "success";
  return layout(
    replayTitle(r),
    html`<p><a href="/replays">← All replays</a></p>
    <section class="card cover" ${r.beatmap?.cover_url ? html`style="background-image:url('${r.beatmap.cover_url}')"` : ""}>
      <div class="coverinner">
        <span class="${rankClass(r.rank)} big">${rankLabel(r.rank)}</span>
        <div>
          <h1>${r.beatmap?.title ?? replayTitle(r)}</h1>
          <p>${r.beatmap?.artist ?? ""}${r.beatmap?.version ? html` · <strong>[${r.beatmap.version}]</strong>` : ""}${r.beatmap?.creator ? ` · mapped by ${r.beatmap.creator}` : ""}</p>
          <p>${modChips(r.mods)}</p>
        </div>
      </div>
    </section>
    ${job?.video_url ? html`<section class="card"><video src="${job.video_url}" controls preload="metadata" class="video"></video></section>` : ""}
    <div class="grid2">
      <section class="card">
        <h2>Play</h2>
        <table class="kv">
          ${row("Player", r.player_name)}
          ${row("Server", r.devserver ?? "osu! (official)")}
          ${row("Accuracy", fmt.acc(r.accuracy))}
          ${row("Score", fmt.number(r.total_score))}
          ${row("Combo", html`${fmt.number(r.max_combo)}${r.perfect ? html` <span class="badge">FC</span>` : ""}`)}
          ${row("Hits", `${fmt.number(r.count300)} / ${fmt.number(r.count100)} / ${fmt.number(r.count50)} / ${fmt.number(r.countmiss)} miss`)}
          ${row("Played", fmt.dateTime(r.played_at))}
          ${row("In the score library", r.score_id ? html`<a href="/scores/${r.score_id}">yes</a>` : "not linked")}
        </table>
      </section>
      <section class="card">
        <h2>Render</h2>
        <table class="kv">
          ${row("Status", renderState(r))}
          ${job ? row("Preset", job.preset ? html`${job.preset}${job.preset_reason ? html` <span class="muted small">(${job.preset_reason})</span>` : ""}` : "picked by the rules when it renders") : ""}
          ${job?.finished_at ? row("Finished", fmt.dateTime(job.finished_at)) : ""}
          ${job?.video_bytes ? row("Size", `${(job.video_bytes / 1024 / 1024).toFixed(1)} MB`) : ""}
        </table>
        ${job?.error ? html`<pre class="alert small">${job.error}</pre>` : ""}
        ${job?.status === "needs_map" ? html`<p>Run <code>kiai render</code> on the PC you played on again: it uploads the map from your Songs folder.</p>` : ""}
        ${job?.video_url ? html`<p><a href="${job.video_url}" download="${r.id}.mp4">Download video</a></p>` : ""}
        ${job?.status === "success" && publicUrl ? html`<p>Public page: <a href="${publicUrl}/r/${r.id}" target="_blank" rel="noopener noreferrer">${publicUrl}/r/${r.id}</a></p>` : ""}
        ${canRetry
          ? html`<form method="post" action="/replays/${r.id}/render" class="row wrap">
              <select name="preset" aria-label="Preset"><option value="">Preset: pick with the rules</option>${presets.map((p) => html`<option value="${p.name}">Preset: ${p.name}</option>`)}</select>
              <button>${job ? "Render again" : "Render"}</button>
            </form>`
          : ""}
      </section>
    </div>`,
    player,
  );
}
