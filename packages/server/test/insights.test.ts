import os from "node:os";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.ts";
import { fillMonths } from "../src/http/insight-views.ts";
import { matchInsights, orderMods, parseInsightFilters, rankPeople, streaks } from "../src/matches/insights.ts";
import { fetchMatch, ingestMatch, recomputeAllMatches } from "../src/matches/store.ts";
import { mediaPaths } from "../src/media.ts";
import { resolvePlayer } from "../src/player.ts";
import { createPpCalculator } from "../src/scores/pp.ts";
import { createTestDb, type TestDb } from "./helpers/db.ts";
import { fakeOsu, osuFile, USER_ID, type FakeOsu } from "./helpers/fake-osu.ts";
import { OPPONENT_A, OPPONENT_B, stableMatch, TEAMMATE, teamMatch, type PlayLine } from "./helpers/matches.ts";

let db: TestDb;
let osu: FakeOsu;
const ids: Record<string, number> = {};

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.drop();
});

async function save(match: ReturnType<typeof teamMatch>) {
  osu.matches.set(match.match.id, match);
  const fetched = await fetchMatch(osu, "stable", match.match.id);
  return ingestMatch(db.sql, fetched!, { addedVia: "import", pp: createPpCalculator((id) => osu.getBeatmapFile(id)) });
}

const red = (a: number, b: number): PlayLine[] => [[USER_ID, a, "red"], [TEAMMATE, b, "red"]];
const blue = (a: number, b: number): PlayLine[] => [[OPPONENT_A, a, "blue"], [OPPONENT_B, b, "blue"]];
const duel = (me: number, them: number): PlayLine[] => [[USER_ID, me], [OPPONENT_A, them]];

beforeEach(async () => {
  await db.sql`truncate osu_users, beatmaps, matches, match_queue cascade`;
  osu = fakeOsu();
  for (const id of [11, 12, 13, 14, 15]) osu.files.set(id, osuFile());
  await resolvePlayer(db.sql, osu, "tester");
  // Aug: won 3–2 on the tiebreaker, with Mate against RivalOne and RivalTwo.
  ids.tiebreak = await save(teamMatch(1, { start: new Date("2026-08-01T12:00:00Z") }));
  // Sep: led 1–0, then lost 1–3.
  ids.choke = await save(
    stableMatch({
      id: 2,
      name: "TST 2026: (Red Rockets) vs (Blue Birds)",
      start: new Date("2026-09-05T12:00:00Z"),
      games: [
        { beatmapId: 11, plays: [...red(700_000, 600_000), ...blue(500_000, 500_000)] },
        { beatmapId: 12, plays: [...red(400_000, 400_000), ...blue(500_000, 500_000)] },
        { beatmapId: 13, plays: [...red(400_000, 400_000), ...blue(500_000, 500_000)] },
        { beatmapId: 14, plays: [...red(499_000, 500_000), ...blue(500_000, 500_000)] },
      ],
    }),
  );
  // Nov: a 1v1 against RivalOne, down 0–2 and won 3–2.
  ids.comeback = await save(
    stableMatch({
      id: 3,
      name: "ABC 2026: (tester) vs (RivalOne)",
      start: new Date("2026-11-10T12:00:00Z"),
      games: [
        { beatmapId: 11, teamType: "head-to-head", plays: duel(400_000, 500_000) },
        { beatmapId: 12, teamType: "head-to-head", plays: duel(400_000, 500_000) },
        { beatmapId: 13, teamType: "head-to-head", plays: duel(600_000, 500_000) },
        { beatmapId: 14, teamType: "head-to-head", plays: duel(600_000, 500_000) },
        { beatmapId: 11, teamType: "head-to-head", plays: duel(500_100, 500_000) },
      ],
    }),
  );
});

const insights = (params: Record<string, string> = {}) => matchInsights(db.sql, USER_ID, parseInsightFilters(new URLSearchParams(params)));

