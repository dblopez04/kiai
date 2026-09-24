// Render presets, the rules that pick one per replay, and the skins presets use. A preset is a
// skin plus a JSON patch over the base danser settings, applied for one run with `-sPatch`.

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { sqlJson, type Sql } from "../db/index.ts";
import { UserError } from "../errors.ts";
import type { MediaPaths } from "../media.ts";
import { extractZip, withLock } from "./maps.ts";
import { matchesRule, parseRule, type RuleFacts } from "./rules.ts";

export interface RenderPreset {
  name: string;
  description: string;
  /** A folder in <DATA_DIR>/skins, or "default" for danser's built-in skin. */
  skin: string;
  /** Merged over the base settings; keys as in danser 0.11's settings/default.json. */
  patch: Record<string, unknown>;
  /** Start at the first hit object (danser's -skip) rather than rendering the lead-in. */
  skipIntro: boolean;
}

export const DEFAULT_PRESET_NAME = "default";
export const BUILTIN_SKIN = "default";
const PRESET_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const SKIN_NAME = /^[A-Za-z0-9][\w .()[\]+-]{0,63}$/;
const MAX_PATCH_BYTES = 64 * 1024;
/** Taken by the editor's routes (/render/presets/new). */
const RESERVED_NAMES = new Set(["new"]);

// ---------- presets ----------

type PresetRow = { name: string; description: string; skin: string; patch: unknown; skip_intro: boolean };

const toPreset = (row: PresetRow): RenderPreset => ({
  name: row.name,
  description: row.description,
  skin: row.skin,
  patch: (row.patch ?? {}) as Record<string, unknown>,
  skipIntro: row.skip_intro,
});

export async function listPresets(sql: Sql): Promise<RenderPreset[]> {
  const rows = await sql<PresetRow[]>`
    select name, description, skin, patch, skip_intro from render_presets order by name = ${DEFAULT_PRESET_NAME} desc, name`;
  return rows.map(toPreset);
}

export async function getPreset(sql: Sql, name: string): Promise<RenderPreset | null> {
  const [row] = await sql<PresetRow[]>`
    select name, description, skin, patch, skip_intro from render_presets where name = ${name}`;
  return row ? toPreset(row) : null;
}

/**
 * Check a patch: a JSON object that leaves alone what kiai itself sets (the folders danser reads
 * and writes, and the mp4 container the pages serve).
 */
export function parsePatch(text: string): Record<string, unknown> {
  if (Buffer.byteLength(text) > MAX_PATCH_BYTES) throw new UserError("The settings patch is larger than 64 KB.");
  let patch: unknown;
  try {
    patch = JSON.parse(text.trim() || "{}");
  } catch (error) {
    throw new UserError(`The settings patch isn't valid JSON: ${(error as Error).message}`);
  }
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new UserError('The settings patch must be a JSON object, like {"Recording": {"FPS": 60}}.');
  const record = patch as Record<string, unknown>;
  if ("General" in record) throw new UserError("Presets can't change General settings: kiai sets the folders danser uses.");
  const recording = record.Recording;
  if (recording && typeof recording === "object" && ("OutputDir" in recording || "Container" in recording)) {
    throw new UserError("Presets can't change Recording.OutputDir or Recording.Container: kiai needs the video as mp4 in its own folder.");
  }
  return record;
}

