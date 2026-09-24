// The render worker: claims render jobs, makes sure the beatmap is on disk, runs danser, and
// records the video. It runs in the render container, next to danser and the GPU.

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { sqlJson, type Sql } from "../db/index.ts";
import { errorMessage } from "../errors.ts";
import type { MediaPaths } from "../media.ts";
import type { OsuClient } from "../osu/api.ts";
import { replayAttributes } from "../replays/attributes.ts";
import { getReplay, linkReplays, replayFile, type ReplayView } from "../replays/store.ts";
import { normalizeMods } from "../scores/mods.ts";
import type { Renderer } from "./danser.ts";
import { ensureBeatmap } from "./maps.ts";
import { notifySafely, type Notifier } from "./notify.ts";
import { presetByName } from "./preset.ts";
import { claimRender, RenderLease } from "./queue.ts";

export interface RenderDeps {
  sql: Sql;
  osu: OsuClient | null;
  paths: MediaPaths;
  renderer: Renderer;
  mirrors: readonly string[];
  /** The score library's player, for linking replays to their plays. */
  playerId: number | null;
  /** Discord, when configured. */
  notifier?: Notifier | null;
  fetch?: typeof fetch;
  log: (message: string) => void;
  heartbeatMs?: number;
}

/**
 * Claim and run one render job. Returns false if nothing was queued. A job whose map can't be
 * found waits in `needs_map` until its .osz is uploaded. On shutdown the job goes back to the queue.
 */
export async function runNextRender(deps: RenderDeps, signal?: AbortSignal): Promise<boolean> {
  const { sql, paths } = deps;
  const token = randomUUID();
  const job = await claimRender(sql, token);
  if (!job) return false;

  const stop = new AbortController();
  const lease = new RenderLease(sql, job, token, () => stop.abort());
  const onShutdown = () => stop.abort();
  signal?.addEventListener("abort", onShutdown, { once: true });
  const log = (message: string) => deps.log(`[render ${job.id} replay ${job.replay_id}] ${message}`);
  lease.startHeartbeat(deps.heartbeatMs);
  log(`started (attempt ${job.attempts})`);

  try {
    const [replay] = await sql<
      { beatmap_md5: string; beatmap_id: number | null; mods: unknown; count300: number; count100: number; count50: number; countmiss: number; max_combo: number }[]
    >`select beatmap_md5, beatmap_id, mods, count300, count100, count50, countmiss, max_combo from replays where id = ${job.replay_id}`;
    if (!replay) throw new Error("The replay was deleted.");
    const preset = presetByName(job.preset);
    if (!preset) throw new Error(`Unknown render preset "${job.preset}".`);

    const map = await ensureBeatmap(
      { sql, osu: deps.osu, paths, mirrors: deps.mirrors, log, ...(deps.fetch ? { fetch: deps.fetch } : {}) },
      replay.beatmap_md5,
      replay.beatmap_id,
    );
    if (map.beatmapId !== null && map.beatmapId !== replay.beatmap_id) {
      await sql`update replays set beatmap_id = ${map.beatmapId} where beatmap_md5 = ${replay.beatmap_md5} and beatmap_id is null`;
    }
    if (deps.playerId !== null) await linkReplays(sql, deps.playerId);
    if (!map.ok) {
      // Not a failure: uploading the .osz queues it again.
      await lease.update({ status: "needs_map", error_text: map.reason, lease_token: null, attempts: 0 });
      log(`waiting for the beatmap: ${map.reason}`);
      return true;
    }

    const osu = await fs.readFile(path.join(paths.songs, map.file.folder, map.file.file), "utf8");
    const attributes = replayAttributes(osu, { ...replay, mods: normalizeMods(replay.mods) });
    await sql`update replays set attributes = ${attributes ? sqlJson(sql, attributes) : null} where id = ${job.replay_id}`;

    stop.signal.throwIfAborted();
    const outputName = `${job.replay_id}-${job.id}`;
    let lastProgress = 0;
    const produced = await deps.renderer.render(
      {
        replayFile: replayFile(paths, job.replay_id),
        outputName,
        preset,
        onProgress: (percent) => {
          if (percent <= lastProgress) return;
          lastProgress = percent;
          lease.update({ progress: percent }).catch(() => {});
        },
      },
      stop.signal,
    );

    const video = path.join(paths.videos, `${outputName}.mp4`);
    if (path.resolve(produced) !== video) await fs.rename(produced, video);
    const { size } = await fs.stat(video);
    await lease.update({
      status: "success",
      progress: 100,
      video_path: path.relative(paths.root, video),
      video_bytes: size,
      error_text: null,
      finished_at: new Date(),
      lease_token: null,
    });
    log(`done: ${path.relative(paths.root, video)} (${(size / 1024 / 1024).toFixed(1)} MB)`);
    await notify(deps, job.id, job.replay_id, (n, view) => n.rendered(view), log);
  } catch (error) {
    const message = errorMessage(error);
    if (lease.lost) {
      log(message);
    } else if (signal?.aborted) {
      // Shutting down isn't the job's fault: don't count the attempt.
      await lease.update({ status: "queued", lease_token: null, attempts: Math.max(0, job.attempts - 1), progress: 0 }).catch(() => {});
      log("interrupted; re-queued");
    } else {
      await lease.update({ status: "failed", error_text: message, finished_at: new Date(), lease_token: null }).catch(() => {});
      log(`failed: ${message}`);
      await notify(deps, job.id, job.replay_id, (n, view) => n.failed(view, message), log);
    }
  } finally {
    lease.stopHeartbeat();
    signal?.removeEventListener("abort", onShutdown);
  }
  return true;
}

/** Send one notification per finished job, if a notifier is configured. */
async function notify(
  deps: RenderDeps,
  jobId: number,
  replayId: string,
  send: (notifier: Notifier, replay: ReplayView) => Promise<void>,
  log: (message: string) => void,
): Promise<void> {
  const notifier = deps.notifier;
  if (!notifier) return;
  const [claimed] = await deps.sql`update render_jobs set notified_at = now() where id = ${jobId} and notified_at is null returning id`;
  if (!claimed) return;
  const replay = await getReplay(deps.sql, replayId);
  if (replay && (await notifySafely(() => send(notifier, replay), log))) log("sent the Discord notification");
}

export interface RenderWorkerOptions {
  /** Jobs run at once, each in its own slot. */
  concurrency: number;
  /** Run at most one job per slot, then return. */
  once?: boolean;
  signal?: AbortSignal;
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

/** Run render jobs until `signal` aborts. */
export async function runRenderWorker(deps: RenderDeps, options: RenderWorkerOptions): Promise<void> {
  const slot = async () => {
    while (!options.signal?.aborted) {
      try {
        const worked = await runNextRender(deps, options.signal);
        if (options.once) return;
        if (!worked) await pause(options.idlePollMs ?? 3000, options.signal);
      } catch (error) {
        deps.log(`render worker error: ${errorMessage(error)}`);
        if (options.once) throw error;
        await pause(15_000, options.signal);
      }
    }
  };
  await Promise.all(Array.from({ length: options.concurrency }, slot));
}
