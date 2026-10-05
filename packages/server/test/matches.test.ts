import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../src/db/index.ts";
import { analyzeMatch, type CostGame } from "../src/matches/cost.ts";
import { crawlLazer, crawlStable, encodeCursor, scanStableFrom } from "../src/matches/discovery.ts";
import { parseMatchRefs } from "../src/matches/import.ts";
import { isCandidateName, matchmakingBot, normalizeStableMatch, parseMatchName } from "../src/matches/normalize.ts";
import {
  canonicalMatchFilters,
  getMatchDetail,
  listMatches,
  listTournamentScores,
  matchFiltersToParams,
  matchStats,
  parseMatchFilters,
  parseTournamentScoreFilters,
  resolveUsers,
} from "../src/matches/query.ts";
import { enqueueMatches, queueOverview } from "../src/matches/queue.ts";
import { fetchMatch, ingestMatch, recomputeQualifierMatches, setGameExcluded, setNotTournament, updateMatchSettings } from "../src/matches/store.ts";
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

  it("leaves out maps marked by hand, after warmups and skipped maps go by position", () => {
    const games = [
      game(1, [[1, 100_000], [2, 900_000]], "head-to-head"),
      { ...game(2, [[1, 500_000], [2, 400_000]], "head-to-head"), excluded: true },
      game(3, [[1, 600_000], [2, 400_000]], "head-to-head"),
      game(4, [[1, 1], [2, 999_999]], "head-to-head"),
    ];
    const result = analyzeMatch(games, { ...options, warmups: 1 });
    expect(result.games.map((g) => g.counted)).toEqual([false, false, true, true]);
    expect([result.redWins, result.blueWins]).toEqual([1, 1]);
    expect(result.players.find((p) => p.userId === 1)!.gamesPlayed).toBe(2);
  });

  it("drops the tiebreaker bonus when a fun tiebreaker is left out", () => {
    const r = (a: number, b: number): [number, number, "red"][] => [[1, a, "red"], [2, b, "red"]];
    const b = (a: number, c: number): [number, number, "blue"][] => [[3, a, "blue"], [4, c, "blue"]];
    const games = [
      game(1, [...r(600_000, 600_000), ...b(400_000, 400_000)]),
      game(2, [...r(600_000, 600_000), ...b(400_000, 400_000)]),
      game(3, [...r(600_000, 600_000), ...b(400_000, 400_000)]),
      game(4, [...r(400_000, 400_000), ...b(600_000, 600_000)]),
      game(5, [...r(400_000, 400_000), ...b(600_000, 600_000)]),
      game(6, [...r(400_000, 400_000), ...b(600_000, 600_000)]),
      game(7, [...r(600_000, 600_000), ...b(400_000, 400_000)]),
    ];
    expect(analyzeMatch(games, options).tiebreaker).toBe(true);
    const funTiebreaker = games.map((g) => (g.id === 7 ? { ...g, excluded: true } : g));
    const result = analyzeMatch(funTiebreaker, options);
    expect(result.tiebreaker).toBe(false);
    expect([result.redWins, result.blueWins]).toEqual([3, 3]);
    expect(result.players.every((p) => p.tiebreakerBonus === 0)).toBe(true);
  });

  describe("warmups from the host", () => {
    const REF = 99;
    const hosted = (hosts: (number | null)[]) =>
      hosts.map((hostId, i) => ({ ...game(i + 1, [[1, 500_000 + i], [2, 400_000]], "head-to-head"), hostId }));
    const warmups = (games: CostGame[]) =>
      analyzeMatch(games, { ...options, warmups: "host" }).games.filter((g) => g.warmup).map((g) => g.id);

    it("leaves out maps played while a player held the host, two at most", () => {
      expect(warmups(hosted([1, 2, null, null]))).toEqual([1, 2]);
      expect(warmups(hosted([1, 2, 2, null]))).toEqual([1, 2]);
      // Not only at the start: a host handed out mid-match counts too.
      expect(warmups(hosted([null, 1, null]))).toEqual([2]);
      const result = analyzeMatch(hosted([1, null, null]), { ...options, warmups: "host" });
      expect(result.games.map((g) => g.counted)).toEqual([false, true, true]);
      expect(result.players.find((p) => p.userId === 1)!.gamesPlayed).toBe(2);
    });

    it("ignores a host who didn't play, and a lobby a player hosted throughout", () => {
      expect(warmups(hosted([REF, REF, null]))).toEqual([]);
      expect(warmups(hosted([1, 1, 1]))).toEqual([]);
      expect(warmups(hosted([null, null]))).toEqual([]);
      // Unfinished games aren't warmups, and don't count as games without a player host.
      const aborted = hosted([1, null]);
      aborted[1] = { ...aborted[1]!, ended: false };
      expect(warmups(aborted)).toEqual([]);
    });

    it("uses a warmup count instead when one is set", () => {
      expect(analyzeMatch(hosted([1, null, null]), { ...options, warmups: 0 }).games.map((g) => g.warmup)).toEqual([false, false, false]);
      expect(analyzeMatch(hosted([null, null, 1]), { ...options, warmups: 1 }).games.map((g) => g.warmup)).toEqual([true, false, false]);
    });
  });
});

