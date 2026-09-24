import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { analyzeMatch, type CostGame } from "../src/matches/cost.ts";
import { crawlLazer, crawlStable, encodeCursor, scanStableFrom } from "../src/matches/discovery.ts";
import { parseMatchRefs } from "../src/matches/import.ts";
import { isCandidateName, matchmakingBot, parseMatchName } from "../src/matches/normalize.ts";
import {
  canonicalMatchFilters,
  getMatchDetail,
  listMatches,
  listTournamentScores,
  matchStats,
  parseMatchFilters,
  parseTournamentScoreFilters,
  resolveUsers,
} from "../src/matches/query.ts";
import { enqueueMatches, queueOverview } from "../src/matches/queue.ts";
import { fetchMatch, ingestMatch, setNotTournament, updateMatchSettings } from "../src/matches/store.ts";
import { createMatchStepper, type MatchWorkerDeps } from "../src/matches/worker.ts";
import { createPpCalculator } from "../src/scores/pp.ts";
import { createTestDb, type TestDb } from "./helpers/db.ts";
import { fakeOsu, osuFile, trackUser, USER_ID, type FakeOsu } from "./helpers/fake-osu.ts";
import { OPPONENT_A, OPPONENT_B, rankedPlayRoom, stableMatch, TEAMMATE, teamMatch, USERS } from "./helpers/matches.ts";

let db: TestDb;
let osu: FakeOsu;

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.drop();
});
beforeEach(async () => {
  await db.sql`truncate osu_users, beatmaps, matches, match_queue cascade`;
  await db.sql`update match_discovery set cursor = '{}', enabled = true, scanned = 0, probed = 0, found = 0, locked_until = null, last_error = null`;
  await trackUser(db.sql);
  osu = fakeOsu();
  for (const id of [11, 12, 13, 14, 15, 21, 22]) osu.files.set(id, osuFile());
});

const q = (params: Record<string, string> = {}) => new URLSearchParams(params);
const pp = () => createPpCalculator((id) => osu.getBeatmapFile(id));

async function save(match: ReturnType<typeof teamMatch>) {
  osu.matches.set(match.match.id, match);
  const fetched = await fetchMatch(osu, "stable", match.match.id);
  return ingestMatch(db.sql, fetched!, { addedVia: "import", pp: pp() });
}

function worker(overrides: Partial<MatchWorkerDeps> = {}) {
  return createMatchStepper({ sql: db.sql, osu, pp: pp(), playerId: USER_ID, playerName: "tester", discovery: true, log: () => {}, ...overrides });
}

