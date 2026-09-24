// The render job queue: rows in `render_jobs`, claimed with a lease token and kept by
// heartbeating, like sync jobs. Unlike sync jobs, several can run at once (one per GPU slot).

import type { Sql } from "../db/index.ts";
import { retryDb } from "../db/index.ts";

export const RENDER_LEASE_TIMEOUT_MS = 5 * 60 * 1000;
/** A job whose worker died this many times is failed instead of claimed again. */
export const MAX_RENDER_ATTEMPTS = 3;

export type RenderStatus = "queued" | "running" | "needs_map" | "success" | "failed";

export interface RenderJob {
  id: number;
  replay_id: string;
  /** Null until the worker picks one with the rules. */
  preset: string | null;
  preset_reason: string | null;
  status: RenderStatus;
  progress: number;
  attempts: number;
  error_text: string | null;
  video_path: string | null;
  video_bytes: number | null;
  video_width: number | null;
  video_height: number | null;
  heartbeat_at: Date | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

const COLUMNS =
  "id, replay_id, preset, preset_reason, status, progress, attempts, error_text, video_path, video_bytes, video_width, video_height, heartbeat_at, created_at, started_at, finished_at";

/**
 * Queue a render of the replay, unless one is already queued, running or waiting for its map.
 * `preset` null lets the rules pick one when the job runs.
 */
export async function enqueueRender(sql: Sql, replayId: string, preset: string | null): Promise<{ job: RenderJob; alreadyQueued: boolean }> {
  const reason = preset === null ? null : "chosen by hand";
  const [created] = await sql<RenderJob[]>`
    insert into render_jobs (replay_id, preset, preset_reason, status) values (${replayId}, ${preset}, ${reason}, 'queued')
    on conflict (replay_id) where status in ('queued', 'running', 'needs_map') do nothing
    returning ${sql.unsafe(COLUMNS)}`;
  if (created) return { job: created, alreadyQueued: false };
  const [active] = await sql<RenderJob[]>`
    select ${sql.unsafe(COLUMNS)} from render_jobs where replay_id = ${replayId} and status in ('queued', 'running', 'needs_map')`;
  if (!active) throw new Error("Could not queue the render: the active one finished while queuing. Try again.");
  // A job waiting for its map is worth another try: the map may have arrived meanwhile.
  if (active.status === "needs_map") {
    await sql`update render_jobs set status = 'queued', error_text = null where id = ${active.id} and status = 'needs_map'`;
    active.status = "queued";
  }
  return { job: active, alreadyQueued: true };
}

/**
 * Claim the oldest queued job. First, running jobs whose heartbeat stopped go back to the queue,
 * or fail once they've been claimed {@link MAX_RENDER_ATTEMPTS} times.
 */
export async function claimRender(sql: Sql, leaseToken: string, leaseTimeoutMs = RENDER_LEASE_TIMEOUT_MS): Promise<RenderJob | null> {
  return sql.begin(async (tx) => {
    await tx`
      update render_jobs set
        status = case when attempts >= ${MAX_RENDER_ATTEMPTS} then 'failed' else 'queued' end,
        error_text = case when attempts >= ${MAX_RENDER_ATTEMPTS}
          then 'The render worker stopped responding ' || attempts || ' times on this replay.' else error_text end,
        finished_at = case when attempts >= ${MAX_RENDER_ATTEMPTS} then now() else null end,
        lease_token = null
      where status = 'running' and heartbeat_at < now() - make_interval(secs => ${leaseTimeoutMs / 1000})`;
    const [claimed] = await tx<RenderJob[]>`
      update render_jobs
      set status = 'running', lease_token = ${leaseToken}, heartbeat_at = now(), started_at = coalesce(started_at, now()),
        attempts = attempts + 1, progress = 0, error_text = null
      where id = (select id from render_jobs where status = 'queued' order by id limit 1 for update skip locked)
      returning ${sql.unsafe(COLUMNS)}`;
    return claimed ?? null;
  });
}

/** Queue again every job that was waiting for one of these maps. Returns how many. */
export async function requeueWaitingFor(sql: Sql, md5s: readonly string[]): Promise<number> {
  if (md5s.length === 0) return 0;
  const rows = await sql`
    update render_jobs j set status = 'queued', error_text = null
    from replays r
    where j.replay_id = r.id and j.status = 'needs_map' and r.beatmap_md5 = any(${[...md5s]}::text[])
    returning j.id`;
  return rows.length;
}

export class RenderLeaseLostError extends Error {
  override name = "RenderLeaseLostError";
  constructor() {
    super("Render lease lost. Another worker will pick the job up.");
  }
}

type RenderUpdate = Partial<{
  status: RenderStatus;
  preset: string;
  preset_reason: string;
  video_width: number;
  video_height: number;
  progress: number;
  attempts: number;
  error_text: string | null;
  video_path: string | null;
  video_bytes: number | null;
  finished_at: Date;
  lease_token: null;
}>;

/** A claimed render. Writes only land while the lease is held. */
export class RenderLease {
  readonly job: RenderJob;
  readonly token: string;
  #sql: Sql;
  #lost = false;
  #heartbeat: NodeJS.Timeout | undefined;
  #onLost: () => void;

  constructor(sql: Sql, job: RenderJob, token: string, onLost: () => void = () => {}) {
    this.#sql = sql;
    this.job = job;
    this.token = token;
    this.#onLost = onLost;
  }

  get lost(): boolean {
    return this.#lost;
  }

  #markLost(): void {
    if (this.#lost) return;
    this.#lost = true;
    this.#onLost();
  }

  async update(fields: RenderUpdate): Promise<void> {
    if (this.#lost) throw new RenderLeaseLostError();
    const sql = this.#sql;
    const updated = await retryDb(() => sql`
      update render_jobs set ${sql({ ...fields })}, heartbeat_at = now()
      where id = ${this.job.id} and lease_token = ${this.token} and status = 'running'
      returning id`);
    if (updated.length === 0) {
      this.#markLost();
      throw new RenderLeaseLostError();
    }
  }

  startHeartbeat(intervalMs = 15_000): void {
    let inFlight = false;
    this.#heartbeat = setInterval(() => {
      if (inFlight || this.#lost) return;
      inFlight = true;
      this.#sql`update render_jobs set heartbeat_at = now() where id = ${this.job.id} and lease_token = ${this.token} and status = 'running' returning id`
        .then((rows) => {
          if (rows.length === 0) this.#markLost();
        })
        .catch(() => {})
        .finally(() => {
          inFlight = false;
        });
    }, intervalMs);
    this.#heartbeat.unref();
  }

  stopHeartbeat(): void {
    clearInterval(this.#heartbeat);
  }
}
