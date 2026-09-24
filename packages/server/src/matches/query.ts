// Searching matches and tournament scores. Match filters are relative to the player (OSU_USER):
// teammates are players on the player's side, opponents everyone else in the match.

import type { PendingQuery, Row } from "postgres";
import type { Sql } from "../db/index.ts";
import type { OsuClient } from "../osu/api.ts";
import { savePastNames } from "../player.ts";
import { normalizeMods, type ScoreMod } from "../scores/mods.ts";
import {
  filtersToParams,
  parseScoreFilters,
  scoreConditions,
  searchWords,
  toBeatmapView,
  type BeatmapView,
  type ScoreFilters,
} from "../scores/query.ts";
import { ezAdjusted, type Side } from "./cost.ts";
import {
  MATCH_KINDS,
  QUALIFIERS_PATTERN,
  MATCHMAKING_BOTS,
  matchKind,
  matchmakingPattern,
  matchUrl,
  type MatchKind,
  type MatchmakingBot,
  type MatchSource,
} from "./normalize.ts";
import { analyzeSavedMatch } from "./store.ts";

export const MATCH_SORT_KEYS = ["date", "match_cost", "maps", "avg_score", "accuracy", "name"] as const;
export type MatchSortKey = (typeof MATCH_SORT_KEYS)[number];
export const MATCH_SOURCES = ["stable", "lazer"] as const;

const PAGE_SIZE_DEFAULT = 50;
const PAGE_SIZE_MAX = 200;

export interface MatchFilters {
  /** Every word must appear in the match name. */
  q: string;
  sort: MatchSortKey;
  order: "asc" | "desc";
  page: number;
  pageSize: number;
  /** Kinds left out. */
  hide: (typeof MATCH_KINDS)[number][];
  /** User ids (or names, until resolved) that played on the player's side. */
  with: string[];
  /** User ids (or names, until resolved) that played against the player. */
  vs: string[];
  result: "won" | "lost" | null;
  /** Only matches the player has scores in. */
  played: boolean;
  minCost: number | null;
  maxCost: number | null;
  minMaps: number | null;
  maxMaps: number | null;
  dateFrom: string | null;
  dateTo: string | null;
}

export const DEFAULT_MATCH_FILTERS: MatchFilters = {
  q: "",
  sort: "date",
  order: "desc",
  page: 1,
  pageSize: PAGE_SIZE_DEFAULT,
  hide: [],
  with: [],
  vs: [],
  result: null,
  played: false,
  minCost: null,
  maxCost: null,
  minMaps: null,
  maxMaps: null,
  dateFrom: null,
  dateTo: null,
};

