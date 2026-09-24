// Render rule expressions: conditions joined by `and`, matched against a replay.
//
//   HD and ar < 10.3          mods: a bare acronym, or `mods has HD` / `mods lacks HD`
//   ar >= 10.3                numbers: ar od cs hp stars bpm length pp accuracy combo misses rate
//   server = gatari.pw        text: server (`official` for osu!'s own), player, rank
//   always                    matches everything (so does an empty expression)
//
// Numeric map values are after mods (AR 9 with DT is 10.33). Without DT/NC-style exactness, a
// required DT also accepts NC, HT accepts DC and SD accepts PF, as in the score filters.

import { UserError } from "../errors.ts";
import type { ReplayAttributes } from "../replays/attributes.ts";
import type { ScoreMod } from "../scores/mods.ts";

export const NUMBER_FIELDS = ["ar", "od", "cs", "hp", "stars", "bpm", "length", "pp", "accuracy", "combo", "misses", "rate"] as const;
export const TEXT_FIELDS = ["server", "player", "rank"] as const;
type NumberField = (typeof NUMBER_FIELDS)[number];
type TextField = (typeof TEXT_FIELDS)[number];
type NumberOp = "<" | "<=" | ">" | ">=" | "=" | "!=";

export type Condition =
  | { kind: "mod"; acronym: string; has: boolean }
  | { kind: "number"; field: NumberField; op: NumberOp; value: number }
  | { kind: "text"; field: TextField; op: "=" | "!="; value: string };

/** What a rule sees about a replay. Map values are null until the map is on disk. */
export interface RuleFacts {
  mods: string[];
  ar: number | null;
  od: number | null;
  cs: number | null;
  hp: number | null;
  stars: number | null;
  bpm: number | null;
  /** Seconds, after the speed change. */
  length: number | null;
  pp: number | null;
  /** 0..100. */
  accuracy: number;
  combo: number;
  misses: number;
  rate: number | null;
  /** The server hostname, or "official". */
  server: string;
  player: string;
  /** SS, S, A, ... as the game shows it. */
  rank: string;
}

const MOD_EQUIVALENTS: Record<string, string[]> = { DT: ["DT", "NC"], HT: ["HT", "DC"], SD: ["SD", "PF"] };
const RANK_LABEL: Record<string, string> = { X: "SS", XH: "SS", SH: "S" };
const MOD = /^[A-Za-z][A-Za-z0-9]{1,3}$/;
const TOKEN = /\s*(>=|<=|!=|=|<|>|[^\s<>=!]+)/y;

function tokenize(expression: string): string[] {
  const tokens: string[] = [];
  TOKEN.lastIndex = 0;
  const text = expression.trim();
  while (TOKEN.lastIndex < text.length) {
    const match = TOKEN.exec(text);
    if (!match) throw new UserError(`Can't read "${text.slice(TOKEN.lastIndex)}".`);
    tokens.push(match[1]!);
  }
  return tokens;
}

/** Parse an expression. Throws {@link UserError} explaining the first problem. */
export function parseRule(expression: string): Condition[] {
  const tokens = tokenize(expression);
  if (tokens.length === 0 || (tokens.length === 1 && tokens[0]!.toLowerCase() === "always")) return [];
  const conditions: Condition[] = [];
  let i = 0;
  const next = () => tokens[i++];
  for (;;) {
    const first = next();
    if (first === undefined) throw new UserError(`"${expression}" ends with "and": add a condition after it.`);
    const lower = first.toLowerCase();
    if (lower === "mods") {
      const verb = next()?.toLowerCase();
      const acronym = next();
      if ((verb !== "has" && verb !== "lacks") || !acronym || !MOD.test(acronym)) {
        throw new UserError(`Write mod conditions as "mods has HD" or "mods lacks HD".`);
      }
      conditions.push({ kind: "mod", acronym: acronym.toUpperCase(), has: verb === "has" });
    } else if ((NUMBER_FIELDS as readonly string[]).includes(lower)) {
      const op = next();
      const raw = next();
      const value = Number(raw);
      if (!op || !["<", "<=", ">", ">=", "=", "!="].includes(op)) throw new UserError(`"${first}" needs a comparison: <, <=, >, >=, = or !=.`);
      if (raw === undefined || raw.trim() === "" || !Number.isFinite(value)) throw new UserError(`"${first} ${op}" needs a number after it.`);
      conditions.push({ kind: "number", field: lower as NumberField, op: op as NumberOp, value });
    } else if ((TEXT_FIELDS as readonly string[]).includes(lower)) {
      const op = next();
      const value = next();
      if (op !== "=" && op !== "!=") throw new UserError(`"${first}" is compared with = or !=.`);
      if (!value) throw new UserError(`"${first} ${op}" needs a value after it.`);
      conditions.push({ kind: "text", field: lower as TextField, op, value: value.toLowerCase() });
    } else if (MOD.test(first) && first === first.toUpperCase()) {
      conditions.push({ kind: "mod", acronym: first, has: true });
    } else {
      throw new UserError(
        `Unknown condition "${first}". Use a mod (HD), mods has/lacks, ${NUMBER_FIELDS.join(", ")}, or ${TEXT_FIELDS.join(", ")}.`,
      );
    }
    const joiner = next();
    if (joiner === undefined) return conditions;
    if (joiner.toLowerCase() !== "and") throw new UserError(`Expected "and" before "${joiner}". (For "or", add another rule.)`);
  }
}

export function matchesRule(conditions: readonly Condition[], facts: RuleFacts): boolean {
  return conditions.every((c) => {
    if (c.kind === "mod") {
      const accepted = MOD_EQUIVALENTS[c.acronym] ?? [c.acronym];
      return accepted.some((acronym) => facts.mods.includes(acronym)) === c.has;
    }
    if (c.kind === "text") return (facts[c.field].toLowerCase() === c.value) === (c.op === "=");
    const value = facts[c.field];
    if (value === null) return false;
    switch (c.op) {
      case "<": return value < c.value;
      case "<=": return value <= c.value;
      case ">": return value > c.value;
      case ">=": return value >= c.value;
      case "=": return Math.abs(value - c.value) < 1e-9;
      case "!=": return Math.abs(value - c.value) >= 1e-9;
    }
  });
}

export function ruleFacts(replay: {
  mods: readonly ScoreMod[];
  accuracy: number;
  max_combo: number;
  countmiss: number;
  devserver: string | null;
  player_name: string;
  rank: string;
  attributes: ReplayAttributes | null;
  /** Official pp of the linked play, preferred over the estimate. */
  score_pp?: number | null;
}): RuleFacts {
  const a = replay.attributes;
  return {
    mods: replay.mods.map((mod) => mod.acronym.toUpperCase()),
    ar: a?.ar ?? null,
    od: a?.od ?? null,
    cs: a?.cs ?? null,
    hp: a?.hp ?? null,
    stars: a?.stars ?? null,
    bpm: a?.bpm ?? null,
    length: a?.length ?? null,
    pp: replay.score_pp ?? a?.pp ?? null,
    accuracy: Math.round(replay.accuracy * 10000) / 100,
    combo: replay.max_combo,
    misses: replay.countmiss,
    rate: a?.clock_rate ?? null,
    server: replay.devserver ?? "official",
    player: replay.player_name,
    rank: RANK_LABEL[replay.rank] ?? replay.rank,
  };
}