describe("match cost (Bathbot's formula)", () => {
  const game = (id: number, scores: [number, number, ("red" | "blue" | "none")?, string[]?][], teamType = "team-vs"): CostGame => ({
    id,
    ended: true,
    teamType,
    scores: scores.map(([userId, score, team = "none" as const, mods = []]) => ({ userId, score, team, mods, accuracy: 0.9 })),
  });
  const options = { warmups: 0, skipLast: 0, ezMultiplier: 1, finished: true };

  it("averages score over each game's average, adds 0.5, and rewards playing every map", () => {
    const games = [
      game(1, [[1, 600_000], [2, 400_000]], "head-to-head"),
      game(2, [[1, 400_000], [2, 600_000]], "head-to-head"),
      game(3, [[1, 500_000], [2, 500_000]], "head-to-head"),
    ];
    const result = analyzeMatch(games, options);
    // (1.2 + 0.8 + 1.0) / 3 + 0.5 = 1.5; all maps played: × 1.5
    expect(result.players.map((p) => p.matchCost)).toEqual([2.25, 2.25]);
    expect(result.format).toBe("1v1");
    expect([result.redWins, result.blueWins]).toEqual([1, 1]);
  });

  it("scales the participation bonus with the share of maps played", () => {
    const games = [
      game(1, [[1, 500_000], [2, 500_000], [3, 500_000]], "head-to-head"),
      game(2, [[1, 500_000], [2, 500_000]], "head-to-head"),
      game(3, [[1, 500_000], [3, 500_000]], "head-to-head"),
    ];
    const [, second] = analyzeMatch(games, options).players.filter((p) => p.userId !== 1);
    // 2 of 3 maps: 1.5 ^ (0.5 ^ 0.6)
    expect(second!.participationBonus).toBeCloseTo(1.5 ** 0.5 ** 0.6, 10);
    expect(second!.matchCost).toBeCloseTo(1.5 * 1.5 ** 0.5 ** 0.6, 10);
  });

  it("gives 2% per mod combination beyond two, ignoring NoFail, and a tiebreaker bonus", () => {
    const r = (a: number, b: number, mods: string[] = []): [number, number, "red", string[]][] => [[1, a, "red", ["NF", ...mods]], [2, b, "red", ["NF"]]];
    const b = (a: number, c: number): [number, number, "blue"][] => [[3, a, "blue"], [4, c, "blue"]];
    const games = [
      game(1, [...r(600_000, 400_000), ...b(500_000, 400_000)]),
      game(2, [...r(300_000, 300_000, ["HD"]), ...b(500_000, 500_000)]),
      game(3, [...r(700_000, 500_000, ["HR"]), ...b(400_000, 400_000)]),
      game(4, [...r(200_000, 200_000, ["DT"]), ...b(600_000, 600_000)]),
      game(5, [...r(800_000, 600_000), ...b(500_000, 500_000)]),
    ];
    const result = analyzeMatch(games, options);
    const me = result.players.find((p) => p.userId === 1)!;
    expect(result.format).toBe("team");
    expect([result.redWins, result.blueWins]).toEqual([3, 2]);
    expect(result.tiebreaker).toBe(true);
    expect(me.modsBonus).toBeCloseTo(1.04, 10); // NM, HD, HR, DT
    expect(me.tiebreakerBonus).toBeCloseTo(0.25 * (800_000 / 600_000), 10);
    // (600/475 + 300/400 + 700/500 + 200/400 + 800/600) / 5 + 0.5, × 1.5 × 1.04, + TB
    expect(me.matchCost).toBeCloseTo(2.750238, 5);
    expect(analyzeMatch(games, { ...options, finished: false }).tiebreaker).toBe(false);
  });

  it("skips warmups, zero scores and trailing maps, and multiplies EZ scores", () => {
    const games = [
      game(1, [[1, 100_000], [2, 900_000]], "head-to-head"),
      game(2, [[1, 500_000], [2, 500_000], [3, 0]], "head-to-head"),
      game(3, [[1, 400_000, "none", ["EZ"]], [2, 600_000]], "head-to-head"),
      game(4, [[1, 1], [2, 999_999]], "head-to-head"),
    ];
    const result = analyzeMatch(games, { ...options, warmups: 1, skipLast: 1, ezMultiplier: 1.5 });
    expect(result.players.map((p) => p.userId).sort()).toEqual([1, 2]);
    expect(result.games.map((g) => g.counted)).toEqual([false, true, true, false]);
    // Game 3: 600k (EZ ×1.5) vs 600k: a draw.
    expect(result.games[2]!.winner).toBeNull();
  });
});