const list = (value: string | null) => (value ?? "").split(",").map((part) => part.trim()).filter(Boolean);
const number = (value: string | null) => {
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const positiveInt = (value: string | null, fallback: number) => {
  const parsed = number(value);
  return parsed !== null && parsed >= 1 ? Math.floor(parsed) : fallback;
};
const date = (value: string | null) => (value && !Number.isNaN(Date.parse(value)) ? value : null);
// `hide=romai,etx`, or the Type checkboxes: `show=<kind>` for each one ticked, plus a `show=-` marker so that
// unticking every box still counts. Everything not shown is hidden.
export const hiddenKinds = (params: URLSearchParams) => {
  if (params.has("show")) {
    const shown = new Set(params.getAll("show"));
    return MATCH_KINDS.filter((kind) => !shown.has(kind));
  }
  const hide = new Set(list(params.getAll("hide").join(",")));
  return MATCH_KINDS.filter((kind) => hide.has(kind));
};

export function parseMatchFilters(params: URLSearchParams): MatchFilters {
  const sort = params.get("sort");
  const result = params.get("result");
  return {
    q: (params.get("q") ?? "").trim(),
    sort: (MATCH_SORT_KEYS as readonly string[]).includes(sort ?? "") ? (sort as MatchSortKey) : "date",
    order: params.get("order") === "asc" ? "asc" : "desc",
    page: positiveInt(params.get("page"), 1),
    pageSize: Math.min(positiveInt(params.get("page_size"), PAGE_SIZE_DEFAULT), PAGE_SIZE_MAX),
    hide: hiddenKinds(params),
    with: [...new Set(list(params.get("with")))],
    vs: [...new Set(list(params.get("vs")))],
    result: result === "won" || result === "lost" ? result : null,
    played: params.get("played") === "true",
    minCost: number(params.get("min_cost")),
    maxCost: number(params.get("max_cost")),
    minMaps: number(params.get("min_maps")),
    maxMaps: number(params.get("max_maps")),
    dateFrom: date(params.get("date_from")),
    dateTo: date(params.get("date_to")),
  };
}

export function matchFiltersToParams(filters: MatchFilters, overrides: Partial<MatchFilters> = {}): URLSearchParams {
  const f = { ...filters, ...overrides };
  const params = new URLSearchParams();
  const set = (key: string, value: string | number | boolean | null, fallback?: string | number | boolean | null) => {
    if (value !== null && value !== "" && value !== false && value !== fallback) params.set(key, String(value));
  };
  set("q", f.q);
  set("sort", f.sort, DEFAULT_MATCH_FILTERS.sort);
  set("order", f.order, DEFAULT_MATCH_FILTERS.order);
  set("page", f.page, 1);
  set("page_size", f.pageSize, PAGE_SIZE_DEFAULT);
  if (f.hide.length) params.set("hide", f.hide.join(","));
  if (f.with.length) params.set("with", f.with.join(","));
  if (f.vs.length) params.set("vs", f.vs.join(","));
  set("result", f.result);
  set("played", f.played);
  set("min_cost", f.minCost);
  set("max_cost", f.maxCost);
  set("min_maps", f.minMaps);
  set("max_maps", f.maxMaps);
  set("date_from", f.dateFrom);
  set("date_to", f.dateTo);
  return params;
}

export interface ResolvedUsers {
  /** Input (id or name) to user id. */
  ids: Map<string, number>;
  /** User id to their latest known name. */
  usernames: Map<number, string>;
  /** Inputs no saved player has. */
  unknown: string[];
}

/**
 * Ids, current names (any case) or past names to user ids, so searches survive name changes.
 * An id wins over a name, a current name over a past one. Names still unknown are looked up on
 * osu! when a client is given (osu! follows renames); only players already in saved matches count.
 */
export async function resolveUsers(
  sql: Sql,
  inputs: readonly string[],
  osu: Pick<OsuClient, "getUser"> | null = null,
): Promise<ResolvedUsers> {
  const ids = new Map<string, number>();
  const usernames = new Map<number, string>();
  const wanted = [...new Set(inputs)];
  if (wanted.length === 0) return { ids, usernames, unknown: [] };
  const rows = await sql<{ input: string; id: number; username: string }[]>`
    select distinct on (input) input, u.id, u.username
    from unnest(${wanted}::text[]) as input
    join osu_user_names n on lower(n.username) = lower(input) or n.user_id::text = input
    join osu_users u on u.id = n.user_id
    order by input, (u.id::text = input) desc, (lower(u.username) = lower(input)) desc, n.last_seen desc`;
  for (const row of rows) {
    ids.set(row.input, Number(row.id));
    usernames.set(Number(row.id), row.username);
  }
  if (osu) {
    for (const name of wanted.filter((n) => !ids.has(n) && !/^\d+$/.test(n))) {
      const user = await osu.getUser(name).catch(() => null);
      if (!user) continue;
      const [known] = await sql`update osu_users set username = ${user.username} where id = ${user.id} returning id`;
      if (!known) continue;
      await savePastNames(sql, user);
      ids.set(name, user.id);
      usernames.set(user.id, user.username);
    }
  }
  return { ids, usernames, unknown: inputs.filter((n) => !ids.has(n)) };
}

/** The player filter's name replaced by an id, like `canonicalMatchFilters`. */
export async function canonicalTournamentFilters(
  sql: Sql,
  f: TournamentScoreFilters,
  osu: Pick<OsuClient, "getUser"> | null,
): Promise<TournamentScoreFilters> {
  if (f.player === "me" || f.player === "all") return f;
  const id = (await resolveUsers(sql, [f.player], osu)).ids.get(f.player);
  return id === undefined ? f : { ...f, player: String(id) };
}

/** Names in the player filters replaced by ids, so saved links keep working after a rename. */
export async function canonicalMatchFilters(sql: Sql, f: MatchFilters, osu: Pick<OsuClient, "getUser"> | null): Promise<MatchFilters> {
  const { ids } = await resolveUsers(sql, [...f.with, ...f.vs], osu);
  const canon = (list: string[]) => [...new Set(list.map((n) => (ids.has(n) ? String(ids.get(n)) : n)))];
  return { ...f, with: canon(f.with), vs: canon(f.vs) };
}

export interface PlayerRef {
  id: number;
  username: string | null;
  country_code: string | null;
}

export interface MatchListItem {
  id: number;
  source: MatchSource;
  external_id: number;
  url: string;
  name: string;
  acronym: string | null;
  kind: MatchKind;
  /** Marked as a casual lobby despite a tournament-style name. */
  not_tournament: boolean;
  red_name: string | null;
  blue_name: string | null;
  start_time: string | null;
  end_time: string | null;
  format: "team" | "1v1" | "ffa" | null;
  games_count: number;
  red_wins: number | null;
  blue_wins: number | null;
  /** The player's line in this match, if they played. */
  me: { side: Side | null; games_played: number; avg_score: number; avg_accuracy: number; match_cost: number } | null;
  result: "won" | "lost" | "draw" | null;
  teammates: PlayerRef[];
  opponents: PlayerRef[];
}

export interface MatchPage {
  matches: MatchListItem[];
  pagination: { page: number; page_size: number; total_count: number; total_pages: number };
  /** Names in `with`/`vs` that no saved player has. */
  unknown_players: string[];
  /** Current names of the players in `with`/`vs`, by the value given. */
  player_names: Record<string, string>;
}

const MATCH_ORDER: Record<MatchSortKey, string> = {
  date: "coalesce(m.start_time, m.created_at)",
  match_cost: "me.match_cost",
  maps: "m.games_count",
  avg_score: "me.avg_score",
  accuracy: "me.avg_accuracy",
  name: "lower(m.name)",
};

/** `matchKind` in SQL, for a `matches` row aliased `m`. */
export const kindOf = (sql: Sql) => {
  const bots = (Object.keys(MATCHMAKING_BOTS) as MatchmakingBot[]).map((bot) => sql`when m.name ~* ${matchmakingPattern(bot)} then ${bot}::text`);
  return sql`(case
    when m.source = 'lazer' then 'ranked'
    ${bots.reduce((all, when) => sql`${all} ${when}`)}
    when m.acronym is null or m.not_tournament then 'other'
    when m.name ~* ${QUALIFIERS_PATTERN} then 'qualifiers'
    else 'tournament' end)`;
};

const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : typeof value === "string" ? value : null);

