// Stats over the player's saved matches: who they play with and against most and how that goes,
// countries faced, events, mod pool, most played maps, streaks, records and activity by month.
// Head-to-head numbers (teammates, opponents, records, streaks) only count matches with sides
// (team matches and 1v1s); match costs count every match the player has one in.

import type { PendingQuery, Row } from "postgres";
import type { Sql } from "../db/index.ts";
import { searchWords, toBeatmapView, type BeatmapView } from "../scores/query.ts";
import { MATCH_KINDS, type MatchKind } from "./normalize.ts";
import { hiddenKinds, kindOf, setHiddenKinds } from "./query.ts";

export interface InsightFilters {
  /** Kinds left out, like the match list's Type boxes. */
  hide: (typeof MATCH_KINDS)[number][];
  /** Every word must appear in the match name. */
  q: string;
  dateFrom: string | null;
  dateTo: string | null;
  /** Players met fewer times than this are left out of the best/worst lists. */
  min: number;
}

export const DEFAULT_MIN_MEETINGS = 3;

export function parseInsightFilters(params: URLSearchParams): InsightFilters {
  const date = (value: string | null) => (value && !Number.isNaN(Date.parse(value)) ? value : null);
  const min = Number(params.get("min"));
  return {
    hide: hiddenKinds(params),
    q: (params.get("q") ?? "").trim(),
    dateFrom: date(params.get("date_from")),
    dateTo: date(params.get("date_to")),
    min: Number.isFinite(min) && min >= 1 ? Math.min(Math.floor(min), 100) : DEFAULT_MIN_MEETINGS,
  };
}

export function insightFiltersToParams(f: InsightFilters): URLSearchParams {
  const params = new URLSearchParams();
  setHiddenKinds(params, f.hide);
  if (f.q) params.set("q", f.q);
  if (f.dateFrom) params.set("date_from", f.dateFrom);
  if (f.dateTo) params.set("date_to", f.dateTo);
  if (f.min !== DEFAULT_MIN_MEETINGS) params.set("min", String(f.min));
  return params;
}

export interface InsightSummary {
  matches: number;
  won: number;
  lost: number;
  draws: number;
  avg_match_cost: number | null;
  /** Matches where nobody had a higher match cost. */
  mvp: number;
  /** Matches with more than one player, the most `mvp` could be. */
  mvp_of: number;
  /** Matches decided by one map after at least five. */
  tiebreakers_won: number;
  tiebreakers_lost: number;
  maps: number;
  maps_won: number;
  maps_lost: number;
  avg_accuracy: number | null;
  /** Maps played at 100% accuracy. */
  perfect_maps: number;
  tournaments: number;
  teammates: number;
  opponents: number;
  countries: number;
  first_match: string | null;
}

export interface PersonStats {
  id: number;
  username: string | null;
  country_code: string | null;
  matches: number;
  won: number;
  lost: number;
  /** The player's average match cost in these matches. */
  my_cost: number;
  /** This person's average match cost in them. */
  their_cost: number;
  /** Matches where the player's match cost beat theirs. */
  outcosted: number;
  /** Different events (tournament acronyms, matchmaking bots) shared. */
  events: number;
  last_played: string | null;
}

export interface CountryStats {
  country_code: string;
  matches: number;
  won: number;
  lost: number;
  players: number;
}

export interface EventStats {
  /** Tournament acronym, or the matchmaking kind. */
  label: string;
  kind: MatchKind;
  matches: number;
  won: number;
  lost: number;
  avg_cost: number | null;
  best_cost: number | null;
  best_match_id: number | null;
  first_played: string | null;
  last_played: string | null;
}

export interface ModStats {
  /** Mod acronyms in the usual order; empty for NoMod. */
  mods: string[];
  maps: number;
  won: number;
  lost: number;
  avg_accuracy: number;
  /** The player's score over the lobby's average on the map, averaged. */
  avg_ratio: number | null;
}

export interface MapStats {
  beatmap_id: number;
  beatmap: BeatmapView | null;
  plays: number;
  won: number;
  lost: number;
  avg_accuracy: number;
  best_score: number;
  avg_ratio: number | null;
}

