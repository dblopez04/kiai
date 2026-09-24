// Turning stable match pages and lazer room event pages into one shape: a match, its games in
// order, and every player's score in each game.

import type { ApiBeatmap, ApiMatch, ApiMatchScore, ApiPlaylistItem, ApiRoomEvents, ApiScore, ApiUserCompact } from "../osu/types.ts";
import { normalizeMods, type ScoreMod } from "../scores/mods.ts";
import { beatmapRow, type BeatmapRow } from "../scores/rows.ts";
import type { Team } from "./cost.ts";

export type MatchSource = "stable" | "lazer";

export interface NormalizedScore {
  userId: number;
  slot: number | null;
  team: Team;
  scoreId: number | null;
  totalScore: number;
  accuracy: number;
  maxCombo: number;
  perfect: boolean;
  passed: boolean;
  rank: string;
  count300: number;
  count100: number;
  count50: number;
  countmiss: number;
  mods: ScoreMod[];
  statistics: Record<string, number>;
  /** osu!'s PP, when it gives any (never for stable multiplayer). */
  pp: number | null;
  isLazer: boolean;
}

export interface NormalizedGame {
  externalId: number;
  beatmapId: number | null;
  rulesetId: number;
  scoringType: string | null;
  teamType: string | null;
  mods: string[];
  startTime: string | null;
  endTime: string | null;
  scores: NormalizedScore[];
}

export interface NormalizedMatch {
  source: MatchSource;
  externalId: number;
  name: string;
  roomType: string | null;
  startTime: string | null;
  endTime: string | null;
  games: NormalizedGame[];
  users: ApiUserCompact[];
  beatmaps: BeatmapRow[];
  /** Everyone who was in the lobby, including players who never finished a map. */
  participants: Set<number>;
}

