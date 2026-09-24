import { randomUUID } from "node:crypto";
import type { Config } from "../config.ts";
import type { Sql } from "../db/index.ts";
import { errorMessage } from "../errors.ts";
import type { OsuClient } from "../osu/api.ts";
import { writeCsvSnapshot } from "../scores/csv.ts";
import { runImport } from "../scores/importer.ts";
import type { PpCalculator } from "../scores/pp.ts";
import { backfillZeroPp, refreshScores } from "../scores/refresh.ts";
import { saveProfile } from "../player.ts";
import { linkReplays } from "../replays/store.ts";
import { claimNextRun, resetLibrary, RunLease } from "./queue.ts";

export interface WorkerDeps {
  sql: Sql;
  osu: OsuClient;
  pp: PpCalculator | null;
  config: Pick<Config, "EXPORT_DIR" | "BACKFILL_ZERO_PP_ON_SYNC">;
  log: (message: string) => void;
  heartbeatMs?: number;
}

/**
 * Claim and run one queued sync job. Returns false if there was nothing to do.
 *
 * On success a CSV snapshot of the whole library is written; if that fails, the job fails. On
 * error the job is marked failed with its checkpoint kept for resuming. If `signal` aborts
 * (shutdown), the job goes back to the queue instead.
 */
export async function runNextJob(deps: WorkerDeps, signal?: AbortSignal): Promise<boolean> {
  const { sql, osu } = deps;
  const token = randomUUID();
  const run = await claimNextRun(sql, token);
  if (!run) return false;

  const lease = new RunLease(sql, run, token);
  const log = (message: string) => deps.log(`[sync ${run.id} ${run.mode} user ${run.user_id}] ${message}`);
  const assertActive = () => {
    lease.assertHeld();
    signal?.throwIfAborted();
  };
  lease.startHeartbeat(deps.heartbeatMs);
  log("started");

  try {
    // Keep the profile (pp, rank, play time) current for the dashboard. Not worth failing over.
    try {
      const profile = await osu.getUser(run.user_id);
      if (profile) await saveProfile(sql, profile);
    } catch (error) {
      log(`profile refresh skipped: ${errorMessage(error)}`);
    }

    let checkpoint = run.checkpoint;
    if (run.mode === "reset" && !checkpoint.resetComplete) {
      // A readable backup first; the database archive and the delete happen atomically after.
      const backup = await writeCsvSnapshot(sql, deps.config.EXPORT_DIR, run.user_id, run.id, "before-reset");
      log(`backup written to ${backup}`);
      assertActive();
      await resetLibrary(sql, lease);
      checkpoint = { resetComplete: true };
    }

    if (run.mode === "refresh") {
      if (!checkpoint.lastRefreshedScoreId) {
        await writeCsvSnapshot(sql, deps.config.EXPORT_DIR, run.user_id, run.id, "before-refresh");
      }
      await refreshScores({
        sql,
        osu,
        pp: deps.pp,
        userId: run.user_id,
        checkpoint,
        assertActive,
        saveCheckpoint: (cp) => lease.update({ checkpoint: cp }),
      });
    } else {
      await runImport({
        sql,
        osu,
        pp: deps.pp,
        userId: run.user_id,
        mode: run.mode === "recent" ? "recent" : "history",
        recentWindowHours: run.recent_window_hours,
        checkpoint,
        assertActive,
        log,
        saveCheckpoint: (cp, stats) =>
          lease.update({
            checkpoint: cp,
            scores_added: run.scores_added + stats.scores_added,
            scores_skipped: run.scores_skipped + stats.scores_skipped,
            beatmaps_upserted: run.beatmaps_upserted + stats.beatmaps_upserted,
          }),
      });
    }

    if (deps.config.BACKFILL_ZERO_PP_ON_SYNC && deps.pp) {
      const backfill = await backfillZeroPp(sql, deps.pp, run.user_id);
      if (backfill.failed) throw new Error(`${backfill.failed} zero-PP recalculations failed. Resume the sync to retry.`);
    }

    // Uploaded replays whose plays just arrived in the library get linked to them.
    const linked = await linkReplays(sql, run.user_id);
    if (linked) log(`linked ${linked} replay(s) to their scores`);

    assertActive();
    const csv = await writeCsvSnapshot(sql, deps.config.EXPORT_DIR, run.user_id, run.id);
    await lease.update({ status: "success", finished_at: new Date(), error_text: null, csv_path: csv });
    log(`done; CSV snapshot at ${csv}`);
  } catch (error) {
    const message = errorMessage(error);
    if (lease.lost) {
      log(message);
    } else if (signal?.aborted) {
      await lease.update({ status: "queued", lease_token: null }).catch(() => {});
      log("interrupted; re-queued to resume later");
    } else {
      await lease.update({ status: "failed", finished_at: new Date(), error_text: message }).catch(() => {});
      log(`failed: ${message}`);
    }
  } finally {
    lease.stopHeartbeat();
  }
  return true;
}
