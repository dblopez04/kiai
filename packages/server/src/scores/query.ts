// Searching the score library. The filter parameters and their meaning are shared by the web UI,
// the JSON API and CSV exports, and are meant to be reused by the replay gallery.

import type { PendingQuery, Row } from "postgres";
import type { Sql } from "../db/index.ts";
import { normalizeMods, type ScoreMod } from "./mods.ts";

export const SORT_KEYS = ["ended_at", "pp", "accuracy", "total_score", "max_combo"] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export const PAGE_SIZE_DEFAULT = 50;
export const PAGE_SIZE_MAX = 200;

export interface ScoreFilters {
  /** Every word must appear in the title, artist or difficulty name. */
  q: string;
  sort: SortKey;
  order: "asc" | "desc";
  page: number;
  pageSize: number;
  /** `SS` also matches X/XH, `S` also matches SH. */
  rank: string[];
  /** Required mods. Without `modsExact`, DT also matches NC, HT matches DC, SD matches PF. */
  mods: string[];
  /** With `modsExact`: mods that may be present but aren't required. */
  modsOptional: string[];
  modsExcluded: string[];
  /** Only required and optional mods are allowed. */
  modsExact: boolean;
  /** No mods, or Classic alone. Overrides the other mod filters. */
  nomod: boolean;
  /** Keep only the highest-PP score per beatmap (ties: the newer score). */
  bestOnly: boolean;
  /** Beatmap ranked status: ranked, loved, graveyard, ... */
  status: string[];
  modeInt: number | null;
  beatmapId: number | null;
  minPp: number | null;
  maxPp: number | null;
  minStars: number | null;
  maxStars: number | null;
  /** Playback rate: 1.5 for DT, custom rates as set. Variable-rate plays never match. */
  minRate: number | null;
  maxRate: number | null;
  perfect: boolean | null;
  dateFrom: string | null;
  dateTo: string | null;
}

export const DEFAULT_FILTERS: ScoreFilters = {
  q: "",
  sort: "ended_at",
  order: "desc",
  page: 1,
  pageSize: PAGE_SIZE_DEFAULT,
  rank: [],
  mods: [],
  modsOptional: [],
  modsExcluded: [],
  modsExact: false,
  nomod: false,
  bestOnly: false,
  status: [],
  modeInt: null,
  beatmapId: null,
  minPp: null,
  maxPp: null,
  minStars: null,
  maxStars: null,
  minRate: null,
  maxRate: null,
  perfect: null,
  dateFrom: null,
  dateTo: null,
};

