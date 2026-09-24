// Getting the exact beatmap a replay was played on into danser's Songs directory. A replay names
// its map only by the .osu file's MD5, so every extracted .osu is indexed by MD5 in
// `beatmap_files`. Sources, in order: what's already extracted, a mirror download of the set
// (after asking osu! which set the MD5 belongs to), and an .osz uploaded by the client.

import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import type { Sql } from "../db/index.ts";
import { errorMessage, UserError } from "../errors.ts";
import type { MediaPaths } from "../media.ts";
import type { OsuClient } from "../osu/api.ts";
import { beatmapRow } from "../scores/rows.ts";
import { upsertBeatmaps } from "../scores/store.ts";

const USER_AGENT = "kiai/0.1 (+https://github.com/dblopez04/kiai)";
/** Beatmap sets with video can be large; this is well above any ranked set. */
export const MAX_OSZ_BYTES = 512 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const MIRROR_TIMEOUT_MS = 5 * 60 * 1000;

export type BeatmapSource = "mirror" | "osu" | "upload";

export interface OsuFileInfo {
  md5: string;
  file: string;
  beatmapId: number | null;
  beatmapsetId: number | null;
  artist: string | null;
  title: string | null;
  version: string | null;
  creator: string | null;
}

export const md5 = (data: Buffer | string) => createHash("md5").update(data).digest("hex");

/** The [General]/[Metadata] values kiai shows. Missing ids (unsubmitted maps) come back null. */
export function parseOsuMetadata(text: string): Omit<OsuFileInfo, "md5" | "file"> {
  const values = new Map<string, string>();
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      section = line;
      if (section === "[Events]" || section === "[HitObjects]") break;
      continue;
    }
    if (section !== "[Metadata]") continue;
    const colon = line.indexOf(":");
    if (colon > 0) values.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  const id = (key: string) => {
    const n = Number(values.get(key));
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  };
  return {
    beatmapId: id("BeatmapID"),
    beatmapsetId: id("BeatmapSetID"),
    artist: values.get("Artist") || values.get("ArtistUnicode") || null,
    title: values.get("Title") || values.get("TitleUnicode") || null,
    version: values.get("Version") || null,
    creator: values.get("Creator") || null,
  };
}

/** The .osu files directly inside a beatmap folder, hashed. */
export async function scanFolder(dir: string): Promise<OsuFileInfo[]> {
  const files = (await fs.readdir(dir, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".osu"));
  const out: OsuFileInfo[] = [];
  for (const entry of files) {
    const data = await fs.readFile(path.join(dir, entry.name));
    out.push({ md5: md5(data), file: entry.name, ...parseOsuMetadata(data.toString("utf8")) });
  }
  return out;
}

/**
 * Unpack an .osz into `dest`, which must not exist yet. Rejects paths that escape the folder
 * (yauzl refuses absolute and `..` names) and archives that unpack to more than 2 GB.
 */
export async function extractOsz(oszPath: string, dest: string): Promise<void> {
  let zip: yauzl.ZipFile;
  try {
    zip = await yauzl.openPromise(oszPath, { lazyEntries: true, strictFileNames: false, validateEntrySizes: true });
  } catch (error) {
    throw new UserError(`That isn't a beatmap archive (.osz): ${errorMessage(error)}`);
  }
  try {
    if (zip.entryCount > MAX_ENTRIES) throw new UserError(`That .osz has ${zip.entryCount} files; the limit is ${MAX_ENTRIES}.`);
    await fs.mkdir(dest);
    const root = path.resolve(dest);
    let total = 0;
    for await (const entry of zip.eachEntry()) {
      if (entry.fileName.endsWith("/")) continue;
      total += entry.uncompressedSize;
      if (total > MAX_EXTRACTED_BYTES) throw new UserError("That .osz unpacks to more than 2 GB.");
      const target = path.resolve(root, entry.fileName);
      if (!target.startsWith(root + path.sep)) throw new UserError(`That .osz contains an unsafe path: ${entry.fileName}`);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await pipeline(await zip.openReadStreamPromise(entry), createWriteStream(target, { flags: "wx" }));
    }
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError(`That .osz couldn't be unpacked: ${errorMessage(error)}`);
  } finally {
    zip.close();
  }
}

