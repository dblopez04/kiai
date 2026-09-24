// Pages for the match database: the match list with import and discovery, one match with its
// maps and match costs, and the tournament score search.

import { html } from "hono/html";
import type { DiscoveryState } from "../matches/discovery.ts";
import { MATCH_KINDS, type MatchKind, type MatchSource } from "../matches/normalize.ts";
import {
  MATCH_SORT_KEYS,
  matchFiltersToParams,
  tournamentFiltersToParams,
  type MatchDetail,
  type MatchFilters,
  type MatchGameView,
  type MatchListItem,
  type MatchPage,
  type MatchPlayerView,
  type MatchStats,
  type PlayerRef,
  type TournamentScoreFilters,
  type TournamentScorePage,
} from "../matches/query.ts";
import type { QueueOverview } from "../matches/queue.ts";
import type { Player } from "../player.ts";
import type { BeatmapView } from "../scores/query.ts";
import { checked, filterForm, fmt, layout, mapCell, modChips, numberValue, pager, rankClass, rankLabel } from "./views.ts";

type Html = ReturnType<typeof html>;

const SOURCE_LABEL: Record<MatchSource, string> = { stable: "stable", lazer: "ranked play" };
export const KIND_LABEL: Record<MatchKind, string> = { tournament: "tournament", romai: "ROMAI", etx: "ETX", omm: "o!mm", ranked: "ranked play", other: "other" };

/** Every type is ticked unless hidden; the `show=-` marker lets unticked boxes count (see `hiddenKinds`). */
export function kindFieldset(hidden: readonly MatchKind[]): Html {
  return html`<fieldset class="inline"><legend>Type</legend>
    <input type="hidden" name="show" value="-">
    ${MATCH_KINDS.map((kind) => html`<label class="check"><input type="checkbox" name="show" value="${kind}" ${checked(!hidden.includes(kind))}> ${KIND_LABEL[kind]}</label>`)}
  </fieldset>`;
}
const cost = (value: number | null | undefined) => (typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "—");
const beatmapTitle = (b: BeatmapView | null, beatmapId: number | null) =>
  b ? `${b.artist ?? "Unknown artist"} - ${b.title ?? "Unknown title"}` : beatmapId ? `Beatmap #${beatmapId} (not on osu!)` : "Unknown beatmap";
const who = (p: { username: string | null; id?: number; user_id?: number }) => p.username ?? `#${p.id ?? p.user_id}`;
const profile = (id: number) => `https://osu.ppy.sh/users/${id}`;

function resultChip(result: MatchListItem["result"]): Html | string {
  if (result === "won") return html`<span class="chip win">W</span>`;
  if (result === "lost") return html`<span class="chip loss">L</span>`;
  if (result === "draw") return html`<span class="chip">D</span>`;
  return "";
}

/** "3 – 2" from the player's side when they played, red first otherwise. */
function scoreLine(m: Pick<MatchListItem, "red_wins" | "blue_wins" | "me">): string {
  if (m.red_wins === null || m.blue_wins === null) return "";
  return m.me?.side === "blue" ? `${m.blue_wins}–${m.red_wins}` : `${m.red_wins}–${m.blue_wins}`;
}

/** A one-line, clipped cell of player links; hovering shows every name. */
function peopleCell(list: PlayerRef[], filter: "with" | "vs"): Html {
  return html`<td class="clip people" title="${list.map(who).join(", ")}">${people(list, filter)}</td>`;
}

/** Players linking to their other matches, by id so the links survive name changes. */
function people(list: PlayerRef[], filter: "with" | "vs", max = 4): Html | string {
  if (list.length === 0) return html`<span class="muted">—</span>`;
  const shown = list.slice(0, max);
  return html`${shown.map((p, i) => html`${i ? ", " : ""}<a href="/matches?${filter}=${p.id}">${who(p)}</a>`)}${
    list.length > max ? html` <span class="muted">+${list.length - max}</span>` : ""
  }`;
}

// ---------- match list ----------

