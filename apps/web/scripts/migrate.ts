/** Apply database migrations once per deploy. Runs as part of `pnpm build`; prefers the unpooled URL. */
import { sql } from "drizzle-orm";
import { openDb } from "../src/server/db/client";

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url || !/^postgres(ql)?:\/\//.test(url)) {
  // Builds without hosted Postgres (CI, local) have nothing to migrate; embedded Postgres migrates itself.
  console.log("migrate: no hosted DATABASE_URL, skipping");
  process.exit(0);
}
async function main() {
  const handle = await openDb(url, { migrate: true });
  const rows = (await handle.db.execute(sql`select table_name from information_schema.tables where table_schema = 'public' order by 1`)) as unknown as Array<{ table_name: string }>;
  console.log("migrated; tables:", rows.map((r) => r.table_name).join(", "));
  await handle.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
