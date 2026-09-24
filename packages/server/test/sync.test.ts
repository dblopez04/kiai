import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runImport, type ImportStats } from "../src/scores/importer.ts";
import { createPpCalculator, PP_CALCULATOR } from "../src/scores/pp.ts";
import type { SyncCheckpoint } from "../src/sync/checkpoint.ts";
import { claimNextRun, enqueueSync, LeaseLostError, resetLibrary, RunLease, scheduleRecentSync, syncOverview } from "../src/sync/queue.ts";
import { runNextJob, type WorkerDeps } from "../src/sync/runner.ts";
import { createTestDb, type TestDb } from "./helpers/db.ts";
import { beatmap, fakeOsu, mostPlayed, osuFile, score, trackUser, USER_ID, type FakeOsu } from "./helpers/fake-osu.ts";

let db: TestDb;
let osu: FakeOsu;
let exportDir: string;

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.drop();
});
beforeEach(async () => {
  await db.sql`truncate osu_users, beatmaps, scores, user_played_maps, sync_runs, score_archives cascade`;
  await trackUser(db.sql);
  osu = fakeOsu();
  exportDir = await fs.mkdtemp(path.join(os.tmpdir(), "kiai-exports-"));
});
afterEach(async () => {
  await fs.rm(exportDir, { recursive: true, force: true });
});

function importer(mode: "recent" | "history", checkpoint: SyncCheckpoint = {}, withPp = false) {
  const checkpoints: SyncCheckpoint[] = [];
  const run = () =>
    runImport({
      sql: db.sql,
      osu,
      pp: withPp ? createPpCalculator((id) => osu.getBeatmapFile(id)) : null,
      userId: USER_ID,
      mode,
      recentWindowHours: 24,
      checkpoint,
      assertActive: () => {},
      saveCheckpoint: async (cp: SyncCheckpoint, _stats: ImportStats) => {
        checkpoints.push(cp);
      },
    });
  return { run, checkpoints };
}

const countScores = async () => (await db.sql<{ n: number }[]>`select count(*)::int as n from scores`)[0]!.n;

describe("recent import", () => {
  it("saves every passed play in the window, with its beatmap, and skips failures and known scores", async () => {
    const plays = Array.from({ length: 150 }, () => score(1));
    osu.recent = [
      ...plays,
      score(1, { passed: false }),
      score(2, { rank: "F" }),
      score(3, { ended_at: new Date(Date.now() - 48 * 3600 * 1000).toISOString() }),
    ];
    const stats = await importer("recent").run();
    expect(stats.scores_added).toBe(150);
    expect(await countScores()).toBe(150);
    const [map] = await db.sql`select title, status from beatmaps where id = 1`;
    expect(map).toEqual({ title: "Title 1", status: "ranked" });
    expect(await db.sql`select beatmap_id from user_played_maps order by beatmap_id`).toEqual([{ beatmap_id: 1 }, { beatmap_id: 2 }, { beatmap_id: 3 }]);

    const again = await importer("recent").run();
    expect(again).toMatchObject({ scores_added: 0, scores_skipped: 150 });
  });

  it("stops paging once a page has nothing inside the window", async () => {
    const old = new Date(Date.now() - 72 * 3600 * 1000).toISOString();
    osu.recent = [...Array.from({ length: 100 }, () => score(1)), ...Array.from({ length: 100 }, () => score(1, { ended_at: old })), score(1)];
    await importer("recent").run();
    expect(osu.calls.filter((c) => c.startsWith("getRecentScores"))).toEqual(["getRecentScores 0", "getRecentScores 100"]);
  });

  it("calculates PP locally for loved maps and for plays osu! gives none", async () => {
    osu.files.set(2, osuFile());
    osu.files.set(3, osuFile());
    osu.recent = [
      score(1, { pp: 123 }),
      score(2, { pp: 0, beatmap: beatmap(2, { status: "loved" }), statistics: { great: 40 }, accuracy: 1, max_combo: 40 }),
      score(3, { pp: null, statistics: { great: 40 }, accuracy: 1, max_combo: 40 }),
      score(4, { pp: null }),
    ];
    await importer("recent", {}, true).run();
    const rows = await db.sql`select beatmap_id, pp, pp_source, pp_calculator from scores order by beatmap_id`;
    expect(rows[0]).toEqual({ beatmap_id: 1, pp: 123, pp_source: "osu", pp_calculator: null });
    expect(rows[1]).toMatchObject({ beatmap_id: 2, pp_source: "local", pp_calculator: PP_CALCULATOR });
    expect(rows[1]!.pp).toBeGreaterThan(0);
    expect(rows[2]).toMatchObject({ beatmap_id: 3, pp_source: "local" });
    // No .osu file available for map 4: stored without PP.
    expect(rows[3]).toEqual({ beatmap_id: 4, pp: null, pp_source: "unavailable", pp_calculator: null });
  });
});

