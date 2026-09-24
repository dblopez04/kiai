// Uploaded replays: saving them, reading them back with their latest render, and linking each to
// its play in the score library.

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { sqlJson, type Sql } from "../db/index.ts";
import { UserError } from "../errors.ts";
import type { MediaPaths } from "../media.ts";
import { normalizeMods, type ScoreMod } from "../scores/mods.ts";
import { parseReplay, replayAccuracy, replayRank } from "./osr.ts";

// No 0/1/l/o, so ids read back unambiguously.
const ID_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

/** 10 random characters: ~50 bits, so public replay links can't be guessed. */
export function newReplayId(): string {
  return [...randomBytes(10)].map((byte) => ID_ALPHABET[byte & 31]).join("");
}

export const replayFile = (paths: MediaPaths, id: string) => path.join(paths.replays, `${id}.osr`);

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;
const OFFICIAL = new Set(["", "official", "bancho", "osu.ppy.sh", "ppy.sh"]);

/** The server a play was set on, as `osu-wine --devserver` takes it. Null for the official servers. */
export function normalizeDevserver(value: string | null | undefined): string | null {
  const host = (value ?? "").trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/\/+$/, "");
  if (OFFICIAL.has(host)) return null;
  if (!HOST.test(host)) throw new UserError(`"${value}" isn't a server hostname such as gatari.pw.`);
  return host;
}

export interface SavedReplay {
  id: string;
  created: boolean;
}

/**
 * Store an uploaded .osr. The same file uploaded again returns the existing replay. Only
 * osu!standard replays are accepted, since danser renders nothing else.
 */
export async function saveReplay(sql: Sql, paths: MediaPaths, data: Buffer, devserver: string | null): Promise<SavedReplay> {
  const header = parseReplay(data);
  if (header.rulesetId !== 0) throw new UserError("Only osu!standard replays can be rendered: danser doesn't play taiko, catch or mania.");
  const sha256 = createHash("sha256").update(data).digest("hex");
  const [existing] = await sql<{ id: string }[]>`select id from replays where file_sha256 = ${sha256}`;
  if (existing) return { id: existing.id, created: false };

  const id = newReplayId();
  const tmp = path.join(paths.tmp, `${id}.osr`);
  await fs.writeFile(tmp, data, { mode: 0o600 });
  await fs.rename(tmp, replayFile(paths, id));

  const [known] = await sql<{ beatmap_id: number }[]>`
    select beatmap_id from replays where beatmap_md5 = ${header.beatmapMd5} and beatmap_id is not null limit 1`;
  const [inserted] = await sql<{ id: string }[]>`
    insert into replays ${sql({
      id,
      file_sha256: sha256,
      devserver,
      ruleset_id: header.rulesetId,
      game_version: header.gameVersion,
      beatmap_md5: header.beatmapMd5,
      beatmap_id: known?.beatmap_id ?? null,
      player_name: header.playerName,
      count300: header.count300,
      count100: header.count100,
      count50: header.count50,
      count_geki: header.countGeki,
      count_katu: header.countKatu,
      countmiss: header.countMiss,
      total_score: header.totalScore,
      max_combo: header.maxCombo,
      perfect: header.perfect,
      mods: sqlJson(sql, header.mods),
      accuracy: replayAccuracy(header),
      rank: replayRank(header),
      played_at: header.playedAt,
      online_score_id: header.onlineScoreId,
    })}
    on conflict (file_sha256) do nothing
    returning id`;
  if (inserted) return { id, created: true };
  // A concurrent upload of the same file won the race.
  await fs.rm(replayFile(paths, id), { force: true });
  const [winner] = await sql<{ id: string }[]>`select id from replays where file_sha256 = ${sha256}`;
  return { id: winner!.id, created: false };
}

/**
 * Link unlinked replays to the player's plays in the score library: by stable's online score id,
 * or else by the same map, player name, combo, hit counts and score. Only replays from the
 * official servers, since the library only has those. Returns how many were linked.
 */
export async function linkReplays(sql: Sql, userId: number): Promise<number> {
  const linked = await sql`
    with player as (select lower(username) as name from osu_users where id = ${userId}),
    matches as (
      select distinct on (r.id) r.id as replay_id, s.id as score_id
      from replays r
      join scores s on s.user_id = ${userId} and (
        (r.online_score_id > 0 and s.legacy_score_id = r.online_score_id)
        or (s.beatmap_id = r.beatmap_id
          and lower(r.player_name) = (select name from player)
          and s.max_combo = r.max_combo and s.count300 = r.count300 and s.count100 = r.count100
          and s.count50 = r.count50 and s.countmiss = r.countmiss
          and r.total_score in (s.total_score, s.legacy_total_score))
      )
      where r.score_id is null and r.devserver is null
      order by r.id, (r.online_score_id > 0 and s.legacy_score_id = r.online_score_id) desc, s.id
    )
    update replays r set score_id = m.score_id from matches m where r.id = m.replay_id
    returning r.id`;
  return linked.length;
}

