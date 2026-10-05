// Discord's media proxy won't play a linked video much over 80–100 MB, and a full-length 1080p60
// render runs to hundreds. A render over the limit gets a smaller copy, which Discord cards and
// link previews point at; the replay page keeps playing the full video. Clips keep to the same
// budget as they're cut.

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

/** What Discord plays reliably, with room to spare (62 MB renders embedded; 206 MB didn't). */
export const EMBED_MAX_BYTES = 75 * 1024 * 1024;

export interface FfmpegOptions {
  ffmpeg: string;
  ffprobe: string;
  /** Extra library directories, for danser's bundled ffmpeg. */
  libraryPath?: string;
  timeoutMs?: number;
}

export function ffmpegEnv(options: FfmpegOptions): NodeJS.ProcessEnv {
  return options.libraryPath
    ? { ...process.env, LD_LIBRARY_PATH: [options.libraryPath, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") }
    : process.env;
}

/** The video's length and its audio track's bitrate (0 without one). */
export async function probeVideo(options: FfmpegOptions, file: string, signal: AbortSignal): Promise<{ durationMs: number; audioBps: number }> {
  const { stdout } = await run(
    options.ffprobe,
    ["-v", "error", "-show_entries", "format=duration:stream=codec_type,bit_rate", "-of", "json", file],
    { env: ffmpegEnv(options), signal, timeout: 60_000 },
  );
  const probe = JSON.parse(stdout) as { format?: { duration?: string }; streams?: { codec_type?: string; bit_rate?: string }[] };
  const durationMs = Math.floor(Number(probe.format?.duration) * 1000);
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error(`ffprobe couldn't read the video's length: ${stdout.trim()}`);
  const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
  // Copied as it is (danser's ffmpeg can't decode audio), so it counts against the budget whole.
  const audioBps = audio ? Number(audio.bit_rate) || 192_000 : 0;
  return { durationMs, audioBps };
}

/**
 * The video bitrate that fits `durationMs` in EMBED_MAX_BYTES next to the audio, and the height to
 * scale to when that bitrate is too thin for 1080p (null: keep the size).
 */
export function embedBudget(durationMs: number, audioBps: number): { videoBps: number; height: number | null } {
  // 5% for the container and the encoder overshooting its rate a little.
  const videoBps = Math.max(250_000, Math.floor((EMBED_MAX_BYTES * 8 * 0.95) / (durationMs / 1000) - audioBps));
  const height = videoBps >= 4_500_000 ? null : videoBps >= 2_000_000 ? 720 : 480;
  return { videoBps, height };
}

/** ffmpeg arguments that keep the video within `videoBps`, scaled down when it must be. */
export function rateCapArgs(budget: { videoBps: number; height: number | null }): string[] {
  return [
    ...(budget.height ? ["-vf", `scale=-2:${budget.height}`] : []),
    "-maxrate", String(budget.videoBps), "-bufsize", String(budget.videoBps),
  ];
}

/** Makes the smaller copy of a render. Tests substitute a fake. */
export interface Embedder {
  /** Re-encodes `source` into `output` within EMBED_MAX_BYTES. Returns the copy's size. */
  shrink(input: { source: string; output: string }, signal: AbortSignal): Promise<number>;
}

/**
 * Re-encodes the video at the bitrate that fits, and copies the audio. NVENC when renders use
 * it (seconds, next to danser on the GPU), x264 otherwise.
 */
export function ffmpegEmbedder(options: FfmpegOptions & { encoder: "h264_nvenc" | "libx264" }): Embedder {
  return {
    async shrink(input, signal) {
      const { durationMs, audioBps } = await probeVideo(options, input.source, signal);
      const budget = embedBudget(durationMs, audioBps);
      const encoder =
        options.encoder === "h264_nvenc"
          ? ["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-b:v", String(budget.videoBps)]
          : ["-c:v", "libx264", "-preset", "veryfast", "-b:v", String(budget.videoBps)];
      await run(
        options.ffmpeg,
        [
          "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
          "-i", input.source,
          "-map", "0:v:0", "-map", "0:a:0?",
          ...encoder, ...rateCapArgs(budget), "-pix_fmt", "yuv420p",
          "-c:a", "copy",
          "-movflags", "+faststart",
          input.output,
        ],
        { env: ffmpegEnv(options), signal, timeout: options.timeoutMs ?? 30 * 60_000, maxBuffer: 1024 * 1024 },
      ).catch((error: Error & { stderr?: string }) => {
        throw new Error(`ffmpeg failed: ${(error.stderr || error.message).trim().split("\n").slice(-5).join("\n")}`);
      });
      const { size } = await fs.stat(input.output);
      if (size > EMBED_MAX_BYTES) throw new Error(`the copy came out at ${(size / 1024 / 1024).toFixed(1)} MB, over Discord's limit`);
      return size;
    },
  };
}
