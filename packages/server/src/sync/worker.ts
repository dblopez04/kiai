import { errorMessage } from "../errors.ts";
import { scheduleRecentSync } from "./queue.ts";
import { runNextJob, type WorkerDeps } from "./runner.ts";

export interface WorkerOptions {
  /** The player whose recent plays are synced on a schedule. */
  playerId: number;
  /** Process at most one job, then return. */
  once?: boolean;
  signal?: AbortSignal;
  /** Queue a recent sync this often; 0 disables. */
  syncIntervalHours: number;
  recentWindowHours: number;
  idlePollMs?: number;
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/** Run sync jobs until `signal` aborts, queuing scheduled recent syncs along the way. */
export async function runWorker(deps: WorkerDeps, options: WorkerOptions): Promise<void> {
  const { signal } = options;
  let lastSchedule = 0;
  while (!signal?.aborted) {
    try {
      if (options.syncIntervalHours > 0 && Date.now() - lastSchedule >= 60_000) {
        lastSchedule = Date.now();
        if (await scheduleRecentSync(deps.sql, options.playerId, options.syncIntervalHours, options.recentWindowHours)) {
          deps.log("scheduled a recent sync");
        }
      }
      const worked = await runNextJob(deps, signal);
      if (options.once) return;
      if (!worked) await pause(options.idlePollMs ?? 5000, signal);
    } catch (error) {
      deps.log(`worker error: ${errorMessage(error)}`);
      if (options.once) throw error;
      await pause(15_000, signal);
    }
  }
}