function matchConditions(sql: Sql, playerId: number, f: MatchFilters, users: Map<string, number>): PendingQuery<Row[]> {
  const c: PendingQuery<Row[]>[] = [sql`true`];
  for (const word of searchWords(f.q)) c.push(sql`m.name ilike ${`%${word}%`}`);
  if (f.hide.length) c.push(sql`${kindOf(sql)} <> all(${f.hide}::text[])`);
  if (f.played) c.push(sql`me.user_id is not null`);
  if (f.result) {
    const lead = sql`(case me.side when 'red' then m.red_wins - m.blue_wins when 'blue' then m.blue_wins - m.red_wins end)`;
    c.push(f.result === "won" ? sql`${lead} > 0` : sql`${lead} < 0`);
  }
  if (f.minCost !== null) c.push(sql`me.match_cost >= ${f.minCost}`);
  if (f.maxCost !== null) c.push(sql`me.match_cost <= ${f.maxCost}`);
  if (f.minMaps !== null) c.push(sql`m.games_count >= ${f.minMaps}`);
  if (f.maxMaps !== null) c.push(sql`m.games_count <= ${f.maxMaps}`);
  if (f.dateFrom !== null) c.push(sql`m.start_time >= ${f.dateFrom}::timestamptz`);
  if (f.dateTo !== null) c.push(sql`m.start_time <= ${f.dateTo}::timestamptz`);
  for (const name of f.with) {
    const id = users.get(name) ?? -1;
    c.push(sql`exists (select 1 from match_players o where o.match_id = m.id and o.user_id = ${id}
      and o.user_id <> ${playerId} and me.side is not null and o.side = me.side)`);
  }
  for (const name of f.vs) {
    const id = users.get(name) ?? -1;
    c.push(sql`exists (select 1 from match_players o where o.match_id = m.id and o.user_id = ${id}
      and o.user_id <> ${playerId} and (me.side is null or o.side is distinct from me.side))`);
  }
  return c.reduce((all, condition) => sql`${all} and ${condition}`);
}