export async function savePreset(
  sql: Sql,
  paths: MediaPaths,
  /** `patch` is JSON text or an object; either way it's checked with parsePatch. Leaving out `skipIntro` keeps it (on for new presets). */
  input: { name: string; description: string; skin: string; patch: string | Record<string, unknown>; skipIntro?: boolean | undefined },
  options: { create: boolean },
): Promise<void> {
  const name = input.name.trim().toLowerCase();
  if (!PRESET_NAME.test(name)) throw new UserError("Preset names are lowercase letters, digits, - and _, up to 32 characters.");
  if (options.create && RESERVED_NAMES.has(name)) throw new UserError(`"${name}" can't be a preset name.`);
  const skin = input.skin.trim() || BUILTIN_SKIN;
  if (skin !== BUILTIN_SKIN && !(await listSkins(paths)).includes(skin)) throw new UserError(`There's no skin named "${skin}". Upload it first.`);
  const patch = parsePatch(typeof input.patch === "string" ? input.patch : JSON.stringify(input.patch));
  const skipIntro = input.skipIntro ?? null;
  const values = { name, description: input.description.trim().slice(0, 500), skin, patch: sqlJson(sql, patch), skip_intro: skipIntro ?? true };
  if (options.create) {
    const [created] = await sql`insert into render_presets ${sql(values)} on conflict (name) do nothing returning name`;
    if (!created) throw new UserError(`A preset named "${name}" already exists.`);
  } else {
    const [updated] = await sql`
      update render_presets set description = ${values.description}, skin = ${skin}, patch = ${values.patch},
        skip_intro = coalesce(${skipIntro}::boolean, skip_intro), updated_at = now()
      where name = ${name} returning name`;
    if (!updated) throw new UserError(`There's no preset named "${name}".`);
  }
}

export async function deletePreset(sql: Sql, name: string): Promise<void> {
  if (name === DEFAULT_PRESET_NAME) throw new UserError("The default preset can't be deleted: it's used when no rule matches.");
  const [used] = await sql<{ n: number }[]>`select count(*)::int as n from render_rules where preset = ${name}`;
  if (used && used.n > 0) throw new UserError(`"${name}" is used by ${used.n} rule(s). Change or delete them first.`);
  await sql`delete from render_presets where name = ${name}`;
}

/** Output size a preset records at, for video tags. danser's default is 1920×1080. */
export function presetFrameSize(preset: RenderPreset): { width: number; height: number } {
  const recording = (preset.patch.Recording ?? {}) as { FrameWidth?: unknown; FrameHeight?: unknown };
  const dim = (value: unknown, fallback: number) => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback);
  return { width: dim(recording.FrameWidth, 1920), height: dim(recording.FrameHeight, 1080) };
}

// ---------- rules ----------

export interface RenderRule {
  id: number;
  position: number;
  expression: string;
  preset: string;
  enabled: boolean;
}

export async function listRules(sql: Sql): Promise<RenderRule[]> {
  return sql<RenderRule[]>`select id, position, expression, preset, enabled from render_rules order by position, id`;
}

async function requirePreset(sql: Sql, name: string): Promise<void> {
  if (!(await getPreset(sql, name))) throw new UserError(`There's no preset named "${name}".`);
}

export async function addRule(sql: Sql, input: { expression: string; preset: string }): Promise<number> {
  parseRule(input.expression);
  await requirePreset(sql, input.preset);
  const [row] = await sql<{ id: number }[]>`
    insert into render_rules (position, expression, preset)
    select coalesce(max(position), 0) + 1, ${input.expression.trim()}, ${input.preset} from render_rules
    returning id`;
  return row!.id;
}

export async function updateRule(sql: Sql, id: number, input: { expression: string; preset: string; enabled: boolean }): Promise<void> {
  parseRule(input.expression);
  await requirePreset(sql, input.preset);
  const [row] = await sql`
    update render_rules set expression = ${input.expression.trim()}, preset = ${input.preset}, enabled = ${input.enabled}
    where id = ${id} returning id`;
  if (!row) throw new UserError("That rule no longer exists.");
}

export async function deleteRule(sql: Sql, id: number): Promise<void> {
  await sql`delete from render_rules where id = ${id}`;
}

/** Swap a rule with its neighbour: -1 moves it up (checked earlier), +1 down. */
export async function moveRule(sql: Sql, id: number, direction: -1 | 1): Promise<void> {
  await sql.begin(async (tx) => {
    const rules = await tx<RenderRule[]>`select id, position from render_rules order by position, id for update`;
    const index = rules.findIndex((rule) => rule.id === id);
    const other = rules[index + direction];
    if (index < 0 || !other) return;
    // Renumber so positions are distinct, then swap.
    const order = rules.map((rule) => rule.id);
    [order[index], order[index + direction]] = [order[index + direction]!, order[index]!];
    for (const [position, ruleId] of order.entries()) await tx`update render_rules set position = ${position + 1} where id = ${ruleId}`;
  });
}

