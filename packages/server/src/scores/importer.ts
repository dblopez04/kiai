// Importing scores from osu!: recent plays, and the full history import that walks every
// osu!standard map on the user's profile "most played" list.

import type { Sql } from "../db/index.ts";
import type { OsuClient } from "../osu/api.ts";
import type { ApiScore } from "../osu/types.ts";
import type { SyncCheckpoint } from "../sync/checkpoint.ts";
import { PP_CALCULATOR, type PpCalculator } from "./pp.ts";
import { beatmapRow, isPassed, scoreRow, wantsLocalPp, type BeatmapRow, type ScorePp } from "./rows.ts";
import { addPlayedMaps, beatmapStatuses, insertScores, loadScoreIds, upsertBeatmaps } from "./store.ts";

export interface ImportStats {
  scores_added: number;
  scores_skipped: number;
  beatmaps_upserted: number;
}

export interface ImportContext {
  sql: Sql;
  osu: OsuClient;
  /** Null when local PP is disabled. */
  pp: PpCalculator | null;
  userId: number;
  mode: "recent" | "history";
  recentWindowHours: number;
  checkpoint: SyncCheckpoint;
  /** Persist progress. Only called after the work it describes is committed. */
  saveCheckpoint: (checkpoint: SyncCheckpoint, stats: ImportStats) => Promise<void>;
  /** Throws when the job should stop (lease lost, shutdown). */
  assertActive: () => void;
  now?: () => number;
  log?: (message: string) => void;
}

const SCORE_BATCH = 100;
const PAGE = 100;
const HYDRATE_BATCH = 50;
const RECENT_REFRESH_MS = 15 * 60 * 1000;

/** Combine a compact and a full beatmap row, preferring whichever has each value. */
function mergeBeatmap(compact: BeatmapRow, full: BeatmapRow | null | undefined): BeatmapRow {
  if (!full) return compact;
  const merged = { ...compact } as Record<string, unknown>;
  for (const [key, value] of Object.entries(full)) if (value !== null) merged[key] = value;
  return merged as unknown as BeatmapRow;
}

