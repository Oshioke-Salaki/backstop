import { and, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { Hex } from "viem";
import { after } from "next/server";
import { escrowAbi, HELD_STATUSES, ONCHAIN_STATUS, statusFromChain, type EscrowStatus } from "@backstop/core";
import { chainNow, ContractRevert, getChainContext, readEscrow, sendEscrowTx, waitForTx, wasReclaimed } from "./chain";
import { getConfig } from "./config";
import { getDb, type Db } from "./db/client";
import { disputes, escrows, jobs, providers, responses, type Escrow, type Job } from "./db/schema";
import { enqueue, getEscrow, recordEvent, transition } from "./escrow-store";

const BATCH = 10;
const MAX_ATTEMPTS = 8;
const STALE_LOCK_MS = 5 * 60_000;
const FUNDING_STALE_MS = 2 * 60_000;
/** Longer than the 60s SLA ceiling plus deposit time, so an in-flight delivery is never cut off. */
const HELD_STALE_MS = 5 * 60_000;

export interface TickReport {
  jobsRun: number;
  jobsFailed: number;
  reconciled: number;
  disputesExpired: number;
}

/** Thrown by a job that cannot proceed yet; it is retried without counting as a failure. */
class NotYet extends Error {
  constructor(
    message: string,
    readonly runAt: Date,
  ) {
    super(message);
  }
}

// --- Chain sync ---------------------------------------------------------------

/**
 * Bring the database in line with the contract for one escrow. The contract always wins; any
 * disagreement that the state machine would not allow is recorded loudly for an operator.
 */
async function syncFromChain(db: Db, escrow: Escrow): Promise<EscrowStatus | null> {
  const onchain = await readEscrow(escrow.id as Hex);
  if (onchain.status === ONCHAIN_STATUS.Held || onchain.status === ONCHAIN_STATUS.None) return null;
  const target = statusFromChain(onchain.status, onchain.status === ONCHAIN_STATUS.Refunded && (await wasReclaimed(escrow.id as Hex)));
  if (!target || target === escrow.status) return target;
  const from = HELD_STATUSES.filter((s) => s === escrow.status);
  const moved = from.length ? await transition(db, escrow.id, from, target, {}, { type: "chain_sync", data: { status: target } }).catch(() => null) : null;
  if (!moved) {
    await db.update(escrows).set({ status: target, updatedAt: new Date() }).where(eq(escrows.id, escrow.id));
    await recordEvent(db, escrow.id, "chain_override", { from: escrow.status, to: target });
    console.error("escrow state overridden from chain", escrow.id, escrow.status, "→", target);
  }
  // A settlement that landed while a dispute was open closes the dispute with the chain's outcome.
  const resolution = target === "released" ? "release" : target === "split" ? "split" : "refund";
  const closed = await db
    .update(disputes)
    .set({ status: "resolved", resolution, resolvedBy: "chain", resolutionNote: "Settled on-chain.", resolvedAt: new Date() })
    .where(and(eq(disputes.escrowId, escrow.id), eq(disputes.status, "open")))
    .returning({ id: disputes.id });
  if (closed.length) await recordEvent(db, escrow.id, "dispute_resolved", { resolution, by: "chain" });
  return target;
}

async function confirmedOrResend(db: Db, job: Job, send: () => Promise<Hex>): Promise<Hex> {
  if (job.txHash) {
    try {
      const r = await waitForTx(job.txHash as Hex, 20_000);
      if (r.status === "success") return job.txHash as Hex;
    } catch {
      // Unknown or dropped: fall through and resend after the caller re-read chain state.
    }
  }
  const hash = await send();
  await db.update(jobs).set({ txHash: hash, updatedAt: new Date() }).where(eq(jobs.id, job.id));
  const r = await waitForTx(hash);
  if (r.status !== "success") throw new Error(`transaction ${hash} reverted`);
  return hash;
}

// --- Job executors ---------------------------------------------------------------

async function runRelease(db: Db, job: Job) {
  const escrow = await getEscrow(db, job.escrowId!);
  if (!escrow) return;
  const fromDispute = job.payload.fromDispute === true;
  const expected: EscrowStatus = fromDispute ? "disputed" : "release_pending";
  if (escrow.status !== expected) return; // superseded by a dispute, a refund, or already done
  if (!fromDispute) {
    if (escrow.releaseAt && escrow.releaseAt > new Date()) throw new NotYet("hold window still open", escrow.releaseAt);
    const [open] = await db
      .select({ id: disputes.id })
      .from(disputes)
      .where(and(eq(disputes.escrowId, escrow.id), eq(disputes.status, "open")))
      .limit(1);
    if (open) return;
  }

  if (await syncFromChain(db, escrow)) return;
  const onchain = await readEscrow(escrow.id as Hex);
  if (onchain.deadline <= (await chainNow())) {
    // Too late to pay the provider: the payer's reclaim right has opened. Refund instead.
    if (!fromDispute) {
      await transition(db, escrow.id, ["release_pending"], "refund_pending", { failureReason: "settlement_deadline_missed" }, { type: "release_missed" });
    }
    await enqueue(db, "refund", escrow.id, { escrowId: escrow.id });
    return;
  }
  const tx = await confirmedOrResend(db, job, () => sendEscrowTx("settler", { functionName: "release", args: [escrow.id as Hex] }));
  await transition(db, escrow.id, [expected], "released", { settleTx: tx }, { type: "released", data: { tx } });
}

async function runRefund(db: Db, job: Job) {
  const escrow = await getEscrow(db, job.escrowId!);
  if (!escrow || !["refund_pending", "disputed", "release_pending"].includes(escrow.status)) return;
  if (await syncFromChain(db, escrow)) return;
  // Record the intent before sending, so the post-send transition is always valid.
  if (escrow.status === "release_pending") {
    await transition(db, escrow.id, ["release_pending"], "refund_pending", {}, { type: "refund_started" });
  }
  const tx = await confirmedOrResend(db, job, () => sendEscrowTx("settler", { functionName: "refund", args: [escrow.id as Hex] }));
  await transition(db, escrow.id, ["refund_pending", "disputed"], "refunded", { settleTx: tx }, { type: "refunded", data: { tx } });
}

async function runSplit(db: Db, job: Job) {
  const escrow = await getEscrow(db, job.escrowId!);
  if (!escrow || escrow.status !== "disputed") return;
  if (await syncFromChain(db, escrow)) return;
  const payerAmount = BigInt(String(job.payload.payerAmount));
  const tx = await confirmedOrResend(db, job, () => sendEscrowTx("settler", { functionName: "split", args: [escrow.id as Hex, payerAmount] }));
  await transition(db, escrow.id, ["disputed"], "split", { settleTx: tx }, { type: "split", data: { tx, payerAmount } });
}

async function runExtend(db: Db, job: Job) {
  const escrow = await getEscrow(db, job.escrowId!);
  if (!escrow || escrow.status !== "disputed") return;
  if (await syncFromChain(db, escrow)) return;
  const onchain = await readEscrow(escrow.id as Hex);
  const wanted = Number(job.payload.deadline);
  const target = Math.min(wanted, onchain.hardDeadline);
  if (target <= onchain.deadline) return; // already long enough, or capped
  if (onchain.deadline <= (await chainNow())) return; // expired; reconciliation refunds it
  await confirmedOrResend(db, job, () => sendEscrowTx("settler", { functionName: "extend", args: [escrow.id as Hex, target] }));
  await db.update(escrows).set({ deadline: new Date(target * 1000), updatedAt: new Date() }).where(eq(escrows.id, escrow.id));
  await recordEvent(db, escrow.id, "deadline_extended", { deadline: target });
}

async function runApprovePayee(db: Db, job: Job) {
  const address = String(job.payload.address) as Hex;
  const { wallets, publicClient } = getChainContext();
  const already = await publicClient.readContract({ address: getConfig().ESCROW_ADDRESS, abi: escrowAbi, functionName: "isPayee", args: [address] });
  if (!already) {
    if (!wallets.registrar) throw new NotYet("waiting for an operator to approve this payout address", new Date(Date.now() + 10 * 60_000));
    await confirmedOrResend(db, job, () => sendEscrowTx("registrar", { functionName: "setPayee", args: [address, true] }));
  }
  await db.update(providers).set({ payoutApproved: true, updatedAt: new Date() }).where(eq(providers.payoutAddress, address));
}

const EXECUTORS: Record<Job["kind"], (db: Db, job: Job) => Promise<void>> = {
  release: runRelease,
  refund: runRefund,
  split: runSplit,
  extend: runExtend,
  approve_payee: runApprovePayee,
};

async function claimJobs(db: Db): Promise<Job[]> {
  const staleBefore = new Date(Date.now() - STALE_LOCK_MS);
  return db.transaction(async (tx) => {
    const due = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        or(
          and(eq(jobs.status, "pending"), lte(jobs.runAt, new Date())),
          and(eq(jobs.status, "running"), lt(jobs.lockedAt, staleBefore)),
        ),
      )
      .orderBy(jobs.runAt)
      .limit(BATCH)
      .for("update", { skipLocked: true });
    if (due.length === 0) return [];
    return tx
      .update(jobs)
      .set({ status: "running", lockedAt: new Date(), attempts: sql`${jobs.attempts} + 1`, updatedAt: new Date() })
      .where(inArray(jobs.id, due.map((d) => d.id)))
      .returning();
  });
}

