import type { OsuClient } from "../../src/osu/api.ts";
import type { ApiBeatmap, ApiMostPlayed, ApiScore, ApiUser } from "../../src/osu/types.ts";
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
  calls: string[];
  /** Throw from a method, once, to simulate an outage. */
  failOnce: Partial<Record<keyof OsuClient, (...args: unknown[]) => boolean>>;
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
