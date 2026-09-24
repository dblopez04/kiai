import os from "node:os";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { createApp } from "../src/http/app.ts";
import { fetchMatch, ingestMatch } from "../src/matches/store.ts";
import { mediaPaths } from "../src/media.ts";
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
  app = createApp({ sql: db.sql, osu, player, media: mediaPaths(os.tmpdir()), config: { RECENT_WINDOW_HOURS: 24, PRIVATE_HOSTS: [] } });
  osu.matches.set(90001, teamMatch(90001));
  const fetched = await fetchMatch(osu, "stable", 90001);
  matchId = await ingestMatch(db.sql, fetched!, { addedVia: "import", pp: createPpCalculator((id) => osu.getBeatmapFile(id)) });
});

describe("match pages", () => {
  it("lists matches with the player's result, match cost, teammates and opponents", async () => {
    // Names become ids in the link, so it survives name changes; the box still shows the name.
    const redirect = await request("/matches?vs=RivalOne");
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("/matches?vs=3003");
    const response = await request("/matches?vs=3003");
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('name="vs" value="RivalOne"');
    expect(body).toContain('href="/matches?with=2002"');
    expect(body).toContain('href="/matches?vs=3003"');
    expect(body).toContain("TST 2026: (Red Rockets) vs (Blue Birds)");
    expect(body).toContain(`href="/matches/${matchId}"`);
    expect(body).toContain("2.75");
    expect(body).toContain("3–2");
    expect(body).toContain("Mate");
    expect(body).toContain("Stable tournament lobbies");
    for (const kind of ["tournament", "qualifiers", "romai", "etx", "omm", "ranked", "other"]) expect(body).toContain(`name="show" value="${kind}" checked`);
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
    expect(await (await request(`/matches/${matchId}`)).text()).toContain("The first map is a warmup");
    // An empty box goes back to finding them from the host (this match has no host changes).
    await post(`/matches/${matchId}/settings`, { warmups: "", skip_last: "0", ez_multiplier: "1" });
    const auto = (await (await request(`/api/matches/${matchId}`)).json()) as { warmups: number | null; me: { games_played: number } };
    expect(auto.warmups).toBeNull();
    expect(auto.me.games_played).toBe(5);
    expect(await (await request(`/matches/${matchId}`)).text()).toContain("No warmups found from the host");
    await post(`/matches/${matchId}/settings`, { warmups: "1", skip_last: "0", ez_multiplier: "1" });
  });

  it("leaves one map out from its menu and counts it again", async () => {
    type Detail = { me: { games_played: number }; games: { id: number; excluded: boolean; counted: boolean }[] };
    const detail = async () => (await (await request(`/api/matches/${matchId}`)).json()) as Detail;
    const before = await detail();
    const last = before.games.at(-1)!;
    expect(await (await request(`/matches/${matchId}`)).text()).toContain(`action="/matches/${matchId}/games/${last.id}/excluded"`);
    const response = await post(`/matches/${matchId}/games/${last.id}/excluded`, { excluded: "true" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/matches/${matchId}#game-${last.id}`);
    const after = await detail();
    expect(after.games.at(-1)).toMatchObject({ excluded: true, counted: false });
    expect(after.me.games_played).toBe(before.me.games_played - 1);
    const body = await (await request(`/matches/${matchId}`)).text();
    expect(body).toContain("left out</span>");
    expect(body).toContain("Count this map again</button>");
    await post(`/matches/${matchId}/games/${last.id}/excluded`, { excluded: "false" });
    expect((await detail()).me.games_played).toBe(before.me.games_played);
    expect((await post(`/matches/999999/games/${last.id}/excluded`, { excluded: "true" })).status).toBe(404);
  });

  it("marks a match as not a tournament and back", async () => {
    expect(await (await request(`/matches/${matchId}`)).text()).toContain("Not a tournament</button>");
    const response = await post(`/matches/${matchId}/tournament`, { not_tournament: "true" });
    expect(response.status).toBe(303);
    const body = await (await request(`/matches/${matchId}`)).text();
    expect(body).toContain("Stable multiplayer (not a tournament)");
    expect(body).toContain("Count as a tournament</button>");
    expect(((await (await request(`/api/matches/${matchId}`)).json()) as { kind: string }).kind).toBe("other");
    await post(`/matches/${matchId}/tournament`, { not_tournament: "false" });
    expect(((await (await request(`/api/matches/${matchId}`)).json()) as { kind: string }).kind).toBe("tournament");
    expect((await post("/matches/999999/tournament", { not_tournament: "true" })).status).toBe(404);
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
    const byName = await request("/matches/scores?player=rivalone&sort=pp");
    expect(byName.status).toBe(302);
    expect(byName.headers.get("location")).toBe("/matches/scores?sort=pp&player=3003");
    expect(await (await request("/matches/scores?sort=pp&player=3003")).text()).toContain('name="player" value="RivalOne"');
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
