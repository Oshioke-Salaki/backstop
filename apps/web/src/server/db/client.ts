import { mkdirSync } from "node:fs";
import path from "node:path";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

interface DbHandle {
  db: Db;
  close: () => Promise<void>;
}

const MIGRATIONS = path.join(process.cwd(), "drizzle");

/**
 * Postgres when DATABASE_URL is set; otherwise embedded Postgres (PGlite) on disk, or in memory for tests.
 * Both run the same migrations, so behaviour (locking, constraints, SQL) is identical.
 */
export async function openDb(url = process.env.DATABASE_URL): Promise<DbHandle> {
  if (url && /^postgres(ql)?:\/\//.test(url)) {
    const { default: postgres } = await import("postgres");
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    const sql = postgres(url, { max: Number(process.env.DATABASE_POOL_SIZE ?? 10), prepare: false });
    const db = drizzle(sql, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS });
    return { db: db as unknown as Db, close: () => sql.end() };
  }

  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const dataDir = url === "memory://" ? undefined : (url?.replace(/^file:\/\//, "") ?? path.join(process.cwd(), ".data", "pglite"));
  if (dataDir) mkdirSync(dataDir, { recursive: true });
  const client = dataDir ? new PGlite(dataDir) : new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  return { db: db as unknown as Db, close: () => client.close() };
}

const globalForDb = globalThis as unknown as { __backstopDb?: Promise<DbHandle> };

/** Process-wide connection, reused across hot reloads in development. */
export function getDb(): Promise<Db> {
  globalForDb.__backstopDb ??= openDb();
  return globalForDb.__backstopDb.then((h) => h.db);
}

/** Tests swap in their own database. */
export function setDbForTesting(handle: Promise<DbHandle> | undefined): void {
  globalForDb.__backstopDb = handle;
}
