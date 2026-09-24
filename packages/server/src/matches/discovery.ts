// Finding new matches automatically.
//
// Stable: osu! has no "matches this player played" endpoint, but `GET /matches` lists every public
// lobby in id order. The crawler walks it forward and queues a probe for each tournament-style
// name ("ACR: (A) vs (B)", qualifier lobbies) and each name containing the player's. A probe
// fetches the match and keeps it only if the player took part. It stays two hours behind the
// newest lobby, so most tournament matches have finished by the time they're probed.
//
// Lazer: the profile's ranked play history lists the rooms the player set a score in, so each one
// is queued directly. The first pass walks back through the player's whole history.

import type { Sql } from "../db/index.ts";
import { sqlJson } from "../db/index.ts";
import { errorMessage } from "../errors.ts";
import type { OsuClient } from "../osu/api.ts";
import type { ApiRoom } from "../osu/types.ts";
import type { MatchRef } from "./import.ts";
import { isCandidateName, type MatchSource } from "./normalize.ts";
import { enqueueMatches, PRIORITY } from "./queue.ts";

export const STABLE_DELAY_MS = 2 * 3600_000;
const STABLE_PAGE = 50;
const ROOM_PAGE = 50;

export interface DiscoveryDeps {
  sql: Sql;
  osu: OsuClient;
  playerId: number;
  playerName: string;
  now?: () => number;
}

interface StableCursor {
  lastId?: number;
}

interface RoomKey {
  ends_at: string;
  id: number;
}

interface LazerCursor {
  /** The newest room seen by the last completed pass. */
  watermark?: RoomKey;
  pass?: { after?: RoomKey; top?: RoomKey };
}

export const encodeCursor = (cursor: object) => Buffer.from(JSON.stringify(cursor)).toString("base64url");

async function lock(sql: Sql, source: MatchSource): Promise<Record<string, unknown> | null> {
  const [row] = await sql<{ cursor: Record<string, unknown> }[]>`
    update match_discovery set locked_until = now() + interval '5 minutes'
    where source = ${source} and enabled and (locked_until is null or locked_until < now())
    returning cursor`;
  return row ? row.cursor : null;
}

async function release(
  sql: Sql,
  source: MatchSource,
  update: { cursor?: object; scanned?: number; error?: string | null },
): Promise<void> {
  await sql`
    update match_discovery set locked_until = null, last_run_at = now(),
      cursor = coalesce(${update.cursor ? sqlJson(sql, update.cursor) : null}::jsonb, cursor),
      scanned = scanned + ${update.scanned ?? 0},
      last_error = ${update.error ?? null}
    where source = ${source}`;
}

export type CrawlResult = "worked" | "idle" | "skipped";

/** One page of the stable lobby list. "idle" means it has caught up. */
export async function crawlStable(deps: DiscoveryDeps): Promise<CrawlResult> {
  const { sql, osu } = deps;
  const now = deps.now?.() ?? Date.now();
  const cursor = (await lock(sql, "stable")) as StableCursor | null;
  if (!cursor) return "skipped";
  try {
    if (cursor.lastId === undefined) {
      // First run: start from the newest lobby. Elitebotix imports cover the past.
      const newest = await osu.listMatches({ sort: "id_desc", limit: 1 });
      await release(sql, "stable", { cursor: { lastId: newest.matches[0]?.id ?? 0 } });
      return "worked";
    }
    const page = await osu.listMatches({ sort: "id_asc", limit: STABLE_PAGE, cursorString: encodeCursor({ match_id: cursor.lastId }) });
    let lastId = cursor.lastId;
    let scanned = 0;
    const candidates: MatchRef[] = [];
    const running: MatchRef[] = [];
    for (const match of page.matches) {
      const started = Date.parse(match.start_time ?? "");
      if (Number.isFinite(started) && started > now - STABLE_DELAY_MS) break;
      scanned++;
      lastId = Math.max(lastId, match.id);
      if (!isCandidateName(match.name ?? "", deps.playerName)) continue;
      const ref = { source: "stable" as const, externalId: match.id, ...(match.name ? { name: match.name } : {}) };
      (match.end_time ? candidates : running).push(ref);
    }
    await enqueueMatches(sql, candidates, { kind: "probe", addedVia: "discovery", priority: PRIORITY.discovery });
    // Still going after two hours: look again once it has probably ended.
    await enqueueMatches(sql, running, { kind: "probe", addedVia: "discovery", priority: PRIORITY.discovery, delayMs: 3600_000 });
    await release(sql, "stable", { cursor: { lastId }, scanned });
    return scanned === STABLE_PAGE ? "worked" : "idle";
  } catch (error) {
    await release(sql, "stable", { error: errorMessage(error) });
    throw error;
  }
}

