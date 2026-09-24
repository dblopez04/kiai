// Fetching matches from osu! and saving them: games, every player's score, local PP for scores
// osu! gives none, and the match costs.

import { sqlJson, type Db, type Sql } from "../db/index.ts";
import type { OsuClient } from "../osu/api.ts";
import type { ApiMatch, ApiRoomEvents, ApiUserCompact } from "../osu/types.ts";
import { PP_CALCULATOR, type PpCalculator } from "../scores/pp.ts";
import { upsertBeatmaps } from "../scores/store.ts";
import { analyzeMatch, type CostGame, type MatchAnalysis, type Team } from "./cost.ts";
import { matchKind, normalizeRoom, normalizeStableMatch, parseMatchName, QUALIFIERS_PATTERN, TOURNAMENT_KINDS, type MatchSource, type NormalizedMatch } from "./normalize.ts";

const EVENT_PAGE = 101;
// Auto-host lobbies can run for days; tournament matches are a page or two.
const MAX_EVENT_PAGES = 200;

/** Every event page of a match, oldest first. Null if osu! has no such match or room. */
export async function fetchMatch(osu: OsuClient, source: MatchSource, externalId: number): Promise<NormalizedMatch | null> {
  if (source === "stable") {
    const pages: ApiMatch[] = [];
    let after = 0;
    for (let i = 0; i < MAX_EVENT_PAGES; i++) {
      const page = await osu.getMatch(externalId, after);
      if (!page) return pages.length ? normalizeStableMatch(pages) : null;
      pages.push(page);
      const last = page.events.at(-1)?.id;
      if (last === undefined || page.events.length < EVENT_PAGE || last >= (page.latest_event_id ?? last)) break;
      after = last;
    }
    return normalizeStableMatch(pages);
  }
  const pages: ApiRoomEvents[] = [];
  let after = 0;
  for (let i = 0; i < MAX_EVENT_PAGES; i++) {
    const page = await osu.getRoomEvents(externalId, after);
    if (!page) return pages.length ? normalizeRoom(pages) : null;
    pages.push(page);
    const last = page.events.at(-1)?.id;
    if (last === undefined || page.events.length < EVENT_PAGE || last >= (page.last_event_id ?? last)) break;
    after = last;
  }
  return normalizeRoom(pages);
}

/** Other players are saved with their name and flag only; the player's own profile stats are kept. */
export async function upsertUsers(sql: Sql, users: readonly ApiUserCompact[]): Promise<void> {
  const rows = [...new Map(users.filter((u) => u.id > 0 && u.username).map((u) => [u.id, u])).values()].map((u) => ({
    id: u.id,
    username: u.username,
    avatar_url: u.avatar_url ?? null,
    country_code: u.country_code ?? null,
  }));
  if (rows.length === 0) return;
  await sql`
    insert into osu_users ${sql(rows, "id", "username", "avatar_url", "country_code")}
    on conflict (id) do update set
      username = excluded.username,
      avatar_url = coalesce(excluded.avatar_url, osu_users.avatar_url),
      country_code = coalesce(excluded.country_code, osu_users.country_code)`;
}

type PpResult = { pp: number | null; source: "osu" | "local" | "unavailable" | "unknown"; calculator: string | null };

/**
 * PP for each score: osu!'s when it has one (lazer ranked play on ranked maps), otherwise rosu-pp.
 * NoFail is left out of the calculation, since tournaments force it. Failed plays get none.
 */
