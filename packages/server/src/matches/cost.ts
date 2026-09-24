// Match costs, ported from Bathbot's `process_match` (bathbot/src/commands/osu/match_costs.rs) so
// the numbers agree with its `<matchcosts` command. Also works out each game's winner and the
// score line for the match pages.

// Flat additive performance cost bonus for each player.
const FLAT_BONUS = 0.5;
// Exponent base: the maximum participation bonus, for playing every game.
const BASE_PARTICIPATION_BONUS = 1.5;
// Curve towards the maximum participation bonus.
const EXP_PARTICIPATION_BONUS = 0.6;
// Multiplier bonus per mod combination beyond the second.
const MOD_BONUS = 0.02;
// Performing average on the tiebreaker rewards this flat amount...
const TIEBREAKER_FACTOR = 0.25;
// ...and any tiebreaker performance cost of 2 or more gets the same bonus.
const MAX_TIEBREAKER_BONUS = 0.5;

export type Team = "none" | "red" | "blue";
export type Side = "red" | "blue";
export type MatchFormat = "team" | "1v1" | "ffa";

export interface CostScore {
  userId: number;
  score: number;
  team: Team;
  /** Mod acronyms. */
  mods: readonly string[];
  accuracy: number;
}

export interface CostGame {
  id: number;
  /** Games without an end time were aborted early or are still being played. */
  ended: boolean;
  teamType: string | null;
  /** Left out by hand, like a warmup anywhere in the match. */
  excluded?: boolean;
  /** The player holding the lobby host when the game started, if any. */
  hostId?: number | null;
  scores: readonly CostScore[];
}

export interface CostOptions {
  /** Games to leave out from the start (Bathbot's `warmups`), or `host` to find them with `hostWarmups`. */
  warmups: number | "host";
  /** Games to leave out from the end. */
  skipLast: number;
  /** Multiplies scores set with EZ. */
  ezMultiplier: number;
  /** The match has ended: only then can the last game be a tiebreaker. */
  finished: boolean;
  /** Who is red in a 1v1, when both players are known: the first player in "A vs B". */
  preferRed?: number | undefined;
}

export interface PlayerCost {
  userId: number;
  /** The first team the player played on. */
  team: Team;
  side: Side | null;
  gamesPlayed: number;
  avgScore: number;
  avgAccuracy: number;
  performanceCost: number;
  participationBonus: number;
  modsBonus: number;
  tiebreakerBonus: number;
  matchCost: number;
}

export interface GameResult {
  id: number;
  /** Counts towards match costs and the score line (not a warmup, skipped, left out or unfinished). */
  counted: boolean;
  /** Left out as a warmup. */
  warmup: boolean;
  winner: Side | null;
  redScore: number | null;
  blueScore: number | null;
}

export interface MatchAnalysis {
  format: MatchFormat;
  players: PlayerCost[];
  games: GameResult[];
  redWins: number | null;
  blueWins: number | null;
  /** The last game counted as a tiebreaker. */
  tiebreaker: boolean;
}

const TEAM_TYPES = new Set(["team-vs", "tag-team-vs", "team_versus"]);

/** Scores as Bathbot counts them: zero scores dropped, EZ scores multiplied. */
function countedScores(game: CostGame, ezMultiplier: number): CostScore[] {
  return game.scores
    .filter((s) => s.score > 0)
    .map((s) => (ezMultiplier !== 1 && s.mods.includes("EZ") ? { ...s, score: Math.trunc(s.score * ezMultiplier) } : s));
}

function winnerOf(totals: Map<string, number>): string | null {
  let best: string | null = null;
  let bestScore = -1;
  let tie = false;
  for (const [key, score] of totals) {
    if (score > bestScore) {
      best = key;
      bestScore = score;
      tie = false;
    } else if (score === bestScore) {
      tie = true;
    }
  }
  return tie ? null : best;
}

/** Warmups found from the host: at most this many. */
export const MAX_HOST_WARMUPS = 2;

/**
 * Refs hand the host to a team captain to pick a warmup and take it back for the mappool, so a
 * game played while one of the match's players held the host is a warmup (the first two such
 * games). If a player held it for every game, the lobby was made in game rather than by a ref,
 * and the host says nothing.
 */
export function hostWarmups(ended: readonly CostGame[]): Set<number> {
  const players = new Set(ended.flatMap((g) => g.scores.map((s) => s.userId)));
  const hosted = ended.filter((g) => g.hostId != null && players.has(g.hostId));
  if (hosted.length === ended.length) return new Set();
  return new Set(hosted.slice(0, MAX_HOST_WARMUPS).map((g) => g.id));
}

