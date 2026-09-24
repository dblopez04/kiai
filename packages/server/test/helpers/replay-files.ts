import { crc32 } from "node:zlib";
import { createHash } from "node:crypto";

export interface OsrOptions {
  rulesetId?: number;
  gameVersion?: number;
  beatmapMd5?: string;
  playerName?: string;
  counts?: [n300: number, n100: number, n50: number, geki: number, katu: number, miss: number];
  totalScore?: number;
  maxCombo?: number;
  perfect?: boolean;
  modBits?: number;
  playedAt?: Date;
  onlineScoreId?: bigint;
  /** Bytes of fake cursor data, so different replays have different files. */
  data?: Buffer;
}

const EPOCH_TICKS = 621_355_968_000_000_000n;

function osuString(value: string): Buffer {
  if (value === "") return Buffer.from([0]);
  const bytes = Buffer.from(value, "utf8");
  const length: number[] = [];
  let n = bytes.length;
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n) byte |= 0x80;
    length.push(byte);
  } while (n);
  return Buffer.concat([Buffer.from([0x0b, ...length]), bytes]);
}

/** A replay file with the given header and fake cursor data. */
export function buildOsr(o: OsrOptions = {}): Buffer {
  const parts: Buffer[] = [];
  const u8 = (n: number) => parts.push(Buffer.from([n]));
  const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); parts.push(b); };
  const i32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32LE(n); parts.push(b); };
  const i64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(n); parts.push(b); };
  u8(o.rulesetId ?? 0);
  i32(o.gameVersion ?? 20240101);
  parts.push(osuString(o.beatmapMd5 ?? "0123456789abcdef0123456789abcdef"));
  parts.push(osuString(o.playerName ?? "tester"));
  parts.push(osuString("fedcba9876543210fedcba9876543210"));
  for (const n of o.counts ?? [400, 10, 1, 50, 5, 0]) u16(n);
  i32(o.totalScore ?? 900_000);
  u16(o.maxCombo ?? 480);
  u8(o.perfect ? 1 : 0);
  i32(o.modBits ?? 0);
  parts.push(osuString("0|1,"));
  i64(BigInt((o.playedAt ?? new Date("2026-09-20T12:00:00Z")).getTime()) * 10_000n + EPOCH_TICKS);
  const data = o.data ?? Buffer.from("fake lzma replay data");
  i32(data.length);
  parts.push(data);
  i64(o.onlineScoreId ?? 0n);
  return Buffer.concat(parts);
}

/** A zip with stored (uncompressed) entries. Names are written as given, even unsafe ones. */
export function buildZip(entries: Record<string, string | Buffer>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = typeof content === "string" ? Buffer.from(content) : content;
    const nameBytes = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBytes.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

export const md5Of = (value: string | Buffer) => createHash("md5").update(value).digest("hex");

/** A minimal .osu file whose metadata (and so MD5) depends on its arguments. */
export function osuText(beatmapId: number, setId: number, version = "Insane"): string {
  return `osu file format v14\n\n[General]\nAudioFilename: audio.mp3\nMode: 0\n\n[Metadata]\nTitle:Song ${setId}\nArtist:Artist ${setId}\nCreator:mapper\nVersion:${version}\nBeatmapID:${beatmapId}\nBeatmapSetID:${setId}\n\n[HitObjects]\n256,192,1000,1,0,0:0:0:0:\n`;
}
