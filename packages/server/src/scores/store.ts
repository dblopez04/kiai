// Writes shared by the importer, the PP refresh and the reset.

import { retryDb, sqlJson, type Sql } from "../db/index.ts";
import { BEATMAP_COLUMNS, type BeatmapRow, type ScoreRow } from "./rows.ts";

const nonNullFields = (row: object) => Object.values(row).filter((value) => value !== null).length;

// Compact beatmaps (from score or profile lists) lack most details; never let them erase a full row.
const BEATMAP_MERGE = BEATMAP_COLUMNS.filter((column) => column !== "id")
  .map((column) => `${column} = coalesce(excluded.${column}, beatmaps.${column})`)
  .join(", ");

/** Insert or enrich beatmaps. Returns how many distinct beatmaps were written. */
export async function upsertBeatmaps(sql: Sql, rows: Iterable<BeatmapRow>, assertActive?: () => void): Promise<number> {
  const unique = new Map<number, BeatmapRow>();
  for (const row of rows) {
    const existing = unique.get(row.id);
    if (!existing || nonNullFields(row) > nonNullFields(existing)) unique.set(row.id, row);
  }
  const all = [...unique.values()];
  for (let from = 0; from < all.length; from += 1000) {
    const chunk = all.slice(from, from + 1000);
    await retryDb(
      () => sql`insert into beatmaps ${sql(chunk, ...BEATMAP_COLUMNS)} on conflict (id) do update set ${sql.unsafe(BEATMAP_MERGE)}`,
      assertActive,
    );
  }
  return all.length;
}

export async function addPlayedMaps(sql: Sql, userId: number, beatmapIds: Iterable<number>, assertActive?: () => void): Promise<void> {
  const rows = [...new Set(beatmapIds)].map((beatmap_id) => ({ user_id: userId, beatmap_id }));
  if (rows.length === 0) return;
  await retryDb(
    () => sql`insert into user_played_maps ${sql(rows, "user_id", "beatmap_id")} on conflict do nothing`,
    assertActive,
  );
}

const SCORE_COLUMNS = [
  "id", "user_id", "beatmap_id", "ruleset_id", "ended_at", "rank", "accuracy", "total_score", "legacy_total_score",
  "max_combo", "perfect", "count300", "count100", "count50", "countmiss", "mods", "statistics", "maximum_statistics",
  "pp", "pp_source", "pp_calculator", "pp_updated_at", "replay_available", "build_id", "legacy_score_id", "is_lazer",
  "preserve", "score_link_status", "score_link_checked_at",
] as const satisfies readonly (keyof ScoreRow)[];

/** Insert new scores, ignoring ids that already exist. Returns how many were inserted. */
export async function insertScores(sql: Sql, rows: readonly ScoreRow[], assertActive?: () => void): Promise<number> {
  if (rows.length === 0) return 0;
  const payload = rows.map((row) => ({
    ...row,
    mods: sqlJson(sql, row.mods),
    statistics: sqlJson(sql, row.statistics),
    maximum_statistics: row.maximum_statistics === null ? null : sqlJson(sql, row.maximum_statistics),
  }));
  const inserted = await retryDb(
    () => sql`insert into scores ${sql(payload, ...SCORE_COLUMNS)} on conflict (id) do nothing returning id`,
    assertActive,
  );
  return inserted.length;
}

export async function loadScoreIds(sql: Sql, userId: number): Promise<Set<number>> {
  const rows = await retryDb(() => sql<{ id: number }[]>`select id from scores where user_id = ${userId}`);
  return new Set(rows.map((row) => row.id));
}

export async function beatmapStatuses(sql: Sql, beatmapIds: readonly number[]): Promise<Map<number, string | null>> {
  if (beatmapIds.length === 0) return new Map();
  const rows = await retryDb(
    () => sql<{ id: number; status: string | null }[]>`select id, status from beatmaps where id = any(${[...beatmapIds]}::bigint[])`,
  );
  return new Map(rows.map((row) => [row.id, row.status]));
}