export interface RuleCheck {
  rule: RenderRule;
  matched: boolean;
  /** Set when the stored expression no longer parses. */
  error: string | null;
}

export interface PresetChoice {
  preset: RenderPreset;
  /** "rule 2: ar >= 10.3" or "no rule matched". */
  reason: string;
  /** Every rule in order, for the dry run. Checking stops at the first match. */
  checks: RuleCheck[];
}

/** The first enabled rule that matches picks the preset; otherwise the default preset. */
export async function choosePreset(sql: Sql, facts: RuleFacts): Promise<PresetChoice> {
  const rules = await listRules(sql);
  const checks: RuleCheck[] = [];
  let chosen: { rule: RenderRule; index: number } | null = null;
  for (const [index, rule] of rules.entries()) {
    if (!rule.enabled) continue;
    let matched = false;
    let error: string | null = null;
    try {
      matched = matchesRule(parseRule(rule.expression), facts);
    } catch (e) {
      error = (e as Error).message;
    }
    checks.push({ rule, matched, error });
    if (matched) {
      chosen = { rule, index };
      break;
    }
  }
  const name = chosen?.rule.preset ?? DEFAULT_PRESET_NAME;
  const preset = (await getPreset(sql, name)) ?? (await getPreset(sql, DEFAULT_PRESET_NAME));
  if (!preset) throw new Error("The default render preset is missing from the database.");
  const reason = chosen ? `rule ${chosen.index + 1}: ${chosen.rule.expression || "always"}` : "no rule matched";
  return { preset, reason, checks };
}

// ---------- skins ----------

export async function listSkins(paths: MediaPaths): Promise<string[]> {
  const entries = await fs.readdir(paths.skins, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name).sort((a, b) => a.localeCompare(b));
}

export function skinNameFrom(fileName: string): string {
  return path.basename(fileName).replace(/\.(osk|zip)$/i, "").replace(/[^\w .()[\]+-]/g, "").trim().slice(0, 64);
}

/**
 * Unpack an .osk into `<skins>/<name>`, replacing a skin of that name. Archives that wrap
 * everything in one folder are flattened, since danser expects skin.ini at the top.
 */
export async function installSkin(sql: Sql, paths: MediaPaths, oskPath: string, rawName: string): Promise<string> {
  const name = rawName.trim();
  if (!SKIN_NAME.test(name) || name.toLowerCase() === BUILTIN_SKIN) {
    throw new UserError(`"${name}" can't be a skin name: use letters, digits, spaces and . _ - ( ) [ ] +, and not "default".`);
  }
  return withLock(sql, `kiai-skin:${name.toLowerCase()}`, async () => {
    const staging = path.join(paths.tmp, `skin-${randomUUID()}`);
    try {
      await extractZip(oskPath, staging, ".osk");
      let root = staging;
      const top = await fs.readdir(staging, { withFileTypes: true });
      if (top.length === 1 && top[0]!.isDirectory()) root = path.join(staging, top[0]!.name);
      const files = await fs.readdir(root);
      if (files.length === 0) throw new UserError("That .osk is empty.");
      if (!files.some((file) => /\.(ini|png|jpg|wav|ogg|mp3)$/i.test(file))) throw new UserError("That .osk has no skin files (skin.ini or images) at its top level.");
      const target = path.join(paths.skins, name);
      await fs.rm(target, { recursive: true, force: true });
      await fs.rename(root, target);
      return name;
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
  });
}

export async function deleteSkin(sql: Sql, paths: MediaPaths, name: string): Promise<void> {
  const [used] = await sql<{ names: string[] | null }[]>`select array_agg(name order by name) as names from render_presets where skin = ${name}`;
  if (used?.names?.length) throw new UserError(`"${name}" is used by preset(s) ${used.names.join(", ")}. Change them first.`);
  if (!(await listSkins(paths)).includes(name)) throw new UserError(`There's no skin named "${name}".`);
  await fs.rm(path.join(paths.skins, name), { recursive: true, force: true });
}
