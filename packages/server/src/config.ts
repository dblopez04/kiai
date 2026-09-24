import { z } from "zod";
import { UserError } from "./errors.ts";

const flag = z
  .enum(["true", "false", "1", "0"])
  .transform((value) => value === "true" || value === "1");

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "set it to a postgres:// connection string"),
  /** osu! OAuth application (https://osu.ppy.sh/home/account/edit#oauth). No callback URL is needed. */
  OSU_CLIENT_ID: z.coerce.number().int().positive().optional(),
  OSU_CLIENT_SECRET: z.string().min(1).optional(),
  /** The player whose scores are imported: an osu! username or user id. */
  OSU_USER: z.string().trim().min(1).optional(),
  /**
   * Extra hostnames the private web UI answers to, comma-separated. IPs, `localhost`, single-label
   * names and .local/.lan/.home.arpa/.internal/.ts.net names are always allowed.
   */
  PRIVATE_HOSTS: z
    .string()
    .default("")
    .transform((value) => value.split(",").map((host) => host.trim().toLowerCase()).filter(Boolean)),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  /** Where CSV snapshots are written after every successful sync. */
  EXPORT_DIR: z.string().default("data/exports"),
  /** How far back "Sync recent" looks. */
  RECENT_WINDOW_HOURS: z.coerce.number().int().positive().default(24),
  /** The worker queues a recent sync for every tracked user this often. 0 disables it. */
  SYNC_INTERVAL_HOURS: z.coerce.number().min(0).default(12),
  /** Calculate PP with rosu-pp for plays osu! gives none (loved, unranked, deleted). */
  LOCAL_PP: flag.default(true),
  /** After each sync, recalculate locally any score stored with exactly 0 PP. */
  BACKFILL_ZERO_PP_ON_SYNC: flag.default(false),
  /** Crawl osu!'s lobby and ranked play lists for new matches the player played in. */
  MATCH_DISCOVERY: flag.default(true),

  // ---------- replays and rendering ----------

  /** Uploaded replays, rendered videos and the beatmaps and skins danser reads. */
  DATA_DIR: z.string().default("data"),
  /** Clients send this as a bearer token to upload replays and beatmaps. Uploads are refused until it's set. */
  UPLOAD_TOKEN: z.string().trim().min(16, "use at least 16 characters, e.g. the output of `openssl rand -hex 24`").optional(),
  /** Beatmap set download URLs, tried in order; `{set}` is replaced by the beatmapset id. */
  MAP_MIRRORS: z
    .string()
    .default("https://catboy.best/d/{set},https://api.nerinyan.moe/d/{set},https://osu.direct/api/d/{set}")
    .transform((value) => value.split(",").map((url) => url.trim()).filter(Boolean))
    .refine((urls) => urls.every((url) => /^https?:\/\//.test(url) && url.includes("{set}")), "each entry must be an http(s) URL containing {set}"),
  /** Where danser 0.11 (`danser-cli`, its libraries and bundled ffmpeg) is unpacked. It keeps its settings and database there too. */
  DANSER_DIR: z.string().default("/opt/danser"),
  /** ffmpeg encoder for renders. h264_nvenc suits NVIDIA GPUs from Pascal on; libx264 needs no GPU. */
  RENDER_ENCODER: z
    .enum(["h264_nvenc", "hevc_nvenc", "av1_nvenc", "h264_qsv", "hevc_qsv", "h264_amf", "hevc_amf", "av1_amf", "libx264", "libx265", "libsvtav1"])
    .default("h264_nvenc"),
  /** Renders run at once by this worker. danser shares one database per install, so keep 1 unless you know it copes. */
  RENDER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
  /** A render still running after this long is stopped and failed. */
  RENDER_TIMEOUT_MINUTES: z.coerce.number().positive().default(60),
  /** Run danser under xvfb-run, since it needs an X display even when recording. */
  RENDER_XVFB: flag.default(true),
  /**
   * Where danser draws: "gpu" runs its OpenGL on the GPU through VirtualGL (the render image has
   * it; compose's nvidia profile sets this). "software" is Mesa on the CPU, many times slower.
   */
  RENDER_GL: z.enum(["gpu", "software"]).default("software"),

  // ---------- public replay pages and notifications ----------

  /** The public replay app's address as viewers see it, e.g. https://replays.example.com. Used in links and embeds. */
  PUBLIC_URL: z
    .string()
    .trim()
    .regex(/^https?:\/\/[^/?#\s]+$/, "expected an address such as https://replays.example.com, without a path")
    .optional(),
  /** Port of the public replay app (`server public`). Only this port is ever routed to the tunnel. */
  PUBLIC_PORT: z.coerce.number().int().min(1).max(65535).default(8081),
  /** Discord: a DM from a bot that shares a server with you (both needed)... */
  DISCORD_BOT_TOKEN: z.string().trim().min(1).optional(),
  DISCORD_USER_ID: z.string().trim().regex(/^\d{15,22}$/, "expected your Discord user id (Developer Mode → Copy User ID)").optional(),
  /** ...or a webhook into a (private) channel. */
  DISCORD_WEBHOOK_URL: z
    .string()
    .trim()
    .regex(/^https:\/\/(discord\.com|discordapp\.com|canary\.discord\.com)\/api\/webhooks\/\d+\/[\w-]+$/, "expected a Discord webhook URL")
    .optional(),
});

export type Config = z.infer<typeof envSchema>;
export type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): Config {
  // Treat empty values (`FOO=` in .env files) as unset.
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value !== ""));
  const parsed = envSchema.safeParse(present);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `  ${issue.path.join(".")}: ${issue.message}`);
    throw new UserError(`Invalid configuration:\n${problems.join("\n")}`);
  }
  return parsed.data;
}

export function requireOsuCredentials(config: Config): { clientId: number; clientSecret: string } {
  if (config.OSU_CLIENT_ID === undefined || config.OSU_CLIENT_SECRET === undefined) {
    throw new UserError(
      "OSU_CLIENT_ID and OSU_CLIENT_SECRET are required. Create an OAuth application at " +
        "https://osu.ppy.sh/home/account/edit#oauth (any callback URL works) and put its id and secret in .env.",
    );
  }
  return { clientId: config.OSU_CLIENT_ID, clientSecret: config.OSU_CLIENT_SECRET };
}

export function requireOsuUser(config: Config): string {
  if (config.OSU_USER === undefined) {
    throw new UserError("OSU_USER is required: set it in .env to your osu! username or user id.");
  }
  return config.OSU_USER;
}