const MATCH_SORT_LABELS: Record<(typeof MATCH_SORT_KEYS)[number], string> = {
  date: "Date",
  match_cost: "Match cost",
  maps: "Maps played",
  avg_score: "Avg score",
  accuracy: "Avg accuracy",
  name: "Name",
};

function statsPanel(stats: MatchStats): Html {
  return html`<section class="card stats" aria-label="Match statistics">
    <div class="stat"><span class="label">Matches</span><strong>${fmt.number(stats.matches)}</strong><span class="muted small">${fmt.number(stats.played)} played</span></div>
    <div class="stat"><span class="label">Record</span><strong>${fmt.number(stats.won)}–${fmt.number(stats.lost)}</strong><span class="muted small">won–lost</span></div>
    <div class="stat"><span class="label">Avg match cost</span><strong>${cost(stats.avg_match_cost)}</strong></div>
    ${stats.best_match_cost
      ? html`<div class="stat"><span class="label">Best match cost</span><a href="/matches/${stats.best_match_cost.match_id}">${cost(stats.best_match_cost.match_cost)}</a><span class="muted small">${stats.best_match_cost.name}</span></div>`
      : ""}
    <div class="stat"><span class="label">Tournaments</span><strong>${fmt.number(stats.tournaments)}</strong></div>
    <div class="stat"><span class="label">Teammates, rivals, records</span><a href="/matches/stats">Match stats →</a></div>
  </section>`;
}

function queueStatus(queue: QueueOverview): Html {
  const parts = [
    queue.requested ? `${fmt.number(queue.requested)} waiting to be fetched` : "",
    queue.refreshing ? `${fmt.number(queue.refreshing)} in progress (refreshed every 10 minutes)` : "",
    queue.probes ? `${fmt.number(queue.probes)} discovered lobbies to check` : "",
  ].filter(Boolean);
  return html`<div data-match-queue>
    <p class="muted small">${parts.length ? parts.join(" · ") : "Nothing waiting."}</p>
    ${queue.failed_count
      ? html`<details>
          <summary class="alert">${fmt.number(queue.failed_count)} couldn't be fetched</summary>
          <ul>${queue.failed.map(
            (f) => html`<li><a href="${f.source === "stable" ? `https://osu.ppy.sh/community/matches/${f.external_id}` : `https://osu.ppy.sh/multiplayer/rooms/${f.external_id}`}" target="_blank" rel="noopener noreferrer">${f.name ?? `${f.source} #${f.external_id}`}</a>: ${f.last_error ?? "unknown error"}</li>`,
          )}</ul>
          <div class="row wrap">
            <form method="post" action="/matches/queue/retry"><button>Retry all</button></form>
            <form method="post" action="/matches/queue/clear"><button class="dangerous">Forget them</button></form>
          </div>
        </details>`
      : ""}
  </div>`;
}

