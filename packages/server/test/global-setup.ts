import { connectDb } from "../src/db/index.ts";
import { TEST_DATABASE_URL } from "./helpers/db.ts";

export default async function setup(): Promise<void> {
  const sql = connectDb(TEST_DATABASE_URL, { max: 1 });
  try {
    // Extensions are per database; create it once here so parallel test files don't race.
    await sql`create extension if not exists pg_trgm`;
  } catch (error) {
    throw new Error(
      `Server tests need PostgreSQL at ${TEST_DATABASE_URL} (override with TEST_DATABASE_URL).\n` +
        `Start one with: npm run db:up\n${(error as Error).message}`,
    );
  } finally {
    await sql.end();
  }
}