export interface MatchRecord {
  match_id: number;
  name: string;
  played_at: string | null;
  match_cost: number;
  /** Maps won and lost by the player's side. */
  us: number | null;
  them: number | null;
  /** What the record measures (maps behind, minutes, ...). */
  value: number;
}

export interface MapRecord {
  match_id: number;
  name: string;
  position: number;
  beatmap_id: number | null;
  beatmap: BeatmapView | null;
  accuracy: number;
  total_score: number;
  mods: string[];
  /** Winning side's team score minus the other's. */
  margin: number | null;
  lobby_ratio: number | null;
}

export interface Streak {
  kind: "won" | "lost";
  length: number;
  from: string | null;
  to: string | null;
}

export interface MonthStats {
  /** `YYYY-MM`. */
  month: string;
  matches: number;
  won: number;
  lost: number;
  avg_cost: number | null;
}

export interface MatchInsights {
  summary: InsightSummary;
  teammates: PersonStats[];
  opponents: PersonStats[];
  countries: CountryStats[];
  events: EventStats[];
  mods: ModStats[];
  maps: MapStats[];
  streaks: { longest_win: Streak | null; longest_loss: Streak | null; current: Streak | null };
  records: {
    best_cost: MatchRecord | null;
    worst_cost: MatchRecord | null;
    best_in_loss: MatchRecord | null;
    worst_in_win: MatchRecord | null;
    biggest_win: MatchRecord | null;
    comeback: MatchRecord | null;
    choke: MatchRecord | null;
    longest: MatchRecord | null;
    marathon: MatchRecord | null;
    pop_off: MapRecord | null;
    closest_win: MapRecord | null;
    closest_loss: MapRecord | null;
    best_accuracy: MapRecord | null;
  };
  months: MonthStats[];
}

// Match costs over fewer maps than this are left out of the match cost records.
const RECORD_MIN_MAPS = 3;
const MOD_ORDER = ["EZ", "HD", "HR", "DT", "NC", "HT", "DC", "FL", "FI", "NF", "SD", "PF", "BL", "RX", "AP", "SO", "TD"];

/** Mods in the order mod pools name them (HDHR, HDDT, EZHD), unknown ones last. */
export function orderMods(mods: readonly string[]): string[] {
  const rank = (m: string) => (MOD_ORDER.includes(m) ? MOD_ORDER.indexOf(m) : MOD_ORDER.length);
  return [...mods].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : typeof value === "string" ? value : null);
const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));

/** The player's matches passing the filters, with their side, match cost and result. */
function mineCte(sql: Sql, playerId: number, f: InsightFilters): PendingQuery<Row[]> {
  const c: PendingQuery<Row[]>[] = [sql`true`];
  for (const word of searchWords(f.q)) c.push(sql`m.name ilike ${`%${word}%`}`);
  if (f.hide.length) c.push(sql`${kindOf(sql)} <> all(${f.hide}::text[])`);
  if (f.dateFrom !== null) c.push(sql`m.start_time >= ${f.dateFrom}::timestamptz`);
  if (f.dateTo !== null) c.push(sql`m.start_time <= ${f.dateTo}::timestamptz`);
  const where = c.reduce((all, condition) => sql`${all} and ${condition}`);
  return sql`mine as (
    select m.id, m.name, m.acronym, ${kindOf(sql)} as kind, m.games_count,
      -- Decided by one map after at least five. Bathbot's tiebreaker bonus only spots these in team matches.
      coalesce(m.end_time is not null and m.red_wins + m.blue_wins > 4 and abs(m.red_wins - m.blue_wins) = 1, false) as tiebreaker, m.ez_multiplier,
      m.start_time, m.end_time, coalesce(m.start_time, m.created_at) as played_at,
      me.side, me.match_cost, me.games_played,
      case me.side when 'red' then m.red_wins when 'blue' then m.blue_wins end as us,
      case me.side when 'red' then m.blue_wins when 'blue' then m.red_wins end as them,
      case when me.side is null or m.red_wins is null then null
        else sign(case me.side when 'red' then m.red_wins - m.blue_wins else m.blue_wins - m.red_wins end)::int end as outcome
    from matches m join match_players me on me.match_id = m.id and me.user_id = ${playerId}
    where ${where})`;
}

