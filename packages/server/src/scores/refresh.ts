// "Refresh all PP": re-read every saved score from osu!, take its current official PP, check
// its link, and calculate PP locally for plays osu! no longer has. Nothing is deleted.

import { sqlJson, type Sql } from "../db/index.ts";
import type { OsuClient } from "../osu/api.ts";
import type { SyncCheckpoint } from "../sync/checkpoint.ts";
import { isLazerScore, normalizeMods } from "./mods.ts";
import { PP_CALCULATOR, type PpCalculator } from "./pp.ts";

export interface RefreshContext {
  sql: Sql;
  osu: OsuClient;
  pp: PpCalculator | null;
  userId: number;
  checkpoint: SyncCheckpoint;
  saveCheckpoint: (checkpoint: SyncCheckpoint) => Promise<void>;
  assertActive: () => void;
  now?: () => Date;
}

interface StoredScore {
  id: number;
  beatmap_id: number;
  ruleset_id: number;
  accuracy: number;
  max_combo: number;
  mods: unknown;
  statistics: Record<string, number> | null;
  maximum_statistics: Record<string, number> | null;
  build_id: number | null;
  legacy_score_id: number | null;
  legacy_total_score: number | null;
  is_lazer: boolean | null;
  preserve: boolean | null;
}

export async function refreshScores(ctx: RefreshContext): Promise<void> {
  const { sql, userId, assertActive } = ctx;
  const now = ctx.now ?? (() => new Date());
  const cp: SyncCheckpoint = { ...ctx.checkpoint, phase: "refresh" };
  const [count] = await sql<{ n: number }[]>`select count(*)::int as n from scores where user_id = ${userId}`;
  cp.scoresTotal = count?.n ?? 0;
  await ctx.saveCheckpoint({ ...cp });

  for (;;) {
    assertActive();
    const page = await sql<StoredScore[]>`
      select id, beatmap_id, ruleset_id, accuracy, max_combo, mods, statistics, maximum_statistics,
             build_id, legacy_score_id, legacy_total_score, is_lazer, preserve
      from scores where user_id = ${userId} and id > ${cp.lastRefreshedScoreId ?? 0}
      order by id limit 100`;
    if (page.length === 0) break;

    for (const stored of page) {
      assertActive();
      // Transient failures throw and stop the job; only "no such score" marks it unavailable.
      const live = await ctx.osu.getScore(stored.id);
      if (live && (live.id !== stored.id || live.user_id !== userId)) {
        throw new Error(`osu! returned a different score for id ${stored.id}.`);
      }
      const merged = live
        ? {
            ...stored,
            mods: live.mods ?? stored.mods,
            statistics: (live.statistics as Record<string, number> | undefined) ?? stored.statistics,
            maximum_statistics: (live.maximum_statistics as Record<string, number> | undefined) ?? stored.maximum_statistics,
            build_id: live.build_id ?? null,
            legacy_score_id: live.legacy_score_id ?? null,
            legacy_total_score: live.legacy_total_score ?? null,
            preserve: live.preserve ?? null,
            is_lazer: isLazerScore(live),
          }
        : stored;
      const mods = normalizeMods(merged.mods);
      const official = live && typeof live.pp === "number" && Number.isFinite(live.pp) ? live.pp : null;
      const pp =
        official ??
        (ctx.pp
          ? await ctx.pp(
              {
                beatmapId: stored.beatmap_id,
                rulesetId: stored.ruleset_id,
                mods,
                accuracy: stored.accuracy,
                maxCombo: stored.max_combo,
                statistics: merged.statistics,
                isLazer: merged.is_lazer ?? isLazerScore(merged),
                legacyTotalScore: merged.legacy_total_score,
              },
              { strict: true },
            )
          : null);

      assertActive();
      const at = now();
      await sql`
        update scores set
          pp = ${pp},
          pp_source = ${official !== null ? "osu" : pp !== null ? "local" : "unavailable"},
          pp_calculator = ${official === null && pp !== null ? PP_CALCULATOR : null},
          pp_updated_at = ${at},
          mods = ${sqlJson(sql, mods)},
          statistics = ${sqlJson(sql, merged.statistics ?? {})},
          maximum_statistics = ${merged.maximum_statistics ? sqlJson(sql, merged.maximum_statistics) : null},
          is_lazer = ${merged.is_lazer ?? isLazerScore(merged)},
          build_id = ${merged.build_id},
          legacy_score_id = ${merged.legacy_score_id},
          legacy_total_score = ${merged.legacy_total_score},
          preserve = ${merged.preserve},
          score_link_status = ${live ? "available" : "unavailable"},
          score_link_checked_at = ${at}
        where id = ${stored.id} and user_id = ${userId}`;

      cp.lastRefreshedScoreId = stored.id;
      cp.scoresRefreshed = (cp.scoresRefreshed ?? 0) + 1;
      if (pp === null) cp.ppUnavailable = (cp.ppUnavailable ?? 0) + 1;
      await ctx.saveCheckpoint({ ...cp });
    }
  }
}

export interface BackfillResult {
  scanned: number;
  updated: number;
  failed: number;
}

/** Calculate local PP for every score stored with exactly 0 PP. */
export async function backfillZeroPp(sql: Sql, pp: PpCalculator, userId: number, now: () => Date = () => new Date()): Promise<BackfillResult> {
  const result: BackfillResult = { scanned: 0, updated: 0, failed: 0 };
  let lastId = 0;
  for (;;) {
    const page = await sql<StoredScore[]>`
      select id, beatmap_id, ruleset_id, accuracy, max_combo, mods, statistics, legacy_total_score,
             build_id, legacy_score_id, is_lazer
      from scores where user_id = ${userId} and pp = 0 and id > ${lastId}
      order by id limit 100`;
    if (page.length === 0) return result;
    for (const score of page) {
      lastId = score.id;
      result.scanned += 1;
      const value = await pp({
        beatmapId: score.beatmap_id,
        rulesetId: score.ruleset_id,
        mods: score.mods,
        accuracy: score.accuracy,
        maxCombo: score.max_combo,
        statistics: score.statistics,
        isLazer: score.is_lazer ?? isLazerScore(score),
        legacyTotalScore: score.legacy_total_score,
      });
      if (value === null || value <= 0) {
        result.failed += 1;
        continue;
      }
      await sql`
        update scores set pp = ${value}, pp_source = 'local', pp_calculator = ${PP_CALCULATOR}, pp_updated_at = ${now()}
        where id = ${score.id} and user_id = ${userId} and pp = 0`;
      result.updated += 1;
    }
  }
}
