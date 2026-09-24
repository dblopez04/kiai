import { randomUUID } from "node:crypto";
import { connectDb, migrate, type Sql } from "../../src/db/index.ts";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://kiai:kiai@localhost:55432/kiai_test";

export interface TestDb {
  sql: Sql;
  drop(): Promise<void>;
}

/** A freshly migrated, private schema, so test files can run in parallel. */
export async function createTestDb(): Promise<TestDb> {
  const schema = `t_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const admin = connectDb(TEST_DATABASE_URL, { max: 1 });
  await admin`create schema ${admin(schema)}`;
  await admin.end();
  const sql = connectDb(TEST_DATABASE_URL, { searchPath: `${schema}, public`, max: 4 });
  await migrate(sql);
  return {
    sql,
    async drop() {
      await sql.end();
      const cleanup = connectDb(TEST_DATABASE_URL, { max: 1 });
      await cleanup`drop schema ${cleanup(schema)} cascade`;
      await cleanup.end();
    },
  };
}