/** Every counted map the player set a score on, with its result and the score over the lobby's average (EZ multiplied). */
function gamesCte(sql: Sql, playerId: number): PendingQuery<Row[]> {
  const adjusted = (alias: string) => sql.unsafe(`(${alias}.total_score * case when 'EZ' = any(${alias}.mod_acronyms) then mine.ez_multiplier else 1 end)`);
  return sql`my_games as (
    select g.id, g.match_id, g.position, g.beatmap_id, g.winner, g.red_score, g.blue_score,
      mine.name, mine.played_at, s.accuracy, s.total_score,
      array(select a from unnest(s.mod_acronyms) a where a not in ('NF', 'CL') order by a) as mods,
      case when mine.side is null or g.winner is null then null when g.winner = mine.side then 1 else -1 end as map_outcome,
      ${adjusted("s")} / nullif((select avg(${adjusted("x")}) from match_scores x where x.game_id = g.id and x.total_score > 0), 0) as lobby_ratio,
      (select count(*) from match_scores x where x.game_id = g.id and x.total_score > 0) as lobby_size
    from mine
    join match_games g on g.match_id = mine.id and g.counted
    join match_scores s on s.game_id = g.id and s.user_id = ${playerId} and s.total_score > 0)`;
}

function toPerson(row: Row): PersonStats {
  return {
    id: row.id,
    username: row.username,
    country_code: row.country_code,
    matches: row.matches,
    won: row.won,
    lost: row.lost,
    my_cost: row.my_cost,
    their_cost: row.their_cost,
    outcosted: row.outcosted,
    events: row.events,
    last_played: iso(row.last_played),
  };
}

function toMatchRecord(row: Row | undefined): MatchRecord | null {
  if (!row) return null;
  return {
    match_id: row.id,
    name: row.name,
    played_at: iso(row.played_at),
    match_cost: row.match_cost,
    us: row.us,
    them: row.them,
    value: Number(row.value ?? 0),
  };
}

function toMapRecord(row: Row | undefined): MapRecord | null {
  if (!row) return null;
  return {
    match_id: row.match_id,
    name: row.name,
    position: row.position,
    beatmap_id: row.beatmap_id,
    beatmap: row.beatmap ? toBeatmapView(row.beatmap) : null,
    accuracy: row.accuracy,
    total_score: row.total_score,
    mods: orderMods(row.mods),
    margin: row.red_score === null || row.blue_score === null ? null : Math.abs(row.red_score - row.blue_score),
    lobby_ratio: num(row.lobby_ratio),
  };
}

/** Longest winning and losing runs, and the one still going, from results oldest first. */
export function streaks(results: readonly { outcome: number; played_at: string | null }[]): MatchInsights["streaks"] {
  let longestWin: Streak | null = null;
  let longestLoss: Streak | null = null;
  let current = null as Streak | null;
  for (const r of results) {
    const kind = r.outcome > 0 ? "won" : r.outcome < 0 ? "lost" : null;
    if (kind === null) {
      current = null;
      continue;
    }
    current = current?.kind === kind ? { ...current, length: current.length + 1, to: r.played_at } : { kind, length: 1, from: r.played_at, to: r.played_at };
    if (kind === "won" && current.length > (longestWin?.length ?? 0)) longestWin = current;
    if (kind === "lost" && current.length > (longestLoss?.length ?? 0)) longestLoss = current;
  }
  return { longest_win: longestWin, longest_loss: longestLoss, current };
}

