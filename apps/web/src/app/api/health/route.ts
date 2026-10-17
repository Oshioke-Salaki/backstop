import { sql } from "drizzle-orm";
import { getChainContext } from "@/server/chain";
import { getDb } from "@/server/db/client";
import { json, route } from "@/server/http";

/** Liveness plus the two dependencies settlement cannot work without. */
export const GET = route(async () => {
  const checks: Record<string, "ok" | string> = {};
  try {
    const db = await getDb();
    await db.execute(sql`select 1`);
    checks.database = "ok";
  } catch (err) {
    checks.database = (err as Error).message.slice(0, 100);
  }
  try {
    await getChainContext().publicClient.getBlockNumber();
    checks.chain = "ok";
  } catch (err) {
    checks.chain = (err as Error).message.slice(0, 100);
  }
  const ok = Object.values(checks).every((v) => v === "ok");
  return json({ ok, checks }, { status: ok ? 200 : 503 });
});
