// Reading the header of an osu! replay (.osr): which map, who, mods and the result. The cursor
// data itself is left to danser. Format: https://osu.ppy.sh/wiki/en/Client/File_formats/osr_(file_format)

import { UserError } from "../errors.ts";
import type { ScoreMod } from "../scores/mods.ts";

export interface ReplayHeader {
  rulesetId: number;
  gameVersion: number;
  beatmapMd5: string;
  playerName: string;
  replayMd5: string;
  count300: number;
  count100: number;
  count50: number;
  countGeki: number;
  countKatu: number;
  countMiss: number;
  totalScore: number;
  maxCombo: number;
  perfect: boolean;
  modBits: number;
  mods: ScoreMod[];
  playedAt: Date;
  /** osu! stable's online score id; 0 when the play wasn't submitted. */
  onlineScoreId: number;
}

// .NET ticks (100 ns since 0001-01-01) at the Unix epoch.
const EPOCH_TICKS = 621_355_968_000_000_000n;
// Replays from before this version store the online score id as a 32-bit integer.
const INT64_SCORE_ID_VERSION = 20140721;
const MD5 = /^[0-9a-f]{32}$/;

class Reader {
  #buffer: Buffer;
  offset = 0;

  constructor(buffer: Buffer) {
    this.#buffer = buffer;
  }

  get remaining(): number {
    return this.#buffer.length - this.offset;
  }

  #need(bytes: number): void {
    if (this.remaining < bytes) throw new UserError("That file isn't an osu! replay (.osr): it ends too early.");
  }

  u8(): number {
    this.#need(1);
    return this.#buffer.readUInt8(this.offset++);
  }

  u16(): number {
    this.#need(2);
    const value = this.#buffer.readUInt16LE(this.offset);
    this.offset += 2;
    return value;
  }

  i32(): number {
    this.#need(4);
    const value = this.#buffer.readInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  i64(): bigint {
    this.#need(8);
    const value = this.#buffer.readBigInt64LE(this.offset);
    this.offset += 8;
    return value;
  }

  skip(bytes: number): void {
    this.#need(bytes);
    this.offset += bytes;
  }

  /** 0x00 for no string, or 0x0b, a ULEB128 byte length and UTF-8. */
  string(): string {
    const marker = this.u8();
    if (marker === 0x00) return "";
    if (marker !== 0x0b) throw new UserError("That file isn't an osu! replay (.osr): a text field is malformed.");
    let length = 0;
    for (let shift = 0; ; shift += 7) {
      const byte = this.u8();
      length += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) break;
      if (shift > 28) throw new UserError("That file isn't an osu! replay (.osr): a text field is too long.");
    }
    this.#need(length);
    const value = this.#buffer.toString("utf8", this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
}

// Stable's mod bits, as lazer acronyms. NC and PF also set DT and SD; those are dropped below.
const LEGACY_MODS: readonly [number, string][] = [
  [1 << 0, "NF"], [1 << 1, "EZ"], [1 << 2, "TD"], [1 << 3, "HD"], [1 << 4, "HR"], [1 << 5, "SD"],
  [1 << 6, "DT"], [1 << 7, "RX"], [1 << 8, "HT"], [1 << 9, "NC"], [1 << 10, "FL"], [1 << 11, "AT"],
  [1 << 12, "SO"], [1 << 13, "AP"], [1 << 14, "PF"], [1 << 20, "FI"], [1 << 21, "RD"], [1 << 22, "CN"],
  [1 << 23, "TP"], [1 << 29, "SV2"], [1 << 30, "MR"],
];

export function legacyMods(bits: number): ScoreMod[] {
  const acronyms = LEGACY_MODS.filter(([bit]) => (bits & bit) !== 0).map(([, acronym]) => acronym);
  return acronyms
    .filter((acronym) => !(acronym === "DT" && acronyms.includes("NC")) && !(acronym === "SD" && acronyms.includes("PF")))
    .map((acronym) => ({ acronym }));
}

/** osu!standard accuracy, 0..1. */
export function replayAccuracy(h: Pick<ReplayHeader, "count300" | "count100" | "count50" | "countMiss">): number {
  const total = h.count300 + h.count100 + h.count50 + h.countMiss;
  return total === 0 ? 0 : (300 * h.count300 + 100 * h.count100 + 50 * h.count50) / (300 * total);
}

/** osu!stable's grade for an osu!standard play: X/XH, S/SH, A, B, C or D. */
export function replayRank(h: Pick<ReplayHeader, "count300" | "count100" | "count50" | "countMiss" | "mods">): string {
  const total = h.count300 + h.count100 + h.count50 + h.countMiss;
  if (total === 0) return "D";
  const silver = h.mods.some((mod) => ["HD", "FL", "FI"].includes(mod.acronym));
  const ratio300 = h.count300 / total;
  const ratio50 = h.count50 / total;
  if (ratio300 === 1) return silver ? "XH" : "X";
  if (ratio300 > 0.9 && ratio50 <= 0.01 && h.countMiss === 0) return silver ? "SH" : "S";
  if ((ratio300 > 0.8 && h.countMiss === 0) || ratio300 > 0.9) return "A";
  if ((ratio300 > 0.7 && h.countMiss === 0) || ratio300 > 0.8) return "B";
  if (ratio300 > 0.6) return "C";
  return "D";
}

/** Parse a replay's header. Throws {@link UserError} for anything that isn't a readable .osr. */
export function parseReplay(buffer: Buffer): ReplayHeader {
  const r = new Reader(buffer);
  const rulesetId = r.u8();
  if (rulesetId > 3) throw new UserError("That file isn't an osu! replay (.osr).");
  const gameVersion = r.i32();
  const beatmapMd5 = r.string().toLowerCase();
  const playerName = r.string();
  const replayMd5 = r.string().toLowerCase();
  if (!MD5.test(beatmapMd5)) throw new UserError("That file isn't an osu! replay (.osr): it names no beatmap.");
  const count300 = r.u16();
  const count100 = r.u16();
  const count50 = r.u16();
  const countGeki = r.u16();
  const countKatu = r.u16();
  const countMiss = r.u16();
  const totalScore = r.i32();
  const maxCombo = r.u16();
  const perfect = r.u8() === 1;
  const modBits = r.i32();
  r.string(); // life bar graph
  const ticks = r.i64();
  const dataLength = r.i32();
  if (dataLength < 0) throw new UserError("That file isn't an osu! replay (.osr): the replay data is malformed.");
  r.skip(dataLength);
  let onlineScoreId = 0n;
  if (gameVersion >= INT64_SCORE_ID_VERSION && r.remaining >= 8) onlineScoreId = r.i64();
  else if (r.remaining >= 4) onlineScoreId = BigInt(r.i32());

  const playedAt = new Date(Number((ticks - EPOCH_TICKS) / 10_000n));
  if (Number.isNaN(playedAt.getTime())) throw new UserError("That file isn't an osu! replay (.osr): its date is invalid.");
  const mods = legacyMods(modBits);
  const counts = { count300, count100, count50, countMiss };
  return {
    rulesetId,
    gameVersion,
    beatmapMd5,
    playerName,
    replayMd5,
    ...counts,
    countGeki,
    countKatu,
    totalScore,
    maxCombo,
    perfect,
    modBits,
    mods,
    playedAt,
    onlineScoreId: onlineScoreId > 0n && onlineScoreId <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(onlineScoreId) : 0,
  };
}