async function scorePp(match: NormalizedMatch, known: Map<string, PpResult>, pp: PpCalculator | null): Promise<Map<string, PpResult>> {
  const results = new Map<string, PpResult>();
  for (const game of match.games) {
    for (const score of game.scores) {
      const key = `${game.externalId}:${score.userId}`;
      const previous = known.get(key);
      if (score.pp !== null) results.set(key, { pp: score.pp, source: "osu", calculator: null });
      else if (previous && previous.pp !== null) results.set(key, previous);
      else if (!score.passed || game.beatmapId === null || score.totalScore <= 0) results.set(key, { pp: null, source: "unavailable", calculator: null });
      else if (!pp) results.set(key, { pp: null, source: "unknown", calculator: null });
      else {
        const value = await pp({
          beatmapId: game.beatmapId,
          rulesetId: game.rulesetId,
          mods: score.mods.filter((mod) => mod.acronym !== "NF"),
          accuracy: score.accuracy,
          maxCombo: score.maxCombo,
          statistics: score.statistics,
          isLazer: score.isLazer,
        });
        results.set(key, value === null ? { pp: null, source: "unavailable", calculator: null } : { pp: value, source: "local", calculator: PP_CALCULATOR });
      }
    }
  }
  return results;
}

export interface IngestOptions {
  addedVia: "import" | "manual" | "discovery";
  pp: PpCalculator | null;
}

/** Save a fetched match (insert or update) and recompute its match costs. Returns its id. */
export async function ingestMatch(sql: Sql, match: NormalizedMatch, options: IngestOptions): Promise<number> {
  await upsertBeatmaps(sql, match.beatmaps);
  await upsertUsers(sql, match.users);

  const knownRows = await sql<{ external_id: number; user_id: number; pp: number | null; pp_source: PpResult["source"]; pp_calculator: string | null }[]>`
    select g.external_id, s.user_id, s.pp, s.pp_source, s.pp_calculator
    from match_scores s join match_games g on g.id = s.game_id join matches m on m.id = s.match_id
    where m.source = ${match.source} and m.external_id = ${match.externalId}`;
  const known = new Map(knownRows.map((r) => [`${r.external_id}:${r.user_id}`, { pp: r.pp, source: r.pp_source, calculator: r.pp_calculator }]));
  const pps = await scorePp(match, known, options.pp);

  // Tournaments are played in stable lobbies; ranked play rooms are named by osu!.
  const parsed = match.source === "stable" ? parseMatchName(match.name) : { acronym: null, red: null, blue: null };
  return sql.begin(async (tx) => {
    const [row] = await tx<{ id: number }[]>`
      insert into matches (source, external_id, name, acronym, red_name, blue_name, room_type, start_time, end_time, added_via, fetched_at)
      values (${match.source}, ${match.externalId}, ${match.name}, ${parsed.acronym}, ${parsed.red}, ${parsed.blue}, ${match.roomType},
              ${match.startTime}, ${match.endTime}, ${options.addedVia}, now())
      on conflict (source, external_id) do update set
        name = excluded.name, acronym = excluded.acronym, red_name = excluded.red_name, blue_name = excluded.blue_name,
        room_type = excluded.room_type, start_time = excluded.start_time, end_time = excluded.end_time, fetched_at = now()
      returning id`;
    const matchId = row!.id;

    for (const [position, game] of match.games.entries()) {
      const [saved] = await tx<{ id: number }[]>`
        insert into match_games (match_id, external_id, position, beatmap_id, ruleset_id, scoring_type, team_type, mods, start_time, end_time, host_id)
        values (${matchId}, ${game.externalId}, ${position + 1}, ${game.beatmapId}, ${game.rulesetId}, ${game.scoringType}, ${game.teamType},
                ${game.mods}::text[], ${game.startTime}, ${game.endTime}, ${game.hostId})
        on conflict (match_id, external_id) do update set
          position = excluded.position, beatmap_id = excluded.beatmap_id, ruleset_id = excluded.ruleset_id,
          scoring_type = excluded.scoring_type, team_type = excluded.team_type, mods = excluded.mods,
          start_time = excluded.start_time, end_time = excluded.end_time, host_id = excluded.host_id
        returning id`;
      const gameId = saved!.id;
      const scores = game.scores.map((s) => {
        const pp = pps.get(`${game.externalId}:${s.userId}`)!;
        return {
          game_id: gameId,
          match_id: matchId,
          user_id: s.userId,
          slot: s.slot,
          team: s.team,
          score_id: s.scoreId,
          total_score: s.totalScore,
          accuracy: s.accuracy,
          max_combo: s.maxCombo,
          perfect: s.perfect,
          passed: s.passed,
          rank: s.rank,
          count300: s.count300,
          count100: s.count100,
          count50: s.count50,
          countmiss: s.countmiss,
          mods: sqlJson(tx, s.mods),
          statistics: sqlJson(tx, s.statistics),
          pp: pp.pp,
          pp_source: pp.source,
          pp_calculator: pp.calculator,
        };
      });
      if (scores.length === 0) continue;
      const columns = Object.keys(scores[0]!) as (keyof (typeof scores)[number])[];
      await tx`
        insert into match_scores ${tx(scores, ...columns)}
        on conflict (game_id, user_id) do update set
          ${tx.unsafe(columns.filter((c) => c !== "game_id" && c !== "user_id").map((c) => `${c} = excluded.${c}`).join(", "))}`;
    }

    await recomputeMatch(tx, matchId);
    return matchId;
  });
}

