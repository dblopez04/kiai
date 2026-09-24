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
