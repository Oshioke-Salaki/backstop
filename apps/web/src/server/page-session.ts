import { cookies } from "next/headers";
import { connection } from "next/server";
import { SESSION_COOKIE, sessionFromToken, type Session } from "./auth";

/**
 * Session for Server Components. With partial prefetching, reading cookies alone does not end
 * prerendering, and the expiry check needs the clock, so wait for the real request first.
 * Render callers inside Suspense.
 */
export async function pageSession(): Promise<Session | null> {
  await connection();
  const store = await cookies();
  return sessionFromToken(store.get(SESSION_COOKIE)?.value);
}