describe("history import", () => {
  beforeEach(() => {
    osu.mostPlayed = [mostPlayed(10), mostPlayed(20, "taiko"), mostPlayed(30), mostPlayed(40)];
    osu.mostPlayedPageCap = 2;
    for (const id of [10, 30, 40]) {
      osu.beatmaps.set(id, beatmap(id, { difficulty_rating: id / 10 }));
      osu.scoresOnMap.set(id, [score(id), score(id)]);
    }
  });

  it("pages the played list by what osu! returns, skips other modes, hydrates maps and checks each map", async () => {
    const { run, checkpoints } = importer("history");
    const stats = await run();
    expect(osu.calls.filter((c) => c.startsWith("getMostPlayed"))).toEqual(["getMostPlayed 0", "getMostPlayed 2", "getMostPlayed 4"]);
    expect(osu.calls.filter((c) => c.startsWith("getBeatmapUserScores"))).toEqual(["getBeatmapUserScores 10", "getBeatmapUserScores 30", "getBeatmapUserScores 40"]);
    expect(osu.calls.some((c) => c.includes("getBeatmaps") && c.includes("20"))).toBe(false);
    expect(stats.scores_added).toBe(6);
    // Full details from the hydration call replaced the compact profile entry.
    expect(await db.sql`select id, difficulty_rating from beatmaps where id = 30`).toEqual([{ id: 30, difficulty_rating: 3 }]);
    expect(checkpoints.at(-1)).toMatchObject({ phase: "export", playedListComplete: true, lastBeatmapId: 40, mapsProcessed: 3, mapsTotal: 3 });
  });

  it("resumes after the last committed map without re-reading the played list", async () => {
    osu.failOnce.getBeatmapUserScores = (beatmapId) => beatmapId === 30;
    const first = importer("history");
    await expect(first.run()).rejects.toThrow(/simulated/);
    const lastGood = first.checkpoints.at(-1)!;
    expect(lastGood).toMatchObject({ playedListComplete: true, lastBeatmapId: 10, mapsProcessed: 1 });
    expect(await countScores()).toBe(2);

    osu.calls = [];
    await importer("history", lastGood).run();
    expect(osu.calls.filter((c) => c.startsWith("getMostPlayed"))).toEqual([]);
    expect(osu.calls.filter((c) => c.startsWith("getBeatmapUserScores"))).toEqual(["getBeatmapUserScores 30", "getBeatmapUserScores 40"]);
    expect(await countScores()).toBe(6);
  });

  it("never checkpoints a map whose scores failed to save", async () => {
    osu.scoresOnMap.set(30, [score(30, { id: 999 })]);
    await db.sql`alter table scores add constraint test_reject check (id <> 999)`;
    try {
      const { run, checkpoints } = importer("history");
      await expect(run()).rejects.toThrow(/test_reject/);
      expect(checkpoints.every((cp) => (cp.lastBeatmapId ?? 0) < 30)).toBe(true);
    } finally {
      await db.sql`alter table scores drop constraint test_reject`;
    }
  });

  it("refuses to loop when osu! repeats a page", async () => {
    osu.getMostPlayed = async () => [mostPlayed(10)];
    await expect(importer("history").run()).rejects.toThrow(/same page/);
  });
});