function toMatchListItem(row: Row): MatchListItem {
  return {
    id: row.id,
    source: row.source,
    external_id: row.external_id,
    url: matchUrl(row.source, row.external_id),
    name: row.name,
    acronym: row.acronym,
    kind: matchKind({ source: row.source, name: row.name, acronym: row.acronym, notTournament: row.not_tournament }),
    not_tournament: row.not_tournament,
    red_name: row.red_name,
    blue_name: row.blue_name,
    start_time: iso(row.start_time),
    end_time: iso(row.end_time),
    format: row.format,
    games_count: row.games_count,
    red_wins: row.red_wins,
    blue_wins: row.blue_wins,
    me:
      row.me_games === null
        ? null
        : { side: row.me_side, games_played: row.me_games, avg_score: row.me_avg_score, avg_accuracy: row.me_avg_accuracy, match_cost: row.me_cost },
    result: row.result,
    teammates: row.teammates ?? [],
    opponents: row.opponents ?? [],
  };
}

const MATCH_SELECT = (sql: Sql, playerId: number) => sql`
  select m.*, me.side as me_side, me.games_played as me_games, me.avg_score as me_avg_score,
    me.avg_accuracy as me_avg_accuracy, me.match_cost as me_cost,
    case
      when me.side is null or m.red_wins is null then null
      when (case me.side when 'red' then m.red_wins - m.blue_wins else m.blue_wins - m.red_wins end) > 0 then 'won'
      when (case me.side when 'red' then m.red_wins - m.blue_wins else m.blue_wins - m.red_wins end) < 0 then 'lost'
      else 'draw'
    end as result,
    (select coalesce(jsonb_agg(jsonb_build_object('id', o.user_id, 'username', u.username, 'country_code', u.country_code) order by o.match_cost desc), '[]')
      from match_players o left join osu_users u on u.id = o.user_id
      where o.match_id = m.id and o.user_id <> ${playerId} and me.side is not null and o.side = me.side) as teammates,
    (select coalesce(jsonb_agg(jsonb_build_object('id', o.user_id, 'username', u.username, 'country_code', u.country_code) order by o.side = 'blue', o.match_cost desc), '[]')
      from match_players o left join osu_users u on u.id = o.user_id
      where o.match_id = m.id and o.user_id <> ${playerId} and (me.side is null or o.side is distinct from me.side)) as opponents
  from matches m
  left join match_players me on me.match_id = m.id and me.user_id = ${playerId}`;

export async function listMatches(
  sql: Sql,
  playerId: number,
  f: MatchFilters,
  osu: Pick<OsuClient, "getUser"> | null = null,
): Promise<MatchPage> {
  const { ids, usernames, unknown } = await resolveUsers(sql, [...f.with, ...f.vs], osu);
  const where = matchConditions(sql, playerId, f, ids);
  const order = sql.unsafe(`${MATCH_ORDER[f.sort]} ${f.order === "asc" ? "asc" : "desc"} nulls last, m.id desc`);
  const offset = (f.page - 1) * f.pageSize;
  const [rows, [count]] = await Promise.all([
    sql`${MATCH_SELECT(sql, playerId)} where ${where} order by ${order} limit ${f.pageSize} offset ${offset}`,
    sql<{ total: number }[]>`select count(*)::int as total from matches m
      left join match_players me on me.match_id = m.id and me.user_id = ${playerId} where ${where}`,
  ]);
  const total = count?.total ?? 0;
  return {
    matches: rows.map(toMatchListItem),
    pagination: { page: f.page, page_size: f.pageSize, total_count: total, total_pages: Math.ceil(total / f.pageSize) },
    unknown_players: unknown,
    player_names: Object.fromEntries([...ids].map(([input, id]) => [input, usernames.get(id)!])),
  };
}

export async function findMatch(sql: Sql, source: MatchSource, externalId: number): Promise<number | null> {
  const [row] = await sql<{ id: number }[]>`select id from matches where source = ${source} and external_id = ${externalId}`;
  return row?.id ?? null;
}

// ---------- one match ----------

export interface MatchPlayerView {
  user_id: number;
  username: string | null;
  country_code: string | null;
  team: string;
  side: Side | null;
  games_played: number;
  avg_score: number;
  avg_accuracy: number;
  performance_cost: number;
  participation_bonus: number;
  mods_bonus: number;
  tiebreaker_bonus: number;
  match_cost: number;
}

