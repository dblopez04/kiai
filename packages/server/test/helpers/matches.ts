// Fixtures for stable matches and lazer ranked play rooms, shaped like osu!'s responses.

import type { ApiMatch, ApiMatchEvent, ApiMatchScore, ApiPlaylistItem, ApiRoom, ApiRoomEvents, ApiScore, ApiUserCompact } from "../../src/osu/types.ts";
import { beatmap, USER_ID } from "./fake-osu.ts";

export const TEAMMATE = 2002;
export const OPPONENT_A = 3003;
export const OPPONENT_B = 3004;

export const USERS: ApiUserCompact[] = [
  { id: USER_ID, username: "tester", country_code: "US" },
  { id: TEAMMATE, username: "Mate", country_code: "US" },
  { id: OPPONENT_A, username: "RivalOne", country_code: "JP" },
  { id: OPPONENT_B, username: "RivalTwo", country_code: "JP" },
];

/** [user id, score, team, mods] */
export type PlayLine = [number, number, ("red" | "blue" | "none")?, (string[] | undefined)?];

let nextEventId = 1_000_000;
let nextGameId = 500_000;

export function matchScore([userId, total, team = "none", mods = ["NF"]]: PlayLine, slot: number, beatmapId: number): ApiMatchScore {
  return {
    id: 0,
    user_id: userId,
    beatmap_id: beatmapId,
    ruleset_id: 0,
    accuracy: 0.95,
    total_score: total,
    max_combo: 30,
    passed: true,
    rank: "A",
    pp: null,
    mods: mods.map((acronym) => ({ acronym, settings: {} })),
    statistics: { great: 36, ok: 3, meh: 0, miss: 1 },
    match: { slot, team, pass: true },
  };
}

export interface GameSpec {
  beatmapId: number;
  plays: PlayLine[];
  teamType?: string;
  ended?: boolean;
}

export function stableGame(spec: GameSpec, start: Date): ApiMatchEvent {
  const id = nextGameId++;
  return {
    id: nextEventId++,
    detail: { type: "other" },
    timestamp: start.toISOString(),
    user_id: null,
    game: {
      id,
      beatmap_id: spec.beatmapId,
      start_time: start.toISOString(),
      end_time: spec.ended === false ? null : new Date(start.getTime() + 180_000).toISOString(),
      mode: "osu",
      mode_int: 0,
      scoring_type: "scorev2",
      team_type: spec.teamType ?? "team-vs",
      mods: ["NF"],
      beatmap: beatmap(spec.beatmapId),
      scores: spec.plays.map((play, slot) => matchScore(play, slot, spec.beatmapId)),
    },
  };
}

export interface MatchSpec {
  id: number;
  name: string;
  games: GameSpec[];
  /** Filler join/leave events, to make the match span several pages. */
  filler?: number;
  ended?: boolean;
  start?: Date;
  users?: ApiUserCompact[];
  /** Players who join but never play. */
  joins?: number[];
}

export function stableMatch(spec: MatchSpec): ApiMatch {
  const start = spec.start ?? new Date("2026-08-01T12:00:00Z");
  const events: ApiMatchEvent[] = [{ id: nextEventId++, detail: { type: "match-created" }, timestamp: start.toISOString(), user_id: null }];
  for (const userId of spec.joins ?? []) events.push({ id: nextEventId++, detail: { type: "player-joined" }, user_id: userId });
  for (let i = 0; i < (spec.filler ?? 0); i++) {
    events.push({ id: nextEventId++, detail: { type: i % 2 ? "player-left" : "player-joined" }, user_id: 9_000_000 + (i % 7) });
  }
  spec.games.forEach((game, i) => events.push(stableGame(game, new Date(start.getTime() + (i + 1) * 300_000))));
  const ended = spec.ended !== false;
  return {
    match: {
      id: spec.id,
      name: spec.name,
      start_time: start.toISOString(),
      end_time: ended ? new Date(start.getTime() + 3600_000).toISOString() : null,
    },
    events,
    users: spec.users ?? USERS,
  };
}

