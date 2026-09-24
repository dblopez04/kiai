// The match stats page: teammates, opponents, countries, events, mod pool, maps, streaks,
// records and activity. Players link to the match list by id, so links survive name changes.

import { html } from "hono/html";
import {
  insightFiltersToParams,
  rankPeople,
  type InsightFilters,
  type MapRecord,
  type MatchInsights,
  type MatchRecord,
  type MonthStats,
  type PersonStats,
  type Streak,
} from "../matches/insights.ts";
import { MATCH_KINDS } from "../matches/normalize.ts";
import { DEFAULT_MATCH_FILTERS, matchFiltersToParams, type MatchFilters } from "../matches/query.ts";
import type { Player } from "../player.ts";
import { KIND_LABEL, kindFieldset } from "./match-views.ts";
import { fmt, layout } from "./views.ts";

type Html = ReturnType<typeof html>;

const TOP = 10;
const cost = (value: number | null | undefined) => (typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "—");
const winRate = (won: number, lost: number) => (won + lost ? `${Math.round((100 * won) / (won + lost))}%` : "—");
const record = (won: number, lost: number) => `${fmt.number(won)}–${fmt.number(lost)}`;
const who = (p: { username: string | null; id: number }) => p.username ?? `#${p.id}`;
const month = (key: string) => new Date(`${key}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
const mods = (list: readonly string[]) => (list.length ? list.join("") : "NM");

/** The match list with the same Type, name and date filters, narrowed by `extra`. */
function matchesLink(f: InsightFilters, extra: Partial<MatchFilters> = {}): string {
  const base: MatchFilters = { ...DEFAULT_MATCH_FILTERS, hide: f.hide, q: f.q, dateFrom: f.dateFrom, dateTo: f.dateTo, played: true };
  return `/matches?${matchFiltersToParams(base, extra).toString()}`;
}

function personLink(p: PersonStats, relation: "with" | "vs", f: InsightFilters): Html {
  return html`<a href="${matchesLink(f, { [relation]: [String(p.id)] })}" title="Your matches ${relation === "with" ? "with" : "against"} ${who(p)}">${who(p)}</a>${
    p.country_code ? html` <span class="muted small">${p.country_code}</span>` : ""
  }`;
}

// ---------- filters and summary ----------

function filterForm(f: InsightFilters): Html {
  return html`<form method="get" action="/matches/stats" class="card filters" data-filters>
    <div class="row wrap">
      <input type="search" name="q" value="${f.q}" placeholder="Only matches named… (e.g. OWC 2026)" aria-label="Match name" class="grow">
      <label>From <input type="date" name="date_from" value="${f.dateFrom ?? ""}"></label>
      <label>To <input type="date" name="date_to" value="${f.dateTo ?? ""}"></label>
    </div>
    <div class="row wrap">
      ${kindFieldset(f.hide)}
      <label title="Teammates and opponents met fewer times are left out of the best and worst lists">Often = at least <input type="number" name="min" min="1" max="100" value="${f.min}" class="num"> matches</label>
      <span class="grow"></span>
      <a href="/matches/stats">Reset filters</a>
      <button class="primary">Apply</button>
    </div>
  </form>`;
}

function summaryPanel(d: MatchInsights, f: InsightFilters): Html {
  const s = d.summary;
  const stat = (label: string, value: Html | string, note: Html | string = "") =>
    html`<div class="stat"><span class="label">${label}</span><strong>${value}</strong>${note ? html`<span class="muted small">${note}</span>` : ""}</div>`;
  const current = d.streaks.current;
  return html`<section class="card stats" aria-label="Summary">
    ${stat("Matches", fmt.number(s.matches), s.first_match ? `since ${fmt.date(s.first_match)}` : "")}
    ${stat("Record", record(s.won, s.lost), `${winRate(s.won, s.lost)} won${s.draws ? ` · ${s.draws} drawn` : ""}`)}
    ${stat("Avg match cost", cost(s.avg_match_cost))}
    ${stat("MVP", fmt.number(s.mvp), s.mvp_of ? `top match cost in ${winRate(s.mvp, s.mvp_of - s.mvp)} of matches` : "")}
    ${stat("Tiebreakers", record(s.tiebreakers_won, s.tiebreakers_lost), s.tiebreakers_won + s.tiebreakers_lost ? `${winRate(s.tiebreakers_won, s.tiebreakers_lost)} clutch` : "none yet")}
    ${stat("Maps", record(s.maps_won, s.maps_lost), `${fmt.number(s.maps)} played · ${s.avg_accuracy === null ? "—" : fmt.acc(s.avg_accuracy)} avg`)}
    ${stat("Perfect maps", fmt.number(s.perfect_maps), "100% accuracy")}
    ${stat("Streak", current ? `${current.length}${current.kind === "won" ? "W" : "L"}` : "—", streakNote(d.streaks.longest_win, "best"))}
    ${stat("Tournaments", fmt.number(s.tournaments))}
    ${stat("Teammates", fmt.number(s.teammates))}
    ${stat("Opponents", fmt.number(s.opponents), s.countries ? html`from ${fmt.number(s.countries)} countries` : "")}
    <div class="stat"><span class="label">Browse</span><a href="${matchesLink(f)}">Matches →</a></div>
  </section>`;
}

function streakNote(streak: Streak | null, label: string): string {
  return streak ? `${label}: ${streak.length} ${streak.kind === "won" ? "wins" : "losses"} in a row` : "";
}

// ---------- records ----------

function matchRecordTile(label: string, r: MatchRecord | null, value: (r: MatchRecord) => string, note: (r: MatchRecord) => string): Html | string {
  if (!r) return "";
  return html`<div class="record">
    <span class="label">${label}</span>
    <strong>${value(r)}</strong>
    <a class="clip" href="/matches/${r.match_id}" title="${r.name}">${r.name || "match"}</a>
    <span class="muted small">${note(r)} · ${fmt.date(r.played_at)}</span>
  </div>`;
}

function mapRecordTile(label: string, r: MapRecord | null, value: (r: MapRecord) => string, note: (r: MapRecord) => string): Html | string {
  if (!r) return "";
  const title = r.beatmap ? `${r.beatmap.title ?? "Unknown title"} [${r.beatmap.version ?? "?"}]` : r.beatmap_id ? `Beatmap #${r.beatmap_id}` : "Unknown beatmap";
  return html`<div class="record">
    <span class="label">${label}</span>
    <strong>${value(r)}</strong>
    <a class="clip" href="/matches/${r.match_id}" title="${title} · ${r.name} · map ${r.position}">${title}</a>
    <span class="muted small">${note(r)} · map ${r.position} of ${r.name || "match"}</span>
  </div>`;
}

