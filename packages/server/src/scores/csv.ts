import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Sql } from "../db/index.ts";
import { modLabel } from "./mods.ts";
import { DEFAULT_FILTERS, streamScores, type ScoreFilters, type ScoreView } from "./query.ts";

/** Quote every cell; prefix text that a spreadsheet would run as a formula. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '""';
  let text = String(value);
  if (typeof value === "string" && /^[\s\u0000-\u001f]*[=+@-]|^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export const CSV_COLUMNS = [
  "score_id", "user_id", "beatmap_id", "beatmapset_id", "artist", "title", "difficulty", "mode", "ended_at", "mods",
  "total_score", "accuracy_percent", "max_combo", "rank", "perfect", "count300", "count100", "count50", "countmiss",
  "pp", "pp_source", "stars", "map_status", "score_url", "mods_json", "clock_rate", "score_link_status",
  "pp_calculator", "pp_updated_at",
] as const;

export function csvRow(s: ScoreView): string {
  const b = s.beatmap;
  return (
    [
      s.id, s.user_id, s.beatmap_id, b.beatmapset_id, b.artist, b.title, b.version, s.ruleset_id, s.ended_at,
      s.mods.map(modLabel).join(" "), s.total_score, s.accuracy * 100, s.max_combo, s.rank, s.perfect, s.count300,
      s.count100, s.count50, s.countmiss, s.pp, s.pp_source, b.difficulty_rating, b.status, s.score_url,
      JSON.stringify(s.mods), s.clock_rate, s.score_link_status, s.pp_calculator, s.pp_updated_at,
    ]
      .map(csvCell)
      .join(",") + "\r\n"
  );
}

/** UTF-8 CSV with a BOM (so Excel reads the encoding), CRLF line endings. */
export async function* scoreCsv(sql: Sql, userId: number, filters: ScoreFilters = DEFAULT_FILTERS): AsyncGenerator<string> {
  yield "﻿" + CSV_COLUMNS.map(csvCell).join(",") + "\r\n";
  for await (const score of streamScores(sql, userId, filters)) yield csvRow(score);
}

/**
 * Write the user's whole library to `<dir>/osu-scores-<user>-run-<run>[-suffix].csv`. The file
 * only gets its final name once complete, and is readable by its owner only.
 */
export async function writeCsvSnapshot(sql: Sql, dir: string, userId: number, runId: number, suffix = ""): Promise<string> {
  const directory = path.resolve(dir);
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, `osu-scores-${userId}-run-${runId}${suffix ? `-${suffix}` : ""}.csv`);
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await pipeline(Readable.from(scoreCsv(sql, userId)), createWriteStream(temporary, { mode: 0o600 }));
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
  return file;
}