/** The match costs, sides, per-game winners and score line of a saved match. */
export async function analyzeSavedMatch(sql: Db, matchId: number): Promise<{ analysis: MatchAnalysis; gamesEnded: number } | null> {
  const [match] = await sql<{
    source: MatchSource;
    name: string;
    acronym: string | null;
    not_tournament: boolean;
    end_time: Date | null;
    red_name: string | null;
    warmups: number | null;
    skip_last: number;
    ez_multiplier: number;
  }[]>`
    select source, name, acronym, not_tournament, end_time, red_name, warmups, skip_last, ez_multiplier from matches where id = ${matchId}`;
  if (!match) return null;
  const games = await sql<{ id: number; end_time: Date | null; team_type: string | null; excluded: boolean; host_id: number | null }[]>`
    select id, end_time, team_type, excluded, host_id from match_games where match_id = ${matchId} order by position`;
  const scores = await sql<{ game_id: number; user_id: number; total_score: number; team: Team; mod_acronyms: string[]; accuracy: number }[]>`
    select game_id, user_id, total_score, team, score_mod_acronyms(mods) as mod_acronyms, accuracy
    from match_scores where match_id = ${matchId} order by game_id, slot nulls last, user_id`;

  let preferRed: number | undefined;
  if (match.red_name) {
    const [red] = await sql<{ id: number }[]>`
      select u.id from osu_users u where lower(u.username) = lower(${match.red_name})
        and u.id in (select user_id from match_scores where match_id = ${matchId})`;
    preferRed = red?.id;
  }

  const costGames: CostGame[] = games.map((g) => ({
    id: g.id,
    ended: g.end_time !== null,
    teamType: g.team_type,
    excluded: g.excluded,
    hostId: g.host_id,
    scores: scores.filter((s) => s.game_id === g.id).map((s) => ({ userId: s.user_id, score: s.total_score, team: s.team, mods: s.mod_acronyms, accuracy: s.accuracy })),
  }));
  // No warmup count set: find them from the host in tournament lobbies. Casual lobbies always
  // have a player as host, so there it says nothing.
  const kind = matchKind({ source: match.source, name: match.name, acronym: match.acronym, notTournament: match.not_tournament });
  const analysis = analyzeMatch(costGames, {
    warmups: match.warmups ?? (TOURNAMENT_KINDS.includes(kind) ? "host" : 0),
    skipLast: match.skip_last,
    ezMultiplier: match.ez_multiplier,
    finished: match.end_time !== null,
    preferRed,
    qualifiers: kind === "qualifiers",
  });
  return { analysis, gamesEnded: games.filter((g) => g.end_time !== null).length };
}

