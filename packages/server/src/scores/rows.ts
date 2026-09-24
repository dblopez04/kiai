// Turning osu! API payloads into database rows.

import type { ApiBeatmap, ApiBeatmapset, ApiScore } from "../osu/types.ts";
import { isLazerScore, normalizeMods, type ScoreMod } from "./mods.ts";

export interface BeatmapRow {
  id: number;
  beatmapset_id: number;
  user_id: number | null;
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
}

export const BEATMAP_COLUMNS = [
  "id", "beatmapset_id", "user_id", "artist", "title", "version", "creator", "difficulty_rating", "bpm", "mode_int",
  "status", "total_length", "hit_length", "count_circles", "count_sliders", "count_spinners", "max_combo",
  "ar", "od", "cs", "drain", "last_updated",
] as const satisfies readonly (keyof BeatmapRow)[];

export type PpSource = "osu" | "local" | "unavailable";

export interface ScoreRow {
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
  statistics: Record<string, number>;
  maximum_statistics: Record<string, number> | null;
  pp: number | null;
  pp_source: PpSource;
  pp_calculator: string | null;
  pp_updated_at: string;
  replay_available: boolean;
  build_id: number | null;
  legacy_score_id: number | null;
  is_lazer: boolean;
  preserve: boolean | null;
  score_link_status: "available" | "unknown";
  score_link_checked_at: string | null;
}

const MODES: Record<string, number> = { osu: 0, taiko: 1, fruits: 2, mania: 3 };

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const int = (value: unknown): number | null => {
  const n = num(value);
  return n === null ? null : Math.trunc(n);
};
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number" && !(value instanceof Date)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** A beatmap row from a full or compact beatmap. Null if ids are missing. */
export function beatmapRow(beatmap: ApiBeatmap | undefined, beatmapset?: ApiBeatmapset): BeatmapRow | null {
  if (!beatmap) return null;
  const set = beatmapset ?? beatmap.beatmapset;
  const id = int(beatmap.id);
  const setId = int(beatmap.beatmapset_id) ?? int(set?.id);
  if (!id || id <= 0 || !setId || setId <= 0) return null;
  return {
    id,
    beatmapset_id: setId,
    user_id: int(beatmap.user_id) ?? int(set?.user_id),
    artist: str(set?.artist),
    title: str(set?.title) ?? str(set?.title_unicode),
    version: str(beatmap.version),
    creator: str(set?.creator),
    difficulty_rating: num(beatmap.difficulty_rating),
    bpm: num(beatmap.bpm) ?? num(set?.bpm),
    mode_int: int(beatmap.mode_int) ?? (beatmap.mode !== undefined ? (MODES[beatmap.mode] ?? null) : null),
    status: str(beatmap.status) ?? str(set?.status),
    total_length: int(beatmap.total_length),
    hit_length: int(beatmap.hit_length),
    count_circles: int(beatmap.count_circles),
    count_sliders: int(beatmap.count_sliders),
    count_spinners: int(beatmap.count_spinners),
    max_combo: int(beatmap.max_combo),
    ar: num(beatmap.ar),
    od: num(beatmap.accuracy),
    cs: num(beatmap.cs),
    drain: num(beatmap.drain),
    last_updated: isoOrNull(beatmap.last_updated) ?? isoOrNull(set?.last_updated),
  };
}

/** Failed plays are never stored. */
export function isPassed(score: ApiScore): boolean {
  return score.passed !== false && score.rank !== "F";
}

function numericStats(stats: unknown): Record<string, number> {
  if (!stats || typeof stats !== "object") return {};
  return Object.fromEntries(Object.entries(stats).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
}

export interface ScorePp {
  pp: number | null;
  source: PpSource;
  calculator?: string | null;
}

export function scoreRow(score: ApiScore, userId: number, beatmapId: number, pp: ScorePp, now: Date = new Date()): ScoreRow {
  const stats = numericStats(score.statistics);
  const stat = (lazer: string, legacy: string) => stats[lazer] || stats[legacy] || 0;
  // Scores returned in the current API format are live on osu!, so the link is known to work.
  const live = score.type === "solo_score";
  return {
    id: score.id,
    user_id: userId,
    beatmap_id: beatmapId,
    ruleset_id: score.ruleset_id ?? 0,
    ended_at: isoOrNull(score.ended_at) ?? now.toISOString(),
    rank: score.rank ?? "D",
    accuracy: score.accuracy ?? 0,
    total_score: score.total_score ?? score.score ?? 0,
    legacy_total_score: score.legacy_total_score ?? null,
    max_combo: score.max_combo ?? 0,
    perfect: score.is_perfect_combo ?? score.perfect ?? score.legacy_perfect ?? false,
    count300: stat("great", "count_300"),
    count100: stat("ok", "count_100"),
    count50: stat("meh", "count_50"),
    countmiss: stat("miss", "count_miss"),
    mods: normalizeMods(score.mods),
    statistics: stats,
    maximum_statistics: score.maximum_statistics ? numericStats(score.maximum_statistics) : null,
    pp: pp.pp,
    pp_source: pp.source,
    pp_calculator: pp.calculator ?? null,
    pp_updated_at: now.toISOString(),
    replay_available: score.has_replay ?? score.replay ?? false,
    build_id: score.build_id ?? null,
    legacy_score_id: score.legacy_score_id ?? null,
    is_lazer: isLazerScore(score),
    preserve: score.preserve ?? null,
    score_link_status: live ? "available" : "unknown",
    score_link_checked_at: live ? now.toISOString() : null,
  };
}

/**
 * Whether to replace or supply PP locally: always when osu! gives none, and for maps whose
 * official PP isn't meaningful (loved, qualified, graveyard, ...). Ranked and approved maps keep
 * osu!'s value.
 */
export function wantsLocalPp(officialPp: number | null | undefined, beatmapStatus: string | null): boolean {
  if (officialPp === null || officialPp === undefined) return true;
  if (!beatmapStatus) return false;
  return !["ranked", "approved"].includes(beatmapStatus.toLowerCase());
}