export interface MatchScoreView {
  id: number;
  user_id: number;
  username: string | null;
  team: string;
  side: Side | null;
  slot: number | null;
  /** The score as osu! recorded it. */
  total_score: number;
  /** The score as the match counts it, with the EZ multiplier applied. */
  score: number;
  accuracy: number;
  max_combo: number;
  perfect: boolean;
  passed: boolean;
  rank: string;
  count300: number;
  count100: number;
  count50: number;
  countmiss: number;
  mods: ScoreMod[];
  pp: number | null;
  pp_source: string;
}

export interface MatchGameView {
  id: number;
  position: number;
  beatmap_id: number | null;
  beatmap: BeatmapView | null;
  ruleset_id: number;
  scoring_type: string | null;
  team_type: string | null;
  mods: string[];
  start_time: string | null;
  end_time: string | null;
  counted: boolean;
  /** Left out by hand. */
  excluded: boolean;
  /** Left out as a warmup, by count or from the host. */
  warmup: boolean;
  /** The player holding the lobby host when the map started. */
  host_id: number | null;
  host_name: string | null;
  winner: Side | null;
  red_score: number | null;
  blue_score: number | null;
  scores: MatchScoreView[];
}

export interface MatchDetail extends Omit<MatchListItem, "teammates" | "opponents"> {
  room_type: string | null;
  /** Null: found from the host (see `games[].warmup`). */
  warmups: number | null;
  skip_last: number;
  ez_multiplier: number;
  fetched_at: string | null;
  added_via: string;
  tiebreaker: boolean;
  players: MatchPlayerView[];
  games: MatchGameView[];
}

function winningSide(red: number | null, blue: number | null): Side | null {
  if (red === null || blue === null || red === blue) return null;
  return red > blue ? "red" : "blue";
}

/** Moves the winner's side to the top, then the loser's, then anyone without a side; the order within each is kept. */
function winnerFirst<T>(rows: T[], sideOf: (row: T) => Side | null, winner: Side | null): T[] {
  if (!winner) return rows;
  const rank = (row: T) => (sideOf(row) === winner ? 0 : sideOf(row) ? 1 : 2);
  return [...rows].sort((a, b) => rank(a) - rank(b));
}

export async function getMatchDetail(sql: Sql, playerId: number, matchId: number): Promise<MatchDetail | null> {
  const [row] = await sql`${MATCH_SELECT(sql, playerId)} where m.id = ${matchId}`;
  if (!row) return null;
  const [players, games, scores, analyzed] = await Promise.all([
    sql<MatchPlayerView[]>`
      select p.*, u.username, u.country_code from match_players p left join osu_users u on u.id = p.user_id
      where p.match_id = ${matchId} order by p.side = 'blue', p.side is null, p.match_cost desc`,
    sql`select g.*, to_jsonb(b) as beatmap, h.username as host_name from match_games g left join beatmaps b on b.id = g.beatmap_id
      left join osu_users h on h.id = g.host_id
      where g.match_id = ${matchId} order by g.position`,
    sql`select s.*, u.username from match_scores s left join osu_users u on u.id = s.user_id
      where s.match_id = ${matchId} order by s.game_id`,
    analyzeSavedMatch(sql, matchId),
  ]);
  const sides = new Map(players.map((p) => [p.user_id, p.side]));
  const results = new Map((analyzed?.analysis.games ?? []).map((g) => [g.id, g]));
  const { teammates: _t, opponents: _o, ...item } = toMatchListItem(row);
  return {
    ...item,
    room_type: row.room_type,
    warmups: row.warmups,
    skip_last: row.skip_last,
    ez_multiplier: row.ez_multiplier,
    fetched_at: iso(row.fetched_at),
    added_via: row.added_via,
    tiebreaker: analyzed?.analysis.tiebreaker ?? false,
    players: winnerFirst(players, (p) => p.side, winningSide(item.red_wins, item.blue_wins)),
    games: games.map((g) => {
      const result = results.get(g.id);
      const gameScores: MatchScoreView[] = scores
        .filter((s) => s.game_id === g.id)
        .map((s) => {
          const mods = normalizeMods(s.mods);
          return {
            id: s.id,
            user_id: s.user_id,
            username: s.username,
            team: s.team,
            side: sides.get(s.user_id) ?? null,
            slot: s.slot,
            total_score: s.total_score,
            score: ezAdjusted(s.total_score, mods.map((mod) => mod.acronym), row.ez_multiplier),
            accuracy: s.accuracy,
            max_combo: s.max_combo,
            perfect: s.perfect,
            passed: s.passed,
            rank: s.rank,
            count300: s.count300,
            count100: s.count100,
            count50: s.count50,
            countmiss: s.countmiss,
            mods,
            pp: s.pp,
            pp_source: s.pp_source,
          };
        })
        .sort((a, b) => Number(a.team === "blue") - Number(b.team === "blue") || b.score - a.score);
      return {
        id: g.id,
        position: g.position,
        beatmap_id: g.beatmap_id,
        beatmap: g.beatmap ? toBeatmapView(g.beatmap) : null,
        ruleset_id: g.ruleset_id,
        scoring_type: g.scoring_type,
        team_type: g.team_type,
        mods: g.mods,
        start_time: iso(g.start_time),
        end_time: iso(g.end_time),
        counted: result?.counted ?? false,
        excluded: g.excluded,
        warmup: result?.warmup ?? false,
        host_id: g.host_id,
        host_name: g.host_name,
        winner: result?.winner ?? null,
        red_score: result?.redScore ?? null,
        blue_score: result?.blueScore ?? null,
        scores: winnerFirst(gameScores, (s) => s.side, result?.winner ?? null),
      };
    }),
  };
}