/** Work out the match costs, sides and score line again from the saved games. */
export async function recomputeMatch(sql: Db, matchId: number): Promise<void> {
  const result = await analyzeSavedMatch(sql, matchId);
  if (!result) return;
  const { analysis } = result;
  await sql`
    update matches set format = ${analysis.format}, games_count = ${result.gamesEnded},
      red_wins = ${analysis.redWins}, blue_wins = ${analysis.blueWins}
    where id = ${matchId}`;
  if (analysis.games.length) {
    await sql`
      update match_games g set counted = r.counted, winner = r.winner, red_score = r."redScore", blue_score = r."blueScore"
      from jsonb_to_recordset(${sqlJson(sql, analysis.games)}) as r(id bigint, counted boolean, winner text, "redScore" bigint, "blueScore" bigint)
      where g.id = r.id`;
  }
  await sql`delete from match_players where match_id = ${matchId}`;
  if (analysis.players.length) {
    const rows = analysis.players.map((p) => ({
      match_id: matchId,
      user_id: p.userId,
      team: p.team,
      side: p.side,
      games_played: p.gamesPlayed,
      avg_score: p.avgScore,
      avg_accuracy: p.avgAccuracy,
      performance_cost: p.performanceCost,
      participation_bonus: p.participationBonus,
      mods_bonus: p.modsBonus,
      tiebreaker_bonus: p.tiebreakerBonus,
      match_cost: p.matchCost,
    }));
    await sql`insert into match_players ${sql(rows, ...(Object.keys(rows[0]!) as (keyof (typeof rows)[number])[]))}`;
  }
}

/** Recompute every match with an EZ score, after the EZ multiplier changed under it. */
export async function recomputeEzMatches(sql: Db): Promise<void> {
  const rows = await sql<{ match_id: number }[]>`select distinct match_id from match_scores where 'EZ' = any(mod_acronyms) order by match_id`;
  for (const { match_id } of rows) await recomputeMatch(sql, match_id);
}

/** Recompute every lobby named like a qualifier, after the rules for qualifiers changed. */
export async function recomputeQualifierMatches(sql: Db): Promise<void> {
  const rows = await sql<{ id: number }[]>`select id from matches where source = 'stable' and name ~* ${QUALIFIERS_PATTERN} order by id`;
  for (const { id } of rows) await recomputeMatch(sql, id);
}

/** Recompute every saved match, after a migration added columns `recomputeMatch` fills. */
export async function recomputeAllMatches(sql: Db): Promise<void> {
  const rows = await sql<{ id: number }[]>`select id from matches order by id`;
  for (const { id } of rows) await recomputeMatch(sql, id);
}

export interface MatchSettings {
  /** Null finds them from the host, in tournament lobbies. */
  warmups: number | null;
  skipLast: number;
  ezMultiplier: number;
}

/**
 * Mark a tournament-style lobby as casual (or undo it). Returns false if the match doesn't exist.
 * Recomputes the match, since only tournament lobbies find warmups from the host.
 */
export async function setNotTournament(sql: Sql, matchId: number, notTournament: boolean): Promise<boolean> {
  return sql.begin(async (tx) => {
    const updated = await tx`update matches set not_tournament = ${notTournament} where id = ${matchId} returning id`;
    if (updated.length === 0) return false;
    await recomputeMatch(tx, matchId);
    return true;
  });
}

/** Leave one map of a match out of its match costs and score line (or count it again). Returns false if the match has no such map. */
export async function setGameExcluded(sql: Sql, matchId: number, gameId: number, excluded: boolean): Promise<boolean> {
  return sql.begin(async (tx) => {
    const updated = await tx`update match_games set excluded = ${excluded} where id = ${gameId} and match_id = ${matchId} returning id`;
    if (updated.length === 0) return false;
    await recomputeMatch(tx, matchId);
    return true;
  });
}

export async function updateMatchSettings(sql: Sql, matchId: number, settings: MatchSettings): Promise<boolean> {
  return sql.begin(async (tx) => {
    const updated = await tx`
      update matches set warmups = ${settings.warmups}, skip_last = ${settings.skipLast}, ez_multiplier = ${settings.ezMultiplier}
      where id = ${matchId} returning id`;
    if (updated.length === 0) return false;
    await recomputeMatch(tx, matchId);
    return true;
  });
}
