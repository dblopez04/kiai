// The match fetch queue. Imported and manually added matches, in-progress matches waiting for a
// refresh, and discovery candidates ("probes") all wait here for the match worker.

import type { Sql } from "../db/index.ts";
import type { MatchRef } from "./import.ts";
import type { MatchSource } from "./normalize.ts";

export type QueueKind = "fetch" | "probe";
export type AddedVia = "import" | "manual" | "discovery";

export const PRIORITY = { requested: 0, refresh: 1, discovery: 2 } as const;

export interface QueueRow {
  source: MatchSource;
  external_id: number;
  kind: QueueKind;
  priority: number;
  added_via: AddedVia;
  name: string | null;
  attempts: number;
  failed: boolean;
  last_error: string | null;
}

export interface EnqueueResult {
  queued: number;
  /** Already saved; not fetched again. */
  known: number;
}

export async function enqueueMatches(
  sql: Sql,
  refs: readonly MatchRef[],
  options: { kind?: QueueKind; addedVia: AddedVia; priority?: number; delayMs?: number; refetch?: boolean },
): Promise<EnqueueResult> {
  if (refs.length === 0) return { queued: 0, known: 0 };
  let pending = [...refs];
  let known = 0;
  if (!options.refetch) {
    const saved = await sql<{ source: MatchSource; external_id: number }[]>`
      select source, external_id from matches
      where (source, external_id) in (select * from unnest(${refs.map((r) => r.source)}::text[], ${refs.map((r) => r.externalId)}::bigint[]))`;
    const savedKeys = new Set(saved.map((r) => `${r.source}:${r.external_id}`));
    pending = refs.filter((r) => !savedKeys.has(`${r.source}:${r.externalId}`));
    known = refs.length - pending.length;
  }
  if (pending.length === 0) return { queued: 0, known };
  const rows = pending.map((r) => ({
    source: r.source,
    external_id: r.externalId,
    kind: options.kind ?? "fetch",
    priority: options.priority ?? PRIORITY.requested,
    added_via: options.addedVia,
    name: r.name ?? null,
    not_before: new Date(Date.now() + (options.delayMs ?? 0)),
  }));
  for (let from = 0; from < rows.length; from += 1000) {
    const chunk = rows.slice(from, from + 1000);
    // A request for a match that's only a discovery probe upgrades it to a fetch.
    await sql`
      insert into match_queue ${sql(chunk, "source", "external_id", "kind", "priority", "added_via", "name", "not_before")}
      on conflict (source, external_id) do update set
        kind = case when excluded.kind = 'fetch' then 'fetch' else match_queue.kind end,
        added_via = case when excluded.kind = 'fetch' and match_queue.kind = 'probe' then excluded.added_via else match_queue.added_via end,
        priority = least(match_queue.priority, excluded.priority),
        name = coalesce(match_queue.name, excluded.name),
        not_before = case when match_queue.failed then excluded.not_before else least(match_queue.not_before, excluded.not_before) end,
        attempts = case when match_queue.failed then 0 else match_queue.attempts end,
        failed = false`;
  }
  return { queued: pending.length, known };
}

/** Take the next due item, hiding it from other workers for ten minutes while it's processed. */
export async function claimQueued(sql: Sql): Promise<QueueRow | null> {
  const [row] = await sql<QueueRow[]>`
    update match_queue q set not_before = now() + interval '10 minutes'
    from (
      select source, external_id from match_queue
      where not failed and not_before <= now()
      order by priority, not_before, created_at
      limit 1 for update skip locked
    ) next
    where q.source = next.source and q.external_id = next.external_id
    returning q.source, q.external_id, q.kind, q.priority, q.added_via, q.name, q.attempts, q.failed, q.last_error`;
  return row ?? null;
}

export async function finishQueued(sql: Sql, row: Pick<QueueRow, "source" | "external_id">): Promise<void> {
  await sql`delete from match_queue where source = ${row.source} and external_id = ${row.external_id}`;
}

export async function rescheduleQueued(
  sql: Sql,
  row: Pick<QueueRow, "source" | "external_id">,
  delayMs: number,
  changes: { kind?: QueueKind; priority?: number } = {},
): Promise<void> {
  await sql`
    update match_queue set not_before = ${new Date(Date.now() + delayMs)}, attempts = 0, last_error = null,
      kind = coalesce(${changes.kind ?? null}, kind), priority = coalesce(${changes.priority ?? null}::int, priority)
    where source = ${row.source} and external_id = ${row.external_id}`;
}

const MAX_ATTEMPTS = 5;

/** Retry later with backoff, or give up for good (`permanent`, or after five attempts). */
export async function failQueued(sql: Sql, row: QueueRow, message: string, permanent = false): Promise<void> {
  const attempts = row.attempts + 1;
  const failed = permanent || attempts >= MAX_ATTEMPTS;
  const delayMs = Math.min(60_000 * 2 ** attempts, 6 * 3600_000);
  await sql`
    update match_queue set attempts = ${attempts}, failed = ${failed}, last_error = ${message},
      not_before = ${new Date(Date.now() + delayMs)}
    where source = ${row.source} and external_id = ${row.external_id}`;
}

export async function retryFailed(sql: Sql): Promise<number> {
  const rows = await sql`update match_queue set failed = false, attempts = 0, not_before = now() where failed returning 1`;
  return rows.length;
}

export async function clearFailed(sql: Sql): Promise<number> {
  const rows = await sql`delete from match_queue where failed returning 1`;
  return rows.length;
}

export interface QueueOverview {
  requested: number;
  refreshing: number;
  probes: number;
  failed: { source: MatchSource; external_id: number; name: string | null; last_error: string | null }[];
  failed_count: number;
}

export async function queueOverview(sql: Sql): Promise<QueueOverview> {
  const [[counts], failed] = await Promise.all([
    sql<{ requested: number; refreshing: number; probes: number; failed: number }[]>`
      select
        count(*) filter (where not failed and kind = 'fetch' and priority <> ${PRIORITY.refresh})::int as requested,
        count(*) filter (where not failed and kind = 'fetch' and priority = ${PRIORITY.refresh})::int as refreshing,
        count(*) filter (where not failed and kind = 'probe')::int as probes,
        count(*) filter (where failed)::int as failed
      from match_queue`,
    sql<QueueOverview["failed"]>`
      select source, external_id, name, last_error from match_queue where failed order by created_at desc limit 20`,
  ]);
  return {
    requested: counts?.requested ?? 0,
    refreshing: counts?.refreshing ?? 0,
    probes: counts?.probes ?? 0,
    failed,
    failed_count: counts?.failed ?? 0,
  };
}
