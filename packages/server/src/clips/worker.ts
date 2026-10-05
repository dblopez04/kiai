// Cutting clips out of rendered videos with ffmpeg. Runs in the render worker, which has
// danser's bundled ffmpeg, in a slot of its own so a clip doesn't wait behind a long render.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Sql } from "../db/index.ts";
import { errorMessage, UserError } from "../errors.ts";
import type { MediaPaths } from "../media.ts";
import { notifySafely, type Notifier } from "../render/notify.ts";
import { getReplay } from "../replays/store.ts";
import { claimClip, failClip, failStuckClips, finishClip, formatTimestamp, releaseClip, type Clip } from "./store.ts";

const run = promisify(execFile);

export interface CutInput {
  source: string;
  output: string;
  startMs: number;
  endMs: number;
}

/** Cuts a stretch of a video into a file. Tests substitute a fake. */
export interface Clipper {
  /** Returns where the clip really ends: `endMs`, or the video's end if that comes first. */
  cut(input: CutInput, signal: AbortSignal): Promise<{ endMs: number }>;
}

export interface FfmpegOptions {
  ffmpeg: string;
  ffprobe: string;
  /** Extra library directories, for danser's bundled ffmpeg. */
  libraryPath?: string;
  timeoutMs?: number;
}

/**
 * Re-encodes the stretch with x264, so the cut lands on the exact frame rather than the nearest
 * keyframe. Clips are short, so this takes seconds on the CPU, next to a render on the GPU.
 * The audio is copied: danser's bundled ffmpeg has no audio decoders, and its renders are AAC
 * already, whose packets are short enough (~21 ms) to cut on.
 */
export function ffmpegClipper(options: FfmpegOptions): Clipper {
  const env = options.libraryPath
    ? { ...process.env, LD_LIBRARY_PATH: [options.libraryPath, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") }
    : process.env;
  return {
    async cut(input, signal) {
      const probe = await run(
        options.ffprobe,
        ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", input.source],
        { env, signal, timeout: 60_000 },
      );
      const durationMs = Math.floor(Number(probe.stdout.trim()) * 1000);
      if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error(`ffprobe couldn't read the video's length: ${probe.stdout.trim()}`);
      if (input.startMs >= durationMs) {
        throw new UserError(`The video is only ${formatTimestamp(durationMs)} long, so ${formatTimestamp(input.startMs)} is past its end.`);
      }
      const endMs = Math.min(input.endMs, durationMs);
      await run(
        options.ffmpeg,
        [
          "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
          "-ss", (input.startMs / 1000).toFixed(3),
          "-i", input.source,
          "-t", ((endMs - input.startMs) / 1000).toFixed(3),
          "-map", "0:v:0", "-map", "0:a:0?",
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
          "-c:a", "copy",
          "-movflags", "+faststart",
          input.output,
        ],
        { env, signal, timeout: options.timeoutMs ?? 15 * 60_000, maxBuffer: 1024 * 1024 },
      ).catch((error: Error & { stderr?: string }) => {
        throw new Error(`ffmpeg failed: ${(error.stderr || error.message).trim().split("\n").slice(-5).join("\n")}`);
      });
      return { endMs };
    },
  };
}

export interface ClipDeps {
  sql: Sql;
  paths: MediaPaths;
  clipper: Clipper;
  notifier?: Notifier | null;
  log: (message: string) => void;
}

/** Answer a finished or failed clip on Discord, if a notifier is configured. */
async function answer(deps: ClipDeps, clip: Clip, log: (message: string) => void): Promise<void> {
  const notifier = deps.notifier;
  if (!notifier) return;
  const replay = await getReplay(deps.sql, clip.replay_id);
  if (replay && (await notifySafely(() => notifier.clip(replay, clip), log))) log("answered on Discord");
}

/**
 * Fail clips that can't be made, then cut the oldest one whose replay is rendered. Returns false
 * if there was nothing to cut. On shutdown the clip goes back to the queue.
 */
export async function runNextClip(deps: ClipDeps, signal?: AbortSignal): Promise<boolean> {
  const { sql, paths } = deps;
  for (const stuck of await failStuckClips(sql)) {
    const log = (message: string) => deps.log(`[clip ${stuck.id} replay ${stuck.replay_id}] ${message}`);
    log(`failed: ${stuck.error_text}`);
    await answer(deps, stuck, log);
  }

  const token = randomUUID();
  const claimed = await claimClip(sql, token);
  if (!claimed) return false;
  const { clip, source } = claimed;
  const log = (message: string) => deps.log(`[clip ${clip.id} replay ${clip.replay_id}] ${message}`);
  const tmp = path.join(paths.tmp, `clip-${clip.id}.mp4`);
  const video = path.join(paths.videos, `clip-${clip.id}.mp4`);
  log(`cutting ${formatTimestamp(clip.start_ms)}–${formatTimestamp(clip.end_ms)}`);

  const stop = new AbortController();
  const onShutdown = () => stop.abort();
  signal?.addEventListener("abort", onShutdown, { once: true });
  try {
    const { endMs } = await deps.clipper.cut({ source: path.join(paths.root, source), output: tmp, startMs: clip.start_ms, endMs: clip.end_ms }, stop.signal);
    await fs.rename(tmp, video);
    const { size } = await fs.stat(video);
    const finished = await finishClip(sql, clip.id, token, { path: path.relative(paths.root, video), bytes: size, endMs });
    if (!finished) {
      await fs.rm(video, { force: true });
      log("gave up on it meanwhile; dropped the video");
      return true;
    }
    log(`done: ${path.relative(paths.root, video)} (${(size / 1024 / 1024).toFixed(1)} MB)`);
    await answer(deps, finished, log);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    if (signal?.aborted) {
      await releaseClip(sql, clip.id, token).catch(() => {});
      log("interrupted; re-queued");
    } else {
      const message = errorMessage(error);
      log(`failed: ${message}`);
      const failed = await failClip(sql, clip.id, token, message);
      if (failed) await answer(deps, failed, log);
    }
  } finally {
    signal?.removeEventListener("abort", onShutdown);
  }
  return true;
}