function discoveryPanel(states: DiscoveryState[], enabled: boolean, osuConfigured: boolean): Html {
  const since = (d: Date | null) => (d ? fmt.dateTime(d) : "never");
  const row = (s: DiscoveryState) => {
    const lastId = typeof s.cursor.lastId === "number" ? s.cursor.lastId : null;
    const detail =
      s.source === "stable"
        ? html`${lastId ? html`Up to lobby <a href="https://osu.ppy.sh/community/matches/${lastId}" target="_blank" rel="noopener noreferrer">#${lastId}</a> · ` : "Starts at the newest lobby · "}${fmt.number(s.scanned)} lobbies scanned · ${fmt.number(s.probed)} tournament lobbies checked · ${fmt.number(s.found)} of yours found`
        : html`${fmt.number(s.scanned)} rooms scanned · ${fmt.number(s.found)} of yours found`;
    return html`<div class="discovery">
      <div class="row wrap">
        <strong class="grow">${s.source === "stable" ? "Stable tournament lobbies" : "Lazer ranked play"}</strong>
        <form method="post" action="/matches/discovery">
          <input type="hidden" name="source" value="${s.source}"><input type="hidden" name="enabled" value="${s.enabled ? "false" : "true"}">
          <button>${s.enabled ? "Pause" : "Resume"}</button>
        </form>
      </div>
      <p class="muted small">${s.enabled ? "" : "Paused. "}${detail} · last run ${since(s.last_run_at)}</p>
      ${s.last_error ? html`<p class="alert small">Last error: ${s.last_error}</p>` : ""}
      ${s.source === "stable"
        ? html`<form method="post" action="/matches/discovery/scan" class="row wrap small">
            <label>Scan from match id <input type="number" name="from" min="1" required class="num wide" placeholder="119000000"></label>
            <button>Scan from here</button>
          </form>`
        : ""}
    </div>`;
  };
  return html`<section class="card" aria-label="Discovery">
    <h2>Discovery</h2>
    ${!enabled ? html`<p class="alert">Discovery is off (<code>MATCH_DISCOVERY=false</code>). Imported and added matches are still fetched.</p>` : ""}
    ${!osuConfigured ? html`<p class="alert">Fetching matches needs <code>OSU_CLIENT_ID</code> and <code>OSU_CLIENT_SECRET</code> in <code>.env</code>.</p>` : ""}
    <p class="muted small">osu! can't list one player's matches, so kiai reads its list of every public lobby, two hours behind, and checks the ones with tournament-style names (<code>ACR: (A) vs (B)</code>, qualifier lobbies) or your name. Ranked play rooms list their players, so yours are found directly.</p>
    ${states.map(row)}
  </section>`;
}

function importPanel(queue: QueueOverview): Html {
  return html`<section class="card" aria-label="Add matches">
    <h2>Add matches</h2>
    <form method="post" action="/matches/add" class="row wrap">
      <input name="link" required placeholder="mp link, ranked play room link or match id" aria-label="Match link" class="grow">
      <button class="primary">Add</button>
    </form>
    <details ${queue.requested === 0 ? html`open` : ""}>
      <summary>Import your match history from Elitebotix</summary>
      <p class="small">In Discord, run Elitebotix's <code>/osu-history</code> with <code>onlymatchhistory: True</code>. Paste the text file it sends, or upload it. Any text with mp links works too. Elitebotix hides recent qualifier links; set discovery to scan from an older match id to find those.</p>
      <form method="post" action="/matches/import" enctype="multipart/form-data" class="stack">
        <textarea name="text" rows="5" placeholder="08-2026 - OWC 2026: (Japan) vs (Germany) ----- https://osu.ppy.sh/community/matches/119283746"></textarea>
        <div class="row wrap"><input type="file" name="file" accept=".txt,text/plain" aria-label="History file"><button class="primary">Import</button></div>
      </form>
    </details>
    ${queueStatus(queue)}
  </section>`;
}

function matchFilterForm(f: MatchFilters, names: Record<string, string>): Html {
  const players = (list: string[]) => list.map((v) => names[v] ?? v).join(", ");
  return html`<form method="get" action="/matches" class="card filters" data-filters>
    <div class="row wrap">
      <input type="search" name="q" value="${f.q}" placeholder="Search match names" aria-label="Search matches" class="grow">
      <label>Sort <select name="sort">${MATCH_SORT_KEYS.map((key) => html`<option value="${key}" ${f.sort === key ? html`selected` : ""}>${MATCH_SORT_LABELS[key]}</option>`)}</select></label>
      <label>Order <select name="order"><option value="desc">High → low</option><option value="asc" ${f.order === "asc" ? html`selected` : ""}>Low → high</option></select></label>
    </div>
    <div class="row wrap">
      <label class="grow">With <input name="with" value="${players(f.with)}" placeholder="teammates (names or ids), comma-separated" class="wide"></label>
      <label class="grow">Against <input name="vs" value="${players(f.vs)}" placeholder="opponents (names or ids), comma-separated" class="wide"></label>
    </div>
    <div class="row wrap">
      ${kindFieldset(f.hide)}
      <label>Result <select name="result"><option value="">any</option><option value="won" ${f.result === "won" ? html`selected` : ""}>won</option><option value="lost" ${f.result === "lost" ? html`selected` : ""}>lost</option></select></label>
      <label class="check"><input type="checkbox" name="played" value="true" ${checked(f.played)}> I played</label>
    </div>
    <div class="row wrap">
      <label>Match cost <input type="number" name="min_cost" value="${numberValue(f.minCost)}" placeholder="min" step="0.01" class="num"> – <input type="number" name="max_cost" value="${numberValue(f.maxCost)}" placeholder="max" step="0.01" class="num"></label>
      <label>Maps <input type="number" name="min_maps" value="${numberValue(f.minMaps)}" placeholder="min" step="1" class="num"> – <input type="number" name="max_maps" value="${numberValue(f.maxMaps)}" placeholder="max" step="1" class="num"></label>
      <label>From <input type="date" name="date_from" value="${f.dateFrom ?? ""}"></label>
      <label>To <input type="date" name="date_to" value="${f.dateTo ?? ""}"></label>
      <span class="grow"></span>
      <a href="/matches">Reset filters</a>
      <button class="primary">Apply</button>
    </div>
  </form>`;
}