describe("queue", () => {
  const enqueue = (mode: "recent" | "history" | "refresh" | "reset" = "recent", userId = USER_ID) =>
    enqueueSync(db.sql, { userId, mode, trigger: "manual", recentWindowHours: 24 });

  it("allows one queued or running job per user", async () => {
    const first = await enqueue("recent");
    const second = await enqueue("history");
    expect(second).toEqual({ runId: first.runId, alreadyQueued: true });
    await expect(enqueue("recent", 424242)).rejects.toThrow(/isn't in the database/);
  });

  it("resumes a failed history import from its checkpoint, but starts recent syncs fresh", async () => {
    await db.sql`insert into sync_runs (user_id, mode, trigger, status, recent_window_hours, checkpoint)
      values (${USER_ID}, 'history', 'manual', 'failed', 24, ${db.sql.json({ lastBeatmapId: 30 })}),
             (${USER_ID}, 'recent', 'manual', 'failed', 24, ${db.sql.json({ lastRecentAt: "x" })})`;
    const history = await enqueue("history");
    expect((await db.sql`select checkpoint from sync_runs where id = ${history.runId}`)[0]!.checkpoint).toEqual({ lastBeatmapId: 30 });
    await db.sql`update sync_runs set status = 'success' where id = ${history.runId}`;
    const recent = await enqueue("recent");
    expect((await db.sql`select checkpoint from sync_runs where id = ${recent.runId}`)[0]!.checkpoint).toEqual({});
  });

  it("runs one job at a time and reclaims jobs whose worker stopped heartbeating", async () => {
    await trackUser(db.sql, 2002, "other");
    const a = await enqueue("recent");
    const b = await enqueue("recent", 2002);
    const claimed = await claimNextRun(db.sql, randomUUID());
    expect(claimed?.id).toBe(a.runId);
    expect(await claimNextRun(db.sql, randomUUID())).toBeNull();

    // The first worker dies; after the lease timeout another worker takes over the same job.
    await db.sql`update sync_runs set heartbeat_at = now() - interval '6 minutes' where id = ${a.runId}`;
    const takeover = await claimNextRun(db.sql, randomUUID());
    expect(takeover?.id).toBe(a.runId);
    expect(takeover?.id).not.toBe(b.runId);

    // The original worker comes back and must not be able to write.
    const stale = new RunLease(db.sql, claimed!, "00000000-0000-0000-0000-000000000000");
    await expect(stale.update({ checkpoint: { lastBeatmapId: 1 } })).rejects.toBeInstanceOf(LeaseLostError);
    expect(stale.lost).toBe(true);
  });

  it("archives and clears a library exactly once per reset job", async () => {
    osu.recent = [score(1), score(1)];
    await importer("recent").run();
    const { runId } = await enqueue("reset");
    const token = randomUUID();
    const run = (await claimNextRun(db.sql, token))!;
    const lease = new RunLease(db.sql, run, token);
    await resetLibrary(db.sql, lease);
    await resetLibrary(db.sql, lease);
    expect(await countScores()).toBe(0);
    const archives = await db.sql<{ run_id: number; scores: unknown[] }[]>`select run_id, scores from score_archives`;
    expect(archives).toHaveLength(1);
    expect(archives[0]!.run_id).toBe(runId);
    expect(archives[0]!.scores).toHaveLength(2);
    // Played maps survive the reset so a reimport still checks them.
    expect(await db.sql`select count(*)::int as n from user_played_maps`).toEqual([{ n: 1 }]);
  });

  it("schedules a recent sync only when none ran within the interval and nothing is active", async () => {
    expect(await scheduleRecentSync(db.sql, USER_ID, 12, 24)).toBe(true);
    expect(await scheduleRecentSync(db.sql, USER_ID, 12, 24)).toBe(false);
    await db.sql`update sync_runs set status = 'success', created_at = now() - interval '13 hours'`;
    expect(await scheduleRecentSync(db.sql, USER_ID, 12, 24)).toBe(true);
  });
});

describe("worker jobs", () => {
  const deps = (): WorkerDeps => ({
    sql: db.sql,
    osu,
    pp: createPpCalculator((id) => osu.getBeatmapFile(id)),
    config: { EXPORT_DIR: exportDir, BACKFILL_ZERO_PP_ON_SYNC: false },
    log: () => {},
  });
  const runRow = async (id: number) => (await db.sql`select * from sync_runs where id = ${id}`)[0]!;

  it("completes a recent sync, refreshes the profile and writes a CSV snapshot", async () => {
    osu.recent = [score(1), score(2)];
    const { runId } = await enqueueSync(db.sql, { userId: USER_ID, mode: "recent", trigger: "manual", recentWindowHours: 24 });
    expect(await runNextJob(deps())).toBe(true);
    const run = await runRow(runId);
    expect(run).toMatchObject({ status: "success", scores_added: 2, error_text: null });
    const csv = await fs.readFile(run.csv_path, "utf8");
    expect(csv.split("\r\n").filter(Boolean)).toHaveLength(3);
    expect((await fs.stat(run.csv_path)).mode & 0o777).toBe(0o600);
    expect((await db.sql`select pp, global_rank from osu_users where id = ${USER_ID}`)[0]).toEqual({ pp: 5000, global_rank: 12345 });
    expect(await runNextJob(deps())).toBe(false);
  });

  it("marks a failed job with its error and keeps its progress for resuming", async () => {
    osu.mostPlayed = [mostPlayed(10), mostPlayed(30)];
    osu.scoresOnMap.set(10, [score(10)]);
    osu.failOnce.getBeatmapUserScores = (id) => id === 30;
    const { runId } = await enqueueSync(db.sql, { userId: USER_ID, mode: "history", trigger: "manual", recentWindowHours: 24 });
    await runNextJob(deps());
    const failed = await runRow(runId);
    expect(failed).toMatchObject({ status: "failed", error_text: "simulated getBeatmapUserScores outage", scores_added: 1 });
    expect(failed.checkpoint).toMatchObject({ lastBeatmapId: 10 });

    const resumed = await enqueueSync(db.sql, { userId: USER_ID, mode: "history", trigger: "manual", recentWindowHours: 24 });
    await runNextJob(deps());
    expect(await runRow(resumed.runId)).toMatchObject({ status: "success" });
    expect(osu.calls.filter((c) => c === "getBeatmapUserScores 10")).toHaveLength(1);
  });

  it("puts an interrupted job back in the queue", async () => {
    const controller = new AbortController();
    osu.getRecentScores = async () => {
      controller.abort();
      return [score(1)];
    };
    const { runId } = await enqueueSync(db.sql, { userId: USER_ID, mode: "recent", trigger: "manual", recentWindowHours: 24 });
    await runNextJob(deps(), controller.signal);
    expect(await runRow(runId)).toMatchObject({ status: "queued", lease_token: null });
  });

  it("refreshes PP: official values win, gone scores keep their row and get local PP", async () => {
    osu.files.set(1, osuFile());
    const kept = score(1, { pp: 100 });
    const gone = score(1, { pp: 90, statistics: { great: 40 }, accuracy: 1, max_combo: 40 });
    osu.recent = [kept, gone];
    await importer("recent").run();
    osu.liveScores.set(kept.id, { ...kept, pp: 123.4, mods: [{ acronym: "DT", settings: { speed_change: 1.1 } }] });

    const { runId } = await enqueueSync(db.sql, { userId: USER_ID, mode: "refresh", trigger: "manual", recentWindowHours: 24 });
    await runNextJob(deps());
    expect(await runRow(runId)).toMatchObject({ status: "success" });
    const rows = await db.sql`select id, pp, pp_source, score_link_status, clock_rate from scores order by id`;
    expect(rows[0]).toMatchObject({ id: kept.id, pp: 123.4, pp_source: "osu", score_link_status: "available", clock_rate: 1.1 });
    expect(rows[1]).toMatchObject({ id: gone.id, pp_source: "local", score_link_status: "unavailable" });
    expect(rows[1]!.pp).toBeGreaterThan(0);
    const files = await fs.readdir(exportDir);
    expect(files.some((f) => f.endsWith("-before-refresh.csv"))).toBe(true);
  });

  it("stops a PP refresh on transient errors without touching the score", async () => {
    osu.recent = [score(1, { pp: 100 })];
    await importer("recent").run();
    osu.failOnce.getScore = () => true;
    const { runId } = await enqueueSync(db.sql, { userId: USER_ID, mode: "refresh", trigger: "manual", recentWindowHours: 24 });
    await runNextJob(deps());
    expect(await runRow(runId)).toMatchObject({ status: "failed" });
    expect(await db.sql`select pp, score_link_status from scores`).toEqual([{ pp: 100, score_link_status: "available" }]);
  });

  it("resets: backs up, archives, clears, then reimports from the played-map list", async () => {
    osu.recent = [score(1), score(1)];
    await importer("recent").run();
    // Map 1 dropped off the most-played list, but it's remembered in user_played_maps.
    osu.recent = [];
    osu.scoresOnMap.set(1, [score(1)]);
    const { runId } = await enqueueSync(db.sql, { userId: USER_ID, mode: "reset", trigger: "manual", recentWindowHours: 24 });
    await runNextJob(deps());
    expect(await runRow(runId)).toMatchObject({ status: "success", scores_added: 1 });
    expect(await countScores()).toBe(1);
    expect((await db.sql`select jsonb_array_length(scores) as n from score_archives`)[0]).toEqual({ n: 2 });
    const files = await fs.readdir(exportDir);
    expect(files.some((f) => f.endsWith("-before-reset.csv"))).toBe(true);
    const overview = await syncOverview(db.sql, USER_ID);
    expect(overview.total_scores).toBe(1);
    expect(overview.last_success).toBeInstanceOf(Date);
  });
});