describe("match insights", () => {
  it("saves each game's result, and backfills them", async () => {
    const games = async () =>
      db.sql`select g.winner, g.counted from match_games g where g.match_id = ${ids.choke!} order by g.position`;
    expect((await games()).map((g) => g.winner)).toEqual(["red", "blue", "blue", "blue"]);
    await db.sql`update match_games set winner = null, counted = false`;
    await recomputeAllMatches(db.sql);
    expect((await games()).map((g) => [g.winner, g.counted])).toEqual([["red", true], ["blue", true], ["blue", true], ["blue", true]]);
  });

  it("summarizes the record, tiebreakers, maps and the people met", async () => {
    const { summary } = await insights();
    expect(summary).toMatchObject({
      matches: 3,
      won: 2,
      lost: 1,
      tiebreakers_won: 2,
      tiebreakers_lost: 0,
      maps: 14,
      maps_won: 7,
      maps_lost: 7,
      tournaments: 2,
      teammates: 1,
      opponents: 2,
      countries: 1,
      first_match: "2026-08-01T12:00:00.000Z",
    });
    expect(summary.mvp_of).toBe(3);
  });

  it("ranks teammates and opponents by user id, with records and match costs", async () => {
    const d = await insights();
    expect(d.teammates.map((p) => [p.id, p.username, p.matches, p.won, p.lost])).toEqual([[TEAMMATE, "Mate", 2, 1, 1]]);
    expect(d.opponents.map((p) => [p.id, p.matches, p.won, p.lost, p.events])).toEqual([
      [OPPONENT_A, 3, 2, 1, 2],
      [OPPONENT_B, 2, 1, 1, 1],
    ]);
    const rivalOne = d.opponents[0]!;
    expect(rivalOne.my_cost).toBeGreaterThan(0);
    expect(rivalOne.outcosted).toBeGreaterThanOrEqual(0);
    expect(d.countries).toEqual([{ country_code: "JP", matches: 3, won: 2, lost: 1, players: 2 }]);

    // A rename changes the name shown, never who is counted.
    await db.sql`update osu_users set username = 'NewRival' where id = ${OPPONENT_A}`;
    const renamed = await insights();
    expect(renamed.opponents.map((p) => [p.id, p.username, p.matches])).toEqual([
      [OPPONENT_A, "NewRival", 3],
      [OPPONENT_B, "RivalTwo", 2],
    ]);
  });

  it("finds comebacks, chokes, streaks and closest maps", async () => {
    const d = await insights();
    expect(d.records.comeback).toMatchObject({ match_id: ids.comeback, value: 2, us: 3, them: 2 });
    expect(d.records.choke).toMatchObject({ match_id: ids.choke, value: 1, us: 1, them: 3 });
    expect(d.records.biggest_win).toMatchObject({ value: 1 });
    expect(d.records.longest).toMatchObject({ value: 5 });
    expect(d.records.closest_win).toMatchObject({ match_id: ids.comeback, position: 5, margin: 100 });
    expect(d.records.closest_loss).toMatchObject({ match_id: ids.choke, position: 4, margin: 1_000 });
    expect(d.records.best_in_loss?.match_id).toBe(ids.choke);
    expect(d.streaks.current).toMatchObject({ kind: "won", length: 1 });
    expect(d.streaks.longest_loss).toMatchObject({ kind: "lost", length: 1 });
  });

  it("groups events, mods, maps and months", async () => {
    const d = await insights();
    expect(d.events.map((e) => [e.label, e.kind, e.matches, e.won, e.lost])).toEqual([
      ["ABC 2026", "tournament", 1, 1, 0],
      ["TST 2026", "tournament", 2, 1, 1],
    ]);
    expect(Object.fromEntries(d.mods.map((m) => [m.mods.join("") || "NM", m.maps]))).toEqual({ NM: 11, HD: 1, HR: 1, DT: 1 });
    expect(d.maps[0]).toMatchObject({ beatmap_id: 11, plays: 4 });
    expect(d.months.map((m) => [m.month, m.matches])).toEqual([["2026-08", 1], ["2026-09", 1], ["2026-11", 1]]);
    expect(fillMonths(d.months).map((m) => [m.month, m.matches])).toEqual([["2026-08", 1], ["2026-09", 1], ["2026-10", 0], ["2026-11", 1]]);
  });

  it("filters by name, date and Type", async () => {
    expect((await insights({ q: "ABC" })).summary.matches).toBe(1);
    expect((await insights({ date_from: "2026-09-01" })).summary.matches).toBe(2);
    expect((await insights({ hide: "tournament" })).summary.matches).toBe(0);
  });

  it("orders mods and ranks people met often enough", () => {
    expect(orderMods(["HR", "HD"])).toEqual(["HD", "HR"]);
    expect(orderMods(["DT", "HD"])).toEqual(["HD", "DT"]);
    const person = (id: number, matches: number, my_cost: number) =>
      ({ id, username: null, country_code: null, matches, won: 0, lost: 0, my_cost, their_cost: 1, outcosted: 0, events: 1, last_played: null });
    const list = [person(1, 5, 1.2), person(2, 1, 3), person(3, 4, 0.8)];
    expect(rankPeople(list, 3, (p) => p.my_cost, "desc").map((p) => p.id)).toEqual([1, 3]);
    expect(rankPeople(list, 1, (p) => p.my_cost, "asc").map((p) => p.id)).toEqual([3, 1, 2]);
    expect(streaks([{ outcome: 1, played_at: "a" }, { outcome: 1, played_at: "b" }, { outcome: 0, played_at: "c" }, { outcome: -1, played_at: "d" }])).toEqual({
      longest_win: { kind: "won", length: 2, from: "a", to: "b" },
      longest_loss: { kind: "lost", length: 1, from: "d", to: "d" },
      current: { kind: "lost", length: 1, from: "d", to: "d" },
    });
  });

  it("renders the stats page with players linked by id", async () => {
    const player = await resolvePlayer(db.sql, osu, "tester");
    const app = createApp({ sql: db.sql, osu, player, media: mediaPaths(os.tmpdir()), config: { RECENT_WINDOW_HOURS: 24, PRIVATE_HOSTS: [] } });
    const response = await app.request("http://localhost:8080/matches/stats?min=1", { headers: { host: "localhost:8080" } });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("Match stats");
    expect(body).toContain("Greatest comeback");
    expect(body).toContain(`href="/matches?with=${TEAMMATE}&amp;played=true"`);
    expect(body).toContain(`href="/matches?vs=${OPPONENT_A}&amp;played=true"`);
    expect(body).toContain('name="min" min="1" max="100" value="1"');
    const json = await app.request("http://localhost:8080/api/matches/insights", { headers: { host: "localhost:8080" } });
    expect(((await json.json()) as { summary: { matches: number } }).summary.matches).toBe(3);
  });
});