/** Stream a request or download body to `file`, failing once it passes `limit` bytes. */
export async function writeStreamLimited(body: ReadableStream<Uint8Array> | Readable, file: string, limit: number, what: string): Promise<number> {
  let bytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      if (bytes > limit) done(new UserError(`${what} is larger than ${Math.round(limit / 1024 / 1024)} MB.`));
      else done(null, chunk);
    },
  });
  const source = body instanceof Readable ? body : Readable.fromWeb(body as import("node:stream/web").ReadableStream<Uint8Array>);
  await pipeline(source, counter, createWriteStream(file, { mode: 0o600 }));
  return bytes;
}

/** Run `work` holding a Postgres advisory lock, so two workers never unpack into the same folder. */
async function withLock<T>(sql: Sql, key: string, work: () => Promise<T>): Promise<T> {
  const reserved = await sql.reserve();
  try {
    await reserved`select pg_advisory_lock(hashtextextended(${key}, 0))`;
    try {
      return await work();
    } finally {
      await reserved`select pg_advisory_unlock(hashtextextended(${key}, 0))`;
    }
  } finally {
    reserved.release();
  }
}

/** Record every .osu in a folder, replacing what was recorded for it before. */
async function indexFolder(sql: Sql, folder: string, files: readonly OsuFileInfo[], source: BeatmapSource): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`delete from beatmap_files where folder = ${folder}`;
    if (files.length === 0) return;
    const rows = files.map((f) => ({
      md5: f.md5,
      folder,
      file: f.file,
      beatmap_id: f.beatmapId,
      beatmapset_id: f.beatmapsetId,
      artist: f.artist,
      title: f.title,
      version: f.version,
      creator: f.creator,
      source,
    }));
    const columns = ["md5", "folder", "file", "beatmap_id", "beatmapset_id", "artist", "title", "version", "creator", "source"] as const;
    await tx`insert into beatmap_files ${tx(rows, ...columns)}
      on conflict (md5) do update set folder = excluded.folder, file = excluded.file, beatmap_id = excluded.beatmap_id,
        beatmapset_id = excluded.beatmapset_id, artist = excluded.artist, title = excluded.title,
        version = excluded.version, creator = excluded.creator, source = excluded.source, added_at = now()`;
  });
}

/**
 * Unpack an .osz into `<songs>/<folder>`, replacing that folder, and index its .osu files. With
 * `requireMd5`, the archive is checked before anything is replaced and refused if it lacks that map.
 */
export async function installOsz(
  sql: Sql,
  paths: MediaPaths,
  oszPath: string,
  folder: string,
  source: BeatmapSource,
  requireMd5?: string,
): Promise<OsuFileInfo[]> {
  return withLock(sql, `kiai-songs:${folder}`, async () => {
    const staging = path.join(paths.tmp, `extract-${randomUUID()}`);
    try {
      await extractOsz(oszPath, staging);
      const files = await scanFolder(staging);
      if (files.length === 0) throw new UserError("That .osz contains no .osu files.");
      if (requireMd5 && !files.some((f) => f.md5 === requireMd5)) {
        throw new UserError(`That .osz doesn't contain the difficulty this replay was played on (MD5 ${requireMd5}). Its .osu files may have been edited or updated since.`);
      }
      const target = path.join(paths.songs, folder);
      await fs.rm(target, { recursive: true, force: true });
      await fs.rename(staging, target);
      await indexFolder(sql, folder, files, source);
      return files;
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
  });
}

export interface BeatmapFile {
  md5: string;
  folder: string;
  file: string;
}

/** Where the .osu with this MD5 is, if it's indexed and still on disk. */
export async function findBeatmapFile(sql: Sql, paths: MediaPaths, hash: string): Promise<BeatmapFile | null> {
  const [row] = await sql<BeatmapFile[]>`select md5, folder, file from beatmap_files where md5 = ${hash}`;
  if (!row) return null;
  try {
    await fs.access(path.join(paths.songs, row.folder, row.file));
    return row;
  } catch {
    return null;
  }
}

/** Try each mirror until one returns a zip. Returns the mirror used, or null with the reasons logged. */
export async function downloadFromMirrors(
  mirrors: readonly string[],
  beatmapsetId: number,
  dest: string,
  options: { fetch?: typeof fetch; log?: (message: string) => void } = {},
): Promise<string | null> {
  const doFetch = options.fetch ?? fetch;
  for (const template of mirrors) {
    const url = template.replaceAll("{set}", String(beatmapsetId));
    const host = new URL(url).host;
    try {
      const response = await doFetch(url, { headers: { "User-Agent": USER_AGENT }, redirect: "follow", signal: AbortSignal.timeout(MIRROR_TIMEOUT_MS) });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        options.log?.(`mirror ${host}: HTTP ${response.status}`);
        continue;
      }
      await writeStreamLimited(response.body, dest, MAX_OSZ_BYTES, "The download");
      const handle = await fs.open(dest);
      const magic = Buffer.alloc(4);
      await handle.read(magic, 0, 4, 0);
      await handle.close();
      if (magic.toString("latin1") !== "PK\x03\x04") {
        options.log?.(`mirror ${host}: not a zip file`);
        continue;
      }
      return host;
    } catch (error) {
      options.log?.(`mirror ${host}: ${errorMessage(error)}`);
    }
  }
  return null;
}

