import { OsuApiError, type OsuClient } from "../../src/osu/api.ts";
import type { ApiBeatmap, ApiMatch, ApiMatchInfo, ApiMostPlayed, ApiRoom, ApiRoomEvents, ApiScore, ApiUser } from "../../src/osu/types.ts";
import type { Sql } from "../../src/db/index.ts";

export const USER_ID = 1001;

export function beatmap(id: number, overrides: Partial<ApiBeatmap> = {}): ApiBeatmap {
  return {
    id,
    beatmapset_id: id * 10,
    mode: "osu",
    status: "ranked",
    version: `Diff ${id}`,
    difficulty_rating: 5,
    bpm: 180,
    ar: 9,
    accuracy: 8,
    cs: 4,
    drain: 5,
    total_length: 120,
    hit_length: 110,
    max_combo: 500,
    beatmapset: { id: id * 10, artist: `Artist ${id}`, title: `Title ${id}`, creator: "mapper", status: overrides.status ?? "ranked" },
    ...overrides,
  };
}

let nextScoreId = 5_000_000_000;

export function score(beatmapId: number, overrides: Partial<ApiScore> = {}): ApiScore {
  return {
    id: nextScoreId++,
    user_id: USER_ID,
    beatmap_id: beatmapId,
    ruleset_id: 0,
    type: "solo_score",
    accuracy: 0.97,
    total_score: 900_000,
    max_combo: 480,
    passed: true,
    rank: "S",
    pp: 150,
    mods: [],
    statistics: { great: 400, ok: 10, meh: 1, miss: 0 },
    ended_at: new Date().toISOString(),
    build_id: 1,
    beatmap: beatmap(beatmapId),
    ...overrides,
  };
}

export interface FakeOsu extends OsuClient {
  users: Map<number, ApiUser>;
  beatmaps: Map<number, ApiBeatmap>;
  mostPlayed: ApiMostPlayed[];
  /** osu! caps most-played pages; simulate that. */
  mostPlayedPageCap: number;
  recent: ApiScore[];
  scoresOnMap: Map<number, ApiScore[]>;
  liveScores: Map<number, ApiScore>;
  files: Map<number, string>;
  /** Beatmaps by .osu MD5, for lookupBeatmap. */
  checksums: Map<string, ApiBeatmap>;
  /** Stable matches with all their events; `getMatch` pages them. */
  matches: Map<number, ApiMatch>;
  /** Stable matches that exist but are private. */
  privateMatches: Set<number>;
  /** osu!'s public lobby list. */
  lobbies: ApiMatchInfo[];
  /** Lazer rooms with all their events. */
  rooms: Map<number, ApiRoomEvents>;
  /** USER_ID's ended ranked play rooms for `listUserRankedPlayRooms`; other users have none. */
  rankedRooms: ApiRoom[];
  calls: string[];
  /** Throw from a method, once, to simulate an outage. */
  failOnce: Partial<Record<keyof OsuClient, (...args: unknown[]) => boolean>>;
}

const decodeCursor = (cursor: string | undefined) => (cursor ? JSON.parse(Buffer.from(cursor, "base64url").toString()) : null);

function eventPage<T extends { events: { id: number }[] }>(full: T, after: number | undefined): T {
  const events = after === undefined ? full.events.slice(-101) : full.events.filter((e) => e.id > after).slice(0, 101);
  return { ...full, events };
}

