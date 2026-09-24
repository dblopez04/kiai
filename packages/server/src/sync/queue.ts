// The sync job queue. Jobs are rows in `sync_runs`; a worker claims one with a lease token and
// keeps it by heartbeating. Only one job runs at a time across all workers, because every job
// spends the same osu! API rate limit.

import type { Sql } from "../db/index.ts";
import { retryDb, sqlJson } from "../db/index.ts";
import { UserError } from "../errors.ts";
import { parseCheckpoint, type SyncCheckpoint, type SyncMode, type SyncStatus, type SyncTrigger } from "./checkpoint.ts";

export const LEASE_TIMEOUT_MS = 5 * 60 * 1000;
const CLAIM_LOCK = 89_345_231;

export interface SyncRun {
  id: number;
  user_id: number;
  mode: SyncMode;
  trigger: SyncTrigger;
  status: SyncStatus;
  checkpoint: SyncCheckpoint;
  recent_window_hours: number;
  scores_added: number;
  scores_skipped: number;
  beatmaps_upserted: number;
  error_text: string | null;
  csv_path: string | null;
  heartbeat_at: Date | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

type RunRow = Omit<SyncRun, "checkpoint"> & { checkpoint: unknown };
const toRun = (row: RunRow): SyncRun => ({ ...row, checkpoint: parseCheckpoint(row.checkpoint) });

// These modes can resume from where a failed attempt stopped.
const RESUMABLE: readonly SyncMode[] = ["history", "refresh", "reset"];

export interface EnqueueResult {
  runId: number;
  /** A job for this user was already queued or running; nothing new was queued. */
  alreadyQueued: boolean;
}

export async function enqueueSync(
  sql: Sql,
  params: { userId: number; mode: SyncMode; trigger: SyncTrigger; recentWindowHours: number },
): Promise<EnqueueResult> {
  const [user] = await sql`select id from osu_users where id = ${params.userId}`;
  if (!user) throw new UserError(`osu! user ${params.userId} isn't in the database.`);

  const [previous] = await sql<{ status: SyncStatus; checkpoint: unknown }[]>`
    select status, checkpoint from sync_runs
    where user_id = ${params.userId} and mode = ${params.mode}
    order by id desc limit 1`;
  const checkpoint = RESUMABLE.includes(params.mode) && previous?.status === "failed" ? parseCheckpoint(previous.checkpoint) : {};

  const [created] = await sql<{ id: number }[]>`
    insert into sync_runs (user_id, mode, trigger, status, recent_window_hours, checkpoint)
    values (${params.userId}, ${params.mode}, ${params.trigger}, 'queued', ${params.recentWindowHours}, ${sqlJson(sql, checkpoint)})
    on conflict (user_id) where status in ('queued', 'running') do nothing
    returning id`;
  if (created) return { runId: created.id, alreadyQueued: false };

  const [active] = await sql<{ id: number }[]>`
    select id from sync_runs where user_id = ${params.userId} and status in ('queued', 'running')`;
  if (!active) throw new Error("Could not queue the sync: the active job finished while queuing. Try again.");
  return { runId: active.id, alreadyQueued: true };
}

/**
 * Queue a recent sync for the player unless one (or a history import) was queued within
 * `intervalHours`, or a job is already active. Returns whether one was queued.
 */
export async function scheduleRecentSync(sql: Sql, userId: number, intervalHours: number, recentWindowHours: number): Promise<boolean> {
  const queued = await sql`
    insert into sync_runs (user_id, mode, trigger, status, recent_window_hours)
    select ${userId}, 'recent', 'schedule', 'queued', ${recentWindowHours}
    where not exists (
      select 1 from sync_runs r
      where r.user_id = ${userId} and r.mode in ('recent', 'history')
        and r.created_at > now() - make_interval(secs => ${intervalHours * 3600})
    )
    on conflict (user_id) where status in ('queued', 'running') do nothing
    returning id`;
  return queued.length > 0;
}

/**
 * Claim the oldest queued job, unless another worker's job is still alive. A running job whose
 * heartbeat is older than {@link LEASE_TIMEOUT_MS} is assumed dead and re-queued first.
 */
export async function claimNextRun(sql: Sql, leaseToken: string, leaseTimeoutMs = LEASE_TIMEOUT_MS): Promise<SyncRun | null> {
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${CLAIM_LOCK})`;
    const [alive] = await tx`
      select id from sync_runs
      where status = 'running' and heartbeat_at > now() - make_interval(secs => ${leaseTimeoutMs / 1000})`;
    if (alive) return null;
    await tx`update sync_runs set status = 'queued', lease_token = null where status = 'running'`;
    const [claimed] = await tx<RunRow[]>`
      update sync_runs
      set status = 'running', lease_token = ${leaseToken}, heartbeat_at = now(), started_at = coalesce(started_at, now())
      where id = (select id from sync_runs where status = 'queued' order by id limit 1 for update skip locked)
      returning *`;
    return claimed ? toRun(claimed) : null;
  });
}

export class LeaseLostError extends Error {
  override name = "LeaseLostError";
  constructor() {
    super("Worker lease lost. The job will resume on another worker.");
  }
}

type RunUpdate = Partial<{
  status: SyncStatus;
  checkpoint: SyncCheckpoint;
  scores_added: number;
  scores_skipped: number;
  beatmaps_upserted: number;
  error_text: string | null;
  csv_path: string | null;
  finished_at: Date;
  lease_token: null;
}>;

/**
 * A claimed job. Every write is conditional on still holding the lease, so a worker that was
 * presumed dead can't overwrite progress made by the worker that took over.
 */
export class RunLease {
  readonly run: SyncRun;
  readonly token: string;
  #sql: Sql;
  #lost = false;
  #heartbeat: NodeJS.Timeout | undefined;

  constructor(sql: Sql, run: SyncRun, token: string) {
    this.#sql = sql;
    this.run = run;
    this.token = token;
  }

  get lost(): boolean {
    return this.#lost;
  }

  assertHeld(): void {
    if (this.#lost) throw new LeaseLostError();
  }

  async update(fields: RunUpdate): Promise<void> {
    this.assertHeld();
    const sql = this.#sql;
    const values: Record<string, unknown> = { ...fields };
    if (fields.checkpoint) values.checkpoint = sqlJson(sql, fields.checkpoint);
    const updated = await retryDb(
      () => sql`
        update sync_runs set ${sql(values)}, heartbeat_at = now()
        where id = ${this.run.id} and lease_token = ${this.token} and status = 'running'
        returning id`,
      () => this.assertHeld(),
    );
    if (updated.length === 0) {
      this.#lost = true;
      throw new LeaseLostError();
    }
  }

  startHeartbeat(intervalMs = 15_000): void {
    let inFlight = false;
    this.#heartbeat = setInterval(() => {
      if (inFlight || this.#lost) return;
      inFlight = true;
      this.update({})
        .catch(() => {
          this.#lost = true;
        })
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

/**
 * Archive every score of the job's user into `score_archives`, then delete them, in one
 * transaction and at most once per job. Requires a live lease on a running reset job.
 */
export async function resetLibrary(sql: Sql, lease: RunLease): Promise<void> {
  await sql.begin(async (tx) => {
    const [job] = await tx<{ user_id: number; checkpoint: unknown }[]>`
      select user_id, checkpoint from sync_runs
      where id = ${lease.run.id} and mode = 'reset' and status = 'running' and lease_token = ${lease.token}
        and heartbeat_at > now() - make_interval(secs => ${LEASE_TIMEOUT_MS / 1000})
      for update`;
    if (!job) throw new LeaseLostError();
    if (parseCheckpoint(job.checkpoint).resetComplete) return;
    await tx`
      insert into score_archives (user_id, run_id, scores)
      select ${job.user_id}, ${lease.run.id}, coalesce(jsonb_agg(to_jsonb(s) order by s.id), '[]'::jsonb)
      from scores s where s.user_id = ${job.user_id}`;
    await tx`delete from scores where user_id = ${job.user_id}`;
    await tx`update sync_runs set checkpoint = ${sqlJson(tx, { resetComplete: true })}, heartbeat_at = now() where id = ${lease.run.id}`;
  });
}

export interface SyncOverview {
  runs: SyncRun[];
  total_scores: number;
  last_success: Date | null;
}

export async function syncOverview(sql: Sql, userId: number): Promise<SyncOverview> {
  const [runs, [count], [success]] = await Promise.all([
    sql<RunRow[]>`select * from sync_runs where user_id = ${userId} order by id desc limit 5`,
    sql<{ total: number }[]>`select count(*)::int as total from scores where user_id = ${userId}`,
    sql<{ finished_at: Date }[]>`
      select finished_at from sync_runs where user_id = ${userId} and status = 'success' order by id desc limit 1`,
  ]);
  return { runs: runs.map(toRun), total_scores: count?.total ?? 0, last_success: success?.finished_at ?? null };
}