function streakTile(label: string, s: Streak | null): Html | string {
  if (!s) return "";
  return html`<div class="record">
    <span class="label">${label}</span>
    <strong>${s.length} ${s.kind === "won" ? (s.length === 1 ? "win" : "wins") : s.length === 1 ? "loss" : "losses"}</strong>
    <span class="muted small">${fmt.date(s.from)} – ${fmt.date(s.to)}</span>
  </div>`;
}

function recordsPanel(d: MatchInsights): Html {
  const r = d.records;
  const line = (m: MatchRecord) => (m.us === null || m.them === null ? `match cost ${cost(m.match_cost)}` : `${m.us}–${m.them} · match cost ${cost(m.match_cost)}`);
  const minutes = (n: number) => (n >= 90 ? `${Math.floor(n / 60)}h ${Math.round(n % 60)}m` : `${Math.round(n)} min`);
  const tiles = [
    matchRecordTile("Peak match cost", r.best_cost, (m) => cost(m.match_cost), line),
    matchRecordTile("Rock bottom", r.worst_cost, (m) => cost(m.match_cost), line),
    matchRecordTile("Did everything you could", r.best_in_loss, (m) => cost(m.match_cost), (m) => `best match cost in a loss · ${m.us}–${m.them}`),
    matchRecordTile("Got carried", r.worst_in_win, (m) => cost(m.match_cost), (m) => `lowest match cost in a win · ${m.us}–${m.them}`),
    matchRecordTile("Biggest stomp", r.biggest_win, (m) => `${m.us}–${m.them}`, (m) => `match cost ${cost(m.match_cost)}`),
    matchRecordTile("Greatest comeback", r.comeback, (m) => `${m.value} map${m.value === 1 ? "" : "s"} down`, (m) => `won ${m.us}–${m.them} anyway`),
    matchRecordTile("Biggest choke", r.choke, (m) => `${m.value} map${m.value === 1 ? "" : "s"} up`, (m) => `lost ${m.us}–${m.them}`),
    matchRecordTile("Longest match", r.longest, (m) => `${m.value} maps`, line),
    matchRecordTile("Marathon", r.marathon, (m) => minutes(m.value), line),
    mapRecordTile("Biggest pop-off", r.pop_off, (m) => `${(m.lobby_ratio ?? 0).toFixed(2)}× lobby avg`, (m) => `${fmt.number(m.total_score)} ${mods(m.mods)}`),
    mapRecordTile("Closest shave", r.closest_win, (m) => `won by ${fmt.number(m.margin)}`, (m) => `${fmt.acc(m.accuracy)} ${mods(m.mods)}`),
    mapRecordTile("Heartbreaker", r.closest_loss, (m) => `lost by ${fmt.number(m.margin)}`, (m) => `${fmt.acc(m.accuracy)} ${mods(m.mods)}`),
    mapRecordTile("Cleanest map", r.best_accuracy, (m) => fmt.acc(m.accuracy), (m) => `${fmt.number(m.total_score)} ${mods(m.mods)}`),
    streakTile("Longest win streak", d.streaks.longest_win),
    streakTile("Longest losing streak", d.streaks.longest_loss),
  ].filter((t) => t !== "");
  return html`<section class="card" aria-label="Records">
    <h2>Records</h2>
    ${tiles.length ? html`<div class="records">${tiles}</div>` : html`<p class="muted">No matches with results yet.</p>`}
    <p class="muted small">Match cost records count matches where you played at least 3 maps. Comebacks and chokes are the most maps you were behind or ahead at any point.</p>
  </section>`;
}

