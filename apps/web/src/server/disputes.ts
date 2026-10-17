import { and, count, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { DISPUTE_REASONS, type DisputeReason } from "@backstop/core";
import { getConfig } from "./config";
import { getDb } from "./db/client";
import { disputes, escrows, jobs, services, type Dispute } from "./db/schema";
import { cancelJob, dedupeKey, enqueue, getEscrow, recordEvent, transition } from "./escrow-store";
import { ApiError } from "./http";
import { settleSoon } from "./worker";

export const openDisputeInput = z
  .object({
    reason: z.enum(Object.keys(DISPUTE_REASONS) as [DisputeReason, ...DisputeReason[]]),
    statement: z
      .string()
      .trim()
      .min(20, "Explain what went wrong in at least 20 characters.")
      .max(2000, "Keep it under 2000 characters."),
  })
  .strict();

export const respondInput = z
  .object({ statement: z.string().trim().min(10, "Add a short explanation.").max(2000, "Keep it under 2000 characters.") })
  .strict();

export const resolveInput = z
  .discriminatedUnion("decision", [
    z.object({ decision: z.literal("release"), note: z.string().trim().min(5).max(1000) }).strict(),
    z.object({ decision: z.literal("refund"), note: z.string().trim().min(5).max(1000) }).strict(),
    z
      .object({
        decision: z.literal("split"),
        payerAmount: z.string().regex(/^(0|[1-9]\d{0,30})$/, "Enter base units as a whole number."),
        note: z.string().trim().min(5).max(1000),
      })
      .strict(),
  ]);

function maybeKick() {
  settleSoon(true);
}

async function openDisputeFor(escrowId: string): Promise<Dispute | null> {
  const db = await getDb();
  const [d] = await db.select().from(disputes).where(and(eq(disputes.escrowId, escrowId), eq(disputes.status, "open"))).limit(1);
  return d ?? null;
}

/** The payer contests a delivery during its dispute window. Holds the funds and extends the on-chain deadline. */
export async function openDispute(escrowId: string, openedBy: string, input: z.infer<typeof openDisputeInput>): Promise<Dispute> {
  const config = getConfig();
  const db = await getDb();
  const escrow = await getEscrow(db, escrowId);
  if (!escrow) throw new ApiError(404, "not_found", "Payment not found.");

  if (escrow.status === "disputed") throw new ApiError(409, "already_disputed", "This payment is already in dispute.");
  if (escrow.status === "refund_pending" || escrow.status === "refunded" || escrow.status === "reclaimed") {
    throw new ApiError(409, "already_refunded", "This payment is already being refunded in full.");
  }
  if (escrow.status !== "release_pending") throw new ApiError(409, "not_disputable", "This payment can no longer be disputed.");
  if (!escrow.releaseAt || escrow.releaseAt <= new Date()) {
    throw new ApiError(409, "window_closed", "The dispute window for this payment has closed.");
  }

  const [running] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.dedupeKey, dedupeKey("release", escrowId)), eq(jobs.status, "running")))
    .limit(1);
  if (running) throw new ApiError(409, "releasing", "This payment is being released right now and can no longer be disputed.");

  const [{ n }] = (await db
    .select({ n: count() })
    .from(disputes)
    .innerJoin(escrows, eq(disputes.escrowId, escrows.id))
    .where(and(eq(escrows.payer, escrow.payer), eq(disputes.status, "open")))) as [{ n: number }];
  if (n >= config.MAX_OPEN_DISPUTES_PER_PAYER) {
    throw new ApiError(429, "too_many_disputes", `A wallet can have ${config.MAX_OPEN_DISPUTES_PER_PAYER} open disputes at a time.`);
  }

  const now = Date.now();
  const dispute = await db.transaction(async (tx) => {
    const moved = await transition(tx, escrowId, ["release_pending"], "disputed", {}, { type: "dispute_opened", data: { reason: input.reason, by: openedBy } });
    if (!moved) throw new ApiError(409, "not_disputable", "This payment changed while you were filing. Refresh and try again.");
    const [row] = await tx
      .insert(disputes)
      .values({
        escrowId,
        reason: input.reason,
        payerStatement: input.statement,
        respondBy: new Date(now + config.DISPUTE_RESPONSE_SECONDS * 1000),
      })
      .returning();
    await cancelJob(tx, "release", escrowId);
    await enqueue(tx, "extend", escrowId, {
      escrowId,
      payload: { deadline: Math.floor(now / 1000) + config.DISPUTE_REVIEW_SECONDS },
    });
    return row!;
  });
  maybeKick();
  return dispute;
}

