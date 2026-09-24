// The match worker: fetches queued matches, then crawls for new ones. It runs next to the score
// sync worker and shares its osu! rate limiter, so both make progress during long imports.

import type { Sql } from "../db/index.ts";
import { errorMessage } from "../errors.ts";
import { OsuApiError, type OsuClient } from "../osu/api.ts";
import type { PpCalculator } from "../scores/pp.ts";
import { crawlLazer, crawlStable, type CrawlResult } from "./discovery.ts";
import { claimQueued, failQueued, finishQueued, PRIORITY, rescheduleQueued, type QueueRow } from "./queue.ts";
import { fetchMatch, ingestMatch } from "./store.ts";

export interface MatchWorkerDeps {
  sql: Sql;
  osu: OsuClient;
  pp: PpCalculator | null;
  playerId: number;
  playerName: string;
  /** Crawl for new matches when the queue is empty. */
  discovery: boolean;
  log: (message: string) => void;
  now?: () => number;
}

const REFRESH_MS = 10 * 60_000;
// In-progress matches are refreshed for a day; probes of running lobbies wait up to 12 hours.
const REFRESH_FOR_MS = 24 * 3600_000;
const PROBE_FOR_MS = 12 * 3600_000;

async function processQueued(deps: MatchWorkerDeps, row: QueueRow): Promise<void> {
  const { sql } = deps;
  const now = deps.now?.() ?? Date.now();
  const label = `${row.source} match ${row.external_id}`;
  let match;
  try {
    match = await fetchMatch(deps.osu, row.source, row.external_id);
  } catch (error) {
    const status = error instanceof OsuApiError ? error.status : undefined;
    if (row.kind === "probe" && (status === 401 || status === 403 || status === 422)) return finishQueued(sql, row);
    if (status === 401 || status === 403) return failQueued(sql, row, "This match is private on osu!.", true);
    if (status === 422) return failQueued(sql, row, "This room isn't a realtime (multiplayer or ranked play) room.", true);
    deps.log(`${label}: ${errorMessage(error)}`);
    return failQueued(sql, row, errorMessage(error));
  }

  if (!match) {
    if (row.kind === "probe") return finishQueued(sql, row);
    return failQueued(sql, row, "osu! has no match with this id.", true);
  }

  const started = Date.parse(match.startTime ?? "") || now;
  const running = match.endTime === null;
  if (row.kind === "probe") {
    await sql`update match_discovery set probed = probed + 1 where source = ${row.source}`;
    if (!match.participants.has(deps.playerId)) {
      if (running && now - started < PROBE_FOR_MS) return rescheduleQueued(sql, row, 3600_000);
      return finishQueued(sql, row);
    }
    await sql`update match_discovery set found = found + 1 where source = ${row.source}`;
    deps.log(`discovered ${label}: ${match.name}`);
  }

  await ingestMatch(sql, match, { addedVia: row.added_via, pp: deps.pp });
  if (running && now - started < REFRESH_FOR_MS) {
    return rescheduleQueued(sql, row, REFRESH_MS, { kind: "fetch", priority: PRIORITY.refresh });
  }
  await finishQueued(sql, row);
}

/** Process one queued match or one crawl page. Returns false when there was nothing to do. */
export function createMatchStepper(deps: MatchWorkerDeps): () => Promise<boolean> {
  let crawls = 0;
  const idleUntil: Record<"stable" | "lazer", number> = { stable: 0, lazer: 0 };
  const IDLE_MS = { stable: 5 * 60_000, lazer: 15 * 60_000 };

  const crawl = async (source: "stable" | "lazer"): Promise<CrawlResult> => {
    const discoveryDeps = { sql: deps.sql, osu: deps.osu, playerId: deps.playerId, playerName: deps.playerName, ...(deps.now ? { now: deps.now } : {}) };
    const result = await (source === "stable" ? crawlStable(discoveryDeps) : crawlLazer(discoveryDeps));
    if (result !== "worked") idleUntil[source] = (deps.now?.() ?? Date.now()) + IDLE_MS[source];
    return result;
  };

  return async () => {
    const row = await claimQueued(deps.sql);
    if (row) {
      await processQueued(deps, row);
      return true;
    }
    if (!deps.discovery) return false;
    const now = deps.now?.() ?? Date.now();
    const due = (["stable", "lazer"] as const).filter((source) => idleUntil[source] <= now);
    if (due.length === 0) return false;
    // Stable tournaments matter most: it gets three crawl turns out of four.
    const source = due.length === 1 ? due[0]! : crawls++ % 4 === 3 ? "lazer" : "stable";
    return (await crawl(source)) === "worked";
  };
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

export async function runMatchWorker(deps: MatchWorkerDeps, options: { signal?: AbortSignal; idlePollMs?: number } = {}): Promise<void> {
  const step = createMatchStepper(deps);
  while (!options.signal?.aborted) {
    try {
      if (!(await step())) await pause(options.idlePollMs ?? 15_000, options.signal);
    } catch (error) {
      deps.log(`match worker error: ${errorMessage(error)}`);
      await pause(30_000, options.signal);
    }
  }
}