// ---------- teammates and opponents ----------

function personTable(list: PersonStats[], relation: "with" | "vs", f: InsightFilters): Html {
  const row = (p: PersonStats) => html`<tr>
    <td class="clip people">${personLink(p, relation, f)}</td>
    <td class="r">${fmt.number(p.matches)}</td>
    <td class="r nowrap">${record(p.won, p.lost)}</td>
    <td class="r">${winRate(p.won, p.lost)}</td>
    <td class="r"><strong>${cost(p.my_cost)}</strong></td>
    <td class="r">${cost(p.their_cost)}</td>
    <td class="r" title="Matches where your match cost beat theirs">${p.outcosted}/${p.matches}</td>
    <td class="r">${fmt.number(p.events)}</td>
    <td class="nowrap">${fmt.date(p.last_played)}</td>
    <td><a href="https://osu.ppy.sh/users/${p.id}" target="_blank" rel="noopener noreferrer" title="osu! profile">↗</a></td>
  </tr>`;
  const head = html`<thead><tr><th>Player</th><th class="r">Matches</th><th class="r">Record</th><th class="r">Win%</th><th class="r">Your MC</th><th class="r">Their MC</th><th class="r">Outcosted</th><th class="r">Events</th><th>Last</th><th></th></tr></thead>`;
  return html`<div class="tablewrap"><table class="scores compact">${head}<tbody>${list.slice(0, TOP).map(row)}</tbody></table></div>
    ${list.length > TOP
      ? html`<details><summary>All ${fmt.number(list.length)}</summary>
          <div class="tablewrap"><table class="scores compact">${head}<tbody>${list.slice(TOP).map(row)}</tbody></table></div>
        </details>`
      : ""}`;
}

function rankList(
  title: string,
  blurb: string,
  people: PersonStats[],
  relation: "with" | "vs",
  f: InsightFilters,
  value: (p: PersonStats) => string,
  empty = "Nobody yet.",
): Html {
  return html`<div class="ranklist">
    <h3>${title}</h3>
    <p class="muted small">${blurb}</p>
    ${people.length
      ? html`<ol>${people.map((p) => html`<li><span class="grow clip">${personLink(p, relation, f)}</span> <strong>${value(p)}</strong> <span class="muted small">${p.matches}×</span></li>`)}</ol>`
      : html`<p class="muted small">${empty}</p>`}
  </div>`;
}