describe("normalizing stable matches", () => {
  it("tracks who holds the host when each game starts", () => {
    const match = stableMatch({
      id: 1,
      name: "TST: (A) vs (B)",
      games: [
        { beatmapId: 11, plays: [[USER_ID, 1]], host: USER_ID },
        { beatmapId: 12, plays: [[USER_ID, 1]], host: 0 },
        { beatmapId: 13, plays: [[USER_ID, 1]], host: TEAMMATE },
        { beatmapId: 14, plays: [[USER_ID, 1]] },
      ],
    });
    // The host leaving before the last game: nobody holds it.
    match.events.splice(-1, 0, { id: 1, detail: { type: "player-left" }, user_id: TEAMMATE });
    expect(normalizeStableMatch([match]).games.map((g) => g.hostId)).toEqual([USER_ID, null, TEAMMATE, null]);
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
    expect(detail.games.map((g) => g.scores.map((s) => s.side))).toEqual(
      detail.games.map((g) => (g.winner === "blue" ? ["blue", "blue", "red", "red"] : ["red", "red", "blue", "blue"])),
    );
    const myScores = detail.games.flatMap((g) => g.scores.filter((s) => s.user_id === USER_ID));
    expect(myScores.every((s) => s.pp_source === "local" && s.pp! > 0)).toBe(true);
    expect(detail.players.find((p) => p.user_id === OPPONENT_A)!.username).toBe("RivalOne");
  });

  it("gives qualifier lobbies no result, even in team vs or with two players", async () => {
    const teams = (await getMatchDetail(db.sql, USER_ID, await save(teamMatch(90010, { name: "TST 2026: Qualifiers Lobby 3" }))))!;
    const pair = (await getMatchDetail(
      db.sql,
      USER_ID,
      await save(stableMatch({ id: 90011, name: "TST 2026: (Qualifiers) Lobby 4", games: [{ beatmapId: 11, teamType: "head-to-head", plays: [[USER_ID, 1], [OPPONENT_A, 2]] }] })),
    ))!;
    for (const detail of [teams, pair]) {
      expect(detail.kind).toBe("qualifiers");
      expect(detail.format).toBe("ffa");
      expect([detail.red_wins, detail.blue_wins, detail.result, detail.tiebreaker]).toEqual([null, null, null, false]);
      expect(detail.games.every((g) => g.winner === null)).toBe(true);
      expect(detail.players.every((p) => p.side === null && p.tiebreaker_bonus === 0)).toBe(true);
      expect(detail.me!.match_cost).toBeGreaterThan(0);
    }
    expect(await matchStats(db.sql, USER_ID)).toMatchObject({ won: 0, lost: 0 });
    // Qualifiers saved before this rule lose their score line when migrated.
    await db.sql`update matches set red_wins = 1, blue_wins = 0 where id = ${pair.id}`;
    await recomputeQualifierMatches(db.sql);
    expect((await getMatchDetail(db.sql, USER_ID, pair.id))!.result).toBeNull();
    // Marked as a casual lobby, it's an ordinary team match again.
    await setNotTournament(db.sql, teams.id, true);
    expect((await getMatchDetail(db.sql, USER_ID, teams.id))!.result).toBe("won");
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

  it("finds warmups from the host in tournament lobbies", async () => {
    // A captain picks the warmup with the host, then the ref clears it for the mappool.
    const hostWarmup = (id: number, name?: string) => {
      const match = teamMatch(id, name ? { name } : {});
      const [first, second] = match.events.filter((e) => e.game);
      match.events.splice(match.events.indexOf(first!), 0, { id: 1, detail: { type: "host-changed" }, user_id: TEAMMATE });
      match.events.splice(match.events.indexOf(second!), 0, { id: 2, detail: { type: "host-changed" }, user_id: 0 });
      return match;
    };
    const id = await save(hostWarmup(90007));
    const detail = (await getMatchDetail(db.sql, USER_ID, id))!;
    expect(detail.warmups).toBeNull();
    expect(detail.games.map((g) => g.warmup)).toEqual([true, false, false, false, false]);
    expect(detail.games[0]).toMatchObject({ counted: false, host_id: TEAMMATE, host_name: "Mate" });
    expect([detail.red_wins, detail.blue_wins]).toEqual([2, 2]);
    expect(detail.me!.games_played).toBe(4);

    // The match list shows them and filters on them, and a match with none is "none found".
    const plain = await save(teamMatch(90009));
    await enqueueMatches(db.sql, [{ source: "stable", externalId: 90009 }], { addedVia: "manual", refetch: true });
    const listed = async (warmups: string) =>
      (await listMatches(db.sql, USER_ID, parseMatchFilters(q(warmups ? { warmups } : {})))).matches.map((m) => [m.id, m.warmup_maps, m.refetching]);
    expect(await listed("found")).toEqual([[id, [1], false]]);
    expect(await listed("none")).toEqual([[plain, [], true]]);
    expect(await listed("")).toHaveLength(2);

    // A warmup count wins over the host.
    await updateMatchSettings(db.sql, id, { warmups: 0, skipLast: 0, ezMultiplier: 1.8 });
    expect((await getMatchDetail(db.sql, USER_ID, id))!.me!.games_played).toBe(5);
    await updateMatchSettings(db.sql, id, { warmups: null, skipLast: 0, ezMultiplier: 1.8 });
    expect((await getMatchDetail(db.sql, USER_ID, id))!.me!.games_played).toBe(4);

    // Casual lobbies always have a player as host, so it says nothing there.
    await setNotTournament(db.sql, id, true);
    expect((await getMatchDetail(db.sql, USER_ID, id))!.games[0]!.warmup).toBe(false);
    await setNotTournament(db.sql, id, false);
    expect((await getMatchDetail(db.sql, USER_ID, id))!.games[0]!.warmup).toBe(true);
    const casual = await save(hostWarmup(90008, "tester's lobby"));
    expect((await getMatchDetail(db.sql, USER_ID, casual))!.me!.games_played).toBe(5);
  });

  it("leaves one map out by hand and keeps it out when the match is fetched again", async () => {
    const match = teamMatch(90006);
    const id = await save(match);
    const before = (await getMatchDetail(db.sql, USER_ID, id))!;
    const last = before.games.at(-1)!;
    expect(await setGameExcluded(db.sql, id, last.id, true)).toBe(true);
    const after = (await getMatchDetail(db.sql, USER_ID, id))!;
    expect(after.games.at(-1)).toMatchObject({ excluded: true, counted: false });
    expect(after.me!.games_played).toBe(before.me!.games_played - 1);
    expect(after.red_wins! + after.blue_wins!).toBe(before.red_wins! + before.blue_wins! - 1);
    await save(match);
    expect((await getMatchDetail(db.sql, USER_ID, id))!.games.at(-1)!.excluded).toBe(true);
    expect(await setGameExcluded(db.sql, id, last.id, false)).toBe(true);
    expect((await getMatchDetail(db.sql, USER_ID, id))!.me!.games_played).toBe(before.me!.games_played);
    // A map from another match, or no map at all.
    expect(await setGameExcluded(db.sql, id + 1, last.id, true)).toBe(false);
    expect(await setGameExcluded(db.sql, id, 999_999, true)).toBe(false);
  });

  describe("EZ multiplier", () => {
    const ezMatch = (id: number) =>
      stableMatch({
        id,
        name: "ABC: (tester) vs (RivalOne)",
        games: [{ beatmapId: 11, teamType: "head-to-head", plays: [[USER_ID, 500_000, "none", ["NF", "EZ"]], [OPPONENT_A, 800_000]] }],
      });
    const myAvgScore = async (id: number) =>
      (await db.sql<{ avg_score: number }[]>`select avg_score from match_players where match_id = ${id} and user_id = ${USER_ID}`)[0]!.avg_score;

    it("counts EZ scores ×1.8 by default", async () => {
      const id = await save(ezMatch(90004));
      const [match] = await db.sql`select ez_multiplier from matches where id = ${id}`;
      expect(match!.ez_multiplier).toBe(1.8);
      expect(await myAvgScore(id)).toBe(900_000);
      const detail = (await getMatchDetail(db.sql, USER_ID, id))!;
      expect(detail.result).toBe("won");
      expect(detail.games[0]!.scores.map((s) => [s.user_id, s.total_score, s.score])).toEqual([
        [USER_ID, 500_000, 900_000],
        [OPPONENT_A, 800_000, 800_000],
      ]);
    });

    it("moves matches saved at ×1 to ×1.8 and recomputes them", async () => {
      const id = await save(ezMatch(90005));
      await updateMatchSettings(db.sql, id, { warmups: 0, skipLast: 0, ezMultiplier: 1 });
      expect(await myAvgScore(id)).toBe(500_000);

      await db.sql`delete from schema_migrations where name = '009_ez_multiplier_default.sql'`;
      expect(await migrate(db.sql)).toEqual(["009_ez_multiplier_default.sql"]);
      const [match] = await db.sql`select ez_multiplier from matches where id = ${id}`;
      expect(match!.ez_multiplier).toBe(1.8);
      expect(await myAvgScore(id)).toBe(900_000);
    });

    it("recomputes after every pending migration, so older hooks see today's schema", async () => {
      const id = await save(ezMatch(90006));
      await updateMatchSettings(db.sql, id, { warmups: 0, skipLast: 0, ezMultiplier: 1 });

      // A database from before 009 and 010: 009's hook recomputes with code that writes 010's columns.
      await db.sql`alter table match_games drop column counted, drop column winner, drop column red_score, drop column blue_score`;
      await db.sql`delete from schema_migrations where name in ('009_ez_multiplier_default.sql', '010_match_game_results.sql')`;
      expect(await migrate(db.sql)).toEqual(["009_ez_multiplier_default.sql", "010_match_game_results.sql"]);
      expect(await myAvgScore(id)).toBe(900_000);
      const [game] = await db.sql`select counted, winner from match_games where match_id = ${id}`;
      expect(game).toMatchObject({ counted: true, winner: "red" });
    });
  });

  it("switches saved matches to finding warmups from the host and fetches tournaments again", async () => {
    const duel = (id: number, name: string) =>
      stableMatch({ id, name, games: [{ beatmapId: 11, teamType: "head-to-head", plays: [[USER_ID, 500_000], [OPPONENT_B, 400_000]] }] });
    const tournament = await save(teamMatch(90010));
    const counted = await save(teamMatch(90011));
    await updateMatchSettings(db.sql, counted, { warmups: 1, skipLast: 0, ezMultiplier: 1.8 });
    await save(duel(90012, "ROMAI: (tester) vs (RivalTwo)"));
    await save(duel(90013, "tester's lobby"));
    const casual = await save(duel(90014, "ABC: (tester) vs (friend)"));
    await setNotTournament(db.sql, casual, true);
    // Back to before the migration: no hosts, every warmup count a number.
    await db.sql`alter table match_games drop column host_id`;
    await db.sql`update matches set warmups = 0 where warmups is null`;
    await db.sql`alter table matches alter column warmups set not null, alter column warmups set default 0`;
    await db.sql`truncate match_queue`;
    await db.sql`delete from schema_migrations where name = '012_match_warmup_detection.sql'`;

    expect(await migrate(db.sql)).toEqual(["012_match_warmup_detection.sql"]);
    const warmups = await db.sql`select external_id, warmups from matches where source = 'stable' order by external_id`;
    expect(warmups.map((r) => [Number(r.external_id), r.warmups])).toEqual([[90010, null], [90011, 1], [90012, null], [90013, null], [90014, null]]);
    const queued = await db.sql`select external_id, kind, priority from match_queue order by external_id`;
    expect(queued.map((r) => [Number(r.external_id), r.kind, r.priority])).toEqual([[90010, "fetch", 2], [90011, "fetch", 2]]);
    expect((await getMatchDetail(db.sql, USER_ID, tournament))!.me!.games_played).toBe(5);
  });

  it("saves which maps are warmups for saved matches and retries ranked play rooms that failed", async () => {
    const id = await save(teamMatch(90015));
    await updateMatchSettings(db.sql, id, { warmups: 2, skipLast: 0, ezMultiplier: 1.8 });
    await enqueueMatches(db.sql, [{ source: "lazer", externalId: 4002 }, { source: "stable", externalId: 90016 }], { addedVia: "manual" });
    await db.sql`update match_queue set failed = true, attempts = 1, last_error = 'This match is private on osu!.'`;
    await db.sql`alter table match_games drop column warmup`;
    await db.sql`delete from schema_migrations where name = '014_match_game_warmup.sql'`;

    expect(await migrate(db.sql)).toEqual(["014_match_game_warmup.sql"]);
    const games = await db.sql`select warmup from match_games where match_id = ${id} order by position`;
    expect(games.map((g) => g.warmup)).toEqual([true, true, false, false, false]);
    const queued = await db.sql`select source, failed, last_error from match_queue order by source`;
    expect(queued).toEqual([
      { source: "lazer", failed: false, last_error: null },
      { source: "stable", failed: true, last_error: "This match is private on osu!." },
    ]);
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

  it("summarizes only the matches the filters keep", async () => {
    const stats = (params: Record<string, string>) => matchStats(db.sql, USER_ID, parseMatchFilters(q(params)));
    expect(await stats({ result: "won" })).toMatchObject({ matches: 1, played: 1, won: 1, lost: 0, tournaments: 1 });
    expect(await stats({ q: "abc tester" })).toMatchObject({ matches: 1, won: 0, lost: 1 });
    expect(await stats({ played: "true" })).toMatchObject({ matches: 2, played: 2 });
    expect((await stats({ result: "lost" })).best_match_cost?.match_cost).toBe((await stats({ q: "abc tester" })).best_match_cost?.match_cost);
    expect(await stats({ hide: "tournament" })).toMatchObject({ matches: 0, played: 0, avg_match_cost: null, best_match_cost: null });
  });

  it("hides tournaments, qualifiers, each matchmaking bot, ranked play or other lobbies", async () => {
    const duel = (id: number, name: string) =>
      stableMatch({ id, name, games: [{ beatmapId: 11, teamType: "head-to-head", plays: [[USER_ID, 500_000], [OPPONENT_B, 400_000]] }] });
    await save(duel(4, "ROMAI: (tester) vs (RivalTwo)"));
    await save(duel(5, "ETX: (tester) vs (RivalTwo)"));
    await save(duel(6, "o!mm Ranked: tester vs RivalTwo"));
    await save(duel(7, "tester's lobby"));
    await save(duel(8, "ABC: Qualifiers Lobby 3"));
    await save(duel(9, "QRT: (Tryouts) Lobby A"));
    const all = (await listMatches(db.sql, USER_ID, parseMatchFilters(q({ hide: "none" })))).matches;
    expect(Object.fromEntries(all.map((m) => [m.external_id, m.kind]))).toEqual({
      1: "tournament", 2: "tournament", 3: "tournament", 4: "romai", 5: "etx", 6: "omm", 7: "other", 8: "qualifiers", 9: "qualifiers",
    });
    // With no Type given, only tournaments show; links leave that default out and spell out "none".
    expect((await names({})).sort()).toEqual([1, 2, 3]);
    expect(matchFiltersToParams(parseMatchFilters(q())).toString()).toBe("");
    expect(matchFiltersToParams(parseMatchFilters(q({ hide: "none" }))).toString()).toBe("hide=none");
    expect((await names({ hide: "tournament" })).sort()).toEqual([4, 5, 6, 7, 8, 9]);
    expect((await names({ hide: "qualifiers" })).sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect((await names({ hide: "romai" })).sort()).toEqual([1, 2, 3, 5, 6, 7, 8, 9]);
    expect((await names({ hide: "romai,etx,omm" })).sort()).toEqual([1, 2, 3, 7, 8, 9]);
    expect((await names({ hide: "other,bogus" })).sort()).toEqual([1, 2, 3, 4, 5, 6, 8, 9]);
    // The form sends the ticked boxes, and a marker so unticking all of them still counts.
    const form = (...shown: string[]) => new URLSearchParams([["show", "-"], ...shown.map((kind): [string, string] => ["show", kind])]);
    const shown = async (...kinds: string[]) =>
      (await listMatches(db.sql, USER_ID, parseMatchFilters(form(...kinds)))).matches.map((m) => m.external_id).sort();
    expect(await shown("tournament", "qualifiers", "romai", "etx", "omm", "ranked", "other")).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(await shown("tournament", "ranked")).toEqual([1, 2, 3]);
    expect(await shown("other")).toEqual([7]);
    expect(await shown()).toEqual([]);
    expect(parseMatchFilters(form("tournament", "ranked")).hide).toEqual(["qualifiers", "romai", "etx", "omm", "other"]);
    // Qualifiers count towards their tournament: ABC already has matches, QRT is new.
    expect(await matchStats(db.sql, USER_ID, parseMatchFilters(q({ hide: "none" })))).toMatchObject({ matches: 9, tournaments: 4 });
    const scores = async (params: Record<string, string>) =>
      (await listTournamentScores(db.sql, USER_ID, parseTournamentScoreFilters(q(params)))).pagination.total_count;
    expect(await scores({ hide: "none" })).toBe(13);
    expect(await scores({})).toBe(await scores({ hide: "qualifiers,romai,etx,omm,ranked,other" }));
    expect(await scores({ hide: "romai,etx,omm" })).toBe(10);
    expect(await scores({ hide: "tournament" })).toBe(6);
    expect(await scores({ hide: "qualifiers,other" })).toBe(10);
  });

  it("stops counting a casual lobby with a tournament-style name as a tournament", async () => {
    const [row] = await db.sql<{ id: number }[]>`select id from matches where external_id = 2`;
    const id = row!.id;
    const kind = async () => (await listMatches(db.sql, USER_ID, parseMatchFilters(q({ q: "ABC", hide: "none" })))).matches[0]!.kind;
    expect(await setNotTournament(db.sql, id, true)).toBe(true);
    expect(await kind()).toBe("other");
    expect(await names({ hide: "tournament" })).toEqual([2]);
    expect(await names({ hide: "other" })).not.toContain(2);
    expect(await matchStats(db.sql, USER_ID, parseMatchFilters(q({ hide: "none" })))).toMatchObject({ matches: 3, tournaments: 2 });
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

  it("never fetches a saved match again when it's imported or discovered", async () => {
    const old = new Date(Date.now() - 5 * 3600_000).toISOString();
    await save(teamMatch(101));
    const room = rankedPlayRoom(5001, [{ beatmapId: 21, scores: [[USER_ID, 1], [OPPONENT_A, 2]] }]);
    osu.rooms.set(5001, room.events);
    await ingestMatch(db.sql, (await fetchMatch(osu, "lazer", 5001))!, { addedVia: "discovery", pp: pp() });
    osu.calls = [];

    expect(await enqueueMatches(db.sql, parseMatchRefs("https://osu.ppy.sh/mp/101\nhttps://osu.ppy.sh/multiplayer/rooms/5001").refs, { addedVia: "import" })).toEqual({
      queued: 0,
      known: 2,
    });
    osu.lobbies = [{ id: 101, name: "TST 2026: (Red Rockets) vs (Blue Birds)", start_time: old, end_time: old }];
    osu.rankedRooms = [room.room];
    await scanStableFrom(db.sql, 101);
    const step = worker();
    for (let i = 0; i < 4; i++) await step();

    // Both crawlers saw the saved matches, but neither queued them.
    expect(osu.calls).toEqual(expect.arrayContaining(["listMatches id_asc 100", `listUserRankedPlayRooms ${USER_ID}`]));
    expect(await db.sql`select * from match_queue`).toHaveLength(0);
    expect(osu.calls.filter((c) => c.startsWith("getMatch") || c.startsWith("getRoomEvents"))).toEqual([]);
    expect((await db.sql`select count(*)::int as n from matches`)[0]!.n).toBe(2);
  });

  it("refreshes matches still in progress", async () => {
    const running = teamMatch(20, { ended: false, start: new Date() });
    osu.matches.set(20, running);
    await enqueueMatches(db.sql, [{ source: "stable", externalId: 20 }], { addedVia: "manual" });
    await worker({ discovery: false })();
    const [row] = await db.sql`select kind, priority, not_before > now() as later from match_queue`;
    expect(row).toEqual({ kind: "fetch", priority: 1, later: true });
  });

  it("crawls ranked play history while a long import is queued, clearing an old error", async () => {
    await db.sql`update match_discovery set last_error = 'osu! /api/v2/rooms returned HTTP 500.' where source = 'lazer'`;
    for (let id = 1; id <= 30; id++) osu.matches.set(id, teamMatch(id));
    await enqueueMatches(db.sql, Array.from({ length: 30 }, (_, i) => ({ source: "stable" as const, externalId: i + 1 })), { addedVia: "import" });
    osu.rankedRooms = [{ id: 7000, ends_at: "2026-09-03T00:00:00Z" }];

    const step = worker();
    for (let i = 0; i < 20; i++) await step();
    expect(osu.calls).toContain(`listUserRankedPlayRooms ${USER_ID}`);
    expect((await db.sql`select count(*)::int as n from match_queue where source = 'stable'`)[0]!.n).toBeGreaterThan(0);
    const [state] = await db.sql`select scanned, last_error, last_run_at from match_discovery where source = 'lazer'`;
    expect(state).toMatchObject({ scanned: 1, last_error: null });
    expect(state!.last_run_at).not.toBeNull();
  });

  it("keeps fetching queued matches when a crawl fails, and saves the error", async () => {
    osu.failOnce.listUserRankedPlayRooms = () => true;
    osu.failOnce.listMatches = () => true;
    for (let id = 1; id <= 10; id++) osu.matches.set(id, teamMatch(id));
    await enqueueMatches(db.sql, Array.from({ length: 10 }, (_, i) => ({ source: "stable" as const, externalId: i + 1 })), { addedVia: "import" });

    const step = worker();
    while (await step()) {}
    expect((await db.sql`select count(*)::int as n from matches`)[0]!.n).toBe(10);
    const errors = await db.sql`select source, last_error from match_discovery order by source`;
    expect(errors).toEqual([
      { source: "lazer", last_error: "simulated listUserRankedPlayRooms outage" },
      { source: "stable", last_error: "simulated listMatches outage" },
    ]);
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
