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
  statistics?: {
    pp?: number | null;
    global_rank?: number | null;
    play_count?: number | null;
    play_time?: number | null;
  };
}