function teammatesPanel(d: MatchInsights, f: InsightFilters): Html {
  const list = d.teammates;
  const rate = (p: PersonStats) => (p.won + p.lost ? p.won / (p.won + p.lost) : 0);
  const often = `met at least ${f.min} time${f.min === 1 ? "" : "s"}`;
  return html`<section class="card" aria-label="Teammates">
    <h2>Teammates <span class="muted small">${fmt.number(list.length)} people</span></h2>
    ${list.length === 0
      ? html`<p class="muted">No team matches yet.</p>`
      : html`<div class="ranklists">
          ${rankList("You shine with", `Your highest average match cost, ${often}.`, rankPeople(list, f.min, (p) => p.my_cost, "desc"), "with", f, (p) => cost(p.my_cost))}
          ${rankList("You struggle with", `Your lowest average match cost, ${often}.`, rankPeople(list, f.min, (p) => p.my_cost, "asc"), "with", f, (p) => cost(p.my_cost))}
          ${rankList("Winningest duo", `Best win rate together, ${often}.`, rankPeople(list, f.min, rate, "desc"), "with", f, (p) => winRate(p.won, p.lost))}
          ${rankList("Your carry", `Out-costs you on average, ${often}.`, rankPeople(list, f.min, (p) => p.their_cost - p.my_cost, "desc").filter((p) => p.their_cost > p.my_cost), "with", f, (p) => `+${cost(p.their_cost - p.my_cost)}`, "Nobody out-costs you.")}
        </div>
        <h3>Most played with</h3>
        ${personTable(list, "with", f)}`}
  </section>`;
}

function opponentsPanel(d: MatchInsights, f: InsightFilters): Html {
  const list = d.opponents;
  const rate = (p: PersonStats) => (p.won + p.lost ? p.won / (p.won + p.lost) : 0);
  const often = `met at least ${f.min} time${f.min === 1 ? "" : "s"}`;
  return html`<section class="card" aria-label="Opponents">
    <h2>Opponents <span class="muted small">${fmt.number(list.length)} people</span></h2>
    ${list.length === 0
      ? html`<p class="muted">No head-to-head matches yet.</p>`
      : html`<div class="ranklists">
          ${rankList("You pop off against", `Your highest average match cost, ${often}.`, rankPeople(list, f.min, (p) => p.my_cost, "desc"), "vs", f, (p) => cost(p.my_cost))}
          ${rankList("They have your number", `Your lowest average match cost, ${often}.`, rankPeople(list, f.min, (p) => p.my_cost, "asc"), "vs", f, (p) => cost(p.my_cost))}
          ${rankList("Favorite victims", `Best win rate against, ${often}.`, rankPeople(list, f.min, rate, "desc"), "vs", f, (p) => record(p.won, p.lost))}
          ${rankList("Nemeses", `Worst win rate against, ${often}.`, rankPeople(list, f.min, rate, "asc"), "vs", f, (p) => record(p.won, p.lost))}
        </div>
        <h3>Most played against</h3>
        ${personTable(list, "vs", f)}`}
  </section>`;
}

function countriesPanel(d: MatchInsights): Html | string {
  if (d.countries.length === 0) return "";
  return html`<section class="card" aria-label="Countries faced">
    <h2>Countries faced <span class="muted small">${fmt.number(d.countries.length)}</span></h2>
    <div class="tablewrap"><table class="scores compact">
      <thead><tr><th>Country</th><th class="r">Matches</th><th class="r">Record</th><th class="r">Win%</th><th class="r">Players</th></tr></thead>
      <tbody>${d.countries.slice(0, 15).map(
        (c) => html`<tr><td>${c.country_code}</td><td class="r">${fmt.number(c.matches)}</td><td class="r nowrap">${record(c.won, c.lost)}</td><td class="r">${winRate(c.won, c.lost)}</td><td class="r">${fmt.number(c.players)}</td></tr>`,
      )}</tbody>
    </table></div>
    ${d.countries.length > 15 ? html`<p class="muted small">…and ${d.countries.length - 15} more.</p>` : ""}
  </section>`;
}

// ---------- events, mods, maps ----------