function matchTable(f: MatchFilters, page: MatchPage): Html {
  const link = (p: number) => `/matches?${matchFiltersToParams(f, { page: p }).toString()}`;
  return html`<section class="card" aria-label="Matches">
    <h2>Matches <span class="muted small">${fmt.number(page.pagination.total_count)} match</span></h2>
    ${page.unknown_players.length ? html`<p class="alert">No saved match has a player called ${page.unknown_players.join(", ")}.</p>` : ""}
    ${page.matches.length === 0
      ? html`<p class="muted">No matches match these filters.</p>`
      : html`<div class="tablewrap"><table class="scores">
          <thead><tr><th>Date</th><th>Match</th><th>Result</th><th class="r">Match cost</th><th class="r">Maps</th><th class="r">Acc</th><th>With</th><th>Against</th><th></th></tr></thead>
          <tbody>${page.matches.map(
            (m) => html`<tr>
              <td class="nowrap">${fmt.date(m.start_time)}</td>
              <td class="clip match" title="${m.name}"><a href="/matches/${m.id}">${m.name || `${SOURCE_LABEL[m.source]} #${m.external_id}`}</a>${m.kind !== "tournament" && m.kind !== "other" ? html` <span class="chip">${KIND_LABEL[m.kind]}</span>` : ""}</td>
              <td class="nowrap">${resultChip(m.result)} ${scoreLine(m)}</td>
              <td class="r">${cost(m.me?.match_cost)}</td>
              <td class="r">${m.me ? html`${m.me.games_played}<span class="muted">/${m.games_count}</span>` : m.games_count}</td>
              <td class="r">${m.me ? fmt.acc(m.me.avg_accuracy) : "—"}</td>
              ${m.me?.side ? peopleCell(m.teammates, "with") : html`<td class="clip people"><span class="muted">—</span></td>`}
              ${peopleCell(m.opponents, "vs")}
              <td><a href="${m.url}" target="_blank" rel="noopener noreferrer" title="Open on osu!">↗</a></td>
            </tr>`,
          )}</tbody>
        </table></div>`}
    ${pager(page.pagination, link)}
  </section>`;
}

export interface MatchesPageData {
  player: Player;
  filters: MatchFilters;
  page: MatchPage;
  stats: MatchStats;
  queue: QueueOverview;
  discovery: DiscoveryState[];
  discoveryEnabled: boolean;
  osuConfigured: boolean;
  notice?: string | undefined;
}

export function matchesPage(d: MatchesPageData): Html {
  return layout(
    "Matches",
    html`${d.notice ? html`<p class="notice" role="status">${d.notice}</p>` : ""}
      ${statsPanel(d.stats)}
      <div class="grid2">${importPanel(d.queue)}${discoveryPanel(d.discovery, d.discoveryEnabled, d.osuConfigured)}</div>
      ${matchFilterForm(d.filters, d.page.player_names)}
      ${matchTable(d.filters, d.page)}`,
    d.player,
  );
}

// ---------- one match ----------

function sideChip(side: string | null): Html | string {
  return side === "red" || side === "blue" ? html`<span class="chip side-${side}">${side}</span>` : "";
}

function headline(m: MatchDetail): Html | string {
  if (m.red_wins === null || m.blue_wins === null) return "";
  const names = (side: "red" | "blue") => {
    const fromName = side === "red" ? m.red_name : m.blue_name;
    if (m.format === "team") return fromName ?? side;
    return m.players.filter((p) => p.side === side).map(who).join(", ") || fromName || side;
  };
  return html`<p class="scoreline"><span class="side-red">${names("red")}</span> <strong>${m.red_wins} – ${m.blue_wins}</strong> <span class="side-blue">${names("blue")}</span></p>`;
}

function playersTable(m: MatchDetail, playerId: number): Html {
  const breakdown = (p: MatchPlayerView) =>
    `performance ${p.performance_cost.toFixed(3)} × participation ${p.participation_bonus.toFixed(3)} × mods ${p.mods_bonus.toFixed(2)}${p.tiebreaker_bonus ? ` + tiebreaker ${p.tiebreaker_bonus.toFixed(3)}` : ""}`;
  return html`<section class="card" aria-label="Match costs">
    <h2>Match costs</h2>
    ${m.players.length === 0
      ? html`<p class="muted">No finished maps yet.</p>`
      : html`<div class="tablewrap"><table class="scores">
          <thead><tr><th>Player</th><th>Side</th><th class="r">Maps</th><th class="r">Avg score</th><th class="r">Avg acc</th><th class="r">Match cost</th></tr></thead>
          <tbody>${m.players.map(
            (p) => html`<tr class="${p.user_id === playerId ? "me" : ""}">
              <td><a href="${profile(p.user_id)}" target="_blank" rel="noopener noreferrer">${who(p)}</a>${p.country_code ? html` <span class="muted small">${p.country_code}</span>` : ""}
                ${p.user_id === playerId ? "" : html` <a class="small" href="/matches?${p.side && p.side === m.me?.side ? "with" : "vs"}=${p.user_id}" title="Other matches with this player">matches</a>`}</td>
              <td>${sideChip(p.side)}</td>
              <td class="r">${p.games_played}</td>
              <td class="r">${fmt.number(Math.round(p.avg_score))}</td>
              <td class="r">${fmt.acc(p.avg_accuracy)}</td>
              <td class="r" title="${breakdown(p)}"><strong>${cost(p.match_cost)}</strong></td>
            </tr>`,
          )}</tbody>
        </table></div>`}
    <p class="muted small">Bathbot's formula: each map's score over that map's average, averaged, plus 0.5; × up to 1.5 for playing every map; × 1.02 per mod combination beyond two; plus up to 0.5 for the tiebreaker${m.tiebreaker ? " (this match went to one)" : ""}. Zero scores are left out. Hover a cost for its parts.</p>
    <details>
      <summary>Warmups and settings</summary>
      <form method="post" action="/matches/${m.id}/settings" class="row wrap">
        <label>Warmups <input type="number" name="warmups" min="0" max="50" value="${m.warmups}" class="num"></label>
        <label>Skip last <input type="number" name="skip_last" min="0" max="50" value="${m.skip_last}" class="num"></label>
        <label>EZ multiplier <input type="number" name="ez_multiplier" min="0.1" max="10" step="0.01" value="${m.ez_multiplier}" class="num"></label>
        <button class="primary">Recalculate</button>
      </form>
    </details>
  </section>`;
}

function gameCard(g: MatchGameView, m: MatchDetail, playerId: number): Html {
  const b = g.beatmap;
  const status = !g.end_time
    ? html`<span class="chip">in progress or aborted</span>`
    : !g.counted
      ? html`<span class="chip">not counted</span>`
      : g.winner
        ? html`<span class="chip side-${g.winner}">${g.winner} wins</span>`
        : "";
  const totals =
    g.red_score !== null && g.blue_score !== null && m.format !== "ffa"
      ? html`<span class="muted small"><span class="side-red">${fmt.number(g.red_score)}</span> – <span class="side-blue">${fmt.number(g.blue_score)}</span></span>`
      : "";
  return html`<section class="card game" aria-label="Map ${g.position}">
    <div class="gamehead">
      ${b ? html`<img src="${b.list_url}" alt="" loading="lazy" width="80" height="60">` : ""}
      <div class="grow">
        <div><span class="muted">#${g.position}</span> ${b ? html`<a href="${b.url}" target="_blank" rel="noopener noreferrer">${beatmapTitle(b, g.beatmap_id)}</a> <span class="muted">[${b.version ?? "?"}]</span>` : beatmapTitle(null, g.beatmap_id)}</div>
        <div class="row wrap small">${b ? fmt.stars(b.difficulty_rating) : ""} ${g.mods.length ? modChips(g.mods.map((acronym) => ({ acronym }))) : ""} <span class="muted">${g.scoring_type ?? ""} ${g.team_type ?? ""}</span> ${status} ${totals}</div>
      </div>
    </div>
    ${g.scores.length
      ? html`<div class="tablewrap"><table class="scores compact">
          <thead><tr><th>Player</th><th class="r">Score</th><th class="r">Acc</th><th class="r">Combo</th><th class="r">Miss</th><th>Rank</th><th>Mods</th><th class="r">PP</th></tr></thead>
          <tbody>${g.scores.map(
            (s) => html`<tr class="${[s.user_id === playerId ? "me" : "", s.side ? `row-${s.side}` : ""].join(" ")}">
              <td>${sideChip(s.side)} ${who(s)}${s.passed ? "" : html` <span class="muted small">failed</span>`}</td>
              <td class="r">${fmt.number(s.total_score)}</td>
              <td class="r">${fmt.acc(s.accuracy)}</td>
              <td class="r">${fmt.number(s.max_combo)}${b?.max_combo ? html`<span class="muted">/${fmt.number(b.max_combo)}</span>` : ""}</td>
              <td class="r">${fmt.number(s.countmiss)}</td>
              <td><span class="${rankClass(s.rank)}">${rankLabel(s.rank)}</span></td>
              <td>${modChips(s.mods)}</td>
              <td class="r" title="${s.pp_source === "local" ? "Local estimate (rosu-pp, without NoFail)" : s.pp_source}">${fmt.pp(s.pp)}</td>
            </tr>`,
          )}</tbody>
        </table></div>`
      : html`<p class="muted small">No scores.</p>`}
  </section>`;
}

export function matchPage(m: MatchDetail, player: Player, notice?: string): Html {
  const duration = m.start_time && m.end_time ? Math.round((Date.parse(m.end_time) - Date.parse(m.start_time)) / 60_000) : null;
  return layout(
    m.name || "Match",
    html`${notice ? html`<p class="notice" role="status">${notice}</p>` : ""}
    <p><a href="/matches">← All matches</a></p>
    <section class="card">
      <div class="row wrap">
        <h1 class="grow">${m.name || `${SOURCE_LABEL[m.source]} #${m.external_id}`}</h1>
        ${resultChip(m.result)}
      </div>
      ${headline(m)}
      <p class="muted">
        ${m.kind === "ranked" ? "Lazer ranked play" : m.kind === "tournament" ? `Tournament ${m.acronym}` : m.kind === "other" ? `Stable multiplayer${m.not_tournament ? " (not a tournament)" : ""}` : `${KIND_LABEL[m.kind]} matchmaking`} ·
        ${fmt.dateTime(m.start_time)}${duration !== null ? ` · ${duration} min` : ""}${m.end_time ? "" : " · in progress"} ·
        ${m.games_count} maps · <a href="${m.url}" target="_blank" rel="noopener noreferrer">View on osu! ↗</a>
      </p>
      <form method="post" action="/matches/${m.id}/refresh" class="row wrap small">
        <span class="muted">Fetched ${fmt.dateTime(m.fetched_at)} (${m.added_via})</span>
        <button>Fetch again</button>
      </form>
      ${m.kind === "tournament" || (m.kind === "other" && m.not_tournament)
        ? html`<form method="post" action="/matches/${m.id}/tournament" class="row wrap small">
            <input type="hidden" name="not_tournament" value="${m.not_tournament ? "false" : "true"}">
            ${m.not_tournament
              ? html`<span class="muted">Left out of tournaments and the tournament count.</span><button>Count as a tournament</button>`
              : html`<span class="muted">A casual lobby with a tournament-style name?</span><button>Not a tournament</button>`}
          </form>`
        : ""}
    </section>
    ${playersTable(m, player.id)}
    ${m.games.map((g) => gameCard(g, m, player.id))}`,
    player,
  );
}

// ---------- tournament scores ----------

export function tournamentScoresPage(player: Player, f: TournamentScoreFilters, page: TournamentScorePage): Html {
  const link = (p: number) => `/matches/scores?${tournamentFiltersToParams(f, { page: p }).toString()}`;
  const extra = html`<div class="row wrap">
    <label>Player <input name="player" value="${f.player === "me" ? "" : (page.player_name ?? f.player)}" placeholder="you (or a name, id, or all)" class="wide"></label>
    <label class="grow">Match <input name="match" value="${f.match}" placeholder="match name words, e.g. OWC 2026" class="wide"></label>
    ${kindFieldset(f.hide)}
  </div>`;
  const showPlayer = f.player !== "me";
  return layout(
    "Tournament scores",
    html`${filterForm(f, { action: "/matches/scores", extra })}
    <section class="card" aria-label="Tournament scores">
      <h2>Tournament scores <span class="muted small">${fmt.number(page.pagination.total_count)} match</span></h2>
      ${page.unknown_player ? html`<p class="alert">No saved match has a player called ${page.unknown_player}.</p>` : ""}
      <p class="muted small">Every score from saved matches. NoFail is ignored in mod filters (NM means no other mods). PP is osu!'s for ranked play, otherwise calculated locally without NoFail.</p>
      ${page.scores.length === 0
        ? html`<p class="muted">No scores match these filters.</p>`
        : html`<div class="tablewrap"><table class="scores">
            <thead><tr><th>Rank</th><th>Beatmap</th><th>Mods</th><th class="r">PP</th><th class="r">Acc</th><th class="r">Score</th><th class="r">Combo</th><th class="r">Miss</th><th class="r">Stars</th>${showPlayer ? html`<th>Player</th>` : ""}<th>Match</th><th>Date</th></tr></thead>
            <tbody>${page.scores.map(
              (s) => html`<tr>
                <td><span class="${rankClass(s.rank)}">${rankLabel(s.rank)}</span></td>
                ${s.beatmap ? mapCell(s.beatmap, s.beatmap.url, true) : html`<td class="clip map">${beatmapTitle(null, s.beatmap_id)}</td>`}
                <td>${modChips(s.mods)}</td>
                <td class="r" title="${s.pp_source === "local" ? "Local estimate (rosu-pp, without NoFail)" : s.pp_source}">${fmt.pp(s.pp)}</td>
                <td class="r">${fmt.acc(s.accuracy)}</td>
                <td class="r">${fmt.number(s.total_score)}</td>
                <td class="r">${fmt.number(s.max_combo)}${s.beatmap?.max_combo ? html`<span class="muted">/${fmt.number(s.beatmap.max_combo)}</span>` : ""}</td>
                <td class="r">${fmt.number(s.countmiss)}</td>
                <td class="r">${fmt.stars(s.beatmap?.difficulty_rating ?? null)}</td>
                ${showPlayer ? html`<td>${s.username ?? `#${s.user_id}`}</td>` : ""}
                <td class="clip match" title="${s.match_name ? `${s.match_name} · map ${s.game_position}` : ""}"><span class="muted small">#${s.game_position}</span> <a href="/matches/${s.match_id}">${s.match_name || "match"}</a></td>
                <td class="nowrap">${fmt.date(s.ended_at)}</td>
              </tr>`,
            )}</tbody>
          </table></div>`}
      ${pager(page.pagination, link)}
    </section>`,
    player,
  );
}
