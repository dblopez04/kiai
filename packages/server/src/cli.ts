import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { serve as serveHttp } from "@hono/node-server";
import pkg from "../package.json" with { type: "json" };
import { loadConfig, requireOsuCredentials, requireOsuUser, type Config, type Env } from "./config.ts";
import { connectDb, migrate, type Sql } from "./db/index.ts";
import { UserError } from "./errors.ts";
import { createApp } from "./http/app.ts";
import { createPublicApp } from "./http/public.ts";
import { scanStableFrom } from "./matches/discovery.ts";
import { parseMatchRefs } from "./matches/import.ts";
import { enqueueMatches } from "./matches/queue.ts";
import { runMatchWorker } from "./matches/worker.ts";
import { ensureMediaDirs, mediaPaths } from "./media.ts";
import { OsuApi, type OsuClient } from "./osu/api.ts";
import { RateLimiter } from "./osu/rate-limit.ts";
import { resolvePlayer, type Player } from "./player.ts";
import { danserRenderer } from "./render/danser.ts";
import { discordNotifier } from "./render/notify.ts";
import { runRenderWorker } from "./render/worker.ts";
import { scoreCsv } from "./scores/csv.ts";
import { createPpCalculator, type PpCalculator } from "./scores/pp.ts";
import { SYNC_MODES, type SyncMode } from "./sync/checkpoint.ts";
import { enqueueSync } from "./sync/queue.ts";
import { runWorker } from "./sync/worker.ts";

export const HELP = `kiai server ${pkg.version}

Usage:
  server serve                  Private web UI + sync worker in one process (runs migrations first)
  server web                    Private web UI and API only
  server worker [--once]        Sync worker only (--once: at most one job, then exit)
  server render-worker [--once] Render worker: runs danser on uploaded replays (the render container)
  server public                 Public replay pages on PUBLIC_PORT (the only port to expose)
  server migrate                Apply database migrations
  server sync [--mode recent|history|refresh|reset] [--confirm RESET]
                                Queue a sync for OSU_USER (default: recent). The worker runs it.
  server export [--out file.csv]
                                Write the whole library as CSV (default: stdout)
  server matches import <file>  Queue every match link in a file ("-" for stdin), such as
                                Elitebotix's /osu-history onlymatchhistory export
  server matches add <link|id>...
                                Queue mp links, ranked play room links or match ids
  server matches scan-from <match id>
                                Point stable discovery at a match id and scan forward from it

Configuration comes from the environment (see .env.example).
`;

export interface Io {
  env: Env;
  out: (line: string) => void;
  err: (line: string) => void;
}

const defaultIo: Io = {
  env: process.env,
  out: (line) => process.stdout.write(line + "\n"),
  err: (line) => process.stderr.write(line + "\n"),
};

const timestamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);

function parse<const T extends ParseArgsOptionsConfig>(args: string[], options: T) {
  try {
    return parseArgs({ args, options, allowPositionals: false, strict: true });
  } catch (error) {
    throw new UserError((error as Error).message);
  }
}

interface Runtime {
  config: Config;
  sql: Sql;
  osu(): OsuClient;
  osuOrNull(): OsuClient | null;
  pp(): PpCalculator | null;
  /** Migrates the database, then resolves OSU_USER (looking it up on osu! the first time). */
  player(): Promise<Player>;
  log: (message: string) => void;
}

function runtime(io: Io): Runtime {
  const config = loadConfig(io.env);
  const sql = connectDb(config.DATABASE_URL);
  let osu: OsuApi | null | undefined;
  const osuOrNull = () => {
    if (osu === undefined) {
      const hasCredentials = config.OSU_CLIENT_ID !== undefined && config.OSU_CLIENT_SECRET !== undefined;
      osu = hasCredentials ? new OsuApi({ ...requireOsuCredentials(config), limiter: new RateLimiter() }) : null;
    }
    return osu;
  };
  let pp: PpCalculator | null | undefined;
  let player: Promise<Player> | undefined;
  return {
    config,
    sql,
    osuOrNull,
    osu: () => osuOrNull() ?? (requireOsuCredentials(config) as never),
    pp: () => {
      if (pp === undefined) {
        const client = osuOrNull();
        pp = config.LOCAL_PP && client ? createPpCalculator((id) => client.getBeatmapFile(id)) : null;
      }
      return pp;
    },
    player: () => {
      const osuUser = requireOsuUser(config);
      player ??= migrate(sql).then(() => resolvePlayer(sql, osuOrNull(), osuUser));
      return player;
    },
    log: (message) => io.out(`${timestamp()} ${message}`),
  };
}