export interface RenderView {
  id: number;
  preset: string;
  status: "queued" | "running" | "needs_map" | "success" | "failed";
  progress: number;
  attempts: number;
  error: string | null;
  created_at: string;
  finished_at: string | null;
  /** Private-network link to the video, once rendered. */
  video_url: string | null;
  video_bytes: number | null;
}

export interface ReplayView {
  id: string;
  devserver: string | null;
  player_name: string;
  beatmap_md5: string;
  beatmap: {
    id: number | null;
    beatmapset_id: number | null;
    artist: string | null;
    title: string | null;
    version: string | null;
    creator: string | null;
    difficulty_rating: number | null;
    cover_url: string | null;
  } | null;
  mods: ScoreMod[];
  accuracy: number;
  rank: string;
  total_score: number;
  max_combo: number;
  perfect: boolean;
  count300: number;
  count100: number;
  count50: number;
  countmiss: number;
  played_at: string;
  uploaded_at: string;
  online_score_id: number | null;
  /** The matching play in the score library. */
  score_id: number | null;
  render: RenderView | null;
}

const iso = (value: unknown) => (value === null || value === undefined ? null : new Date(value as string).toISOString());

type Row = Record<string, unknown>;

function toReplayView(row: Row): ReplayView {
  const b = row.beatmap as Row | null;
  const f = row.beatmap_file as Row | null;
  const setId = (b?.beatmapset_id ?? f?.beatmapset_id ?? null) as number | null;
  const job = row.render as Row | null;
  const beatmap = b || f
    ? {
        id: ((b?.id ?? f?.beatmap_id) as number | null) ?? null,
        beatmapset_id: setId,
        artist: ((b?.artist ?? f?.artist) as string | null) ?? null,
        title: ((b?.title ?? f?.title) as string | null) ?? null,
        version: ((b?.version ?? f?.version) as string | null) ?? null,
        creator: ((b?.creator ?? f?.creator) as string | null) ?? null,
        difficulty_rating: (b?.difficulty_rating as number | null) ?? null,
        cover_url: setId ? `https://assets.ppy.sh/beatmaps/${setId}/covers/cover.jpg` : null,
      }
    : null;
  return {
    id: row.id as string,
    devserver: row.devserver as string | null,
    player_name: row.player_name as string,
    beatmap_md5: row.beatmap_md5 as string,
    beatmap,
    mods: normalizeMods(row.mods),
    accuracy: row.accuracy as number,
    rank: row.rank as string,
    total_score: row.total_score as number,
    max_combo: row.max_combo as number,
    perfect: row.perfect as boolean,
    count300: row.count300 as number,
    count100: row.count100 as number,
    count50: row.count50 as number,
    countmiss: row.countmiss as number,
    played_at: iso(row.played_at)!,
    uploaded_at: iso(row.uploaded_at)!,
    online_score_id: (row.online_score_id as number) || null,
    score_id: row.score_id as number | null,
    render: job
      ? {
          id: job.id as number,
          preset: job.preset as string,
          status: job.status as RenderView["status"],
          progress: job.progress as number,
          attempts: job.attempts as number,
          error: job.error_text as string | null,
          created_at: iso(job.created_at)!,
          finished_at: iso(job.finished_at),
          video_url: job.status === "success" ? `/replays/${row.id as string}/video` : null,
          video_bytes: job.video_bytes as number | null,
        }
      : null,
  };
}

const SELECT = `
  select r.*, to_jsonb(b) as beatmap, to_jsonb(f) as beatmap_file, to_jsonb(j) as render
  from replays r
  left join beatmaps b on b.id = r.beatmap_id
  left join beatmap_files f on f.md5 = r.beatmap_md5
  left join lateral (select * from render_jobs where replay_id = r.id order by id desc limit 1) j on true`;

export async function getReplay(sql: Sql, id: string): Promise<ReplayView | null> {
  if (!/^[a-z0-9]{10}$/.test(id)) return null;
  const [row] = await sql`${sql.unsafe(SELECT)} where r.id = ${id}`;
  return row ? toReplayView(row) : null;
}

/** Newest uploads first. */
export async function listReplays(sql: Sql, limit = 50): Promise<ReplayView[]> {
  const rows = await sql`${sql.unsafe(SELECT)} order by r.uploaded_at desc, r.id limit ${limit}`;
  return rows.map(toReplayView);
}
