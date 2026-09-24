import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scoreCsv } from "../src/scores/csv.ts";
import { getScore, listScores, parseScoreFilters, scoreStats, streamScores } from "../src/scores/query.ts";
import { beatmapRow, scoreRow } from "../src/scores/rows.ts";
import { insertScores, upsertBeatmaps } from "../src/scores/store.ts";
import type { ApiMod, ApiScore } from "../src/osu/types.ts";
import { createTestDb, type TestDb } from "./helpers/db.ts";
import { beatmap, score, trackUser, USER_ID } from "./helpers/fake-osu.ts";

let db: TestDb;
const ids: Record<string, number> = {};

/** Seed one score per call; `key` names it for assertions. */
async function seed(key: string, beatmapId: number, overrides: Partial<ApiScore> & { mods?: (ApiMod | string)[] } = {}, map: Parameters<typeof beatmap>[1] = {}) {
  const b = beatmap(beatmapId, map);
  await upsertBeatmaps(db.sql, [beatmapRow(b)!]);
  const s = score(beatmapId, overrides);
  await insertScores(db.sql, [scoreRow(s, USER_ID, beatmapId, { pp: s.pp ?? null, source: s.pp == null ? "unavailable" : "osu" })]);
  ids[key] = s.id;
}

const find = async (query: string) => (await listScores(db.sql, USER_ID, parseScoreFilters(new URLSearchParams(query)))).scores.map((s) => keyOf(s.id)).sort();
const keyOf = (id: number) => Object.entries(ids).find(([, value]) => value === id)?.[0] ?? String(id);

beforeAll(async () => {
  db = await createTestDb();
  await trackUser(db.sql);
  await trackUser(db.sql, 2002, "other");
  await seed("nm", 1, { pp: 100, rank: "A", ended_at: "2026-01-01T00:00:00Z" }, { beatmapset: { id: 10, artist: "Camellia", title: "Ghost", creator: "m" } });
  await seed("cl", 2, { mods: ["CL"], pp: 110, rank: "S" });
  await seed("ez", 3, { mods: ["EZ"], pp: 50, rank: "B" });
  await seed("ezcl", 3, { mods: ["EZ", "CL"], pp: 55, rank: "B" });
  await seed("ezdt", 3, { mods: ["EZ", "DT"], pp: 60, rank: "C" });
  await seed("hddt", 4, { mods: ["HD", "DT"], pp: 300, rank: "X", accuracy: 1 });
  await seed("nc", 4, { mods: ["NC"], pp: 280, rank: "SH" });
  await seed("dt12", 5, { mods: [{ acronym: "DT", settings: { speed_change: 1.2 } }], pp: 200, rank: "XH" });
  await seed("pf", 6, { mods: ["PF"], pp: null, rank: "D" }, { status: "loved", difficulty_rating: 8 });
  await seed("wu", 7, { mods: ["WU"], pp: 90, rank: "A", ended_at: "2026-06-01T00:00:00Z" }, { beatmapset: { id: 70, artist: "xi", title: "Blue Zenith", creator: "m" }, version: "FOUR DIMENSIONS" });
  await seed("hdfl", 8, { mods: ["HD", "FL"], pp: 150, rank: "S" });
  // Another player's score on the same map must never leak into this user's results.
  const foreign = score(1, { pp: 999 });
  await db.sql`insert into scores (id, user_id, beatmap_id, ended_at, rank, accuracy, total_score, max_combo, pp)
    values (${foreign.id}, 2002, 1, now(), 'S', 1, 1, 1, 999)`;
});

afterAll(async () => {
  await db.drop();
});

describe("mod filters", () => {
  it("exact mods: required EZ with optional CL matches EZ and EZ+CL only", async () => {
    expect(await find("mods=EZ&mods_optional=CL&mods_exact=true")).toEqual(["ez", "ezcl"]);
    expect(await find("mods=EZ&mods_optional=CL&mods_excluded=CL&mods_exact=true")).toEqual(["ez"]);
    // Nothing required, CL optional: no mods or CL alone.
    expect(await find("mods_optional=CL&mods_exact=true")).toEqual(["cl", "nm"]);
  });

  it("without exact mods, DT also matches NC and SD matches PF; others must be present", async () => {
    expect(await find("mods=DT")).toEqual(["dt12", "ezdt", "hddt", "nc"]);
    expect(await find("mods=DT&mods_exact=true")).toEqual(["dt12"]);
    expect(await find("mods=SD")).toEqual(["pf"]);
    expect(await find("mods=HD,DT")).toEqual(["hddt"]);
  });

  it("NM means no mods or Classic alone, and ignores other mod filters", async () => {
    expect(await find("nomod=true")).toEqual(["cl", "nm"]);
    expect(await find("nomod=true&mods=HD&mods_excluded=CL")).toEqual(["cl", "nm"]);
  });

  it("excluded mods remove any score that has them", async () => {
    expect(await find("mods_excluded=HD,DT")).toEqual(["cl", "ez", "ezcl", "nc", "nm", "pf", "wu"]);
  });

  it("speed filters use the stored rate; variable-rate plays never match", async () => {
    expect(await find("min_rate=1.1&max_rate=1.3")).toEqual(["dt12"]);
    expect(await find("min_rate=1.5")).toEqual(["ezdt", "hddt", "nc"]);
    expect(await find("max_rate=1")).not.toContain("wu");
  });
});

