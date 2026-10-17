import { and, eq, inArray } from "drizzle-orm";
import { assertTransition, type EscrowStatus } from "@backstop/core";
import type { Db } from "./db/client";
import { escrows, events, jobs, type Escrow, type JobKind } from "./db/schema";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Executor = Db | Tx;

export async function recordEvent(db: Executor, escrowId: string, type: string, data: Record<string, unknown> = {}) {
  await db.insert(events).values({ escrowId, type, data: jsonSafe(data) });
}

/**
 * Move an escrow between statuses only if it is still in one of `from`. Returns the updated row, or
 * null if another actor moved it first. Every successful transition is validated and logged.
 */
export async function transition(
  db: Executor,
  id: string,
  from: readonly EscrowStatus[],
  to: EscrowStatus,
  patch: Partial<Omit<typeof escrows.$inferInsert, "id" | "status">> = {},
  event?: { type: string; data?: Record<string, unknown> },
): Promise<Escrow | null> {
  for (const f of from) assertTransition(f, to);
  const [row] = await db
    .update(escrows)
    .set({ ...patch, status: to, updatedAt: new Date() })
    .where(and(eq(escrows.id, id), inArray(escrows.status, [...from])))
    .returning();
  if (!row) return null;
  if (event) await recordEvent(db, id, event.type, event.data);
  return row;
}

export function dedupeKey(kind: JobKind, subject: string): string {
  return `${kind}:${subject.toLowerCase()}`;
}

/** Queue a job once. Re-enqueueing the same kind for the same subject is a no-op. */
export async function enqueue(
  db: Executor,
  kind: JobKind,
  subject: string,
  options: { escrowId?: string; payload?: Record<string, unknown>; runAt?: Date } = {},
): Promise<boolean> {
  const rows = await db
    .insert(jobs)
    .values({
      kind,
      dedupeKey: dedupeKey(kind, subject),
      escrowId: options.escrowId ?? null,
      payload: jsonSafe(options.payload ?? {}),
      runAt: options.runAt ?? new Date(),
    })
    .onConflictDoNothing({ target: jobs.dedupeKey })
    .returning({ id: jobs.id });
  return rows.length > 0;
}

/** Move a pending job earlier, e.g. when a dispute window is cut short. */
export async function rescheduleJob(db: Executor, kind: JobKind, subject: string, runAt: Date) {
  await db
    .update(jobs)
    .set({ runAt, updatedAt: new Date() })
    .where(and(eq(jobs.dedupeKey, dedupeKey(kind, subject)), eq(jobs.status, "pending")));
}

/** Cancel a pending job, e.g. a release that a dispute has superseded. */
export async function cancelJob(db: Executor, kind: JobKind, subject: string) {
  await db
    .update(jobs)
    .set({ status: "done", lastError: "cancelled", updatedAt: new Date() })
    .where(and(eq(jobs.dedupeKey, dedupeKey(kind, subject)), eq(jobs.status, "pending")));
}

export async function getEscrow(db: Executor, id: string): Promise<Escrow | null> {
  const [row] = await db.select().from(escrows).where(eq(escrows.id, id)).limit(1);
  return row ?? null;
}

function jsonSafe(data: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}