async function runJobs(db: Db, report: TickReport) {
  for (const job of await claimJobs(db)) {
    try {
      await EXECUTORS[job.kind](db, job);
      await db.update(jobs).set({ status: "done", lockedAt: null, lastError: null, updatedAt: new Date() }).where(eq(jobs.id, job.id));
      report.jobsRun++;
    } catch (err) {
      if (err instanceof NotYet) {
        await db
          .update(jobs)
          .set({ status: "pending", lockedAt: null, runAt: err.runAt, attempts: sql`${jobs.attempts} - 1`, lastError: err.message, updatedAt: new Date() })
          .where(eq(jobs.id, job.id));
        continue;
      }
      const message = err instanceof ContractRevert ? `revert: ${err.errorName ?? err.message}` : (err as Error).message;
      const exhausted = job.attempts >= MAX_ATTEMPTS;
      const backoffMs = Math.min(30 * 60_000, 2 ** job.attempts * 5_000);
      await db
        .update(jobs)
        .set({
          status: exhausted ? "failed" : "pending",
          lockedAt: null,
          runAt: new Date(Date.now() + backoffMs),
          lastError: message.slice(0, 500),
          updatedAt: new Date(),
        })
        .where(eq(jobs.id, job.id));
      if (job.escrowId) await recordEvent(db, job.escrowId, exhausted ? "settlement_stuck" : "settlement_retry", { kind: job.kind, error: message.slice(0, 200) });
      console.error(`job ${job.id} (${job.kind}) failed, attempt ${job.attempts}`, message);
      report.jobsFailed++;
    }
  }
}