const MODES: Record<string, number> = { osu: 0, taiko: 1, fruits: 2, mania: 3 };
const num = (value: unknown, fallback = 0) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const iso = (value: unknown): string | null => {
  if (typeof value !== "string" || value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};
const team = (value: unknown): Team => (value === "red" || value === "blue" ? value : "none");

function numericStats(stats: unknown): Record<string, number> {
  if (!stats || typeof stats !== "object") return {};
  return Object.fromEntries(Object.entries(stats).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
}

function scoreFields(score: ApiScore): Omit<NormalizedScore, "slot" | "team" | "scoreId" | "isLazer"> {
  const stats = numericStats(score.statistics);
  const stat = (lazer: string, legacy: string) => stats[lazer] ?? stats[legacy] ?? 0;
  return {
    userId: num(score.user_id),
    totalScore: num(score.total_score, num(score.score)),
    accuracy: num(score.accuracy),
    maxCombo: num(score.max_combo),
    perfect: score.is_perfect_combo ?? score.legacy_perfect ?? score.perfect ?? false,
    passed: score.passed !== false,
    rank: score.rank ?? "D",
    count300: stat("great", "count_300"),
    count100: stat("ok", "count_100"),
    count50: stat("meh", "count_50"),
    countmiss: stat("miss", "count_miss"),
    mods: normalizeMods(score.mods),
    statistics: stats,
    pp: typeof score.pp === "number" ? score.pp : null,
  };
}

function modAcronyms(mods: unknown): string[] {
  return normalizeMods(mods).map((mod) => mod.acronym);
}

/** Pages of `GET /matches/{id}`, fetched oldest first. */
export function normalizeStableMatch(pages: readonly ApiMatch[]): NormalizedMatch {
  const first = pages[0];
  if (!first) throw new Error("No match pages to normalize.");
  const users = new Map<number, ApiUserCompact>();
  const beatmaps: BeatmapRow[] = [];
  const participants = new Set<number>();
  const games = new Map<number, NormalizedGame>();

  for (const page of pages) {
    for (const user of page.users ?? []) users.set(user.id, user);
    for (const event of page.events) {
      if (event.user_id) participants.add(event.user_id);
      const game = event.game;
      if (!game) continue;
      const beatmap = game.beatmap ? beatmapRow(game.beatmap as ApiBeatmap) : null;
      if (beatmap) beatmaps.push(beatmap);
      const scores = (game.scores ?? []).map((score: ApiMatchScore): NormalizedScore => {
        participants.add(num(score.user_id));
        return {
          ...scoreFields(score),
          passed: score.match?.pass ?? score.passed !== false,
          slot: typeof score.match?.slot === "number" ? score.match.slot : null,
          team: team(score.match?.team),
          // Stable multiplayer scores have no score of their own on osu!.
          scoreId: null,
          isLazer: false,
        };
      });
      games.set(game.id, {
        externalId: game.id,
        beatmapId: game.beatmap_id && game.beatmap_id > 0 ? game.beatmap_id : null,
        rulesetId: game.mode_int ?? MODES[game.mode ?? "osu"] ?? 0,
        scoringType: game.scoring_type ?? null,
        teamType: game.team_type ?? null,
        mods: modAcronyms(game.mods),
        startTime: iso(game.start_time),
        endTime: iso(game.end_time),
        scores: scores.filter((s) => s.userId > 0),
      });
    }
  }

  const info = pages.at(-1)!.match ?? first.match;
  return {
    source: "stable",
    externalId: info.id,
    name: info.name ?? "",
    roomType: null,
    startTime: iso(info.start_time),
    endTime: iso(info.end_time),
    games: [...games.values()].sort((a, b) => a.externalId - b.externalId),
    users: [...users.values()],
    beatmaps,
    participants,
  };
}

/** Pages of `GET /rooms/{id}/events`, fetched oldest first. */
export function normalizeRoom(pages: readonly ApiRoomEvents[]): NormalizedMatch {
  const first = pages[0];
  if (!first) throw new Error("No room pages to normalize.");
  const users = new Map<number, ApiUserCompact>();
  const beatmapsById = new Map<number, ApiBeatmap>();
  const items = new Map<number, ApiPlaylistItem>();
  const participants = new Set<number>();
  const setsById = new Map<number, NonNullable<ApiRoomEvents["beatmapsets"]>[number]>();

  for (const page of pages) {
    for (const user of page.users ?? []) users.set(user.id, user);
    for (const set of page.beatmapsets ?? []) setsById.set(set.id, set);
    for (const beatmap of page.beatmaps ?? []) beatmapsById.set(beatmap.id, beatmap);
    for (const event of page.events) if (event.user_id) participants.add(event.user_id);
    // Later pages carry fresher copies of the same playlist item (more scores).
    for (const item of page.playlist_items ?? []) {
      items.set(item.id, item);
      if (item.beatmap) beatmapsById.set(item.beatmap.id, item.beatmap);
    }
  }

  const beatmaps = [...beatmapsById.values()].flatMap((b) => {
    const row = beatmapRow(b, b.beatmapset ?? (b.beatmapset_id ? setsById.get(b.beatmapset_id) : undefined));
    return row ? [row] : [];
  });

  const games = [...items.values()]
    .filter((item) => (item.scores?.length ?? 0) > 0 || item.played_at)
    .map((item): NormalizedGame => {
      const teams = item.details?.teams ?? {};
      const hasTeams = Object.keys(teams).length > 0;
      return {
        externalId: item.id,
        beatmapId: item.beatmap_id && item.beatmap_id > 0 ? item.beatmap_id : null,
        rulesetId: item.ruleset_id ?? 0,
        scoringType: "standardised",
        teamType: hasTeams ? "team_versus" : (item.details?.room_type ?? null),
        mods: modAcronyms(item.required_mods),
        startTime: iso(item.details?.started_at) ?? iso(item.created_at),
        endTime: iso(item.played_at),
        scores: (item.scores ?? [])
          .filter((score) => num(score.user_id) > 0)
          .map((score): NormalizedScore => {
            participants.add(num(score.user_id));
            return {
              ...scoreFields(score),
              slot: null,
              team: team(teams[String(score.user_id)]),
              scoreId: score.id ?? null,
              isLazer: true,
            };
          }),
      };
    })
    .sort((a, b) => (a.startTime ?? "").localeCompare(b.startTime ?? "") || a.externalId - b.externalId);

  const room = pages.at(-1)!.room ?? first.room;
  return {
    source: "lazer",
    externalId: room.id,
    name: room.name ?? "",
    roomType: room.type ?? null,
    startTime: iso(room.starts_at),
    endTime: iso(room.ends_at),
    games,
    users: [...users.values()],
    beatmaps,
    participants,
  };
}

// ---------- names ----------

export interface ParsedMatchName {
  acronym: string | null;
  red: string | null;
  blue: string | null;
}

// "OWC 2025: (United States) vs (Japan)", "ACR: TeamA vs. TeamB"
const VERSUS = /^\s*([^:()]{1,40}?)\s*:\s*\(?(.+?)\)?\s+vs\.?\s+\(?(.+?)\)?\s*$/i;
// "ACR: Qualifiers Lobby 3", "ACR: (Tryouts) Lobby A"
const PREFIXED = /^\s*([^:()]{1,40}?)\s*:\s*\S/;
const LOBBY_WORDS = /\b(qualifiers?|quals|tryouts?|lobby|showmatch|groups?)\b/i;

export function parseMatchName(name: string): ParsedMatchName {
  const versus = VERSUS.exec(name);
  if (versus) return { acronym: versus[1]!.trim(), red: versus[2]!.trim(), blue: versus[3]!.trim() };
  const prefixed = PREFIXED.exec(name);
  if (prefixed && LOBBY_WORDS.test(name)) return { acronym: prefixed[1]!.trim(), red: null, blue: null };
  return { acronym: null, red: null, blue: null };
}

// Matchmaking bots name their lobbies like tournaments ("ROMAI: (A) vs (B)", "ETX: ...", "o!mm Ranked: ...").
// Each name prefix matches case-insensitively as a whole word, with a pattern that works in JavaScript and in Postgres (`~*`).
export const MATCHMAKING_BOTS = { romai: "romai", etx: "etx", omm: "o!mm" } as const;
export type MatchmakingBot = keyof typeof MATCHMAKING_BOTS;

export const matchmakingPattern = (bot: MatchmakingBot) => `^\\s*${MATCHMAKING_BOTS[bot]}(?![a-z0-9_])`;
const MATCHMAKING_NAMES = (Object.keys(MATCHMAKING_BOTS) as MatchmakingBot[]).map((bot) => [bot, new RegExp(matchmakingPattern(bot), "i")] as const);

/** The matchmaking bot (ROMAI, ETX, o!mm) that made a lobby, if any: casual play, not a tournament. */
export function matchmakingBot(name: string): MatchmakingBot | null {
  return MATCHMAKING_NAMES.find(([, pattern]) => pattern.test(name))?.[0] ?? null;
}

/** What a match is: a tournament match, one matchmaking bot's lobby, a ranked play room, or (not filterable) any other lobby. */
export const MATCH_KINDS = ["tournament", "romai", "etx", "omm", "ranked"] as const;
export type MatchKind = (typeof MATCH_KINDS)[number] | "other";

export function matchKind(match: { source: MatchSource; name: string; acronym: string | null }): MatchKind {
  if (match.source === "lazer") return "ranked";
  return matchmakingBot(match.name) ?? (match.acronym !== null ? "tournament" : "other");
}

/** Lobby names worth fetching during discovery: tournament-style names, or ones naming the player. */
export function isCandidateName(name: string, playerName: string): boolean {
  if (parseMatchName(name).acronym !== null) return true;
  return playerName.length > 1 && name.toLowerCase().includes(playerName.toLowerCase());
}

export function matchUrl(source: MatchSource, externalId: number): string {
  return source === "stable" ? `https://osu.ppy.sh/community/matches/${externalId}` : `https://osu.ppy.sh/multiplayer/rooms/${externalId}`;
}