describe("names and imports", () => {
  it("parses tournament names", () => {
    expect(parseMatchName("OWC 2025: (United States) vs (Japan)")).toEqual({ acronym: "OWC 2025", red: "United States", blue: "Japan" });
    expect(parseMatchName("5WC: Team A VS. Team B")).toEqual({ acronym: "5WC", red: "Team A", blue: "Team B" });
    expect(parseMatchName("ACR: Qualifiers Lobby 3")).toEqual({ acronym: "ACR", red: null, blue: null });
    expect(parseMatchName("peppy's game")).toEqual({ acronym: null, red: null, blue: null });
  });

  it("recognizes matchmaking bot lobbies", () => {
    expect(matchmakingBot("ROMAI: (tester) vs (RivalTwo)")).toBe("romai");
    expect(matchmakingBot("etx: (tester) vs (RivalTwo)")).toBe("etx");
    expect(matchmakingBot("o!mm Ranked: tester vs RivalTwo")).toBe("omm");
    expect(matchmakingBot("O!MM: casual")).toBe("omm");
    for (const name of ["ROMAIC: (A) vs (B)", "ETXC 2026: (A) vs (B)", "OWC 2025: (ETX) vs (Japan)", "peppy's o!mm lobby"]) {
      expect(matchmakingBot(name)).toBeNull();
    }
    expect(isCandidateName("4* auto host", "tester")).toBe(false);
    expect(isCandidateName("tester's lobby", "tester")).toBe(true);
  });

  it("reads Elitebotix history files, mp links, room links and bare ids", () => {
    const text = [
      "08-2026 - TST 2026: (Red Rockets) vs (Blue Birds) ----- https://osu.ppy.sh/community/matches/111",
      "09-2026 - TST 2026: Qualifiers Lobby 2 ----- XXXXXXXXX (hidden for 14 days)",
      "see https://osu.ppy.sh/mp/222 and osu.ppy.sh/multiplayer/rooms/333",
      "444444",
      "https://osu.ppy.sh/community/matches/111",
    ].join("\n");
    expect(parseMatchRefs(text)).toEqual({
      refs: [
        { source: "stable", externalId: 111, name: "TST 2026: (Red Rockets) vs (Blue Birds)" },
        { source: "stable", externalId: 222 },
        { source: "lazer", externalId: 333 },
        { source: "stable", externalId: 444444 },
      ],
      hidden: 1,
    });
  });
});

describe("saving matches", () => {
  it("pages through every event and saves games, scores, players, local PP and the score line", async () => {
    const id = await save(teamMatch(90001, { filler: 250 }));
    expect(osu.calls.filter((c) => c.startsWith("getMatch"))).toHaveLength(3);

    const detail = (await getMatchDetail(db.sql, USER_ID, id))!;
    expect(detail.acronym).toBe("TST 2026");
    expect(detail.format).toBe("team");
    expect([detail.red_wins, detail.blue_wins]).toEqual([3, 2]);
    expect(detail.result).toBe("won");
    expect(detail.tiebreaker).toBe(true);
    expect(detail.games).toHaveLength(5);
    expect(detail.games.map((g) => g.winner)).toEqual(["red", "blue", "red", "blue", "red"]);
    expect(detail.me!.match_cost).toBeCloseTo(2.750238, 5);
    expect(detail.players.map((p) => p.side)).toEqual(["red", "red", "blue", "blue"]);
    const myScores = detail.games.flatMap((g) => g.scores.filter((s) => s.user_id === USER_ID));
    expect(myScores.every((s) => s.pp_source === "local" && s.pp! > 0)).toBe(true);
    expect(detail.players.find((p) => p.user_id === OPPONENT_A)!.username).toBe("RivalOne");
  });

  it("keeps the player's own profile when saving match players", async () => {
    await db.sql`update osu_users set pp = 5000 where id = ${USER_ID}`;
    await save(teamMatch(90002));
    const [me] = await db.sql`select pp, username from osu_users where id = ${USER_ID}`;
    expect(me).toEqual({ pp: 5000, username: "tester" });
  });

  it("recomputes match costs when warmups change", async () => {
    const id = await save(teamMatch(90003));
    await updateMatchSettings(db.sql, id, { warmups: 1, skipLast: 0, ezMultiplier: 1 });
    const detail = (await getMatchDetail(db.sql, USER_ID, id))!;
    expect(detail.games[0]!.counted).toBe(false);
    expect([detail.red_wins, detail.blue_wins]).toEqual([2, 2]);
    expect(detail.me!.games_played).toBe(4);
  });

  it("saves lazer ranked play rooms as 1v1s, keeping osu!'s PP", async () => {
    const { events } = rankedPlayRoom(4001, [
      { beatmapId: 21, scores: [[USER_ID, 900_000, 250], [OPPONENT_A, 800_000, 240]] },
      { beatmapId: 22, scores: [[USER_ID, 700_000], [OPPONENT_A, 750_000]] },
    ]);
    osu.rooms.set(4001, events);
    const fetched = await fetchMatch(osu, "lazer", 4001);
    const id = await ingestMatch(db.sql, fetched!, { addedVia: "discovery", pp: pp() });
    const detail = (await getMatchDetail(db.sql, USER_ID, id))!;
    expect(detail.source).toBe("lazer");
    expect(detail.url).toBe("https://osu.ppy.sh/multiplayer/rooms/4001");
    expect(detail.format).toBe("1v1");
    expect(detail.games.map((g) => g.winner)).toEqual(["red", "blue"]);
    expect(detail.games[0]!.scores.find((s) => s.user_id === USER_ID)!).toMatchObject({ pp: 250, pp_source: "osu" });
    expect(detail.games[1]!.scores.find((s) => s.user_id === USER_ID)!.pp_source).toBe("local");
  });
});