// --- Reconciliation -----------------------------------------------------------

async function reconcileFunding(db: Db, report: TickReport) {
  const stale = await db
    .select()
    .from(escrows)
    .where(and(eq(escrows.status, "funding"), lt(escrows.updatedAt, new Date(Date.now() - FUNDING_STALE_MS))))
    .limit(50);
  for (const escrow of stale) {
    const onchain = await readEscrow(escrow.id as Hex);
    if (onchain.status === ONCHAIN_STATUS.None) {
      // Never landed. Once the authorization can no longer be used, nothing can be owed.
      if (BigInt(Math.floor(Date.now() / 1000)) > escrow.validBefore + 60n) {
        await transition(db, escrow.id, ["funding"], "funding_failed", { failureReason: "Payment never confirmed." }, { type: "payment_failed", data: { code: "unconfirmed" } });
        report.reconciled++;
      }
      continue;
    }
    // Landed but the provider was never called: hold it, then refund in full.
    await db.transaction(async (tx) => {
      const held = await transition(tx, escrow.id, ["funding"], "held", { feeBps: onchain.feeBps, deadline: new Date(onchain.deadline * 1000), hardDeadline: new Date(onchain.hardDeadline * 1000) }, { type: "funds_held", data: { reconciled: true } });
      if (!held) return;
      await transition(tx, escrow.id, ["held"], "refund_pending", { failureReason: "delivery_not_attempted" }, { type: "delivery_failed", data: { reason: "delivery_not_attempted" } });
      await enqueue(tx, "refund", escrow.id, { escrowId: escrow.id });
    });
    report.reconciled++;
  }
}

async function reconcileHeld(db: Db, report: TickReport) {
  const stale = await db
    .select({ id: escrows.id })
    .from(escrows)
    .where(and(eq(escrows.status, "held"), lt(escrows.updatedAt, new Date(Date.now() - HELD_STALE_MS))))
    .limit(50);
  for (const { id } of stale) {
    await db.transaction(async (tx) => {
      const moved = await transition(tx, id, ["held"], "refund_pending", { failureReason: "delivery_interrupted" }, { type: "delivery_failed", data: { reason: "delivery_interrupted" } });
      if (moved) await enqueue(tx, "refund", id, { escrowId: id });
    });
    report.reconciled++;
  }
}

