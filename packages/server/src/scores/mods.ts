import catalog from "./mod-catalog.json" with { type: "json" };

// Source: ppy/osu-web database/mods.json, retrieved 2026-09-08.
export interface CatalogMod {
  acronym: string;
  name: string;
  type: string;
  modes: number[];
}

export const MOD_CATALOG: readonly CatalogMod[] = catalog;
export const STANDARD_MODS = MOD_CATALOG.filter((mod) => mod.modes.includes(0));
export const MOD_CATEGORIES = [
  { type: "DifficultyReduction", label: "Difficulty Reduction" },
  { type: "DifficultyIncrease", label: "Difficulty Increase" },
  { type: "Automation", label: "Automation" },
  { type: "Conversion", label: "Conversion" },
  { type: "Fun", label: "Fun" },
  { type: "System", label: "System" },
] as const;

export interface ScoreMod {
  acronym: string;
  settings?: Record<string, unknown>;
}

const ACRONYM = /^[A-Z0-9]{1,5}$/i;
const SPEED_MODS = ["DT", "NC", "HT", "DC"];
const VARIABLE_RATE_MODS = ["WU", "WD", "AS"];

/** Accepts API mods, bare acronyms, or a JSON string of either. Drops anything malformed. */
export function normalizeMods(value: unknown): ScoreMod[] {
  if (typeof value === "string") {
    try {
      return normalizeMods(JSON.parse(value));
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap((mod: unknown): ScoreMod[] => {
    const record = mod && typeof mod === "object" ? (mod as { acronym?: unknown; settings?: unknown }) : null;
    const acronym = typeof mod === "string" ? mod : record?.acronym;
    if (typeof acronym !== "string" || !ACRONYM.test(acronym)) return [];
    const settings = record?.settings;
    const hasSettings = settings && typeof settings === "object" && !Array.isArray(settings);
    return [{ acronym: acronym.toUpperCase(), ...(hasSettings ? { settings: settings as Record<string, unknown> } : {}) }];
  });
}

/**
 * The constant playback rate the mods imply, or null for variable-rate mods.
 * Mirrors `score_clock_rate` in the database.
 */
export function clockRate(mods: unknown): number | null {
  const normalized = normalizeMods(mods);
  if (normalized.some((mod) => VARIABLE_RATE_MODS.includes(mod.acronym))) return null;
  const speed = normalized.find((mod) => SPEED_MODS.includes(mod.acronym));
  if (!speed) return 1;
  const rate = speed.settings?.speed_change;
  if (typeof rate === "number" && Number.isFinite(rate) && rate > 0 && rate <= 100) return rate;
  return ["DT", "NC"].includes(speed.acronym) ? 1.5 : 0.75;
}

/** Short label: `HD`, `DT 1.2×`, `WU 1→1.5×`. */
export function modLabel(mod: ScoreMod): string {
  if (SPEED_MODS.includes(mod.acronym)) return `${mod.acronym} ${clockRate([mod])}×`;
  if (mod.acronym === "WU" || mod.acronym === "WD") {
    const start = mod.settings?.initial_rate ?? 1;
    const end = mod.settings?.final_rate ?? (mod.acronym === "WU" ? 1.5 : 0.75);
    return `${mod.acronym} ${start}→${end}×`;
  }
  return mod.acronym;
}

/** Full name plus every setting, for tooltips. */
export function modDescription(mod: ScoreMod): string {
  const name = MOD_CATALOG.find((m) => m.acronym === mod.acronym)?.name ?? mod.acronym;
  const settings = Object.entries(mod.settings ?? {}).map(
    ([key, value]) => `${key.replaceAll("_", " ")}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`,
  );
  return [name, ...settings].join(" · ");
}

/** Settings not already shown by {@link modLabel}, compactly: `AR9.5`, `adjust pitch: on`. */
export function modSettingLabels(mod: ScoreMod): string[] {
  const abbreviations: Record<string, string> = {
    approach_rate: "AR",
    overall_difficulty: "OD",
    circle_size: "CS",
    drain_rate: "HP",
  };
  return Object.entries(mod.settings ?? {}).flatMap(([key, value]) => {
    if (value == null) return [];
    if (key === "speed_change" && SPEED_MODS.includes(mod.acronym)) return [];
    if ((key === "initial_rate" || key === "final_rate") && (mod.acronym === "WU" || mod.acronym === "WD")) return [];
    const short = abbreviations[key];
    if (short) return [`${short}${String(value)}`];
    const shown = typeof value === "boolean" ? (value ? "on" : "off") : typeof value === "object" ? JSON.stringify(value) : String(value);
    return [`${key.replaceAll("_", " ")}: ${shown}`];
  });
}

/**
 * Whether a score was set on lazer. Build metadata decides when present; older payloads fall
 * back to an inference from Classic mod and lazer-only hit statistics.
 */
export function isLazerScore(score: {
  build_id?: unknown;
  legacy_score_id?: unknown;
  is_lazer?: unknown;
  mods?: unknown;
  statistics?: unknown;
}): boolean {
  if (typeof score.is_lazer === "boolean") return score.is_lazer;
  if (typeof score.legacy_score_id === "number" && score.legacy_score_id > 0) return false;
  if (typeof score.build_id === "number" && score.build_id > 0) return true;
  if (normalizeMods(score.mods).some((mod) => mod.acronym === "CL")) return false;
  const stats = score.statistics && typeof score.statistics === "object" ? score.statistics : {};
  return "great" in stats || "slider_tail_hit" in stats;
}