const list = (value: string | null) => (value ?? "").split(",").map((part) => part.trim()).filter(Boolean);
const upperList = (value: string | null, pattern: RegExp) => [...new Set(list(value).map((v) => v.toUpperCase()).filter((v) => pattern.test(v)))];
const number = (value: string | null) => {
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const positiveInt = (value: string | null, fallback: number) => {
  const parsed = number(value);
  return parsed !== null && parsed >= 1 ? Math.floor(parsed) : fallback;
};
const bool = (value: string | null) => (value === "true" || value === "1" ? true : value === "false" || value === "0" ? false : null);
const date = (value: string | null) => (value && !Number.isNaN(Date.parse(value)) ? value : null);

const MOD = /^[A-Z0-9]{1,5}$/;
const RANK = /^(XH|X|SS|SH|S|A|B|C|D)$/;

/** Read filters from query parameters. Unknown or malformed values fall back to defaults. */
export function parseScoreFilters(params: URLSearchParams): ScoreFilters {
  const sort = params.get("sort");
  return {
    q: (params.get("q") ?? "").trim(),
    sort: (SORT_KEYS as readonly string[]).includes(sort ?? "") ? (sort as SortKey) : "ended_at",
    order: params.get("order") === "asc" ? "asc" : "desc",
    page: positiveInt(params.get("page"), 1),
    pageSize: Math.min(positiveInt(params.get("page_size"), PAGE_SIZE_DEFAULT), PAGE_SIZE_MAX),
    rank: upperList(params.get("rank"), RANK),
    mods: upperList(params.get("mods"), MOD),
    modsOptional: upperList(params.get("mods_optional"), MOD),
    modsExcluded: upperList(params.get("mods_excluded"), MOD),
    modsExact: params.get("mods_exact") === "true",
    nomod: params.get("nomod") === "true",
    bestOnly: params.get("best_only") === "true",
    status: [...new Set(list(params.get("status")).map((s) => s.toLowerCase()))],
    modeInt: number(params.get("mode_int")),
    beatmapId: number(params.get("beatmap_id")),
    minPp: number(params.get("min_pp")),
    maxPp: number(params.get("max_pp")),
    minStars: number(params.get("min_stars")),
    maxStars: number(params.get("max_stars")),
    minRate: number(params.get("min_rate")),
    maxRate: number(params.get("max_rate")),
    perfect: bool(params.get("perfect")),
    dateFrom: date(params.get("date_from")),
    dateTo: date(params.get("date_to")),
  };
}

/** The inverse of {@link parseScoreFilters}, omitting defaults, for links and pagination. */
export function filtersToParams(filters: ScoreFilters, overrides: Partial<ScoreFilters> = {}): URLSearchParams {
  const f = { ...filters, ...overrides };
  const params = new URLSearchParams();
  const set = (key: string, value: string | number | boolean | null, fallback?: string | number | boolean | null) => {
    if (value !== null && value !== "" && value !== false && value !== fallback) params.set(key, String(value));
  };
  const setList = (key: string, value: string[]) => value.length && params.set(key, value.join(","));
  set("q", f.q);
  set("sort", f.sort, DEFAULT_FILTERS.sort);
  set("order", f.order, DEFAULT_FILTERS.order);
  set("page", f.page, 1);
  set("page_size", f.pageSize, PAGE_SIZE_DEFAULT);
  setList("rank", f.rank);
  setList("mods", f.mods);
  setList("mods_optional", f.modsOptional);
  setList("mods_excluded", f.modsExcluded);
  set("mods_exact", f.modsExact);
  set("nomod", f.nomod);
  set("best_only", f.bestOnly);
  setList("status", f.status);
  set("mode_int", f.modeInt);
  set("beatmap_id", f.beatmapId);
  set("min_pp", f.minPp);
  set("max_pp", f.maxPp);
  set("min_stars", f.minStars);
  set("max_stars", f.maxStars);
  set("min_rate", f.minRate);
  set("max_rate", f.maxRate);
  if (f.perfect !== null) params.set("perfect", String(f.perfect));
  set("date_from", f.dateFrom);
  set("date_to", f.dateTo);
  return params;
}

// Required mods that also accept their stronger variant when "Exact mods" is off.
const MOD_EQUIVALENTS: Record<string, string[]> = { DT: ["DT", "NC"], HT: ["HT", "DC"], SD: ["SD", "PF"] };

/** Search terms reduced to letters, digits and hyphens, so they can't act as LIKE wildcards. */
export function searchWords(q: string): string[] {
  return q.replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/).filter(Boolean);
}

/** WHERE conditions over `scores s join beatmaps b`. */
export function scoreConditions(sql: Sql, userId: number, f: ScoreFilters): PendingQuery<Row[]> {
  const c: PendingQuery<Row[]>[] = [sql`s.user_id = ${userId}`];
  if (f.beatmapId !== null) c.push(sql`s.beatmap_id = ${f.beatmapId}`);
  if (f.modeInt !== null) c.push(sql`s.ruleset_id = ${f.modeInt}`);
  if (f.status.length) c.push(sql`b.status = any(${f.status}::text[])`);
  if (f.minPp !== null) c.push(sql`s.pp >= ${f.minPp}`);
  if (f.maxPp !== null) c.push(sql`s.pp <= ${f.maxPp}`);
  if (f.minStars !== null) c.push(sql`b.difficulty_rating >= ${f.minStars}`);
  if (f.maxStars !== null) c.push(sql`b.difficulty_rating <= ${f.maxStars}`);
  if (f.perfect !== null) c.push(sql`s.perfect = ${f.perfect}`);
  if (f.dateFrom !== null) c.push(sql`s.ended_at >= ${f.dateFrom}::timestamptz`);
  if (f.dateTo !== null) c.push(sql`s.ended_at <= ${f.dateTo}::timestamptz`);
  if (f.minRate !== null) c.push(sql`s.clock_rate >= ${f.minRate}`);
  if (f.maxRate !== null) c.push(sql`s.clock_rate <= ${f.maxRate}`);

  if (f.rank.length) {
    const ranks = new Set(f.rank);
    if (ranks.has("SS")) ranks.add("X").add("XH");
    if (ranks.has("S")) ranks.add("SH");
    c.push(sql`s.rank = any(${[...ranks]}::text[])`);
  }

  if (f.nomod) {
    c.push(sql`s.mod_acronyms <@ array['CL']::text[]`);
  } else {
    if (f.modsExact) {
      const allowed = [...new Set([...f.mods, ...f.modsOptional])];
      c.push(sql`s.mod_acronyms @> ${f.mods}::text[] and s.mod_acronyms <@ ${allowed}::text[]`);
    } else {
      for (const mod of f.mods) {
        const accepted = MOD_EQUIVALENTS[mod];
        c.push(accepted ? sql`s.mod_acronyms && ${accepted}::text[]` : sql`s.mod_acronyms @> ${[mod]}::text[]`);
      }
    }
    if (f.modsExcluded.length) c.push(sql`not (s.mod_acronyms && ${f.modsExcluded}::text[])`);
  }

  for (const word of searchWords(f.q)) {
    const pattern = `%${word}%`;
    c.push(sql`(b.title ilike ${pattern} or b.artist ilike ${pattern} or b.version ilike ${pattern})`);
  }

  return c.reduce((all, condition) => sql`${all} and ${condition}`);
}