export async function matchInsights(sql: Sql, playerId: number, f: InsightFilters): Promise<MatchInsights> {
  const mine = mineCte(sql, playerId, f);
  const withGames = sql`with ${mine}, ${gamesCte(sql, playerId)}`;
  const people = (relation: "with" | "vs") => sql`with ${mine}
    select o.user_id as id, u.username, u.country_code,
      count(*)::int as matches,
      count(*) filter (where mine.outcome > 0)::int as won,
      count(*) filter (where mine.outcome < 0)::int as lost,
      avg(mine.match_cost) as my_cost,
      avg(o.match_cost) as their_cost,
      count(*) filter (where mine.match_cost > o.match_cost)::int as outcosted,
      count(distinct coalesce(lower(mine.acronym), mine.kind))::int as events,
      max(mine.played_at) as last_played
    from mine
    join match_players o on o.match_id = mine.id and o.user_id <> ${playerId}
      and ${relation === "with" ? sql`o.side = mine.side` : sql`o.side <> mine.side`}
    left join osu_users u on u.id = o.user_id
    where mine.side is not null
    group by o.user_id, u.username, u.country_code
    order by matches desc, won desc, o.user_id`;
  // One row per match, for the match records.
  const matchRecord = (where: PendingQuery<Row[]>, order: PendingQuery<Row[]>, value: PendingQuery<Row[]> = sql`null`) =>
    sql`with ${mine}, swings as (${swings})
      select mine.*, ${value} as value from mine left join swings on swings.match_id = mine.id
      where ${where} order by ${order}, mine.played_at desc limit 1`;
  // The biggest deficit and lead in maps at any point in each match with sides.
  const swings = sql`
    select match_id, max(them - us) as deficit, max(us - them) as lead from (
      select g.match_id,
        sum(case when g.winner = mine.side then 1 else 0 end) over w as us,
        sum(case when g.winner is not null and g.winner <> mine.side then 1 else 0 end) over w as them
      from mine join match_games g on g.match_id = mine.id and g.counted
      where mine.side is not null
      window w as (partition by g.match_id order by g.position)
    ) t group by match_id`;
  const mapRecord = (where: PendingQuery<Row[]>, order: PendingQuery<Row[]>) =>
    sql`${withGames} select my_games.*, to_jsonb(b) as beatmap from my_games left join beatmaps b on b.id = my_games.beatmap_id
      where ${where} order by ${order}, my_games.played_at desc limit 1`;
  const enoughMaps = sql`mine.games_played >= ${RECORD_MIN_MAPS}`;

  const [
    [summary],
    [maps],
    [circle],
    teammates,
    opponents,
    countries,
    events,
    mods,
    mapRows,
    results,
    months,
    ...records
  ] = await Promise.all([
    sql`with ${mine}
      select count(*)::int as matches,
        count(*) filter (where outcome > 0)::int as won,
        count(*) filter (where outcome < 0)::int as lost,
        count(*) filter (where outcome = 0)::int as draws,
        avg(match_cost) as avg_cost,
        count(*) filter (where others.n > 0 and others.best <= mine.match_cost)::int as mvp,
        count(*) filter (where others.n > 0)::int as mvp_of,
        count(*) filter (where tiebreaker and outcome > 0)::int as tiebreakers_won,
        count(*) filter (where tiebreaker and outcome < 0)::int as tiebreakers_lost,
        count(distinct lower(acronym)) filter (where kind in ('tournament', 'qualifiers'))::int as tournaments,
        min(played_at) as first_match
      from mine cross join lateral (
        select count(*)::int as n, max(p.match_cost) as best from match_players p where p.match_id = mine.id and p.user_id <> ${playerId}
      ) others`,
    sql`${withGames}
      select count(*)::int as maps,
        count(*) filter (where map_outcome > 0)::int as maps_won,
        count(*) filter (where map_outcome < 0)::int as maps_lost,
        avg(accuracy) as avg_accuracy,
        count(*) filter (where accuracy >= 1)::int as perfect_maps
      from my_games`,
    sql`with ${mine}
      select count(distinct o.user_id) filter (where o.side = mine.side)::int as teammates,
        count(distinct o.user_id) filter (where o.side <> mine.side)::int as opponents,
        count(distinct u.country_code) filter (where o.side <> mine.side)::int as countries
      from mine join match_players o on o.match_id = mine.id and o.user_id <> ${playerId}
      left join osu_users u on u.id = o.user_id
      where mine.side is not null`,
    people("with"),
    people("vs"),
    sql`with ${mine}
      select u.country_code,
        count(distinct mine.id)::int as matches,
        count(distinct mine.id) filter (where mine.outcome > 0)::int as won,
        count(distinct mine.id) filter (where mine.outcome < 0)::int as lost,
        count(distinct o.user_id)::int as players
      from mine join match_players o on o.match_id = mine.id and o.user_id <> ${playerId} and o.side <> mine.side
      join osu_users u on u.id = o.user_id
      where mine.side is not null and u.country_code is not null
      group by u.country_code order by matches desc, won desc, u.country_code`,
    sql`with ${mine}
      select (array_agg(coalesce(acronym, kind) order by played_at desc))[1] as label, (array_agg(kind order by played_at desc))[1] as kind,
        count(*)::int as matches,
        count(*) filter (where outcome > 0)::int as won,
        count(*) filter (where outcome < 0)::int as lost,
        avg(match_cost) as avg_cost,
        max(match_cost) filter (where games_played >= ${RECORD_MIN_MAPS}) as best_cost,
        (array_agg(id order by games_played >= ${RECORD_MIN_MAPS} desc, match_cost desc))[1] as best_match_id,
        min(played_at) as first_played, max(played_at) as last_played
      from mine where kind <> 'other'
      group by case when kind in ('tournament', 'qualifiers') then lower(acronym) else kind end
      order by max(played_at) desc`,
    sql`${withGames}
      select mods, count(*)::int as maps,
        count(*) filter (where map_outcome > 0)::int as won,
        count(*) filter (where map_outcome < 0)::int as lost,
        avg(accuracy) as avg_accuracy, avg(lobby_ratio) as avg_ratio
      from my_games group by mods order by maps desc, mods`,
    sql`${withGames}
      select t.*, to_jsonb(b) as beatmap from (
        select beatmap_id, count(*)::int as plays,
          count(*) filter (where map_outcome > 0)::int as won,
          count(*) filter (where map_outcome < 0)::int as lost,
          avg(accuracy) as avg_accuracy, max(total_score) as best_score, avg(lobby_ratio) as avg_ratio,
          max(played_at) as last_played
        from my_games where beatmap_id is not null group by beatmap_id having count(*) >= 2
      ) t left join beatmaps b on b.id = t.beatmap_id
      order by t.plays desc, t.won desc, t.last_played desc limit 10`,
    sql`with ${mine} select outcome, played_at from mine where outcome is not null order by played_at, id`,
    sql`with ${mine}
      select to_char(date_trunc('month', played_at), 'YYYY-MM') as month,
        count(*)::int as matches,
        count(*) filter (where outcome > 0)::int as won,
        count(*) filter (where outcome < 0)::int as lost,
        avg(match_cost) as avg_cost
      from mine group by 1 order by 1`,
    matchRecord(enoughMaps, sql`mine.match_cost desc`),
    matchRecord(enoughMaps, sql`mine.match_cost asc`),
    matchRecord(sql`${enoughMaps} and mine.outcome < 0`, sql`mine.match_cost desc`),
    matchRecord(sql`${enoughMaps} and mine.outcome > 0`, sql`mine.match_cost asc`),
    matchRecord(sql`mine.outcome > 0`, sql`mine.us - mine.them desc, mine.us desc`, sql`mine.us - mine.them`),
    matchRecord(sql`mine.outcome > 0 and swings.deficit > 0`, sql`swings.deficit desc`, sql`swings.deficit`),
    matchRecord(sql`mine.outcome < 0 and swings.lead > 0`, sql`swings.lead desc`, sql`swings.lead`),
    matchRecord(sql`mine.outcome is not null`, sql`mine.games_count desc`, sql`mine.games_count`),
    matchRecord(
      sql`mine.outcome is not null and mine.end_time > mine.start_time`,
      sql`mine.end_time - mine.start_time desc`,
      sql`extract(epoch from mine.end_time - mine.start_time) / 60`,
    ),
    mapRecord(sql`my_games.lobby_size > 1 and my_games.lobby_ratio is not null`, sql`my_games.lobby_ratio desc`),
    mapRecord(sql`my_games.map_outcome > 0`, sql`abs(my_games.red_score - my_games.blue_score) asc`),
    mapRecord(sql`my_games.map_outcome < 0`, sql`abs(my_games.red_score - my_games.blue_score) asc`),
    mapRecord(sql`true`, sql`my_games.accuracy desc, my_games.total_score desc`),
  ]);

  const [bestCost, worstCost, bestInLoss, worstInWin, biggestWin, comeback, choke, longest, marathon, popOff, closestWin, closestLoss, bestAccuracy] =
    records as Row[][];
  return {
    summary: {
      matches: summary?.matches ?? 0,
      won: summary?.won ?? 0,
      lost: summary?.lost ?? 0,
      draws: summary?.draws ?? 0,
      avg_match_cost: num(summary?.avg_cost),
      mvp: summary?.mvp ?? 0,
      mvp_of: summary?.mvp_of ?? 0,
      tiebreakers_won: summary?.tiebreakers_won ?? 0,
      tiebreakers_lost: summary?.tiebreakers_lost ?? 0,
      maps: maps?.maps ?? 0,
      maps_won: maps?.maps_won ?? 0,
      maps_lost: maps?.maps_lost ?? 0,
      avg_accuracy: num(maps?.avg_accuracy),
      perfect_maps: maps?.perfect_maps ?? 0,
      tournaments: summary?.tournaments ?? 0,
      teammates: circle?.teammates ?? 0,
      opponents: circle?.opponents ?? 0,
      countries: circle?.countries ?? 0,
      first_match: iso(summary?.first_match),
    },
    teammates: teammates.map(toPerson),
    opponents: opponents.map(toPerson),
    countries: countries.map((r) => ({ country_code: r.country_code, matches: r.matches, won: r.won, lost: r.lost, players: r.players })),
    events: events.map((r) => ({
      label: r.label,
      kind: r.kind,
      matches: r.matches,
      won: r.won,
      lost: r.lost,
      avg_cost: num(r.avg_cost),
      best_cost: num(r.best_cost),
      best_match_id: r.best_cost === null ? null : r.best_match_id,
      first_played: iso(r.first_played),
      last_played: iso(r.last_played),
    })),
    mods: mods.map((r) => ({ mods: orderMods(r.mods), maps: r.maps, won: r.won, lost: r.lost, avg_accuracy: r.avg_accuracy, avg_ratio: num(r.avg_ratio) })),
    maps: mapRows.map((r) => ({
      beatmap_id: r.beatmap_id,
      beatmap: r.beatmap ? toBeatmapView(r.beatmap) : null,
      plays: r.plays,
      won: r.won,
      lost: r.lost,
      avg_accuracy: r.avg_accuracy,
      best_score: r.best_score,
      avg_ratio: num(r.avg_ratio),
    })),
    streaks: streaks(results.map((r) => ({ outcome: r.outcome, played_at: iso(r.played_at) }))),
    records: {
      best_cost: toMatchRecord(bestCost?.[0]),
      worst_cost: toMatchRecord(worstCost?.[0]),
      best_in_loss: toMatchRecord(bestInLoss?.[0]),
      worst_in_win: toMatchRecord(worstInWin?.[0]),
      biggest_win: toMatchRecord(biggestWin?.[0]),
      comeback: toMatchRecord(comeback?.[0]),
      choke: toMatchRecord(choke?.[0]),
      longest: toMatchRecord(longest?.[0]),
      marathon: toMatchRecord(marathon?.[0]),
      pop_off: toMapRecord(popOff?.[0]),
      closest_win: toMapRecord(closestWin?.[0]),
      closest_loss: toMapRecord(closestLoss?.[0]),
      best_accuracy: toMapRecord(bestAccuracy?.[0]),
    },
    months: months.map((r) => ({ month: r.month, matches: r.matches, won: r.won, lost: r.lost, avg_cost: num(r.avg_cost) })),
  };
}

/** People met at least `min` times, best first by `key` (`asc` for the worst). */
export function rankPeople(list: readonly PersonStats[], min: number, key: (p: PersonStats) => number, order: "desc" | "asc", limit = 5): PersonStats[] {
  const sign = order === "desc" ? -1 : 1;
  return list
    .filter((p) => p.matches >= min)
    .toSorted((a, b) => sign * (key(a) - key(b)) || b.matches - a.matches || a.id - b.id)
    .slice(0, limit);
}
