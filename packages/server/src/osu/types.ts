// The subset of osu! API v2 responses this project reads (x-api-version 20250530).
// Fields are optional where the API omits them in compact variants.

export interface ApiBeatmapset {
  id: number;
  artist?: string;
  title?: string;
  title_unicode?: string;
  creator?: string;
  user_id?: number;
  status?: string;
  bpm?: number;
  last_updated?: string | null;
}

export interface ApiBeatmap {
  id: number;
  beatmapset_id?: number;
  user_id?: number;
  version?: string;
  mode?: string;
  mode_int?: number;
  status?: string;
  difficulty_rating?: number;
  bpm?: number;
  ar?: number;
  /** Overall difficulty. */
  accuracy?: number;
  cs?: number;
  drain?: number;
  total_length?: number;
  hit_length?: number;
  count_circles?: number;
  count_sliders?: number;
  count_spinners?: number;
  max_combo?: number;
  last_updated?: string | null;
  /** MD5 of the current .osu file. */
  checksum?: string | null;
  beatmapset?: ApiBeatmapset;
}

export interface ApiMod {
  acronym: string;
  settings?: Record<string, unknown>;
}

/** Lazer hit statistics use `great`/`ok`/...; legacy payloads use `count_300`/... */
export type ApiStatistics = Partial<Record<string, number>>;

export interface ApiScore {
  id: number;
  user_id?: number;
  beatmap_id?: number;
  ruleset_id?: number;
  type?: string;
  accuracy?: number;
  total_score?: number;
  /** Legacy payloads. */
  score?: number;
  legacy_total_score?: number | null;
  max_combo?: number;
  passed?: boolean;
  rank?: string;
  pp?: number | null;
  mods?: (ApiMod | string)[];
  statistics?: ApiStatistics;
  maximum_statistics?: ApiStatistics;
  ended_at?: string | null;
  is_perfect_combo?: boolean;
  legacy_perfect?: boolean;
  perfect?: boolean;
  has_replay?: boolean;
  replay?: boolean;
  build_id?: number | null;
  legacy_score_id?: number | null;
  preserve?: boolean;
  beatmap?: ApiBeatmap;
  beatmapset?: ApiBeatmapset;
}

export interface ApiMostPlayed {
  beatmap_id: number;
  count: number;
  beatmap?: ApiBeatmap;
  beatmapset?: ApiBeatmapset;
}

export interface ApiUser {
  id: number;
  username: string;
  avatar_url?: string;
  country_code?: string;
  /** Names the user had before, oldest first. Only on full profiles. */
  previous_usernames?: string[];
  statistics?: {
    pp?: number | null;
    global_rank?: number | null;
    play_count?: number | null;
    play_time?: number | null;
  };
}

export type ApiUserCompact = Pick<ApiUser, "id" | "username" | "avatar_url" | "country_code">;

// ---------- stable multiplayer (tournament mp links) ----------

export interface ApiMatchInfo {
  id: number;
  name?: string;
  start_time?: string | null;
  end_time?: string | null;
}

/** A player's score in a stable game: lazer-format fields plus the lobby slot and team. */
export interface ApiMatchScore extends ApiScore {
  match?: { slot?: number; team?: string; pass?: boolean };
}

export interface ApiMatchGame {
  id: number;
  beatmap_id?: number | null;
  start_time?: string | null;
  end_time?: string | null;
  mode?: string;
  mode_int?: number;
  scoring_type?: string;
  team_type?: string;
  /** Lobby mods as acronyms. */
  mods?: (string | ApiMod)[];
  beatmap?: ApiBeatmap | null;
  scores?: ApiMatchScore[];
}

export interface ApiMatchEvent {
  id: number;
  detail?: { type?: string; text?: string };
  timestamp?: string;
  user_id?: number | null;
  game?: ApiMatchGame;
}

/** `GET /matches/{id}`: one page of events. */
export interface ApiMatch {
  match: ApiMatchInfo;
  events: ApiMatchEvent[];
  users?: ApiUserCompact[];
  first_event_id?: number;
  latest_event_id?: number;
  current_game_id?: number | null;
}

/** `GET /matches`: every public lobby, not only tournaments. */
export interface ApiMatchList {
  matches: ApiMatchInfo[];
  cursor_string?: string | null;
}

// ---------- lazer rooms (ranked play) ----------

export interface ApiRoom {
  id: number;
  name?: string;
  type?: string;
  category?: string;
  status?: string;
  starts_at?: string | null;
  ends_at?: string | null;
  participant_count?: number;
  host?: ApiUserCompact;
  recent_participants?: ApiUserCompact[];
}

/** A player's ranked play history: `GET /users/{id}/ranked-play` as JSON. */
export interface ApiRoomList {
  rooms: ApiRoom[];
  /** Null on the last page. */
  cursor_string?: string | null;
}

export interface ApiPlaylistItem {
  id: number;
  room_id?: number;
  beatmap_id?: number;
  ruleset_id?: number;
  required_mods?: (ApiMod | string)[];
  allowed_mods?: (ApiMod | string)[];
  expired?: boolean;
  playlist_order?: number | null;
  played_at?: string | null;
  created_at?: string | null;
  /** The game-started event's details; `teams` maps user ids to red/blue in team rooms. */
  details?: { room_type?: string; teams?: Record<string, string>; started_at?: string | null } | null;
  scores?: ApiScore[];
  beatmap?: ApiBeatmap;
}

/** `GET /rooms/{id}/events`: one page of events and the playlist items they touch. */
export interface ApiRoomEvents {
  room: ApiRoom;
  events: { id: number; event_type?: string; playlist_item_id?: number | null; user_id?: number | null; created_at?: string }[];
  playlist_items?: ApiPlaylistItem[];
  beatmaps?: ApiBeatmap[];
  beatmapsets?: ApiBeatmapset[];
  users?: ApiUserCompact[];
  first_event_id?: number;
  last_event_id?: number;
}
