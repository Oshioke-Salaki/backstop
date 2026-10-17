/** Apply database migrations once, before deploying: `DATABASE_URL=... pnpm migrate`. */
import { sql } from "drizzle-orm";
import { openDb } from "../src/server/db/client";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
async function main() {
  const handle = await openDb(url);
  const rows = (await handle.db.execute(sql`select table_name from information_schema.tables where table_schema = 'public' order by 1`)) as unknown as Array<{ table_name: string }>;
  console.log("migrated; tables:", rows.map((r) => r.table_name).join(", "));
  await handle.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
