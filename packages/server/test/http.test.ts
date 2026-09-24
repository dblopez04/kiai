import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { createApp } from "../src/http/app.ts";
import { resolvePlayer, type Player } from "../src/player.ts";
import { runImport } from "../src/scores/importer.ts";
import { createTestDb, type TestDb } from "./helpers/db.ts";
import { fakeOsu, score, USER_ID, type FakeOsu } from "./helpers/fake-osu.ts";

const ORIGIN = "http://localhost:8080";

let db: TestDb;
let osu: FakeOsu;
let app: Hono;
let player: Player;
let ids: number[];

const request = (path: string, init: RequestInit & { host?: string } = {}) => {
  const headers = new Headers(init.headers);
  headers.set("host", init.host ?? "localhost:8080");
  return app.request(`${ORIGIN}${path}`, { ...init, headers });
};
const post = (path: string, fields: Record<string, string>, origin = ORIGIN) =>
  request(path, { method: "POST", body: new URLSearchParams(fields), headers: { origin, "content-type": "application/x-www-form-urlencoded" } });

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.sql`truncate osu_users, beatmaps, scores, user_played_maps, sync_runs, score_archives cascade`;
  osu = fakeOsu();
  player = await resolvePlayer(db.sql, osu, "tester");
  app = createApp({ sql: db.sql, osu, player, config: { RECENT_WINDOW_HOURS: 24, PRIVATE_HOSTS: ["scores.home.example"] } });
});

async function seedScores() {
  const plays = [score(1, { pp: 300, mods: ["HD", "DT"] }), score(2, { pp: 100, mods: [] }), score(3, { pp: 200, mods: ["NC"] })];
  osu.recent = plays;
  await runImport({
    sql: db.sql, osu, pp: null, userId: USER_ID, mode: "recent", recentWindowHours: 24, checkpoint: {},
    assertActive: () => {}, saveCheckpoint: async () => {},
  });
  ids = plays.map((p) => p.id);
}

describe("the player", () => {
  it("is looked up on osu! once, then found locally by name or id", async () => {
    expect(player).toMatchObject({ id: USER_ID, username: "tester", pp: 5000 });
    osu.calls = [];
    expect((await resolvePlayer(db.sql, null, "TESTER")).id).toBe(USER_ID);
    expect((await resolvePlayer(db.sql, null, String(USER_ID))).username).toBe("tester");
    expect(osu.calls).toEqual([]);
  });

  it("explains what's missing when it can't be found", async () => {
    await expect(resolvePlayer(db.sql, null, "someone-else")).rejects.toThrow(/OSU_CLIENT_ID/);
    await expect(resolvePlayer(db.sql, osu, "nobody-here")).rejects.toThrow(/no user "nobody-here"/);
  });
});

describe("privacy", () => {
  it("serves the local network without any login", async () => {
    await seedScores();
    for (const host of ["localhost:8080", "192.168.1.20:8080", "homelab:8080", "scores.home.example"]) {
      expect((await request("/", { host })).status, host).toBe(200);
    }
  });

  it("refuses public hostnames and anything that came through a tunnel, for pages and API alike", async () => {
    const page = await request("/", { host: "replays.example.com" });
    expect(page.status).toBe(403);
    expect(await page.text()).toContain("private to your own network");
    expect((await request("/api/scores", { host: "replays.example.com" })).status).toBe(403);
    expect((await request("/api/scores", { headers: { "cf-connecting-ip": "203.0.113.9" } })).status).toBe(403);
    expect((await request("/healthz", { host: "replays.example.com" })).status).toBe(200);
  });

  it("refuses writes from other sites", async () => {
    expect((await post("/sync", { mode: "recent" }, "https://evil.example")).status).toBe(403);
    expect((await post("/sync", { mode: "recent" }, "null")).status).toBe(403);
    expect((await post("/sync", { mode: "recent" })).status).toBe(303);
  });
});