describe("searching matches", () => {
  beforeEach(async () => {
    await save(teamMatch(1, { start: new Date("2026-07-01T00:00:00Z") }));
    // A 1v1 the player lost against RivalTwo.
    await save(
      stableMatch({
        id: 2,
        name: "ABC: (tester) vs (RivalTwo)",
        start: new Date("2026-08-01T00:00:00Z"),
        games: [
          { beatmapId: 11, teamType: "head-to-head", plays: [[USER_ID, 300_000], [OPPONENT_B, 700_000]] },
          { beatmapId: 12, teamType: "head-to-head", plays: [[USER_ID, 300_000], [OPPONENT_B, 700_000]] },
        ],
      }),
    );
    // A match someone else played, added by hand.
    await save(stableMatch({ id: 3, name: "XYZ: (A) vs (B)", games: [{ beatmapId: 11, plays: [[TEAMMATE, 1, "red"], [OPPONENT_A, 2, "blue"]] }] }));
  });
  const names = async (params: Record<string, string>) =>
    (await listMatches(db.sql, USER_ID, parseMatchFilters(q(params)))).matches.map((m) => m.external_id);

  it("filters by teammates and opponents, relative to the player", async () => {
    expect(await names({ with: "mate" })).toEqual([1]);
    expect(await names({ vs: "RivalTwo" })).toEqual([2, 1]);
    expect(await names({ vs: "rivalone" })).toEqual([3, 1]);
    expect(await names({ with: "RivalOne" })).toEqual([]);
    expect(await names({ vs: String(OPPONENT_B), with: "Mate" })).toEqual([1]);
    const page = await listMatches(db.sql, USER_ID, parseMatchFilters(q({ with: "nobody" })));
    expect(page.unknown_players).toEqual(["nobody"]);
    expect(page.matches).toEqual([]);
  });

  it("finds players by id and by any name they had, after a name change", async () => {
    await db.sql`update osu_users set username = 'NewMate' where id = ${TEAMMATE}`;
    expect(await names({ with: String(TEAMMATE) })).toEqual([1]);
    expect(await names({ with: "newmate" })).toEqual([1]);
    expect(await names({ with: "Mate" })).toEqual([1]);
    const page = await listMatches(db.sql, USER_ID, parseMatchFilters(q({ with: "mate" })));
    expect(page.player_names).toEqual({ mate: "NewMate" });

    // Someone else taking the old name gets it for their current name; the id still finds the first.
    await db.sql`update osu_users set username = 'Mate' where id = ${OPPONENT_A}`;
    expect((await resolveUsers(db.sql, ["Mate", String(TEAMMATE)])).ids).toEqual(new Map([["Mate", OPPONENT_A], [String(TEAMMATE), TEAMMATE]]));
  });

  it("looks names it hasn't seen up on osu!, which follows renames", async () => {
    osu.users.set(TEAMMATE, { id: TEAMMATE, username: "Mate", previous_usernames: ["FirstMate"] });
    osu.users.set(9999, { id: 9999, username: "Stranger" });
    const found = await resolveUsers(db.sql, ["FirstMate", "Stranger", "nobody"], osu);
    expect(found.ids).toEqual(new Map([["FirstMate", TEAMMATE]]));
    expect(found.unknown).toEqual(["Stranger", "nobody"]);
    // Remembered, so the next search doesn't need osu!.
    expect((await resolveUsers(db.sql, ["firstmate"])).ids.get("firstmate")).toBe(TEAMMATE);
  });

  it("rewrites names in the player filters to ids", async () => {
    const f = await canonicalMatchFilters(db.sql, parseMatchFilters(q({ with: "Mate", vs: `rivalone,${OPPONENT_A},nobody` })), null);
    expect(f.with).toEqual([String(TEAMMATE)]);
    expect(f.vs).toEqual([String(OPPONENT_A), "nobody"]);
  });

  it("filters by result, name, played and match cost, and sorts by match cost", async () => {
    expect(await names({ result: "won" })).toEqual([1]);
    expect(await names({ result: "lost" })).toEqual([2]);
    expect(await names({ q: "abc tester" })).toEqual([2]);
    expect(await names({ played: "true" })).toEqual([2, 1]);
    expect(await names({ min_cost: "2" })).toEqual([1]);
    expect(await names({ sort: "match_cost", played: "true" })).toEqual([1, 2]);
    expect(await names({ sort: "match_cost", order: "asc", played: "true" })).toEqual([2, 1]);
    const [first] = (await listMatches(db.sql, USER_ID, parseMatchFilters(q({ q: "TST" })))).matches;
    expect(first!.teammates.map((p) => p.username)).toEqual(["Mate"]);
    expect(first!.opponents.map((p) => p.username).sort()).toEqual(["RivalOne", "RivalTwo"]);
  });

  it("summarizes the player's record", async () => {
    expect(await matchStats(db.sql, USER_ID)).toMatchObject({ matches: 3, played: 2, won: 1, lost: 1, tournaments: 3 });
  });

  it("hides tournaments, each matchmaking bot or ranked play, but never other lobbies", async () => {
    const duel = (id: number, name: string) =>
      stableMatch({ id, name, games: [{ beatmapId: 11, teamType: "head-to-head", plays: [[USER_ID, 500_000], [OPPONENT_B, 400_000]] }] });
    await save(duel(4, "ROMAI: (tester) vs (RivalTwo)"));
    await save(duel(5, "ETX: (tester) vs (RivalTwo)"));
    await save(duel(6, "o!mm Ranked: tester vs RivalTwo"));
    await save(duel(7, "tester's lobby"));
    const all = (await listMatches(db.sql, USER_ID, parseMatchFilters(q()))).matches;
    expect(Object.fromEntries(all.map((m) => [m.external_id, m.kind]))).toEqual({
      1: "tournament", 2: "tournament", 3: "tournament", 4: "romai", 5: "etx", 6: "omm", 7: "other",
    });
    expect((await names({ hide: "tournament" })).sort()).toEqual([4, 5, 6, 7]);
    expect((await names({ hide: "romai" })).sort()).toEqual([1, 2, 3, 5, 6, 7]);
    expect((await names({ hide: "romai,etx,omm" })).sort()).toEqual([1, 2, 3, 7]);
    // `other` has no box, so it can't be hidden, like any unknown kind.
    expect((await names({ hide: "other,bogus" })).length).toBe(7);
    // The form sends the ticked boxes, and a marker so unticking all of them still counts.
    const form = (...shown: string[]) => new URLSearchParams([["show", "-"], ...shown.map((kind): [string, string] => ["show", kind])]);
    const shown = async (...kinds: string[]) =>
      (await listMatches(db.sql, USER_ID, parseMatchFilters(form(...kinds)))).matches.map((m) => m.external_id).sort();
    expect(await shown("tournament", "romai", "etx", "omm", "ranked")).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(await shown("tournament", "ranked")).toEqual([1, 2, 3, 7]);
    expect(await shown()).toEqual([7]);
    expect(parseMatchFilters(form("tournament", "ranked")).hide).toEqual(["romai", "etx", "omm"]);
    expect(await matchStats(db.sql, USER_ID)).toMatchObject({ matches: 7, tournaments: 3 });
    const scores = async (params: Record<string, string>) =>
      (await listTournamentScores(db.sql, USER_ID, parseTournamentScoreFilters(q(params)))).pagination.total_count;
    expect(await scores({})).toBe(11);
    expect(await scores({ hide: "romai,etx,omm" })).toBe(8);
    expect(await scores({ hide: "tournament" })).toBe(4);
  });

  it("stops counting a casual lobby with a tournament-style name as a tournament", async () => {
    const [row] = await db.sql<{ id: number }[]>`select id from matches where external_id = 2`;
    const id = row!.id;
    const kind = async () => (await listMatches(db.sql, USER_ID, parseMatchFilters(q({ q: "ABC" })))).matches[0]!.kind;
    expect(await setNotTournament(db.sql, id, true)).toBe(true);
    expect(await kind()).toBe("other");
    expect(await names({ hide: "tournament" })).toEqual([2]);
    expect(await matchStats(db.sql, USER_ID)).toMatchObject({ matches: 3, tournaments: 2 });
    const scores = async (params: Record<string, string>) =>
      (await listTournamentScores(db.sql, USER_ID, parseTournamentScoreFilters(q(params)))).pagination.total_count;
    expect(await scores({ hide: "tournament" })).toBe(2);
    // Fetching the match again keeps the mark.
    await save(stableMatch({ id: 2, name: "ABC: (tester) vs (RivalTwo)", games: [{ beatmapId: 11, teamType: "head-to-head", plays: [[USER_ID, 1], [OPPONENT_B, 2]] }] }));
    expect(await kind()).toBe("other");
    expect(await setNotTournament(db.sql, id, false)).toBe(true);
    expect(await kind()).toBe("tournament");
    expect(await setNotTournament(db.sql, 999_999, true)).toBe(false);
  });

  it("searches tournament scores with the score library's filters", async () => {
    const list = async (params: Record<string, string>) => listTournamentScores(db.sql, USER_ID, parseTournamentScoreFilters(q(params)));
    const mine = await list({ sort: "pp" });
    expect(mine.pagination.total_count).toBe(7);
    expect(mine.scores.every((s) => s.user_id === USER_ID)).toBe(true);
    const pps = mine.scores.map((s) => s.pp!);
    expect(pps).toEqual(pps.toSorted((a, b) => b - a));
    // NoFail is ignored, so NM means no other mods.
    expect((await list({ nomod: "true" })).pagination.total_count).toBe(4);
    expect((await list({ mods: "HD" })).pagination.total_count).toBe(1);
    expect((await list({ player: "all" })).pagination.total_count).toBe(26);
    expect((await list({ player: "RivalTwo", match: "abc" })).pagination.total_count).toBe(2);
    expect((await list({ best_only: "true" })).pagination.total_count).toBe(5);
    expect((await list({ player: "ghost" })).unknown_player).toBe("ghost");
  });
});