export interface BeatmapView {
  id: number;
  beatmapset_id: number;
  artist: string | null;
  title: string | null;
  version: string | null;
  creator: string | null;
  difficulty_rating: number | null;
  bpm: number | null;
  mode_int: number | null;
  status: string | null;
  total_length: number | null;
  hit_length: number | null;
  count_circles: number | null;
  count_sliders: number | null;
  count_spinners: number | null;
  max_combo: number | null;
  ar: number | null;
  od: number | null;
  cs: number | null;
  drain: number | null;
  last_updated: string | null;
  url: string;
  cover_url: string;
  list_url: string;
}

export interface ScoreView {
  id: number;
  user_id: number;
  beatmap_id: number;
  ruleset_id: number;
  ended_at: string;
  rank: string;
  accuracy: number;
  total_score: number;
  legacy_total_score: number | null;
  max_combo: number;
  perfect: boolean;
  count300: number;
  count100: number;
  count50: number;
  countmiss: number;
  mods: ScoreMod[];
  clock_rate: number | null;
  statistics: Record<string, number>;
  maximum_statistics: Record<string, number> | null;
  pp: number | null;
  pp_source: string;
  pp_calculator: string | null;
  pp_updated_at: string | null;
  replay_available: boolean;
  build_id: number | null;
  legacy_score_id: number | null;
  is_lazer: boolean | null;
  preserve: boolean | null;
  score_link_status: string;
  score_link_checked_at: string | null;
  /** Only when the score is known to still exist on osu!. */
  score_url: string | null;
  beatmap: BeatmapView;
}

const iso = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

export function toScoreView(row: Row): ScoreView {
  const b = (row.beatmap ?? {}) as Record<string, unknown>;
  const setId = Number(b.beatmapset_id ?? 0);
  const beatmap = { ...b } as unknown as BeatmapView;
  beatmap.last_updated = iso(b.last_updated);
  beatmap.url = `https://osu.ppy.sh/beatmapsets/${setId}#osu/${String(b.id)}`;
  beatmap.cover_url = `https://assets.ppy.sh/beatmaps/${setId}/covers/cover.jpg`;
  beatmap.list_url = `https://assets.ppy.sh/beatmaps/${setId}/covers/list@2x.jpg`;
  return {
    id: row.id,
    user_id: row.user_id,
    beatmap_id: row.beatmap_id,
    ruleset_id: row.ruleset_id,
    ended_at: iso(row.ended_at) ?? new Date(0).toISOString(),
    rank: row.rank,
    accuracy: row.accuracy,
    total_score: row.total_score,
    legacy_total_score: row.legacy_total_score,
    max_combo: row.max_combo,
    perfect: row.perfect,
    count300: row.count300,
    count100: row.count100,
    count50: row.count50,
    countmiss: row.countmiss,
    mods: normalizeMods(row.mods),
    clock_rate: row.clock_rate,
    statistics: row.statistics ?? {},
    maximum_statistics: row.maximum_statistics ?? null,
    pp: row.pp,
    pp_source: row.pp_source,
    pp_calculator: row.pp_calculator,
    pp_updated_at: iso(row.pp_updated_at),
    replay_available: row.replay_available,
    build_id: row.build_id,
    legacy_score_id: row.legacy_score_id,
    is_lazer: row.is_lazer,
    preserve: row.preserve,
    score_link_status: row.score_link_status,
    score_link_checked_at: iso(row.score_link_checked_at),
    score_url: row.score_link_status === "available" ? `https://osu.ppy.sh/scores/${row.id}` : null,
    beatmap,
  };
}

// Whitelisted, so safe to splice into ORDER BY.
const orderBy = (sql: Sql, table: string, f: ScoreFilters) =>
  sql.unsafe(`${table}.${f.sort} ${f.order === "asc" ? "asc" : "desc"} nulls last, ${table}.id desc`);

const FROM = "from scores s join beatmaps b on b.id = s.beatmap_id";

/** Best-per-map rows, still unsorted. */
function bestPerMap(sql: Sql, userId: number, f: ScoreFilters) {
  return sql`select distinct on (s.beatmap_id) s.*, to_jsonb(b) as beatmap ${sql.unsafe(FROM)}
    where ${scoreConditions(sql, userId, f)}
    order by s.beatmap_id, s.pp desc nulls last, s.id desc`;
}

