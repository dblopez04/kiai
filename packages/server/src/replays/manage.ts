// Managing uploaded replays from the private app: listing them a page at a time, deleting them or
// just their videos, and clearing out videos that newer renders replaced.

import fs from "node:fs/promises";
import path from "node:path";
import type { Sql } from "../db/index.ts";
import type { MediaPaths } from "../media.ts";
import { listReplaysByIds, replayFile, replaySearchCondition, type ReplayView } from "./store.ts";

/** The latest render's state, as the panel filters on it. */
export const RENDER_FILTERS = ["all", "rendered", "pending", "problem", "none"] as const;
export type RenderFilter = (typeof RENDER_FILTERS)[number];

export interface ReplayListOptions {
  query: string;
  render: RenderFilter;
  page: number;
  pageSize: number;
}

export interface ReplayListPage {
  replays: ReplayView[];
  pagination: { page: number; page_size: number; total_count: number; total_pages: number };
}

const isReplayId = (id: string) => /^[a-z0-9]{10}$/.test(id);

/** Replays matching the search and render state, newest uploads first. */
export async function listReplayPage(sql: Sql, o: ReplayListOptions): Promise<ReplayListPage> {
  const status = {
    all: sql`true`,
    rendered: sql`j.status = 'success'`,
    pending: sql`j.status in ('queued', 'running')`,
    problem: sql`j.status in ('failed', 'needs_map')`,
    none: sql`j.status is null`,
  }[o.render];
  const from = sql`from replays r
    left join beatmaps b on b.id = r.beatmap_id
    left join beatmap_files f on f.md5 = r.beatmap_md5
    left join lateral (select status from render_jobs where replay_id = r.id order by id desc limit 1) j on true
    where ${replaySearchCondition(sql, o.query)} and ${status}`;
  const [rows, [count]] = await Promise.all([
    sql<{ id: string }[]>`select r.id ${from} order by r.uploaded_at desc, r.id limit ${o.pageSize} offset ${(o.page - 1) * o.pageSize}`,
    sql<{ total: number }[]>`select count(*)::int as total ${from}`,
  ]);
  const total = count?.total ?? 0;
  return {
    replays: await listReplaysByIds(sql, rows.map((row) => row.id)),
    pagination: { page: o.page, page_size: o.pageSize, total_count: total, total_pages: Math.ceil(total / o.pageSize) },
  };
}

export interface ReplayStorage {
  replays: number;
  render_bytes: number;
  clip_bytes: number;
  /** Videos of renders a newer successful render replaced: nothing serves them. */
  superseded_videos: number;
  superseded_bytes: number;
}

const SUPERSEDED = `status in ('success', 'failed')
  and exists (select 1 from render_jobs n where n.replay_id = j.replay_id and n.id > j.id and n.status = 'success')`;

export async function replayStorage(sql: Sql): Promise<ReplayStorage> {
  const [row] = await sql<ReplayStorage[]>`select
    (select count(*)::int from replays) as replays,
    (select coalesce(sum(video_bytes), 0)::float8 from render_jobs where video_path is not null) as render_bytes,
    (select coalesce(sum(video_bytes), 0)::float8 from clip_jobs where video_path is not null) as clip_bytes,
    (select count(*)::int from render_jobs j where video_path is not null and ${sql.unsafe(SUPERSEDED)}) as superseded_videos,
    (select coalesce(sum(video_bytes), 0)::float8 from render_jobs j where video_path is not null and ${sql.unsafe(SUPERSEDED)}) as superseded_bytes`;
  return row!;
}

/** Remove a file under DATA_DIR by its stored relative path; anything outside it is left alone. */
async function removeMedia(paths: MediaPaths, relative: string): Promise<void> {
  const file = path.resolve(paths.root, relative);
  if (!file.startsWith(paths.root + path.sep)) return;
  await fs.rm(file, { force: true });
}

/**
 * Delete replays with their .osr, every render and clip, and their videos. A render or clip in
 * progress loses its lease and drops what it made. Returns how many replays were deleted.
 */
export async function deleteReplays(sql: Sql, paths: MediaPaths, ids: readonly string[]): Promise<number> {
  const valid = [...new Set(ids)].filter(isReplayId);
  if (valid.length === 0) return 0;
  const { deleted, videos } = await sql.begin(async (tx) => {
    // Locking the jobs first means a render finishing now either lands before this (and its video
    // is listed here) or finds its job gone.
    const videos = await tx<{ video_path: string | null }[]>`
      select video_path from render_jobs where replay_id = any(${valid}::text[]) for update`;
    const clips = await tx<{ video_path: string | null }[]>`
      select video_path from clip_jobs where replay_id = any(${valid}::text[]) for update`;
    const deleted = await tx<{ id: string }[]>`delete from replays where id = any(${valid}::text[]) returning id`;
    return { deleted: deleted.map((row) => row.id), videos: [...videos, ...clips].flatMap((row) => row.video_path ?? []) };
  });
  await Promise.all([...deleted.map((id) => fs.rm(replayFile(paths, id), { force: true })), ...videos.map((video) => removeMedia(paths, video))]);
  return deleted.length;
}

/**
 * Delete the finished renders of these replays and their videos, keeping the replays (they can be
 * rendered again) and their clips. Renders still queued or running are left alone. Returns how
 * many videos were deleted.
 */
export async function deleteRenderVideos(sql: Sql, paths: MediaPaths, ids: readonly string[]): Promise<number> {
  const valid = [...new Set(ids)].filter(isReplayId);
  if (valid.length === 0) return 0;
  const rows = await sql<{ video_path: string | null }[]>`
    delete from render_jobs where replay_id = any(${valid}::text[]) and status in ('success', 'failed') returning video_path`;
  const videos = rows.flatMap((row) => row.video_path ?? []);
  await Promise.all(videos.map((video) => removeMedia(paths, video)));
  return videos.length;
}

/**
 * Delete renders that a newer successful render of the same replay replaced. Public pages, the
 * gallery and clips only use the latest, so nothing loses its video. Returns the space freed.
 */
export async function pruneSupersededRenders(sql: Sql, paths: MediaPaths): Promise<{ videos: number; bytes: number }> {
  const rows = await sql<{ video_path: string | null; video_bytes: number | null }[]>`
    delete from render_jobs j where ${sql.unsafe(SUPERSEDED)} returning video_path, video_bytes`;
  const videos = rows.filter((row) => row.video_path !== null);
  await Promise.all(videos.map((row) => removeMedia(paths, row.video_path!)));
  return { videos: videos.length, bytes: videos.reduce((sum, row) => sum + Number(row.video_bytes ?? 0), 0) };
}