function eventsPanel(d: MatchInsights, f: InsightFilters): Html | string {
  if (d.events.length === 0) return "";
  return html`<section class="card" aria-label="Events">
    <h2>Tournaments and matchmaking <span class="muted small">${fmt.number(d.events.length)}</span></h2>
    <div class="tablewrap"><table class="scores compact">
      <thead><tr><th>Event</th><th class="r">Matches</th><th class="r">Record</th><th class="r">Avg MC</th><th class="r">Best MC</th><th>Played</th></tr></thead>
      <tbody>${d.events.map((e) => {
        // A tournament's qualifiers count with its matches, under its acronym.
        const tournament = e.kind === "tournament" || e.kind === "qualifiers";
        const label = tournament ? e.label : KIND_LABEL[e.kind];
        const link = tournament ? matchesLink(f, { q: e.label }) : matchesLink(f, { hide: MATCH_KINDS.filter((k) => k !== e.kind) });
        return html`<tr>
          <td class="clip match"><a href="${link}">${label}</a>${tournament ? "" : html` <span class="chip">matchmaking</span>`}</td>
          <td class="r">${fmt.number(e.matches)}</td>
          <td class="r nowrap">${record(e.won, e.lost)}</td>
          <td class="r">${cost(e.avg_cost)}</td>
          <td class="r">${e.best_match_id ? html`<a href="/matches/${e.best_match_id}">${cost(e.best_cost)}</a>` : "—"}</td>
          <td class="nowrap">${fmt.date(e.first_played)}${e.first_played?.slice(0, 10) === e.last_played?.slice(0, 10) ? "" : ` – ${fmt.date(e.last_played)}`}</td>
        </tr>`;
      })}</tbody>
    </table></div>
  </section>`;
}

function modsPanel(d: MatchInsights): Html | string {
  if (d.mods.length === 0) return "";
  return html`<section class="card" aria-label="Mod pool">
    <h2>Mod pool report card</h2>
    <div class="tablewrap"><table class="scores compact">
      <thead><tr><th>Mods</th><th class="r">Maps</th><th class="r">Maps won</th><th class="r">Win%</th><th class="r">Avg acc</th><th class="r" title="Your score over the lobby's average score on the map">vs lobby</th></tr></thead>
      <tbody>${d.mods.map(
        (m) => html`<tr><td><span class="mod">${mods(m.mods)}</span></td><td class="r">${fmt.number(m.maps)}</td><td class="r nowrap">${record(m.won, m.lost)}</td><td class="r">${winRate(m.won, m.lost)}</td><td class="r">${fmt.acc(m.avg_accuracy)}</td><td class="r">${m.avg_ratio === null ? "—" : `${m.avg_ratio.toFixed(2)}×`}</td></tr>`,
      )}</tbody>
    </table></div>
    <p class="muted small">Mods you played each map with (NoFail left out). "vs lobby" is your score over everyone's average on that map: above 1.00 you beat the lobby.</p>
  </section>`;
}