export interface ScorePage {
  scores: ScoreView[];
  pagination: { page: number; page_size: number; total_count: number; total_pages: number };
}

export async function listScores(sql: Sql, userId: number, f: ScoreFilters): Promise<ScorePage> {
  const offset = (f.page - 1) * f.pageSize;
  const where = scoreConditions(sql, userId, f);
  const [rows, [count]] = f.bestOnly
    ? await Promise.all([
        sql`select * from (${bestPerMap(sql, userId, f)}) t order by ${orderBy(sql, "t", f)} limit ${f.pageSize} offset ${offset}`,
        sql<{ total: number }[]>`select count(distinct s.beatmap_id)::int as total ${sql.unsafe(FROM)} where ${where}`,
      ])
    : await Promise.all([
        sql`select s.*, to_jsonb(b) as beatmap ${sql.unsafe(FROM)} where ${where}
          order by ${orderBy(sql, "s", f)} limit ${f.pageSize} offset ${offset}`,
        sql<{ total: number }[]>`select count(*)::int as total ${sql.unsafe(FROM)} where ${where}`,
      ]);
  const total = count?.total ?? 0;
  return {
    scores: rows.map(toScoreView),
    pagination: { page: f.page, page_size: f.pageSize, total_count: total, total_pages: Math.ceil(total / f.pageSize) },
  };
}

/**
 * Every matching score, without paging, read through a cursor. Ordered by score id, or by the
 * selected sort when keeping the best score per map.
 */
export async function* streamScores(sql: Sql, userId: number, f: ScoreFilters): AsyncGenerator<ScoreView> {
  const query = f.bestOnly
    ? sql`select * from (${bestPerMap(sql, userId, f)}) t order by ${orderBy(sql, "t", f)}`
    : sql`select s.*, to_jsonb(b) as beatmap ${sql.unsafe(FROM)} where ${scoreConditions(sql, userId, f)} order by s.id asc`;
  for await (const rows of query.cursor(500)) {
    for (const row of rows) yield toScoreView(row);
  }
}

export async function getScore(sql: Sql, userId: number, scoreId: number): Promise<ScoreView | null> {
  const [row] = await sql`select s.*, to_jsonb(b) as beatmap ${sql.unsafe(FROM)} where s.id = ${scoreId} and s.user_id = ${userId}`;
  return row ? toScoreView(row) : null;
}

export interface ScoreStats {
  user_id: number;
  total_scores: number;
  recent_scores_24h: number;
  unique_beatmaps_played: number;
  rank_distribution: { SS: number; S: number; A: number; B: number; C: number; D: number };
  top_pp_score: ScoreView | null;
  top_total_score: ScoreView | null;
  user_pp: number | null;
  user_rank: number | null;
  user_play_time: number | null;
}

/** Whole-library aggregates, independent of filters. */
export async function scoreStats(sql: Sql, userId: number): Promise<ScoreStats> {
  const [[summary], [topPp], [topScore], [profile]] = await Promise.all([
    sql`select
        count(*)::int as total,
        count(*) filter (where ended_at >= now() - interval '24 hours')::int as recent,
        count(distinct beatmap_id)::int as maps,
        count(*) filter (where rank in ('SS', 'X', 'XH'))::int as ss,
        count(*) filter (where rank in ('S', 'SH'))::int as s,
        count(*) filter (where rank = 'A')::int as a,
        count(*) filter (where rank = 'B')::int as b,
        count(*) filter (where rank = 'C')::int as c,
        count(*) filter (where rank = 'D')::int as d
      from scores where user_id = ${userId}`,
    sql`select s.*, to_jsonb(b) as beatmap ${sql.unsafe(FROM)} where s.user_id = ${userId}
      order by s.pp desc nulls last, s.id desc limit 1`,
    sql`select s.*, to_jsonb(b) as beatmap ${sql.unsafe(FROM)} where s.user_id = ${userId}
      order by s.total_score desc nulls last, s.id desc limit 1`,
    sql`select pp, global_rank, play_time from osu_users where id = ${userId}`,
  ]);
  return {
    user_id: userId,
    total_scores: summary?.total ?? 0,
    recent_scores_24h: summary?.recent ?? 0,
    unique_beatmaps_played: summary?.maps ?? 0,
    rank_distribution: {
      SS: summary?.ss ?? 0,
      S: summary?.s ?? 0,
      A: summary?.a ?? 0,
      B: summary?.b ?? 0,
      C: summary?.c ?? 0,
      D: summary?.d ?? 0,
    },
    top_pp_score: topPp ? toScoreView(topPp) : null,
    top_total_score: topScore ? toScoreView(topScore) : null,
    user_pp: profile?.pp ?? null,
    user_rank: profile?.global_rank ?? null,
    user_play_time: profile?.play_time ?? null,
  };
}