describe("match worker", () => {
  it("fetches imported matches, keeping failures for a retry", async () => {
    osu.matches.set(10, teamMatch(10));
    osu.privateMatches.add(11);
    await enqueueMatches(db.sql, parseMatchRefs("https://osu.ppy.sh/mp/10\nhttps://osu.ppy.sh/mp/11\nhttps://osu.ppy.sh/mp/12").refs, { addedVia: "import" });
    const step = worker({ discovery: false });
    while (await step()) {}
    expect((await db.sql`select external_id from matches`).map((r) => r.external_id)).toEqual([10]);
    const overview = await queueOverview(db.sql);
    expect(overview.failed_count).toBe(2);
    expect(overview.failed.map((f) => f.last_error).sort()).toEqual(["This match is private on osu!.", "osu! has no match with this id."]);
    // Known matches aren't queued again.
    expect(await enqueueMatches(db.sql, [{ source: "stable", externalId: 10 }], { addedVia: "import" })).toEqual({ queued: 0, known: 1 });
  });

  it("refreshes matches still in progress", async () => {
    const running = teamMatch(20, { ended: false, start: new Date() });
    osu.matches.set(20, running);
    await enqueueMatches(db.sql, [{ source: "stable", externalId: 20 }], { addedVia: "manual" });
    await worker({ discovery: false })();
    const [row] = await db.sql`select kind, priority, not_before > now() as later from match_queue`;
    expect(row).toEqual({ kind: "fetch", priority: 1, later: true });
  });

  it("crawls stable lobbies two hours behind, probing tournament names and keeping the player's", async () => {
    const old = new Date(Date.now() - 5 * 3600_000).toISOString();
    const recent = new Date(Date.now() - 600_000).toISOString();
    osu.lobbies = [
      { id: 100, name: "4* auto host", start_time: old, end_time: old },
      { id: 101, name: "TST 2026: (Red Rockets) vs (Blue Birds)", start_time: old, end_time: old },
      { id: 102, name: "ZZZ: (Others) vs (People)", start_time: old, end_time: old },
      { id: 103, name: "TST 2026: (C) vs (D)", start_time: recent, end_time: null },
    ];
    osu.matches.set(101, teamMatch(101));
    osu.matches.set(102, stableMatch({ id: 102, name: "ZZZ: (Others) vs (People)", games: [{ beatmapId: 11, plays: [[OPPONENT_A, 1, "red"], [OPPONENT_B, 2, "blue"]] }] }));
    await scanStableFrom(db.sql, 100);

    const step = worker();
    for (let i = 0; i < 6; i++) await step();
    expect((await db.sql`select external_id, added_via from matches`).map((r) => [r.external_id, r.added_via])).toEqual([[101, "discovery"]]);
    const [state] = await db.sql`select cursor, scanned, probed, found from match_discovery where source = 'stable'`;
    expect(state).toEqual({ cursor: { lastId: 102 }, scanned: 3, probed: 2, found: 1 });
    expect(osu.calls).not.toContain("getMatch 100 0");
    expect(await db.sql`select * from match_queue`).toHaveLength(0);
  });

  it("starts the stable crawl at the newest lobby", async () => {
    osu.lobbies = [{ id: 7, name: "a" }, { id: 9, name: "b" }];
    await crawlStable({ sql: db.sql, osu, playerId: USER_ID, playerName: "tester" });
    const [state] = await db.sql`select cursor from match_discovery where source = 'stable'`;
    expect(state!.cursor).toEqual({ lastId: 9 });
  });

  it("walks the player's ranked play history back to the last pass and queues every room", async () => {
    const mine = rankedPlayRoom(5001, [{ beatmapId: 21, scores: [[USER_ID, 1], [OPPONENT_A, 2]] }], "2026-09-01T11:00:00Z");
    osu.rooms.set(5001, mine.events);
    osu.rankedRooms = [
      mine.room,
      ...Array.from({ length: 120 }, (_, i) => ({ id: 6000 + i, ends_at: new Date(Date.parse("2026-09-02T00:00:00Z") + i * 1000).toISOString() })),
    ];
    const deps = { sql: db.sql, osu, playerId: USER_ID, playerName: "tester" };
    expect(await crawlLazer(deps)).toBe("worked");
    expect(await crawlLazer(deps)).toBe("worked");
    expect(await crawlLazer(deps)).toBe("idle");
    expect(osu.calls).toEqual([`listUserRankedPlayRooms ${USER_ID}`, `listUserRankedPlayRooms ${USER_ID} 6070`, `listUserRankedPlayRooms ${USER_ID} 6020`]);
    const queued = (await db.sql`select external_id from match_queue where source = 'lazer' order by external_id`).map((r) => Number(r.external_id));
    expect(queued).toEqual([5001, ...Array.from({ length: 120 }, (_, i) => 6000 + i)]);
    const [state] = await db.sql`select cursor, scanned, found from match_discovery where source = 'lazer'`;
    expect(state!.scanned).toBe(121);
    expect(state!.found).toBe(121);
    expect(state!.cursor).toEqual({ watermark: { ends_at: osu.rankedRooms[120]!.ends_at, id: 6119 } });

    // The next pass stops at the watermark.
    osu.rankedRooms.push({ id: 7000, ends_at: "2026-09-03T00:00:00Z" });
    expect(await crawlLazer(deps)).toBe("idle");
    expect(osu.calls.at(-1)).toBe(`listUserRankedPlayRooms ${USER_ID}`);
    const [next] = await db.sql`select cursor, scanned from match_discovery where source = 'lazer'`;
    expect(next!.scanned).toBe(122);
    expect(next!.cursor).toEqual({ watermark: { ends_at: "2026-09-03T00:00:00Z", id: 7000 } });
    expect(encodeCursor({ a: 1 })).toBe(Buffer.from('{"a":1}').toString("base64url"));
  });
});
