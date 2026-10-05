// Clips of rendered replays: queuing them, and the queue the render worker cuts them from. A clip
// waits until its replay's latest render has succeeded, so asking for a clip of an unrendered
// replay renders it first.

import { sqlJson, type Sql } from "../db/index.ts";
import { UserError } from "../errors.ts";
import { enqueueRender } from "../render/queue.ts";
import { newReplayId } from "../replays/store.ts";

/** Longer clips are refused: they take a while to encode and are too big to watch in Discord. */
export const MAX_CLIP_MS = 5 * 60_000;
/** A clip still running after this long was abandoned by its worker. */
export const CLIP_STALE_MS = 15 * 60_000;

export type ClipStatus = "queued" | "running" | "success" | "failed";

/** Where to answer a clip made with the slash command. */
export interface ClipDiscord {
  application_id: string;
  token: string;
  user_id: string;
}

export interface Clip {
  id: string;
  replay_id: string;
  start_ms: number;
  end_ms: number;
  status: ClipStatus;
  error_text: string | null;
  video_path: string | null;
  video_bytes: number | null;
  discord: ClipDiscord | null;
  created_at: Date;
  finished_at: Date | null;
}

const COLUMNS = "id, replay_id, start_ms, end_ms, status, error_text, video_path, video_bytes, discord, created_at, finished_at";
const C_COLUMNS = COLUMNS.split(", ").map((column) => `c.${column}`).join(", ");

/** `83`, `1:23`, `1:23.5` or `1:02:03`, in milliseconds. Null when it isn't a timestamp. */
export function parseTimestamp(text: string): number | null {
  const match = /^(?:(\d+):)?(?:(\d+):)?(\d+(?:\.\d{1,3})?)$/.exec(text.trim());
  if (!match) return null;
  const [, a, b, s] = match;
  const hours = b === undefined ? 0 : Number(a);
  const minutes = b === undefined ? Number(a ?? 0) : Number(b);
  const seconds = Number(s);
  // Below the largest unit, minutes and seconds stay under 60.
  if ((a !== undefined && seconds >= 60) || (b !== undefined && minutes >= 60)) return null;
  return Math.round(((hours * 60 + minutes) * 60 + seconds) * 1000);
}

/** `1:23`, or `1:23.5` when it isn't a whole second. */
export function formatTimestamp(ms: number): string {
  const tenths = Math.round(ms / 100);
  const seconds = Math.floor(tenths / 10);
  const minutes = Math.floor(seconds / 60);
  const fraction = tenths % 10 ? `.${tenths % 10}` : "";
  const ss = String(seconds % 60).padStart(2, "0") + fraction;
  return minutes >= 60 ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${ss}` : `${minutes}:${ss}`;
}

/** Parse a clip's start and end, as typed. Throws a {@link UserError} that says what's wrong. */
export function parseClipRange(start: string, end: string): { startMs: number; endMs: number } {
  const startMs = parseTimestamp(start);
  const endMs = parseTimestamp(end);
  if (startMs === null) throw new UserError(`"${start}" isn't a timestamp. Use seconds or m:ss, like 83 or 1:23.`);
  if (endMs === null) throw new UserError(`"${end}" isn't a timestamp. Use seconds or m:ss, like 83 or 1:23.`);
  if (endMs <= startMs) throw new UserError("The end has to come after the start.");
  if (endMs - startMs > MAX_CLIP_MS) throw new UserError(`Clips can be up to ${formatTimestamp(MAX_CLIP_MS)} long.`);
  return { startMs, endMs };
}

/**
 * Queue a clip. When the replay has no successful render yet, a render is queued too (or the
 * waiting one retried) and `rendering` is true.
 */