const roomKey = (room: ApiRoom): RoomKey | null => (room.ends_at ? { ends_at: room.ends_at, id: room.id } : null);
const newer = (a: RoomKey, b: RoomKey) => {
  const at = Date.parse(a.ends_at);
  const bt = Date.parse(b.ends_at);
  return at > bt || (at === bt && a.id > b.id);
};

/** One page of the player's ended ranked play rooms, newest first, down to the previous pass's newest. */
export async function crawlLazer(deps: DiscoveryDeps): Promise<CrawlResult> {
  const { sql, osu } = deps;
  const cursor = (await lock(sql, "lazer")) as LazerCursor | null;
  if (!cursor) return "skipped";
  try {
    const pass = cursor.pass ?? {};
    const page = await osu.listUserRankedPlayRooms(deps.playerId, {
      limit: ROOM_PAGE,
      ...(pass.after ? { cursorString: encodeCursor(pass.after) } : {}),
    });
    let top = pass.top;
    let after = pass.after;
    let reachedWatermark = false;
    let scanned = 0;
    const mine: MatchRef[] = [];
    for (const room of page.rooms) {
      const key = roomKey(room);
      if (!key) continue;
      if (cursor.watermark && !newer(key, cursor.watermark)) {
        reachedWatermark = true;
        break;
      }
      scanned++;
      if (!top || newer(key, top)) top = key;
      after = key;
      mine.push({ source: "lazer", externalId: room.id, ...(room.name ? { name: room.name } : {}) });
    }
    await enqueueMatches(sql, mine, { addedVia: "discovery", priority: PRIORITY.discovery });
    if (mine.length) await sql`update match_discovery set found = found + ${mine.length} where source = 'lazer'`;
    const done = reachedWatermark || !page.cursor_string;
    const next: LazerCursor = done
      ? { ...((top ?? cursor.watermark) ? { watermark: (top ?? cursor.watermark)! } : {}) }
      : { ...(cursor.watermark ? { watermark: cursor.watermark } : {}), pass: { ...(after ? { after } : {}), ...(top ? { top } : {}) } };
    await release(sql, "lazer", { cursor: next, scanned });
    return done ? "idle" : "worked";
  } catch (error) {
    await release(sql, "lazer", { error: errorMessage(error) });
    throw error;
  }
}

/** Point the stable crawler at a match id, to scan (again) from there. */
export async function scanStableFrom(sql: Sql, matchId: number): Promise<void> {
  await sql`update match_discovery set cursor = ${sqlJson(sql, { lastId: Math.max(0, matchId - 1) })}, enabled = true where source = 'stable'`;
}

export async function setDiscoveryEnabled(sql: Sql, source: MatchSource, enabled: boolean): Promise<void> {
  await sql`update match_discovery set enabled = ${enabled} where source = ${source}`;
}

export interface DiscoveryState {
  source: MatchSource;
  enabled: boolean;
  cursor: Record<string, unknown>;
  scanned: number;
  probed: number;
  found: number;
  last_run_at: Date | null;
  last_error: string | null;
}

export async function discoveryState(sql: Sql): Promise<DiscoveryState[]> {
  return sql<DiscoveryState[]>`
    select source, enabled, cursor, scanned, probed, found, last_run_at, last_error from match_discovery order by source desc`;
}