/** Escrows past their on-chain deadline: pick up payer reclaims, or return the funds ourselves. */
async function reconcileExpired(db: Db, report: TickReport) {
  const expired = await db
    .select()
    .from(escrows)
    .where(and(inArray(escrows.status, [...HELD_STATUSES]), lt(escrows.deadline, new Date())))
    .limit(50);
  for (const escrow of expired) {
    if (await syncFromChain(db, escrow)) {
      report.reconciled++;
      continue;
    }
    if (escrow.status === "release_pending") {
      await transition(db, escrow.id, ["release_pending"], "refund_pending", { failureReason: "settlement_deadline_missed" }, { type: "release_missed" });
    }
    if (await enqueue(db, "refund", escrow.id, { escrowId: escrow.id })) report.reconciled++;
  }
}

/** Providers who ignore a dispute forfeit it. */
async function expireDisputes(db: Db, report: TickReport) {
  const overdue = await db
    .select()
    .from(disputes)
    .where(and(eq(disputes.status, "open"), isNull(disputes.providerRespondedAt), lt(disputes.respondBy, new Date())))
    .limit(50);
  for (const d of overdue) {
    await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(disputes)
        .set({ status: "resolved", resolution: "refund", resolvedBy: "system", resolutionNote: "Provider did not respond in time.", resolvedAt: new Date() })
        .where(and(eq(disputes.id, d.id), eq(disputes.status, "open")))
        .returning({ id: disputes.id });
      if (!updated) return;
      await recordEvent(tx, d.escrowId, "dispute_resolved", { resolution: "refund", by: "system" });
      await enqueue(tx, "refund", d.escrowId, { escrowId: d.escrowId });
    });
    report.disputesExpired++;
  }
}

async function purgeExpiredResponses(db: Db) {
  await db.delete(responses).where(lt(responses.expiresAt, new Date()));
}

// --- Entry points -------------------------------------------------------------

/** One full pass. Safe to run concurrently from several processes: jobs are claimed with SKIP LOCKED. */
export async function tick(): Promise<TickReport> {
  const db = await getDb();
  const report: TickReport = { jobsRun: 0, jobsFailed: 0, reconciled: 0, disputesExpired: 0 };
  const steps: Array<[string, () => Promise<void>]> = [
    ["disputes", () => expireDisputes(db, report)],
    ["funding", () => reconcileFunding(db, report)],
    ["held", () => reconcileHeld(db, report)],
    ["expired", () => reconcileExpired(db, report)],
    ["jobs", () => runJobs(db, report)],
    ["purge", () => purgeExpiredResponses(db)],
  ];
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (err) {
      // One failing step (say, the RPC is down) must not stop the others.
      console.error(`worker step ${name} failed`, err);
    }
  }
  return report;
}

let running: Promise<unknown> | null = null;
let again = false;

/** Run a tick soon, coalescing bursts. Used to settle refunds right after a failed delivery. */
export function kickWorker(): void {
  if (running) {
    again = true;
    return;
  }
  running = tick()
    .catch((err) => console.error("worker tick failed", err))
    .finally(() => {
      running = null;
      if (again) {
        again = false;
        kickWorker();
      }
    });
}

/** Wait for any in-flight kick (tests and graceful shutdown). */
export async function drainWorker(): Promise<void> {
  while (running) await running;
}

let loop: ReturnType<typeof setInterval> | undefined;

export function startWorkerLoop(intervalMs = 5_000): () => void {
  if (loop) return () => undefined;
  loop = setInterval(kickWorker, intervalMs);
  loop.unref?.();
  kickWorker();
  return () => {
    clearInterval(loop);
    loop = undefined;
  };
}

const SETTLE_THROTTLE_MS = 20_000;
let lastScheduled = 0;

/**
 * Settle soon without a long-running process. With WORKER_INLINE the in-process loop is kicked;
 * otherwise a tick runs after the current response is sent (serverless hosts keep the function alive
 * for it). Throttled per instance; `urgent` skips the throttle, e.g. right after a failed delivery.
 */
export function settleSoon(urgent = false): void {
  if (getConfig().WORKER_INLINE) {
    kickWorker();
    return;
  }
  const now = Date.now();
  if (!urgent && now - lastScheduled < SETTLE_THROTTLE_MS) return;
  lastScheduled = now;
  try {
    after(() => tick().catch((err) => console.error("after-response tick failed", err)));
  } catch {
    // Outside a request (scripts, tests): callers run tick() themselves.
  }
}