describe("other filters", () => {
  it("rank SS includes X/XH and S includes SH", async () => {
    expect(await find("rank=SS")).toEqual(["dt12", "hddt"]);
    expect(await find("rank=S")).toEqual(["cl", "hdfl", "nc"]);
  });

  it("search needs every word in the title, artist or difficulty", async () => {
    expect(await find("q=camellia ghost")).toEqual(["nm"]);
    expect(await find("q=blue dimensions")).toEqual(["wu"]);
    expect(await find("q=ghost dimensions")).toEqual([]);
    expect(await find("q=%25")).toHaveLength(11); // a lone wildcard is stripped, not matched
  });

  it("filters on map status, stars, pp, perfect and dates", async () => {
    expect(await find("status=loved")).toEqual(["pf"]);
    expect(await find("min_stars=7")).toEqual(["pf"]);
    expect(await find("min_pp=200&max_pp=290")).toEqual(["dt12", "nc"]);
    expect(await find("date_from=2026-05-01&date_to=2026-07-01")).toEqual(["wu"]);
  });

  it("scopes everything to the requested user", async () => {
    const other = await listScores(db.sql, 2002, parseScoreFilters(new URLSearchParams()));
    expect(other.scores.map((s) => s.pp)).toEqual([999]);
  });
});

describe("sorting, paging and best per map", () => {
  it("sorts with nulls last in both directions and pages", async () => {
    const desc = await listScores(db.sql, USER_ID, parseScoreFilters(new URLSearchParams("sort=pp&page_size=4")));
    expect(desc.scores.map((s) => keyOf(s.id))).toEqual(["hddt", "nc", "dt12", "hdfl"]);
    expect(desc.pagination).toEqual({ page: 1, page_size: 4, total_count: 11, total_pages: 3 });
    const asc = await listScores(db.sql, USER_ID, parseScoreFilters(new URLSearchParams("sort=pp&order=asc&page=3&page_size=4")));
    expect(asc.scores.map((s) => keyOf(s.id))).toEqual(["nc", "hddt", "pf"]);
  });

  it("keeps the highest-PP score per map, then sorts and counts maps", async () => {
    const best = await listScores(db.sql, USER_ID, parseScoreFilters(new URLSearchParams("best_only=true&sort=pp")));
    expect(best.scores.map((s) => keyOf(s.id))).toEqual(["hddt", "dt12", "hdfl", "cl", "nm", "wu", "ezdt", "pf"]);
    expect(best.pagination.total_count).toBe(8);
    // Best-per-map applies after filtering.
    expect(await find("best_only=true&mods_excluded=DT")).toEqual(["cl", "ezcl", "hdfl", "nc", "nm", "pf", "wu"]);
  });
});

describe("views, stats and streaming", () => {
  it("returns a score with its beatmap, mods and link", async () => {
    const view = await getScore(db.sql, USER_ID, ids.dt12!);
    expect(view).toMatchObject({
      rank: "XH",
      clock_rate: 1.2,
      mods: [{ acronym: "DT", settings: { speed_change: 1.2 } }],
      score_url: `https://osu.ppy.sh/scores/${ids.dt12}`,
      beatmap: { id: 5, beatmapset_id: 50, title: "Title 5", cover_url: "https://assets.ppy.sh/beatmaps/50/covers/cover.jpg" },
    });
    expect(typeof view!.ended_at).toBe("string");
    expect(await getScore(db.sql, 2002, ids.dt12!)).toBeNull();
  });

  it("summarizes the whole library", async () => {
    const stats = await scoreStats(db.sql, USER_ID);
    expect(stats).toMatchObject({ total_scores: 11, unique_beatmaps_played: 8, rank_distribution: { SS: 2, S: 3, A: 2, B: 2, C: 1, D: 1 } });
    expect(stats.top_pp_score?.id).toBe(ids.hddt);
  });

  it("streams every row past the cursor page size, in id order", async () => {
    const rows = Array.from({ length: 1234 }, (_, i) => scoreRow(score(100 + (i % 7), { pp: i }), USER_ID, 100 + (i % 7), { pp: i, source: "osu" }));
    await upsertBeatmaps(db.sql, Array.from({ length: 7 }, (_, i) => beatmapRow(beatmap(100 + i))!));
    await insertScores(db.sql, rows);
    const seen: number[] = [];
    for await (const s of streamScores(db.sql, USER_ID, parseScoreFilters(new URLSearchParams("min_pp=0")))) seen.push(s.id);
    expect(seen.length).toBeGreaterThanOrEqual(1234);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));

    let lines = 0;
    let header = "";
    for await (const chunk of scoreCsv(db.sql, USER_ID)) {
      if (lines === 0) header = chunk;
      expect(chunk.endsWith("\r\n")).toBe(true);
      lines += 1;
    }
    expect(header.startsWith('﻿"score_id","user_id"')).toBe(true);
    expect(lines).toBe(1 + 11 + 1234);
    await db.sql`delete from scores where beatmap_id >= 100`;
  });

  it("writes mod settings and links into CSV rows", async () => {
    let row = "";
    for await (const chunk of scoreCsv(db.sql, USER_ID, parseScoreFilters(new URLSearchParams("min_rate=1.1&max_rate=1.3")))) row = chunk;
    expect(row).toContain('"DT 1.2×"');
    expect(row).toContain("speed_change");
    expect(row).toContain(`https://osu.ppy.sh/scores/${ids.dt12}`);
  });
});
