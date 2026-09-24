import fs from "node:fs/promises";
import postgres from "postgres";

export type Sql = postgres.Sql;
/** A connection or an open transaction. */
export type Db = postgres.Sql | postgres.TransactionSql;

const INT8_OID = 20;

export interface ConnectOptions {
  /** Used by tests to isolate each file in its own schema. */
  searchPath?: string;
  max?: number;
}

export function connectDb(url: string, options: ConnectOptions = {}): Sql {
  return postgres(url, {
    max: options.max ?? 10,
    onnotice: () => {},
    transform: { undefined: null },
    // osu! ids fit comfortably in a double (score ids are ~10^10), so read bigint as number.
    types: {
      bigint: {
        to: INT8_OID,
        from: [INT8_OID],
        serialize: (value: number) => String(value),
        parse: (value: string) => Number(value),
      },
    },
    ...(options.searchPath ? { connection: { search_path: options.searchPath } } : {}),
  });
}

const MIGRATIONS_DIR = new URL("./migrations/", import.meta.url);
// Arbitrary constant: serializes concurrent `migrate` runs (web and worker starting together).
const MIGRATION_LOCK = 7_301_442;

// Code to run after a migration's SQL, in the same transaction, for data SQL can't work out.
const MIGRATION_HOOKS: Record<string, (tx: Db) => Promise<void>> = {
  "009_ez_multiplier_default.sql": async (tx) => (await import("../matches/store.ts")).recomputeEzMatches(tx),
};

/** Apply every migration in `db/migrations/` that hasn't run yet, in filename order. */
export async function migrate(sql: Sql): Promise<string[]> {
  const files = (await fs.readdir(MIGRATIONS_DIR)).filter((file) => /^\d{3}_[\w-]+\.sql$/.test(file)).sort();
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${MIGRATION_LOCK})`;
    await tx`create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`;
    const applied = new Set((await tx<{ name: string }[]>`select name from schema_migrations`).map((row) => row.name));
    const ran: string[] = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      await tx.unsafe(await fs.readFile(new URL(file, MIGRATIONS_DIR), "utf8"));
      await MIGRATION_HOOKS[file]?.(tx);
      await tx`insert into schema_migrations (name) values (${file})`;
      ran.push(file);
    }
    return ran;
  });
}

export function sqlJson(sql: Pick<Sql, "json">, value: unknown) {
  return sql.json(value as postgres.JSONValue);
}

const TRANSIENT_SQLSTATES = new Set(["40001", "40P01", "53300", "57P01", "57P03"]);
const TRANSIENT_NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "CONNECTION_CLOSED", "CONNECTION_ENDED", "CONNECTION_DESTROYED"]);

/** Serialization failures, deadlocks, restarts and dropped connections: worth another try. */
export function isTransientDbError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== "string") return false;
  return TRANSIENT_SQLSTATES.has(code) || code.startsWith("08") || TRANSIENT_NETWORK_CODES.has(code);
}

/**
 * Retry a database operation on transient failures with exponential backoff.
 * Only for reads and idempotent writes (upserts, `on conflict do nothing` inserts).
 */
export async function retryDb<T>(
  operation: () => Promise<T>,
  assertActive: () => void = () => {},
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    assertActive();
    try {
      return await operation();
    } catch (error) {
      if (!isTransientDbError(error) || attempt >= 4) throw error;
      await wait(1000 * 2 ** attempt);
    }
  }
}