// ---------- tournament scores ----------

export interface TournamentScoreFilters extends ScoreFilters {
  /** `me` (default), `all`, or a username or id. */
  player: string;
  /** Every word must appear in the match name. */
  match: string;
  /** Leave out scores from matches of these kinds. */
  hide: (typeof MATCH_KINDS)[number][];
}

export function parseTournamentScoreFilters(params: URLSearchParams): TournamentScoreFilters {
  return {
    ...parseScoreFilters(params),
    player: (params.get("player") ?? "").trim() || "me",
    match: (params.get("match") ?? "").trim(),
    hide: hiddenKinds(params),
  };
}

export function tournamentFiltersToParams(f: TournamentScoreFilters, overrides: Partial<TournamentScoreFilters> = {}): URLSearchParams {
  const merged = { ...f, ...overrides };
  const params = filtersToParams(merged);
  if (merged.player !== "me") params.set("player", merged.player);
  if (merged.match) params.set("match", merged.match);
  if (merged.hide.length) params.set("hide", merged.hide.join(","));
  return params;
}

export interface TournamentScoreView {
  id: number;
  user_id: number;
  username: string | null;
  beatmap_id: number | null;
  beatmap: BeatmapView | null;
  ended_at: string | null;
  rank: string;
  accuracy: number;
  total_score: number;
  max_combo: number;
  perfect: boolean;
  passed: boolean;
  countmiss: number;
  mods: ScoreMod[];
  clock_rate: number | null;
  pp: number | null;
  pp_source: string;
  team: string;
  match_id: number;
  match_name: string;
  match_source: MatchSource;
  match_url: string;
  game_position: number;
}

export interface TournamentScorePage {
  scores: TournamentScoreView[];
  pagination: MatchPage["pagination"];
  unknown_player: string | null;
  /** Current name of the player in `player`, when it's someone else. */
  player_name: string | null;
}

const SCORE_ORDER = (sql: Sql, table: string, f: ScoreFilters) =>
  sql.unsafe(`${table}.${f.sort} ${f.order === "asc" ? "asc" : "desc"} nulls last, ${table}.id desc`);

function toTournamentScore(row: Row): TournamentScoreView {
  return {
    id: row.id,
    user_id: row.user_id,
    username: row.username,
    beatmap_id: row.beatmap_id,
    beatmap: row.beatmap ? toBeatmapView(row.beatmap) : null,
    ended_at: iso(row.ended_at),
    rank: row.rank,
    accuracy: row.accuracy,
    total_score: row.total_score,
    max_combo: row.max_combo,
    perfect: row.perfect,
    passed: row.passed,
    countmiss: row.countmiss,
    mods: normalizeMods(row.mods),
    clock_rate: row.clock_rate,
    pp: row.pp,
    pp_source: row.pp_source,
    team: row.team,
    match_id: row.match_id,
    match_name: row.match_name,
    match_source: row.match_source,
    match_url: matchUrl(row.match_source, row.match_external_id),
    game_position: row.game_position,
  };
}