function mapsPanel(d: MatchInsights): Html | string {
  if (d.maps.length === 0) return "";
  return html`<section class="card" aria-label="Most played maps">
    <h2>Most played maps</h2>
    <div class="tablewrap"><table class="scores compact">
      <thead><tr><th>Beatmap</th><th class="r">Plays</th><th class="r">Record</th><th class="r">Avg acc</th><th class="r">Best score</th><th class="r">vs lobby</th></tr></thead>
      <tbody>${d.maps.map((m) => {
        const b = m.beatmap;
        const title = b ? `${b.artist ?? "Unknown artist"} - ${b.title ?? "Unknown title"} [${b.version ?? "?"}]` : `Beatmap #${m.beatmap_id}`;
        return html`<tr>
          <td class="clip map" title="${title}">${b ? html`<a href="${b.url}" target="_blank" rel="noopener noreferrer">${b.title ?? "Unknown title"}</a> <span class="muted">[${b.version ?? "?"}]</span> <span class="muted small">${b.artist ?? ""}</span>` : title}</td>
          <td class="r">${fmt.number(m.plays)}</td>
          <td class="r nowrap">${record(m.won, m.lost)}</td>
          <td class="r">${fmt.acc(m.avg_accuracy)}</td>
          <td class="r">${fmt.number(m.best_score)}</td>
          <td class="r">${m.avg_ratio === null ? "—" : `${m.avg_ratio.toFixed(2)}×`}</td>
        </tr>`;
      })}</tbody>
    </table></div>
  </section>`;
}

// ---------- activity ----------

/** Every month from the first to the last, with empty months filled in. */
export function fillMonths(months: readonly MonthStats[]): MonthStats[] {
  if (months.length === 0) return [];
  const byKey = new Map(months.map((m) => [m.month, m]));
  const [firstYear, firstMonth] = months[0]!.month.split("-").map(Number) as [number, number];
  const out: MonthStats[] = [];
  for (let i = 0; ; i++) {
    const date = new Date(Date.UTC(firstYear, firstMonth - 1 + i, 1));
    const key = date.toISOString().slice(0, 7);
    out.push(byKey.get(key) ?? { month: key, matches: 0, won: 0, lost: 0, avg_cost: null });
    if (key >= months.at(-1)!.month) return out;
  }
}

function activityPanel(d: MatchInsights): Html | string {
  const months = fillMonths(d.months);
  if (months.length === 0) return "";
  const max = Math.max(...months.map((m) => m.matches));
  // One column per month in viewBox units; bars leave a 2-unit gap and the SVG stretches to fit.
  const col = 20;
  const height = 100;
  const tip = (m: MonthStats) => `${month(m.month)}: ${m.matches} match${m.matches === 1 ? "" : "es"}, ${record(m.won, m.lost)}, avg match cost ${cost(m.avg_cost)}`;
  const busiest = months.reduce((a, b) => (b.matches > a.matches ? b : a));
  return html`<section class="card" aria-label="Activity">
    <h2>Activity <span class="muted small">busiest: ${month(busiest.month)}, ${busiest.matches} matches</span></h2>
    <svg class="bars" viewBox="0 0 ${months.length * col} ${height}" preserveAspectRatio="none" role="img" aria-label="Matches per month">
      <line class="baseline" x1="0" x2="${months.length * col}" y1="${height}" y2="${height}"></line>
      ${months.map((m, i) => {
        const h = max ? (m.matches / max) * (height - 4) : 0;
        return html`<g><title>${tip(m)}</title>
          <rect class="hit" x="${i * col}" y="0" width="${col}" height="${height}"></rect>
          ${h > 0 ? html`<rect class="bar" x="${i * col + 1}" y="${height - h}" width="${col - 2}" height="${h}" rx="2"></rect>` : ""}
        </g>`;
      })}
    </svg>
    <div class="row small muted"><span class="grow">${month(months[0]!.month)}</span><span>${month(months.at(-1)!.month)}</span></div>
    <details>
      <summary>As a table</summary>
      <div class="tablewrap"><table class="scores compact">
        <thead><tr><th>Month</th><th class="r">Matches</th><th class="r">Record</th><th class="r">Avg MC</th></tr></thead>
        <tbody>${months.filter((m) => m.matches > 0).toReversed().map(
          (m) => html`<tr><td>${month(m.month)}</td><td class="r">${m.matches}</td><td class="r nowrap">${record(m.won, m.lost)}</td><td class="r">${cost(m.avg_cost)}</td></tr>`,
        )}</tbody>
      </table></div>
    </details>
  </section>`;
}

export function matchStatsPage(player: Player, f: InsightFilters, d: MatchInsights): Html {
  const query = insightFiltersToParams(f).toString();
  return layout(
    "Match stats",
    html`<p><a href="/matches">← Matches</a> · <a href="/api/matches/insights${query ? `?${query}` : ""}">JSON</a></p>
    ${filterForm(f)}
    ${d.summary.matches === 0
      ? html`<section class="card"><p class="muted">No matches you played match these filters. Add some from the <a href="/matches">Matches</a> page.</p></section>`
      : html`${summaryPanel(d, f)}
        ${recordsPanel(d)}
        ${teammatesPanel(d, f)}
        ${opponentsPanel(d, f)}
        <div class="grid2">${countriesPanel(d)}${modsPanel(d)}</div>
        ${eventsPanel(d, f)}
        ${mapsPanel(d)}
        ${activityPanel(d)}`}`,
    player,
  );
}