/** The provider answers a dispute. They can edit the answer until it is resolved. */
export async function respondToDispute(escrowId: string, providerId: string, input: z.infer<typeof respondInput>) {
  const db = await getDb();
  await assertProviderOwns(escrowId, providerId);
  const dispute = await openDisputeFor(escrowId);
  if (!dispute) throw new ApiError(409, "not_open", "There is no open dispute on this payment.");
  const [row] = await db
    .update(disputes)
    .set({ providerStatement: input.statement, providerRespondedAt: new Date() })
    .where(and(eq(disputes.id, dispute.id), eq(disputes.status, "open")))
    .returning();
  await recordEvent(db, escrowId, "dispute_answered", {});
  return row!;
}

/** The provider gives the money back, before or during a dispute. */
export async function providerRefund(escrowId: string, providerId: string) {
  const db = await getDb();
  const escrow = await assertProviderOwns(escrowId, providerId);
  if (escrow.status === "release_pending") {
    await db.transaction(async (tx) => {
      const moved = await transition(tx, escrowId, ["release_pending"], "refund_pending", { failureReason: "refunded_by_provider" }, { type: "provider_refunded" });
      if (!moved) throw new ApiError(409, "changed", "This payment changed. Refresh and try again.");
      await cancelJob(tx, "release", escrowId);
      await enqueue(tx, "refund", escrowId, { escrowId });
    });
  } else if (escrow.status === "disputed") {
    await resolve(escrowId, `provider:${providerId}`, { decision: "refund", note: "Provider refunded the payment." });
    return;
  } else {
    throw new ApiError(409, "not_refundable", "Only payments that are held can be refunded.");
  }
  maybeKick();
}

/** The payer drops their dispute; the provider is paid. */
export async function withdrawDispute(escrowId: string, by: string) {
  await resolve(escrowId, by, { decision: "release", note: "Payer withdrew the dispute." });
}

/** Final decision on a dispute. Arbiters call this; providers and payers reach it through refund and withdraw. */
export async function resolve(escrowId: string, by: string, input: z.infer<typeof resolveInput>) {
  const db = await getDb();
  const escrow = await getEscrow(db, escrowId);
  if (!escrow) throw new ApiError(404, "not_found", "Payment not found.");
  const dispute = await openDisputeFor(escrowId);
  if (!dispute || escrow.status !== "disputed") throw new ApiError(409, "not_open", "There is no open dispute on this payment.");

  let decision = input.decision;
  let payerAmount: bigint | null = null;
  if (input.decision === "split") {
    payerAmount = BigInt(input.payerAmount);
    if (payerAmount > escrow.amountAtomic) throw new ApiError(400, "invalid_split", "The payer's share cannot exceed the payment.");
    // Normalise the edges so they settle through the simpler paths.
    if (payerAmount === 0n) decision = "release";
    else if (payerAmount === escrow.amountAtomic) decision = "refund";
  }

  await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(disputes)
      .set({ status: "resolved", resolution: decision, payerAmount, resolvedBy: by, resolutionNote: input.note, resolvedAt: new Date() })
      .where(and(eq(disputes.id, dispute.id), eq(disputes.status, "open")))
      .returning({ id: disputes.id });
    if (!updated) throw new ApiError(409, "not_open", "This dispute was resolved by someone else.");
    await recordEvent(tx, escrowId, "dispute_resolved", { resolution: decision, by, payerAmount });
    await cancelJob(tx, "extend", escrowId);
    if (decision === "release") await enqueue(tx, "release", `${escrowId}:dispute`, { escrowId, payload: { fromDispute: true } });
    if (decision === "refund") await enqueue(tx, "refund", escrowId, { escrowId });
    if (decision === "split") await enqueue(tx, "split", escrowId, { escrowId, payload: { payerAmount: payerAmount!.toString() } });
  });
  maybeKick();
}

async function assertProviderOwns(escrowId: string, providerId: string) {
  const db = await getDb();
  const [row] = await db
    .select({ escrow: escrows })
    .from(escrows)
    .innerJoin(services, eq(escrows.serviceId, services.id))
    .where(and(eq(escrows.id, escrowId), eq(services.providerId, providerId)))
    .limit(1);
  if (!row) throw new ApiError(404, "not_found", "Payment not found.");
  return row.escrow;
}

export async function listOpenDisputes() {
  const db = await getDb();
  return db
    .select({ dispute: disputes, escrow: escrows, serviceName: services.name, serviceSlug: services.slug })
    .from(disputes)
    .innerJoin(escrows, eq(disputes.escrowId, escrows.id))
    .innerJoin(services, eq(escrows.serviceId, services.id))
    .where(inArray(disputes.status, ["open"]))
    .orderBy(disputes.respondBy);
}