/** Scores from every saved match, with the score library's filters plus player, match name and hidden kinds. */
export async function listTournamentScores(
  sql: Sql,
  playerId: number,
  f: TournamentScoreFilters,
  osu: Pick<OsuClient, "getUser"> | null = null,
): Promise<TournamentScorePage> {
  let userId: number | null = playerId;
  let unknownPlayer: string | null = null;
  let playerName: string | null = null;
  if (f.player === "all") userId = null;
  else if (f.player !== "me") {
    const { ids, usernames } = await resolveUsers(sql, [f.player], osu);
    userId = ids.get(f.player) ?? -1;
    if (userId === -1) unknownPlayer = f.player;
    else playerName = usernames.get(userId) ?? null;
  }
  const extra: PendingQuery<Row[]>[] = [sql`true`];
  for (const word of searchWords(f.match)) extra.push(sql`s.match_name ilike ${`%${word}%`}`);
  if (f.hide.length) extra.push(sql`exists (select 1 from matches m where m.id = s.match_id and ${kindOf(sql)} <> all(${f.hide}::text[]))`);
  const where = sql`${scoreConditions(sql, userId, f)} and ${extra.reduce((all, c) => sql`${all} and ${c}`)}`;
  const from = sql`from match_score_rows s left join beatmaps b on b.id = s.beatmap_id left join osu_users u on u.id = s.user_id`;
  const offset = (f.page - 1) * f.pageSize;
  const [rows, [count]] = f.bestOnly
    ? await Promise.all([
        sql`select * from (
            select distinct on (s.beatmap_id) s.*, to_jsonb(b) as beatmap, u.username ${from} where ${where}
            order by s.beatmap_id, s.pp desc nulls last, s.id desc
          ) t order by ${SCORE_ORDER(sql, "t", f)} limit ${f.pageSize} offset ${offset}`,
        sql<{ total: number }[]>`select count(distinct s.beatmap_id)::int as total ${from} where ${where}`,
      ])
    : await Promise.all([
        sql`select s.*, to_jsonb(b) as beatmap, u.username ${from} where ${where}
          order by ${SCORE_ORDER(sql, "s", f)} limit ${f.pageSize} offset ${offset}`,
        sql<{ total: number }[]>`select count(*)::int as total ${from} where ${where}`,
      ]);
  const total = count?.total ?? 0;
  return {
    scores: rows.map(toTournamentScore),
    pagination: { page: f.page, page_size: f.pageSize, total_count: total, total_pages: Math.ceil(total / f.pageSize) },
    unknown_player: unknownPlayer,
    player_name: playerName,
  };
}

// ---------- overview ----------

export interface MatchStats {
  matches: number;
  played: number;
  won: number;
  lost: number;
  avg_match_cost: number | null;
  best_match_cost: { match_id: number; name: string; match_cost: number } | null;
  tournaments: number;
}

export async function matchStats(sql: Sql, playerId: number): Promise<MatchStats> {
  const [[summary], [best]] = await Promise.all([
    sql`
      select count(*)::int as matches,
        count(me.user_id)::int as played,
        count(*) filter (where (case me.side when 'red' then m.red_wins - m.blue_wins when 'blue' then m.blue_wins - m.red_wins end) > 0)::int as won,
        count(*) filter (where (case me.side when 'red' then m.red_wins - m.blue_wins when 'blue' then m.blue_wins - m.red_wins end) < 0)::int as lost,
        avg(me.match_cost) as avg_cost,
        count(distinct lower(m.acronym)) filter (where ${kindOf(sql)} in ('tournament', 'qualifiers'))::int as tournaments
      from matches m left join match_players me on me.match_id = m.id and me.user_id = ${playerId}`,
    sql`
      select m.id as match_id, m.name, me.match_cost from match_players me join matches m on m.id = me.match_id
      where me.user_id = ${playerId} and me.games_played >= 3 order by me.match_cost desc limit 1`,
  ]);
  return {
    matches: summary?.matches ?? 0,
    played: summary?.played ?? 0,
    won: summary?.won ?? 0,
    lost: summary?.lost ?? 0,
    avg_match_cost: summary?.avg_cost ?? null,
    best_match_cost: best ? { match_id: best.match_id, name: best.name, match_cost: best.match_cost } : null,
    tournaments: summary?.tournaments ?? 0,
  };
}