/** A 2v2 team match: tester + Mate (red) vs RivalOne + RivalTwo (blue). Red wins 3–2 on the tiebreaker. */
export function teamMatch(id: number, overrides: Partial<MatchSpec> = {}): ApiMatch {
  const red = (a: number, b: number, mods?: string[]): PlayLine[] => [
    [USER_ID, a, "red", mods],
    [TEAMMATE, b, "red"],
  ];
  const blue = (a: number, b: number): PlayLine[] => [
    [OPPONENT_A, a, "blue"],
    [OPPONENT_B, b, "blue"],
  ];
  return stableMatch({
    id,
    name: "TST 2026: (Red Rockets) vs (Blue Birds)",
    games: [
      { beatmapId: 11, plays: [...red(600_000, 400_000), ...blue(500_000, 400_000)] },
      { beatmapId: 12, plays: [...red(300_000, 300_000, ["NF", "HD"]), ...blue(500_000, 500_000)] },
      { beatmapId: 13, plays: [...red(700_000, 500_000, ["NF", "HR"]), ...blue(400_000, 400_000)] },
      { beatmapId: 14, plays: [...red(200_000, 200_000, ["NF", "DT"]), ...blue(600_000, 600_000)] },
      { beatmapId: 15, plays: [...red(800_000, 600_000), ...blue(500_000, 500_000)] },
    ],
    ...overrides,
  });
}

// ---------- lazer ranked play ----------

let nextRoomEventId = 7_000_000;
let nextItemId = 800_000;
let nextLazerScoreId = 6_000_000_000;

export function lazerScore(userId: number, beatmapId: number, total: number, pp: number | null = null): ApiScore {
  return {
    id: nextLazerScoreId++,
    type: "solo_score",
    user_id: userId,
    beatmap_id: beatmapId,
    ruleset_id: 0,
    accuracy: 0.97,
    total_score: total,
    max_combo: 35,
    passed: true,
    rank: "S",
    pp,
    mods: [],
    statistics: { great: 38, ok: 2, miss: 0 },
    ended_at: new Date("2026-09-01T10:10:00Z").toISOString(),
  };
}

export function rankedPlayRoom(id: number, games: { beatmapId: number; scores: [number, number, (number | null)?][] }[], endsAt = "2026-09-01T11:00:00Z"): { room: ApiRoom; events: ApiRoomEvents } {
  const room: ApiRoom = {
    id,
    name: "Ranked Play: tester vs RivalOne",
    type: "ranked_play",
    starts_at: "2026-09-01T10:00:00Z",
    ends_at: endsAt,
    recent_participants: [USERS[0]!, USERS[2]!],
  };
  const items: ApiPlaylistItem[] = games.map((game, i) => ({
    id: nextItemId++,
    room_id: id,
    beatmap_id: game.beatmapId,
    ruleset_id: 0,
    required_mods: [],
    played_at: new Date(Date.parse(room.starts_at!) + (i + 1) * 300_000).toISOString(),
    details: { room_type: "ranked_play", started_at: new Date(Date.parse(room.starts_at!) + i * 300_000 + 60_000).toISOString() },
    scores: game.scores.map(([userId, total, pp]) => lazerScore(userId, game.beatmapId, total, pp ?? null)),
  }));
  const events: ApiRoomEvents = {
    room,
    events: items.flatMap((item) => [
      { id: nextRoomEventId++, event_type: "game_started", playlist_item_id: item.id, user_id: null },
      { id: nextRoomEventId++, event_type: "game_completed", playlist_item_id: item.id, user_id: null },
    ]),
    playlist_items: items,
    beatmaps: games.map((g) => beatmap(g.beatmapId)),
    users: [USERS[0]!, USERS[2]!],
  };
  return { room, events };
}