export async function createClip(
  sql: Sql,
  input: { replayId: string; startMs: number; endMs: number; discord: ClipDiscord | null },
): Promise<{ clip: Clip; rendering: boolean }> {
  const [latest] = await sql<{ status: string }[]>`
    select status from render_jobs where replay_id = ${input.replayId} order by id desc limit 1`;
  const rendering = latest?.status !== "success";
  if (rendering) await enqueueRender(sql, input.replayId, null);
  const [clip] = await sql<Clip[]>`
    insert into clip_jobs ${sql({
      id: newReplayId(),
      replay_id: input.replayId,
      start_ms: input.startMs,
      end_ms: input.endMs,
      discord: input.discord ? sqlJson(sql, input.discord) : null,
    })}
    returning ${sql.unsafe(COLUMNS)}`;
  return { clip: clip!, rendering };
}

export async function getClip(sql: Sql, id: string): Promise<Clip | null> {
  if (!/^[a-z0-9]{10}$/.test(id)) return null;
  const [clip] = await sql<Clip[]>`select ${sql.unsafe(COLUMNS)} from clip_jobs where id = ${id}`;
  return clip ?? null;
}

/**
 * Fail queued clips that can't be cut: their replay's latest render failed, or a worker died
 * while cutting them. Returns the clips it failed, to answer them.
 */
export async function failStuckClips(sql: Sql, staleMs = CLIP_STALE_MS): Promise<Clip[]> {
  return sql<Clip[]>`
    update clip_jobs c set
      status = 'failed',
      finished_at = now(),
      lease_token = null,
      error_text = case when c.status = 'running' then 'The render worker stopped while cutting this clip.'
        else 'The replay failed to render: ' || coalesce(j.error_text, 'no reason given.') end
    from clip_jobs c0
    left join lateral (select status, error_text from render_jobs where replay_id = c0.replay_id order by id desc limit 1) j on true
    where c.id = c0.id and (
      (c.status = 'queued' and j.status = 'failed')
      or (c.status = 'running' and c.started_at < now() - make_interval(secs => ${staleMs / 1000}))
    )
    returning ${sql.unsafe(C_COLUMNS)}`;
}

/** Claim the oldest queued clip whose replay's latest render succeeded, with that render's video. */
export async function claimClip(sql: Sql, leaseToken: string): Promise<{ clip: Clip; source: string } | null> {
  const [row] = await sql<(Clip & { source: string })[]>`
    with next as (
      select c.id, j.video_path
      from clip_jobs c
      join lateral (select status, video_path from render_jobs where replay_id = c.replay_id order by id desc limit 1) j
        on j.status = 'success'
      where c.status = 'queued'
      order by c.created_at, c.id
      limit 1
      for update of c skip locked
    )
    update clip_jobs c set status = 'running', lease_token = ${leaseToken}, started_at = now()
    from next where c.id = next.id
    returning ${sql.unsafe(C_COLUMNS)}, next.video_path as source`;
  if (!row) return null;
  const { source, ...clip } = row;
  return { clip, source };
}

/**
 * Record a finished clip. `endMs` is where it really ended, earlier than asked when the video is
 * shorter. Null when the lease was lost (the clip was failed as stale meanwhile).
 */
export async function finishClip(sql: Sql, id: string, leaseToken: string, video: { path: string; bytes: number; endMs: number }): Promise<Clip | null> {
  const [clip] = await sql<Clip[]>`
    update clip_jobs set status = 'success', video_path = ${video.path}, video_bytes = ${video.bytes}, end_ms = ${video.endMs},
      finished_at = now(), lease_token = null
    where id = ${id} and lease_token = ${leaseToken} and status = 'running'
    returning ${sql.unsafe(COLUMNS)}`;
  return clip ?? null;
}

/** Put a claimed clip back in the queue, as when the worker shuts down mid-cut. */
export async function releaseClip(sql: Sql, id: string, leaseToken: string): Promise<void> {
  await sql`update clip_jobs set status = 'queued', lease_token = null, started_at = null
    where id = ${id} and lease_token = ${leaseToken} and status = 'running'`;
}

export async function failClip(sql: Sql, id: string, leaseToken: string, error: string): Promise<Clip | null> {
  const [clip] = await sql<Clip[]>`
    update clip_jobs set status = 'failed', error_text = ${error}, finished_at = now(), lease_token = null
    where id = ${id} and lease_token = ${leaseToken} and status = 'running'
    returning ${sql.unsafe(COLUMNS)}`;
  return clip ?? null;
}
