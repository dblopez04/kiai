// A replay's map with its mods applied: effective AR/OD/CS/HP, stars, BPM and length, plus the
// play's pp. Render rules match on these, and replay pages and Discord messages show them.

import { Beatmap, BeatmapAttributesBuilder, Performance } from "rosu-pp-js";
import { clockRate as modClockRate, type ScoreMod } from "../scores/mods.ts";

export interface ReplayAttributes {
  stars: number;
  ar: number;
  od: number;
  cs: number;
  hp: number;
  /** After the speed change. */
  bpm: number;
  /** Seconds from the first to the last object, after the speed change. */
  length: number;
  clock_rate: number;
  max_combo: number;
  /** rosu-pp's estimate for this play. */
  pp: number;
}

export interface PlayForAttributes {
  mods: readonly ScoreMod[];
  count300: number;
  count100: number;
  count50: number;
  countmiss: number;
  max_combo: number;
}

const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;

/** First and last hit object times in ms, read straight from the .osu. */
function objectSpan(osu: string): number {
  const start = osu.indexOf("[HitObjects]");
  if (start < 0) return 0;
  const times = osu
    .slice(start + "[HitObjects]".length)
    .split(/\r?\n/)
    .map((line) => Number(line.split(",")[2]))
    .filter(Number.isFinite);
  return times.length ? Math.max(...times) - Math.min(...times) : 0;
}

/** Null when the map can't be parsed or the mods have no single speed (Wind Up and friends). */
export function replayAttributes(osu: string, play: PlayForAttributes): ReplayAttributes | null {
  const rate = modClockRate(play.mods);
  if (rate === null) return null;
  let map: Beatmap;
  try {
    map = new Beatmap(osu);
  } catch {
    return null;
  }
  const mods = play.mods.map((mod) => ({ ...mod }));
  try {
    // build() consumes the builder, so it's never freed separately.
    const attrs = new BeatmapAttributesBuilder({ map, mods, clockRate: rate }).build();
    const { ar, od, cs, hp } = attrs;
    attrs.free();
    const performance = new Performance({
      mods,
      clockRate: rate,
      lazer: false,
      n300: play.count300,
      n100: play.count100,
      n50: play.count50,
      misses: play.countmiss,
      combo: play.max_combo,
    });
    let pp: number, stars: number, maxCombo: number;
    try {
      const result = performance.calculate(map);
      ({ pp } = result);
      ({ stars, maxCombo } = result.difficulty);
      result.free();
    } finally {
      performance.free();
    }
    const out: ReplayAttributes = {
      stars: round(stars),
      ar: round(ar),
      od: round(od),
      cs: round(cs),
      hp: round(hp),
      bpm: round(map.bpm * rate, 1),
      length: Math.round(objectSpan(osu) / 1000 / rate),
      clock_rate: rate,
      max_combo: maxCombo,
      pp: round(pp),
    };
    return Object.values(out).every(Number.isFinite) ? out : null;
  } catch {
    return null;
  } finally {
    map.free();
  }
}