export interface MapContext {
  sql: Sql;
  /** Null without osu! credentials: only already-extracted maps can be used. */
  osu: OsuClient | null;
  paths: MediaPaths;
  mirrors: readonly string[];
  fetch?: typeof fetch;
  log?: (message: string) => void;
}

export type MapResult = { ok: true; file: BeatmapFile; beatmapId: number | null } | { ok: false; reason: string; beatmapId: number | null };

/**
 * Make the beatmap with this MD5 available in the Songs directory. `beatmapId` is what's already
 * known about it (from an earlier lookup); otherwise osu! is asked, and the beatmap row saved.
 */
export async function ensureBeatmap(ctx: MapContext, hash: string, knownBeatmapId: number | null): Promise<MapResult> {
  const { sql, paths } = ctx;
  const log = ctx.log ?? (() => {});
  const existing = await findBeatmapFile(sql, paths, hash);
  if (existing) return { ok: true, file: existing, beatmapId: knownBeatmapId };

  let beatmapId = knownBeatmapId;
  let setId: number | null = null;
  if (beatmapId !== null) {
    const [row] = await sql<{ beatmapset_id: number }[]>`select beatmapset_id from beatmaps where id = ${beatmapId}`;
    setId = row?.beatmapset_id ?? null;
  }
  if (setId === null) {
    if (!ctx.osu) return { ok: false, reason: "Looking up maps needs OSU_CLIENT_ID and OSU_CLIENT_SECRET.", beatmapId };
    const found = await ctx.osu.lookupBeatmap(hash);
    const row = beatmapRow(found ?? undefined);
    if (!row) {
      return {
        ok: false,
        reason: "osu! doesn't know this version of the map (unsubmitted, edited, or updated since the play). Upload the .osz it was played on.",
        beatmapId,
      };
    }
    await upsertBeatmaps(sql, [row]);
    beatmapId = row.id;
    setId = row.beatmapset_id;
  }

  const folder = String(setId);
  const resolvedId = beatmapId;
  return withLock(sql, `kiai-download:${folder}`, async (): Promise<MapResult> => {
    // Another worker may have fetched this set while we waited for the lock.
    const raced = await findBeatmapFile(sql, paths, hash);
    if (raced) return { ok: true, file: raced, beatmapId: resolvedId };

    const download = path.join(paths.tmp, `set-${setId}-${randomUUID()}.osz`);
    try {
      const mirror = await downloadFromMirrors(ctx.mirrors, setId, download, { log, ...(ctx.fetch ? { fetch: ctx.fetch } : {}) });
      if (!mirror) return { ok: false, reason: `No mirror had beatmap set ${setId}. Upload its .osz.`, beatmapId: resolvedId };
      log(`downloaded beatmap set ${setId} from ${mirror}`);
      const files = await installOsz(sql, paths, download, folder, "mirror");
      if (!files.some((f) => f.md5 === hash)) {
        // Mirrors can lag behind map updates. osu! serves the current .osu, which is the one that matched.
        const text = resolvedId !== null && ctx.osu ? await ctx.osu.getBeatmapFile(resolvedId) : null;
        if (text === null || md5(text) !== hash) {
          return { ok: false, reason: `The mirror's copy of set ${setId} is a different version of the map. Upload the .osz it was played on.`, beatmapId: resolvedId };
        }
        const file = `kiai-${resolvedId}-${hash.slice(0, 8)}.osu`;
        await fs.writeFile(path.join(paths.songs, folder, file), text);
        await indexFolder(sql, folder, await scanFolder(path.join(paths.songs, folder)), "osu");
        log(`used osu!'s current .osu for beatmap ${resolvedId}; the mirror's was outdated`);
      }
      const ready = await findBeatmapFile(sql, paths, hash);
      return ready ? { ok: true, file: ready, beatmapId: resolvedId } : { ok: false, reason: "The beatmap was downloaded but couldn't be indexed.", beatmapId: resolvedId };
    } finally {
      await fs.rm(download, { force: true });
    }
  });
}