export async function runImport(ctx: ImportContext): Promise<ImportStats> {
  const { sql, osu, userId, assertActive } = ctx;
  const now = ctx.now ?? Date.now;
  const log = ctx.log ?? (() => {});
  const stats: ImportStats = { scores_added: 0, scores_skipped: 0, beatmaps_upserted: 0 };
  const checkpoint: SyncCheckpoint = { ...ctx.checkpoint };
  const buffer: (ApiScore & { beatmap_id: number })[] = [];

  const save = async () => {
    assertActive();
    await ctx.saveCheckpoint({ ...checkpoint }, { ...stats });
  };

  const known = await loadScoreIds(sql, userId);
  log(`${known.size} scores already saved`);

  async function resolvePp(score: ApiScore & { beatmap_id: number }, status: string | null): Promise<ScorePp> {
    const official: ScorePp = { pp: score.pp ?? null, source: score.pp != null ? "osu" : "unavailable" };
    if (!ctx.pp || !wantsLocalPp(score.pp, status)) return official;
    const local = await ctx.pp({
      beatmapId: score.beatmap_id,
      rulesetId: score.ruleset_id ?? null,
      mods: score.mods,
      accuracy: score.accuracy ?? null,
      maxCombo: score.max_combo ?? null,
      statistics: score.statistics ?? null,
      legacyTotalScore: score.legacy_total_score ?? null,
    });
    return local === null ? official : { pp: local, source: "local", calculator: PP_CALCULATOR };
  }

  async function flush() {
    if (buffer.length === 0) return;
    const batch = buffer.splice(0, buffer.length);
    const statuses = await beatmapStatuses(sql, [...new Set(batch.map((s) => s.beatmap_id))]);
    const rows = [];
    for (const score of batch) {
      assertActive();
      const pp = await resolvePp(score, statuses.get(score.beatmap_id) ?? null);
      rows.push(scoreRow(score, userId, score.beatmap_id, pp, new Date(now())));
    }
    assertActive();
    stats.scores_added += await insertScores(sql, rows, assertActive);
  }

  async function queueScore(score: ApiScore, beatmapId: number) {
    if (!Number.isSafeInteger(score.id) || score.id <= 0 || !isPassed(score)) return;
    if (known.has(score.id)) {
      stats.scores_skipped += 1;
      return;
    }
    known.add(score.id);
    buffer.push({ ...score, beatmap_id: beatmapId });
    if (buffer.length >= SCORE_BATCH) await flush();
  }

  async function saveBeatmaps(rows: BeatmapRow[]) {
    stats.beatmaps_upserted += await upsertBeatmaps(sql, rows, assertActive);
    // Only osu!standard maps are checked during history imports.
    await addPlayedMaps(sql, userId, rows.filter((row) => row.mode_int === 0).map((row) => row.id), assertActive);
  }

  async function fetchRecent() {
    log(`fetching plays from the last ${ctx.recentWindowHours}h`);
    const cutoff = now() - ctx.recentWindowHours * 3600 * 1000;
    for (let offset = 0; ; ) {
      assertActive();
      const page = await osu.getRecentScores(userId, PAGE, offset);
      if (page.length === 0) break;
      await saveBeatmaps(page.flatMap((s) => beatmapRow(s.beatmap, s.beatmapset) ?? []));
      let insideWindow = false;
      for (const score of page) {
        const endedAt = Date.parse(score.ended_at ?? "");
        if (!Number.isFinite(endedAt) || endedAt < cutoff) continue;
        insideWindow = true;
        const beatmapId = score.beatmap?.id ?? score.beatmap_id;
        if (typeof beatmapId === "number") await queueScore(score, beatmapId);
      }
      if (page.length < PAGE || !insideWindow) break;
      offset += page.length;
    }
    await flush();
    checkpoint.lastRecentAt = new Date(now()).toISOString();
    checkpoint.phase = "recent";
    await save();
  }

  /** Keep recording new plays while a long history import runs. */
  async function refreshRecentIfDue() {
    const last = checkpoint.lastRecentAt ? Date.parse(checkpoint.lastRecentAt) : 0;
    if (!last || now() - last >= RECENT_REFRESH_MS) await fetchRecent();
  }

  async function syncPlayedList() {
    if (checkpoint.playedListComplete) return;
    checkpoint.phase = "played-list";
    await save();
    for (;;) {
      assertActive();
      await refreshRecentIfDue();
      const offset = checkpoint.playedListOffset ?? 0;
      const page = await osu.getMostPlayed(userId, PAGE, offset);
      if (page.length === 0) {
        checkpoint.playedListComplete = true;
        await save();
        return;
      }
      const pageKey = page.map((entry) => entry.beatmap_id).join(",");
      if (pageKey === checkpoint.playedListLastPage) {
        throw new Error("osu! returned the same page of played maps twice. Resume the import to retry.");
      }
      const compact = page
        .map((entry) => beatmapRow(entry.beatmap, entry.beatmapset))
        .filter((row): row is BeatmapRow => row !== null && row.mode_int === 0);
      // The profile list only has compact maps; fetch full details in batches.
      for (let from = 0; from < compact.length; from += HYDRATE_BATCH) {
        assertActive();
        const batch = compact.slice(from, from + HYDRATE_BATCH);
        const full = new Map((await osu.getBeatmaps(batch.map((row) => row.id))).map((b) => [b.id, beatmapRow(b)]));
        await saveBeatmaps(batch.map((row) => mergeBeatmap(row, full.get(row.id))));
      }
      // Advance by what came back, not the requested page size: osu! may cap pages.
      checkpoint.playedListLastPage = pageKey;
      checkpoint.playedListOffset = offset + page.length;
      await save();
    }
  }

  async function checkPlayedMaps() {
    const after = checkpoint.lastBeatmapId ?? 0;
    const [done] = await sql<{ n: number }[]>`
      select count(*)::int as n from user_played_maps where user_id = ${userId} and beatmap_id <= ${after}`;
    const remaining = await sql<{ beatmap_id: number }[]>`
      select beatmap_id from user_played_maps where user_id = ${userId} and beatmap_id > ${after} order by beatmap_id`;
    checkpoint.mapsProcessed = done?.n ?? 0;
    checkpoint.mapsTotal = checkpoint.mapsProcessed + remaining.length;
    checkpoint.phase = "scores";
    await save();
    log(`${remaining.length} played osu!standard maps left to check`);

    for (const { beatmap_id } of remaining) {
      assertActive();
      await refreshRecentIfDue();
      for (const score of await osu.getBeatmapUserScores(beatmap_id, userId)) await queueScore(score, beatmap_id);
      // Commit this map's scores before recording it as done.
      await flush();
      checkpoint.lastBeatmapId = beatmap_id;
      checkpoint.mapsProcessed = (checkpoint.mapsProcessed ?? 0) + 1;
      await save();
    }
  }

  if (ctx.mode === "history") {
    await syncPlayedList();
    await fetchRecent();
    await checkPlayedMaps();
  } else {
    await fetchRecent();
  }
  await flush();
  checkpoint.phase = "export";
  await save();
  log(`added ${stats.scores_added}, skipped ${stats.scores_skipped} already saved`);
  return stats;
}
