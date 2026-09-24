// Running danser-cli to record a replay. danser 0.11 keeps its settings, database and logs next
// to its binary, finds beatmaps by scanning OsuSongsDir, and writes <OutputDir>/<out>.mp4.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { MediaPaths } from "../media.ts";
import type { RenderPreset } from "./presets.ts";

export interface RenderInput {
  replayFile: string;
  /** File name without extension; the video lands at `<paths.videos>/<outputName>.mp4`. */
  outputName: string;
  preset: RenderPreset;
  onProgress: (percent: number) => void;
}

/** Produces a video from a replay whose beatmap is already in the Songs directory. Tests substitute a fake. */
export interface Renderer {
  /** Returns the video's path. Rejects if no video was produced; aborting `signal` stops the render. */
  render(input: RenderInput, signal: AbortSignal): Promise<string>;
}

export interface DanserOptions {
  dir: string;
  paths: MediaPaths;
  encoder: string;
  /** Wrap danser in `xvfb-run`: it opens a (hidden) window even when recording. */
  xvfb: boolean;
  /**
   * Where danser's OpenGL runs. "gpu" wraps it in VirtualGL's `vglrun -d egl`, which sends GL to
   * the GPU through EGL while the window lives on Xvfb. "software" leaves GL to whatever the
   * display offers, which under Xvfb is Mesa's llvmpipe: every frame drawn on the CPU.
   */
  gl: "gpu" | "software";
  timeoutMs: number;
  log?: (message: string) => void;
  /** Overrides the executable, for tests. */
  command?: string;
}

/** The settings file danser loads (`-settings kiai`). Presets patch it per run. */
export const SETTINGS_NAME = "kiai";

/**
 * Base settings. They go in a real file rather than the per-run patch because danser scans the
 * Songs directory before it applies `-sPatch` when the settings file is new.
 */
export function baseSettings(options: Pick<DanserOptions, "paths" | "encoder">) {
  return {
    General: {
      OsuSongsDir: options.paths.songs,
      OsuSkinsDir: options.paths.skins,
      DiscordPresenceOn: false,
      UnpackOszFiles: false,
    },
    Recording: {
      Encoder: options.encoder,
      OutputDir: options.paths.videos,
      Container: "mp4",
    },
  };
}

const PROGRESS = /Progress: (\d{1,3})%/;
const GL_RENDERER = /GL Renderer:\s*(.+)$/;
const SOFTWARE_GL = /llvmpipe|softpipe|swrast|software rasterizer/i;
const TAIL_LINES = 30;

/** The command line for one render: danser-cli, inside vglrun and xvfb-run as configured. */
export function danserCommand(options: Pick<DanserOptions, "xvfb" | "gl">, executable: string, args: readonly string[]): string[] {
  // VGL_READBACK=none (set in the environment) skips copying frames back to Xvfb: danser reads
  // its frames from its own buffers, and nobody looks at the hidden window.
  const inner = options.gl === "gpu" ? ["vglrun", "-d", "egl", executable, ...args] : [executable, ...args];
  return options.xvfb ? ["xvfb-run", "-a", "-s", "-screen 0 1920x1080x24", ...inner] : inner;
}

export function danserRenderer(options: DanserOptions): Renderer {
  const executable = options.command ?? path.join(options.dir, "danser-cli");
  return {
    async render(input, signal) {
      // danser rewrites its settings file on load, so write ours before every run.
      await fs.mkdir(path.join(options.dir, "settings"), { recursive: true });
      await fs.writeFile(path.join(options.dir, "settings", `${SETTINGS_NAME}.json`), JSON.stringify(baseSettings(options), null, 2));
      const output = path.join(options.paths.videos, `${input.outputName}.mp4`);
      await fs.rm(output, { force: true });

      const args = [
        "-replay", input.replayFile,
        "-record",
        "-out", input.outputName,
        "-settings", SETTINGS_NAME,
        "-skin", input.preset.skin,
        "-sPatch", JSON.stringify(input.preset.patch),
        "-quickstart",
        "-noupdatecheck",
        "-preciseprogress",
        ...(input.preset.skipIntro ? ["-skip"] : []),
      ];
      const [command, ...commandArgs] = danserCommand(options, executable, args);

      const tail: string[] = [];
      let glReported = false;
      const code = await new Promise<number | string>((resolve, reject) => {
        const child = spawn(command!, commandArgs, {
          cwd: options.dir,
          env: {
            ...process.env,
            // danser's bundled ffmpeg has a broken rpath; point it at its libraries.
            LD_LIBRARY_PATH: [path.join(options.dir, "ffmpeg"), options.dir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":"),
            ...(options.gl === "gpu" ? { VGL_READBACK: "none" } : {}),
          },
          stdio: ["ignore", "pipe", "pipe"],
          // Its own process group, so stopping it also stops Xvfb and ffmpeg.
          detached: true,
        });
        const kill = (sig: NodeJS.Signals) => {
          try {
            process.kill(-child.pid!, sig);
          } catch {
            // Already gone.
          }
        };
        let stopReason: string | null = null;
        const stop = (reason: string) => {
          if (stopReason) return;
          stopReason = reason;
          kill("SIGTERM");
          setTimeout(() => kill("SIGKILL"), 10_000).unref();
        };
        const timer = setTimeout(() => stop(`timed out after ${Math.round(options.timeoutMs / 60_000)} minutes`), options.timeoutMs);
        const onAbort = () => stop("stopped");
        signal.addEventListener("abort", onAbort, { once: true });

        let pending = "";
        const onData = (chunk: Buffer) => {
          pending += chunk.toString("utf8");
          const lines = pending.split(/\r?\n|\r/);
          pending = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            tail.push(line);
            if (tail.length > TAIL_LINES) tail.shift();
            const match = PROGRESS.exec(line);
            if (match) input.onProgress(Math.min(100, Number(match[1])));
            const renderer = glReported ? null : GL_RENDERER.exec(line);
            if (renderer) {
              glReported = true;
              const name = renderer[1]!.trim();
              if (SOFTWARE_GL.test(name)) {
                options.log?.(
                  `danser is drawing with ${name}, on the CPU, which makes renders very slow.` +
                    (options.gl === "gpu"
                      ? " VirtualGL found no GPU: give the container NVIDIA_DRIVER_CAPABILITIES with graphics (see compose.yaml)."
                      : " Set RENDER_GL=gpu on an NVIDIA host (compose's nvidia profile does)."),
                );
              } else {
                options.log?.(`danser is drawing with ${name}`);
              }
            }
          }
        };
        child.stdout!.on("data", onData);
        child.stderr!.on("data", onData);
        child.on("error", (error) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          reject(new Error(`Couldn't start ${command}: ${error.message}`));
        });
        child.on("close", (exitCode, exitSignal) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          resolve(stopReason ?? exitCode ?? exitSignal ?? "unknown");
        });
      });

      signal.throwIfAborted();
      const size = await fs.stat(output).then((stat) => stat.size, () => 0);
      if (code === 0 && size > 0) return output;
      await fs.rm(output, { force: true });
      const notFound = tail.some((line) => line.includes("Beatmap not found"));
      const reason = notFound
        ? "danser couldn't find the beatmap in its Songs directory."
        : typeof code === "number"
          ? `danser exited with code ${code}${code === 0 ? " without writing a video" : ""}.`
          : `danser ${code}.`;
      throw new Error(`${reason} Last output:\n${tail.slice(-12).join("\n")}`);
    },
  };
}