export function analyzeMatch(games: readonly CostGame[], options: CostOptions): MatchAnalysis {
  const ended = games.filter((g) => g.ended);
  const warmups = options.warmups === "host" ? hostWarmups(ended) : new Set(ended.slice(0, options.warmups).map((g) => g.id));
  let counted = ended.filter((g) => !warmups.has(g.id));
  if (options.skipLast > 0) counted = counted.slice(0, Math.max(0, counted.length - options.skipLast));
  // Warmups and skipped maps go by position among the ended games, whether or not any are left out by hand.
  counted = counted.filter((g) => !g.excluded);
  const countedIds = new Set(counted.map((g) => g.id));
  const scoresByGame = new Map(counted.map((g) => [g.id, countedScores(g, options.ezMultiplier)]));

  // Per-user performance costs, mod combinations and first team, and Bathbot's per-team win count
  // (keyed by the score's team, so head-to-head games only count wins for "none").
  const perf = new Map<number, { score: number; cost: number }[]>();
  const modCombos = new Map<number, Set<string>>();
  const firstTeam = new Map<number, Team>();
  const teamWins = new Map<Team, number>();
  for (const game of counted) {
    const scores = scoresByGame.get(game.id)!;
    const avg = scores.reduce((sum, s) => sum + s.score, 0) / scores.length;
    const totals = new Map<string, number>();
    for (const s of scores) {
      const entries = perf.get(s.userId) ?? [];
      entries.push({ score: s.score, cost: s.score / avg });
      perf.set(s.userId, entries);
      const combo = s.mods.filter((m) => m !== "NF").toSorted().join("");
      modCombos.set(s.userId, (modCombos.get(s.userId) ?? new Set()).add(combo));
      if (!firstTeam.has(s.userId)) firstTeam.set(s.userId, s.team);
      totals.set(s.team, (totals.get(s.team) ?? 0) + s.score);
    }
    // Bathbot's `max_by_key` picks some team even with no scores or a tie.
    const winner = (winnerOf(totals) ?? [...totals.keys()].at(-1) ?? "none") as Team;
    teamWins.set(winner, (teamWins.get(winner) ?? 0) + 1);
  }

  const red = teamWins.get("red");
  const blue = teamWins.get("blue");
  const winDiff = red !== undefined && blue !== undefined ? Math.abs(red - blue) : 0;
  const tiebreakerGame = options.finished && counted.length > 4 && winDiff === 1 ? counted.at(-1) : undefined;
  const tiebreakerPlayers = new Set((tiebreakerGame ? scoresByGame.get(tiebreakerGame.id)! : []).map((s) => s.userId));

  const gamesCount = counted.length;
  const accuracy = new Map<number, number[]>();
  for (const scores of scoresByGame.values()) {
    for (const s of scores) accuracy.set(s.userId, [...(accuracy.get(s.userId) ?? []), s.accuracy]);
  }

  const players: PlayerCost[] = [...perf].map(([userId, entries]) => {
    const n = entries.length;
    const performanceCost = entries.reduce((sum, e) => sum + e.cost, 0) / n + FLAT_BONUS;
    const tiebreakerBonus = tiebreakerPlayers.has(userId) ? Math.min(MAX_TIEBREAKER_BONUS, TIEBREAKER_FACTOR * entries.at(-1)!.cost) : 0;
    const exp = gamesCount <= 1 ? 0 : (n - 1) / (gamesCount - 1);
    const participationBonus = BASE_PARTICIPATION_BONUS ** (exp ** EXP_PARTICIPATION_BONUS);
    const modsUsed = modCombos.get(userId)?.size ?? 0;
    const modsBonus = modsUsed > 2 ? 1 + MOD_BONUS * (modsUsed - 2) : 1;
    const accs = accuracy.get(userId) ?? [];
    return {
      userId,
      team: firstTeam.get(userId) ?? "none",
      side: null,
      gamesPlayed: n,
      avgScore: Math.trunc(entries.reduce((sum, e) => sum + e.score, 0) / n),
      avgAccuracy: accs.reduce((a, b) => a + b, 0) / (accs.length || 1),
      performanceCost,
      participationBonus,
      modsBonus,
      tiebreakerBonus,
      matchCost: performanceCost * participationBonus * modsBonus + tiebreakerBonus,
    };
  });
  players.sort((a, b) => b.matchCost - a.matchCost || a.userId - b.userId);

  // Sides and the score line. Team matches use the lobby teams; a two-player head-to-head gets
  // one side each, as Bathbot does; anything else (qualifiers, free-for-alls) has no score line.
  const firstCounted = counted[0] ?? ended[0] ?? games[0];
  let format: MatchFormat = "ffa";
  const sideOf = new Map<number, Side>();
  if (firstCounted && TEAM_TYPES.has(firstCounted.teamType ?? "")) {
    format = "team";
    for (const p of players) if (p.team === "red" || p.team === "blue") sideOf.set(p.userId, p.team);
  } else {
    const ids = players.length === 2 ? players.map((p) => p.userId) : [];
    if (ids.length === 2) {
      format = "1v1";
      const firstSeen = counted.flatMap((g) => scoresByGame.get(g.id)!.map((s) => s.userId));
      const redId = options.preferRed !== undefined && ids.includes(options.preferRed) ? options.preferRed : firstSeen[0]!;
      for (const id of ids) sideOf.set(id, id === redId ? "red" : "blue");
    }
  }
  for (const p of players) p.side = sideOf.get(p.userId) ?? null;

  const results: GameResult[] = games.map((game) => {
    const isCounted = countedIds.has(game.id);
    const scores = isCounted ? scoresByGame.get(game.id)! : countedScores(game, options.ezMultiplier);
    if (format === "ffa" || !game.ended) return { id: game.id, counted: isCounted, warmup: warmups.has(game.id), winner: null, redScore: null, blueScore: null };
    const side = (s: CostScore): Side | undefined => (format === "team" ? (s.team === "none" ? undefined : s.team) : sideOf.get(s.userId));
    const totals = new Map<string, number>([["red", 0], ["blue", 0]]);
    for (const s of scores) {
      const key = side(s);
      if (key) totals.set(key, totals.get(key)! + s.score);
    }
    const redScore = totals.get("red")!;
    const blueScore = totals.get("blue")!;
    const winner: Side | null = redScore === blueScore ? null : redScore > blueScore ? "red" : "blue";
    return { id: game.id, counted: isCounted, warmup: warmups.has(game.id), winner, redScore, blueScore };
  });

  const counting = results.filter((r) => r.counted);
  return {
    format,
    players,
    games: results,
    redWins: format === "ffa" ? null : counting.filter((r) => r.winner === "red").length,
    blueWins: format === "ffa" ? null : counting.filter((r) => r.winner === "blue").length,
    tiebreaker: tiebreakerGame !== undefined,
  };
}