export function fakeOsu(): FakeOsu {
  const fake: FakeOsu = {
    users: new Map([[USER_ID, { id: USER_ID, username: "tester", country_code: "US", statistics: { pp: 5000, global_rank: 12345, play_count: 9000, play_time: 360000 } }]]),
    beatmaps: new Map(),
    mostPlayed: [],
    mostPlayedPageCap: 100,
    recent: [],
    scoresOnMap: new Map(),
    liveScores: new Map(),
    files: new Map(),
    checksums: new Map(),
    matches: new Map(),
    privateMatches: new Set(),
    lobbies: [],
    rooms: new Map(),
    rankedRooms: [],
    calls: [],
    failOnce: {},

    async getUser(user) {
      fake.calls.push(`getUser ${user}`);
      if (typeof user === "number") return fake.users.get(user) ?? null;
      return [...fake.users.values()].find((u) => u.username.toLowerCase() === user.toLowerCase()) ?? null;
    },
    async getMostPlayed(userId, limit, offset) {
      fake.calls.push(`getMostPlayed ${offset}`);
      check("getMostPlayed", userId, offset);
      return fake.mostPlayed.slice(offset, offset + Math.min(limit, fake.mostPlayedPageCap));
    },
    async getBeatmaps(ids) {
      fake.calls.push(`getBeatmaps ${ids.join(",")}`);
      return ids.flatMap((id) => fake.beatmaps.get(id) ?? []);
    },
    async getRecentScores(_userId, limit, offset) {
      fake.calls.push(`getRecentScores ${offset}`);
      return fake.recent.slice(offset, offset + limit);
    },
    async getBeatmapUserScores(beatmapId, userId) {
      fake.calls.push(`getBeatmapUserScores ${beatmapId}`);
      check("getBeatmapUserScores", beatmapId, userId);
      return fake.scoresOnMap.get(beatmapId) ?? [];
    },
    async getScore(scoreId) {
      fake.calls.push(`getScore ${scoreId}`);
      check("getScore", scoreId);
      return fake.liveScores.get(scoreId) ?? null;
    },
    async getBeatmapFile(beatmapId) {
      fake.calls.push(`getBeatmapFile ${beatmapId}`);
      check("getBeatmapFile", beatmapId);
      return fake.files.get(beatmapId) ?? null;
    },
    async lookupBeatmap(checksum) {
      fake.calls.push(`lookupBeatmap ${checksum}`);
      check("lookupBeatmap", checksum);
      return fake.checksums.get(checksum) ?? null;
    },
    async getMatch(matchId, after) {
      fake.calls.push(`getMatch ${matchId} ${after ?? ""}`.trim());
      check("getMatch", matchId);
      if (fake.privateMatches.has(matchId)) throw new OsuApiError("private", 403);
      const full = fake.matches.get(matchId);
      if (!full) return null;
      const ids = full.events.map((e) => e.id);
      return { ...eventPage(full, after), first_event_id: Math.min(...ids), latest_event_id: Math.max(...ids) };
    },
    async listMatches({ sort, limit, cursorString }) {
      fake.calls.push(`listMatches ${sort} ${cursorString ? decodeCursor(cursorString).match_id : ""}`.trim());
      check("listMatches");
      const from = decodeCursor(cursorString)?.match_id as number | undefined;
      const sorted = fake.lobbies.toSorted((a, b) => (sort === "id_asc" ? a.id - b.id : b.id - a.id));
      const after = from === undefined ? sorted : sorted.filter((m) => (sort === "id_asc" ? m.id > from : m.id < from));
      return { matches: after.slice(0, limit) };
    },
    async getRoomEvents(roomId, after) {
      fake.calls.push(`getRoomEvents ${roomId} ${after ?? ""}`.trim());
      check("getRoomEvents", roomId);
      const full = fake.rooms.get(roomId);
      if (!full) return null;
      const ids = full.events.map((e) => e.id);
      return { ...eventPage(full, after), first_event_id: Math.min(...ids), last_event_id: Math.max(...ids) };
    },
    async listUserRankedPlayRooms(userId, { limit, cursorString }) {
      const cursor = decodeCursor(cursorString) as { ends_at: string; id: number } | null;
      fake.calls.push(`listUserRankedPlayRooms ${userId} ${cursor ? cursor.id : ""}`.trim());
      if (userId !== USER_ID) return { rooms: [], cursor_string: null };
      const key = (r: ApiRoom) => [Date.parse(r.ends_at ?? ""), r.id] as const;
      const sorted = fake.rankedRooms.toSorted((a, b) => key(b)[0] - key(a)[0] || b.id - a.id);
      const older = cursor
        ? sorted.filter((r) => key(r)[0] < Date.parse(cursor.ends_at) || (key(r)[0] === Date.parse(cursor.ends_at) && r.id < cursor.id))
        : sorted;
      const rooms = older.slice(0, limit);
      const last = rooms.at(-1);
      const more = older.length > limit && last;
      return { rooms, cursor_string: more ? Buffer.from(JSON.stringify({ ends_at: last.ends_at, id: last.id })).toString("base64url") : null };
    },
  };

  function check(method: keyof OsuClient, ...args: unknown[]) {
    const predicate = fake.failOnce[method];
    if (predicate?.(...args)) {
      delete fake.failOnce[method];
      throw new Error(`simulated ${method} outage`);
    }
  }

  return fake;
}

export function mostPlayed(id: number, mode = "osu"): ApiMostPlayed {
  const b = beatmap(id, { mode });
  // The profile list carries compact beatmaps: no stats, just identity and mode.
  return { beatmap_id: id, count: 1, beatmap: { id, beatmapset_id: b.beatmapset_id!, mode, version: b.version! }, beatmapset: b.beatmapset! };
}

/** A small but valid osu!standard map that rosu-pp can calculate. */
export function osuFile(objects = 40): string {
  const hitObjects = Array.from({ length: objects }, (_, i) => `${i % 2 ? 400 : 100},192,${1000 + i * 180},1,0,0:0:0:0:`).join("\n");
  return `osu file format v14\n\n[General]\nMode: 0\n\n[Difficulty]\nHPDrainRate:5\nCircleSize:4\nOverallDifficulty:8\nApproachRate:9\nSliderMultiplier:1.4\nSliderTickRate:1\n\n[TimingPoints]\n0,500,4,2,1,100,1,0\n\n[HitObjects]\n${hitObjects}\n`;
}

export async function trackUser(sql: Sql, id = USER_ID, username = "tester"): Promise<void> {
  await sql`insert into osu_users (id, username) values (${id}, ${username}) on conflict do nothing`;
}
