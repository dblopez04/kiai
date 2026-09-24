import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { createApp } from "../src/http/app.ts";
import { fetchMatch, ingestMatch } from "../src/matches/store.ts";
import { resolvePlayer, type Player } from "../src/player.ts";
import { createPpCalculator } from "../src/scores/pp.ts";
import { createTestDb, type TestDb } from "./helpers/db.ts";
import { fakeOsu, osuFile, type FakeOsu } from "./helpers/fake-osu.ts";
import { teamMatch } from "./helpers/matches.ts";

const ORIGIN = "http://localhost:8080";

let db: TestDb;
let osu: FakeOsu;
let app: Hono;
let player: Player;
let matchId: number;

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
  await db.sql`truncate osu_users, beatmaps, matches, match_queue cascade`;
  osu = fakeOsu();
  for (const id of [11, 12, 13, 14, 15]) osu.files.set(id, osuFile());
  player = await resolvePlayer(db.sql, osu, "tester");
  app = createApp({ sql: db.sql, osu, player, config: { RECENT_WINDOW_HOURS: 24, PRIVATE_HOSTS: [] } });
  osu.matches.set(90001, teamMatch(90001));
  const fetched = await fetchMatch(osu, "stable", 90001);
  matchId = await ingestMatch(db.sql, fetched!, { addedVia: "import", pp: createPpCalculator((id) => osu.getBeatmapFile(id)) });
});

describe("match pages", () => {
  it("lists matches with the player's result, match cost, teammates and opponents", async () => {
    const response = await request("/matches?vs=RivalOne");
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("TST 2026: (Red Rockets) vs (Blue Birds)");
    expect(body).toContain(`href="/matches/${matchId}"`);
    expect(body).toContain("2.75");
    expect(body).toContain("3–2");
    expect(body).toContain("Mate");
    expect(body).toContain("Stable tournament lobbies");
  });

  it("shows one match with every map, score and match cost", async () => {
    const response = await request(`/matches/${matchId}`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("Red Rockets");
    expect(body).toContain("https://osu.ppy.sh/community/matches/90001");
    expect(body.match(/class="card game"/g)).toHaveLength(5);
    expect(body).toContain("RivalTwo");
    expect(body).toContain("tiebreaker");
    expect((await request("/matches/999999")).status).toBe(404);
  });

  it("recalculates match costs with warmups", async () => {
    const response = await post(`/matches/${matchId}/settings`, { warmups: "1", skip_last: "0", ez_multiplier: "1" });
    expect(response.status).toBe(303);
    const detail = (await (await request(`/api/matches/${matchId}`)).json()) as { warmups: number; me: { games_played: number } };
    expect(detail.warmups).toBe(1);
    expect(detail.me.games_played).toBe(4);
  });

  it("imports pasted Elitebotix history and adds single links", async () => {
    const text = "08-2026 - TST 2026: (A) vs (B) ----- https://osu.ppy.sh/community/matches/90001\n07-2026 - OLD: (C) vs (D) ----- https://osu.ppy.sh/community/matches/80001";
    const response = await post("/matches/import", { text });
    expect(response.status).toBe(303);
    expect(decodeURIComponent(response.headers.get("location")!)).toContain("Queued 1 match. 1 already saved.");
    expect((await db.sql`select external_id, name from match_queue`)).toEqual([{ external_id: 80001, name: "OLD: (C) vs (D)" }]);

    const known = await post("/matches/add", { link: "https://osu.ppy.sh/mp/90001" });
    expect(known.headers.get("location")).toBe(`/matches/${matchId}`);
    expect((await post("/matches/add", { link: "not a link" })).status).toBe(400);
    expect((await request("/mp/90001")).headers.get("location")).toBe(`/matches/${matchId}`);
  });

  it("searches tournament scores with the score filters", async () => {
    const page = await request("/matches/scores?sort=pp&player=all");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("RivalOne");
    const api = (await (await request("/api/matches/scores?mods=HD")).json()) as { pagination: { total_count: number } };
    expect(api.pagination.total_count).toBe(1);
  });

  it("pauses discovery and sets where stable discovery scans from", async () => {
    await post("/matches/discovery", { source: "lazer", enabled: "false" });
    await post("/matches/discovery/scan", { from: "118000000" });
    const { discovery } = (await (await request("/api/matches/queue")).json()) as { discovery: unknown[] };
    expect(discovery).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "lazer", enabled: false }),
        expect.objectContaining({ source: "stable", enabled: true, cursor: { lastId: 117999999 } }),
      ]),
    );
  });

  it("stays private, like the score library", async () => {
    expect((await request("/matches", { host: "replays.example.com" })).status).toBe(403);
    expect((await post("/matches/import", { text: "123456" }, "https://evil.example")).status).toBe(403);
  });
});