/** Run the CLI and return the exit code. Long-running commands resolve when stopped. */
export async function run(argv: readonly string[], io: Io = defaultIo): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    io.out(HELP);
    return 0;
  }
  if (command === "--version") {
    io.out(pkg.version);
    return 0;
  }

  let rt: Runtime | undefined;
  try {
    rt = runtime(io);
    return await dispatch(command, rest, rt, io);
  } catch (error) {
    if (error instanceof UserError) {
      io.err(`error: ${error.message}`);
      return 1;
    }
    throw error;
  } finally {
    await rt?.sql.end({ timeout: 5 });
  }
}

/** Aborts on SIGINT/SIGTERM. */
function stopSignal(): AbortController {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return controller;
}

async function startWeb(rt: Runtime, player: Player, signal: AbortSignal): Promise<void> {
  const media = mediaPaths(rt.config.DATA_DIR);
  await ensureMediaDirs(media);
  const app = createApp({ sql: rt.sql, osu: rt.osuOrNull(), player, media, config: rt.config });
  const server = serveHttp({ fetch: app.fetch, port: rt.config.PORT, hostname: rt.config.HOST });
  rt.log(`private web UI for ${player.username} listening on http://${rt.config.HOST}:${rt.config.PORT} (never expose this port publicly)`);
  await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function startWorker(rt: Runtime, player: Player, signal: AbortSignal, once = false): Promise<void> {
  const deps = { sql: rt.sql, osu: rt.osu(), pp: rt.pp(), config: rt.config, log: rt.log };
  rt.log(`sync worker started for ${player.username}${rt.config.SYNC_INTERVAL_HOURS > 0 ? `; recent syncs every ${rt.config.SYNC_INTERVAL_HOURS}h` : ""}`);
  const sync = runWorker(deps, {
    playerId: player.id,
    signal,
    once,
    syncIntervalHours: rt.config.SYNC_INTERVAL_HOURS,
    recentWindowHours: rt.config.RECENT_WINDOW_HOURS,
  });
  if (once) return sync;
  // Matches are fetched alongside score syncs; both share the osu! rate limiter.
  rt.log(`match worker started${rt.config.MATCH_DISCOVERY ? " with discovery" : ""}`);
  const matches = runMatchWorker(
    { sql: rt.sql, osu: rt.osu(), pp: rt.pp(), playerId: player.id, playerName: player.username, discovery: rt.config.MATCH_DISCOVERY, log: rt.log },
    { signal },
  );
  return Promise.all([sync, matches]).then(() => {});
}

async function dispatch(command: string, args: string[], rt: Runtime, io: Io): Promise<number> {
  switch (command) {
    case "migrate": {
      parse(args, {});
      const ran = await migrate(rt.sql);
      io.out(ran.length ? `applied ${ran.join(", ")}` : "database is up to date");
      return 0;
    }

    case "serve":
    case "web": {
      parse(args, {});
      if (command === "serve") requireOsuCredentials(rt.config);
      const player = await rt.player();
      const controller = stopSignal();
      await Promise.all([
        startWeb(rt, player, controller.signal),
        command === "serve" ? startWorker(rt, player, controller.signal) : Promise.resolve(),
      ]);
      rt.log("stopped");
      return 0;
    }

    case "worker": {
      const { values } = parse(args, { once: { type: "boolean" } });
      const player = await rt.player();
      const controller = stopSignal();
      await startWorker(rt, player, controller.signal, values.once ?? false);
      return 0;
    }

    case "render-worker": {
      const { values } = parse(args, { once: { type: "boolean" } });
      const player = await rt.player();
      const media = mediaPaths(rt.config.DATA_DIR);
      await ensureMediaDirs(media);
      const controller = stopSignal();
      const { config } = rt;
      const renderer = danserRenderer({
        dir: config.DANSER_DIR,
        paths: media,
        encoder: config.RENDER_ENCODER,
        xvfb: config.RENDER_XVFB,
        timeoutMs: config.RENDER_TIMEOUT_MINUTES * 60_000,
        log: rt.log,
      });
      rt.log(`render worker started: ${config.RENDER_CONCURRENCY} slot(s), encoder ${config.RENDER_ENCODER}, danser in ${config.DANSER_DIR}`);
      if (!rt.osuOrNull()) rt.log("no osu! credentials: only beatmaps already on disk or uploaded can be rendered");
      const notifier = discordNotifier({
        botToken: config.DISCORD_BOT_TOKEN,
        userId: config.DISCORD_USER_ID,
        webhookUrl: config.DISCORD_WEBHOOK_URL,
        publicUrl: config.PUBLIC_URL,
      });
      rt.log(notifier ? `Discord notifications on (${config.DISCORD_BOT_TOKEN && config.DISCORD_USER_ID ? "DM" : "webhook"})` : "Discord notifications off");
      await runRenderWorker(
        { sql: rt.sql, osu: rt.osuOrNull(), paths: media, renderer, mirrors: config.MAP_MIRRORS, playerId: player.id, notifier, log: rt.log },
        { concurrency: config.RENDER_CONCURRENCY, once: values.once ?? false, signal: controller.signal },
      );
      rt.log("stopped");
      return 0;
    }

    case "public": {
      parse(args, {});
      await migrate(rt.sql);
      const app = createPublicApp({ sql: rt.sql, media: mediaPaths(rt.config.DATA_DIR), publicUrl: rt.config.PUBLIC_URL });
      const controller = stopSignal();
      const server = serveHttp({ fetch: app.fetch, port: rt.config.PUBLIC_PORT, hostname: rt.config.HOST });
      rt.log(`public replay pages listening on http://${rt.config.HOST}:${rt.config.PUBLIC_PORT}${rt.config.PUBLIC_URL ? ` (${rt.config.PUBLIC_URL})` : ""}`);
      await new Promise<void>((resolve) => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rt.log("stopped");
      return 0;
    }

    case "sync": {
      const { values } = parse(args, { mode: { type: "string" }, confirm: { type: "string" } });
      const mode = values.mode ?? "recent";
      if (!(SYNC_MODES as readonly string[]).includes(mode)) throw new UserError(`--mode must be one of ${SYNC_MODES.join(", ")}.`);
      if (mode === "reset" && values.confirm !== "RESET") {
        throw new UserError("A reset clears and reimports the whole library. Add --confirm RESET to go ahead.");
      }
      const player = await rt.player();
      const result = await enqueueSync(rt.sql, { userId: player.id, mode: mode as SyncMode, trigger: "manual", recentWindowHours: rt.config.RECENT_WINDOW_HOURS });
      io.out(result.alreadyQueued ? `A sync is already queued or running (#${result.runId}).` : `Queued ${mode} sync #${result.runId} for ${player.username}.`);
      return 0;
    }

    case "export": {
      const { values } = parse(args, { out: { type: "string" } });
      const player = await rt.player();
      const target = values.out ? createWriteStream(values.out, { mode: 0o600 }) : process.stdout;
      await pipeline(Readable.from(scoreCsv(rt.sql, player.id)), target, { end: target !== process.stdout });
      if (values.out) io.err(`wrote ${values.out}`);
      return 0;
    }

    case "matches": {
      const [sub, ...rest] = args;
      await rt.player();
      if (sub === "import" || sub === "add") {
        if (rest.length === 0) throw new UserError(sub === "import" ? "Give a file to import, or - for stdin." : "Give at least one match link or id.");
        const text =
          sub === "add"
            ? rest.join("\n")
            : rest[0] === "-"
              ? await new Response(Readable.toWeb(process.stdin) as ReadableStream).text()
              : await readFile(rest[0]!, "utf8");
        const parsed = parseMatchRefs(text);
        const result = await enqueueMatches(rt.sql, parsed.refs, { addedVia: sub === "add" ? "manual" : "import" });
        io.out(
          `Found ${parsed.refs.length} match links: queued ${result.queued}, ${result.known} already saved` +
            (parsed.hidden ? `, ${parsed.hidden} hidden by Elitebotix skipped.` : "."),
        );
        if (result.queued) io.out("The worker (serve or worker) fetches them.");
        return 0;
      }
      if (sub === "scan-from") {
        const from = Number(rest[0]);
        if (!Number.isSafeInteger(from) || from <= 0) throw new UserError("Give the match id to scan from.");
        await scanStableFrom(rt.sql, from);
        io.out(`Stable discovery will scan lobbies from match ${from} onwards.`);
        return 0;
      }
      throw new UserError('Usage: server matches import <file> | add <link|id>... | scan-from <match id>');
    }

    default:
      throw new UserError(`Unknown command "${command}". Run "server help" for usage.`);
  }
}
