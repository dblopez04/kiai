import { Beatmap, Performance, type PerformanceArgs } from "rosu-pp-js";
import { OsuApiError } from "../osu/api.ts";
import { clockRate, isLazerScore, normalizeMods } from "./mods.ts";

export const PP_CALCULATOR = "rosu-pp-js@4.0.1";

export interface LocalPpInput {
  beatmapId: number;
  rulesetId?: number | null;
  mods?: unknown;
  /** 0..1, as stored. */
  accuracy?: number | null;
  maxCombo?: number | null;
  statistics?: Partial<Record<string, number>> | null;
  isLazer?: boolean | null;
  legacyTotalScore?: number | null;
}

export interface PpOptions {
  /**
   * Throw {@link BeatmapFetchError} when the .osu download fails for a transient reason, so a
   * resumable job stops instead of recording "unavailable". Otherwise such failures give null.
   */
  strict?: boolean;
}

/** Local PP for a play, or null when it can't be calculated. */
export type PpCalculator = (input: LocalPpInput, options?: PpOptions) => Promise<number | null>;

export class BeatmapFetchError extends Error {
  override name = "BeatmapFetchError";
}

export function performanceArgs(input: LocalPpInput): PerformanceArgs {
  const mods = normalizeMods(input.mods);
  const stats = input.statistics ?? {};
  const lazer = input.isLazer ?? isLazerScore({ mods, statistics: stats });
  return {
    mods,
    clockRate: clockRate(mods),
    lazer,
    accuracy: input.accuracy == null ? null : input.accuracy * 100,
    combo: input.maxCombo ?? null,
    n300: stats.great ?? stats.count_300 ?? 0,
    n100: stats.ok ?? stats.count_100 ?? 0,
    n50: stats.meh ?? stats.count_50 ?? 0,
    misses: stats.miss ?? stats.count_miss ?? 0,
    nGeki: stats.perfect ?? stats.count_geki ?? 0,
    nKatu: stats.good ?? stats.count_katu ?? 0,
    largeTickHits: lazer ? (stats.large_tick_hit ?? 0) : null,
    smallTickHits: lazer ? (stats.small_tick_hit ?? 0) : null,
    sliderEndHits: lazer ? (stats.slider_tail_hit ?? 0) : null,
    legacyTotalScore: input.legacyTotalScore ?? null,
  };
}

/** PP for a play on an already-loaded .osu file. Null for variable-rate mods. */
export function calculatePp(osuFile: string, input: LocalPpInput): number | null {
  // A single clock rate can't represent Wind Up / Wind Down / Adaptive Speed.
  if (clockRate(input.mods) === null) return null;
  const map = new Beatmap(osuFile);
  try {
    const args = performanceArgs(input);
    if (input.rulesetId != null && map.mode !== input.rulesetId) map.convert(input.rulesetId, args.mods);
    const performance = new Performance(args);
    try {
      const pp = performance.calculate(map).pp;
      return Number.isFinite(pp) && pp >= 0 ? pp : null;
    } finally {
      performance.free();
    }
  } finally {
    map.free();
  }
}

/**
 * A calculator that downloads .osu files through `fetchBeatmap` (the rate-limited osu! client),
 * keeping the most recent `cacheSize` files in memory.
 */
export function createPpCalculator(fetchBeatmap: (beatmapId: number) => Promise<string | null>, cacheSize = 500): PpCalculator {
  const cache = new Map<number, string>();

  return async (input, options = {}) => {
    if (!Number.isSafeInteger(input.beatmapId) || input.beatmapId <= 0) return null;
    if (clockRate(input.mods) === null) return null;

    let text = cache.get(input.beatmapId);
    if (text === undefined) {
      let fetched: string | null;
      try {
        fetched = await fetchBeatmap(input.beatmapId);
      } catch (error) {
        if (!options.strict) return null;
        const detail = error instanceof OsuApiError || error instanceof Error ? error.message : String(error);
        throw new BeatmapFetchError(`Beatmap ${input.beatmapId} download failed (${detail}). Resume to retry.`, { cause: error });
      }
      if (fetched === null) return null;
      text = fetched;
      cache.set(input.beatmapId, text);
      if (cache.size > cacheSize) cache.delete(cache.keys().next().value!);
    }

    try {
      return calculatePp(text, input);
    } catch {
      return null;
    }
  };
}