describe("pages", () => {
  it("renders the dashboard with filters applied and values escaped", async () => {
    await seedScores();
    await db.sql`update beatmaps set title = '<script>alert(1)</script>' where id = 1`;
    const page = await request("/?mods=DT&sort=pp");
    const body = await page.text();
    expect(page.status).toBe(200);
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(body).not.toContain("<script>alert(1)");
    expect(body).toContain("2 match");
    expect(body).toContain('data-mod="DT" data-state="required"');
    expect(body.indexOf("300pp")).toBeLessThan(body.indexOf("200pp"));
    expect(body).not.toContain("user=");
  });

  it("shows a score's detail page", async () => {
    await seedScores();
    const page = await request(`/scores/${ids[0]}`);
    expect(page.status).toBe(200);
    const body = await page.text();
    expect(body).toContain("Title 1");
    expect(body).toContain("180 → 270"); // BPM at 1.5×
    expect((await request("/scores/123")).status).toBe(404);
  });

  it("queues syncs from the dashboard, requiring RESET for a reset", async () => {
    await seedScores();
    const queued = await post("/sync", { mode: "history" });
    expect(decodeURIComponent(queued.headers.get("location")!)).toContain("Queued.");
    const again = await post("/sync", { mode: "recent" });
    expect(decodeURIComponent(again.headers.get("location")!)).toContain("already queued");
    await db.sql`update sync_runs set status = 'success'`;
    const reset = await post("/sync", { mode: "reset", confirm: "reset" });
    expect(reset.status).toBe(400);
    expect(await reset.text()).toContain("Type RESET");
    expect(await (await request("/partials/sync")).text()).toContain("data-sync-status");
  });
});

describe("API", () => {
  it("lists, filters and pages scores with the same parameters as the UI", async () => {
    await seedScores();
    const response = await request("/api/scores?mods=DT&sort=pp&order=asc");
    const body = (await response.json()) as { scores: { id: number }[]; pagination: unknown };
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body.scores.map((s) => s.id)).toEqual([ids[2], ids[0]]);
    expect(body.pagination).toEqual({ page: 1, page_size: 50, total_count: 2, total_pages: 1 });
  });

  it("returns the player, stats, a single score and sync status", async () => {
    await seedScores();
    expect(await (await request("/api/player")).json()).toMatchObject({ id: USER_ID, username: "tester" });
    expect(await (await request("/api/scores/stats")).json()).toMatchObject({ total_scores: 3, unique_beatmaps_played: 3 });
    expect(await (await request(`/api/scores/${ids[1]}`)).json()).toMatchObject({ id: ids[1], beatmap: { id: 2 } });
    expect((await request("/api/scores/1")).status).toBe(404);
    expect(await (await request("/api/sync")).json()).toMatchObject({ total_scores: 3, runs: [], osu_configured: true });
  });

  it("downloads filtered CSV", async () => {
    await seedScores();
    const response = await request("/api/scores/export?nomod=true");
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment; filename="osu-scores-1001-\d{4}-\d{2}-\d{2}\.csv"$/);
    const lines = (await response.text()).split("\r\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(`"${ids[1]}"`);
  });

  it("checks score links against osu!, caching the answer for an hour", async () => {
    await seedScores();
    await db.sql`update scores set score_link_status = 'unknown', score_link_checked_at = null`;
    osu.liveScores.set(ids[0]!, { id: ids[0]!, user_id: USER_ID });
    const check = (id: number) => request(`/api/scores/${id}/link`, { method: "POST", headers: { origin: ORIGIN } });
    expect(await (await check(ids[0]!)).json()).toEqual({ available: true, url: `https://osu.ppy.sh/scores/${ids[0]}` });
    expect(await (await check(ids[1]!)).json()).toEqual({ available: false, url: null });

    osu.calls = [];
    await check(ids[0]!);
    expect(osu.calls).toEqual([]);

    osu.failOnce.getScore = () => true;
    await db.sql`update scores set score_link_checked_at = now() - interval '2 hours' where id = ${ids[0]!}`;
    expect((await check(ids[0]!)).status).toBe(503);
  });

  it("queues syncs by API but never a reset", async () => {
    await seedScores();
    const json = (body: unknown) => ({ method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    const queued = await request("/api/sync", json({ mode: "history" }));
    expect(queued.status).toBe(202);
    expect(await queued.json()).toMatchObject({ already_queued: false });
    expect((await request("/api/sync", json({ mode: "reset" }))).status).toBe(400);
  });
});
