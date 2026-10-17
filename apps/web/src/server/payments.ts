import { and, asc, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import { ESCROW_STATUSES, formatUsdc, settlementFor, verifyCapabilityToken, type EscrowStatus } from "@backstop/core";
import { getConfig } from "./config";
import { getDb } from "./db/client";
import { disputes, escrows, events, providers, services, type Dispute, type Escrow, type EscrowEvent } from "./db/schema";
import { ApiError } from "./http";
import type { Session } from "./auth";

export type Viewer = "payer" | "provider" | "admin";

export interface PaymentView {
  id: string;
  status: EscrowStatus;
  service: { slug: string; name: string; providerName: string };
  payer: string;
  payee: string;
  amount: string;
  amountAtomic: string;
  feeBps: number | null;
  /** What each party receives if the payment settles as it is heading now. */
  outcome: { payer: string; payee: string; fee: string } | null;
  verdict: Escrow["verdict"];
  latencyMs: number | null;
  upstreamStatus: number | null;
  failureReason: string | null;
  depositTx: string | null;
  settleTx: string | null;
  releaseAt: Date | null;
  deadline: Date | null;
  createdAt: Date;
  receipt: Escrow["receipt"];
  dispute: (Omit<Dispute, "payerAmount"> & { payerAmount: string | null }) | null;
  events: Array<Pick<EscrowEvent, "id" | "type" | "createdAt"> & { data: Record<string, unknown> }>;
  canDispute: boolean;
  canWithdraw: boolean;
  canRespond: boolean;
  canRefund: boolean;
  canResolve: boolean;
  explorerUrl: string | null;
}

const EXPLORERS: Record<number, string> = {
  8453: "https://basescan.org/tx/",
  84532: "https://sepolia.basescan.org/tx/",
};

/** Events that only the provider or an arbiter should see. */
const PRIVATE_EVENT_TYPES = new Set(["chain_override", "settlement_retry", "settlement_stuck", "deposit_uncertain"]);

function projectedOutcome(e: Escrow, dispute: Dispute | null) {
  const amount = e.amountAtomic;
  const bps = e.feeBps ?? 0;
  const pick = (): ReturnType<typeof settlementFor> | null => {
    switch (e.status) {
      case "release_pending":
      case "released":
        return settlementFor("release", amount, bps);
      case "refund_pending":
      case "refunded":
      case "reclaimed":
        return settlementFor("refund", amount, bps);
      case "split":
        return settlementFor("split", amount, bps, dispute?.payerAmount ?? 0n);
      case "disputed":
        if (dispute?.resolution === "split") return settlementFor("split", amount, bps, dispute.payerAmount ?? 0n);
        if (dispute?.resolution === "refund") return settlementFor("refund", amount, bps);
        if (dispute?.resolution === "release") return settlementFor("release", amount, bps);
        return null;
      default:
        return null;
    }
  };
  const s = pick();
  return s ? { payer: formatUsdc(s.payer), payee: formatUsdc(s.payee), fee: formatUsdc(s.fee) } : null;
}

async function load(id: string) {
  const db = await getDb();
  const [row] = await db
    .select({ escrow: escrows, serviceSlug: services.slug, serviceName: services.name, providerName: providers.name, providerId: providers.id, ownerAddress: providers.ownerAddress })
    .from(escrows)
    .innerJoin(services, eq(escrows.serviceId, services.id))
    .innerJoin(providers, eq(services.providerId, providers.id))
    .where(eq(escrows.id, id))
    .limit(1);
  return row ?? null;
}

/** Work out who is looking, from a capability token or a signed-in session. Returns null when they may not see it. */
export async function viewerFor(id: string, auth: { token?: string | null; session?: Session | null; providerId?: string | null }): Promise<Viewer | null> {
  const row = await load(id.toLowerCase());
  if (!row) return null;
  if (auth.session?.isAdmin) return "admin";
  if (auth.providerId && auth.providerId === row.providerId) return "provider";
  if (auth.session && auth.session.address.toLowerCase() === row.ownerAddress.toLowerCase()) return "provider";
  if (auth.session && auth.session.address.toLowerCase() === row.escrow.payer.toLowerCase()) return "payer";
  if (verifyCapabilityToken(getConfig().CAPABILITY_SECRET, id, auth.token)) return "payer";
  return null;
}

export async function getPayment(id: string, viewer: Viewer): Promise<PaymentView> {
  const db = await getDb();
  const row = await load(id.toLowerCase());
  if (!row) throw new ApiError(404, "not_found", "Payment not found.");
  const e = row.escrow;
  const [dispute] = await db.select().from(disputes).where(eq(disputes.escrowId, e.id)).limit(1);
  const timeline = await db.select().from(events).where(eq(events.escrowId, e.id)).orderBy(asc(events.id)).limit(200);
  const now = new Date();
  const openDispute = dispute && dispute.status === "open" ? dispute : null;

  return {
    id: e.id,
    status: e.status as EscrowStatus,
    service: { slug: row.serviceSlug, name: row.serviceName, providerName: row.providerName },
    payer: e.payer,
    payee: e.payee,
    amount: formatUsdc(e.amountAtomic),
    amountAtomic: e.amountAtomic.toString(),
    feeBps: e.feeBps,
    outcome: projectedOutcome(e, dispute ?? null),
    verdict: e.verdict,
    latencyMs: e.latencyMs,
    upstreamStatus: e.upstreamStatus,
    failureReason: e.failureReason,
    depositTx: e.depositTx,
    settleTx: e.settleTx,
    releaseAt: e.releaseAt,
    deadline: e.deadline,
    createdAt: e.createdAt,
    receipt: e.receipt,
    dispute: dispute ? { ...dispute, payerAmount: dispute.payerAmount?.toString() ?? null } : null,
    events: timeline
      .filter((ev) => viewer !== "payer" || !PRIVATE_EVENT_TYPES.has(ev.type))
      .map((ev) => ({ id: ev.id, type: ev.type, createdAt: ev.createdAt, data: ev.data })),
    canDispute: viewer === "payer" && e.status === "release_pending" && !!e.releaseAt && e.releaseAt > now,
    canWithdraw: viewer === "payer" && !!openDispute,
    canRespond: viewer === "provider" && !!openDispute,
    canRefund: viewer === "provider" && (e.status === "release_pending" || !!openDispute),
    canResolve: viewer === "admin" && !!openDispute,
    explorerUrl: EXPLORERS[getConfig().network.chainId] ?? null,
  };
}

export interface PaymentRow {
  id: string;
  status: EscrowStatus;
  serviceName: string;
  serviceSlug: string;
  payer: string;
  amount: string;
  createdAt: Date;
  reason: string | null;
  releaseAt: Date | null;
}

const PAGE = 25;

/** Keyset pagination on (created_at, id), newest first. */
export async function listPayments(filter: { providerId?: string; payer?: string; status?: EscrowStatus[]; cursor?: string | null }) {
  const db = await getDb();
  const where = [];
  if (filter.providerId) where.push(eq(services.providerId, filter.providerId));
  if (filter.payer) where.push(sql`lower(${escrows.payer}) = ${filter.payer.toLowerCase()}`);
  if (filter.status?.length) where.push(inArray(escrows.status, filter.status));
  if (filter.cursor) {
    const [ts, id] = Buffer.from(filter.cursor, "base64url").toString().split("|");
    const at = new Date(ts ?? "");
    if (!id || Number.isNaN(at.getTime())) throw new ApiError(400, "invalid_cursor", "Invalid page cursor.");
    where.push(or(lt(escrows.createdAt, at), and(eq(escrows.createdAt, at), lt(escrows.id, id)))!);
  }
  const rows = await db
    .select({ e: escrows, serviceName: services.name, serviceSlug: services.slug })
    .from(escrows)
    .innerJoin(services, eq(escrows.serviceId, services.id))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(escrows.createdAt), desc(escrows.id))
    .limit(PAGE + 1);
  const page = rows.slice(0, PAGE);
  const last = page.at(-1);
  return {
    items: page.map(
      (r): PaymentRow => ({
        id: r.e.id,
        status: r.e.status as EscrowStatus,
        serviceName: r.serviceName,
        serviceSlug: r.serviceSlug,
        payer: r.e.payer,
        amount: formatUsdc(r.e.amountAtomic),
        createdAt: r.e.createdAt,
        reason: r.e.failureReason,
        releaseAt: r.e.releaseAt,
      }),
    ),
    nextCursor: rows.length > PAGE && last ? Buffer.from(`${last.e.createdAt.toISOString()}|${last.e.id}`).toString("base64url") : null,
  };
}

// --- Scorecards ---------------------------------------------------------------

export interface Scorecard {
  calls: number;
  delivered: number;
  failed: number;
  disputed: number;
  refundRate: number | null;
  deliveryRate: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  volume: string;
  windowDays: number;
}

/** Delivery record over the last 30 days, from settled and in-flight payments (failed fundings excluded). */
export async function scorecard(filter: { serviceId?: string; providerId?: string }): Promise<Scorecard> {
  const db = await getDb();
  const windowDays = 30;
  const since = new Date(Date.now() - windowDays * 86400_000);
  const conditions = [gte(escrows.createdAt, since), sql`${escrows.status} not in ('funding', 'funding_failed')`];
  if (filter.serviceId) conditions.push(eq(escrows.serviceId, filter.serviceId));
  if (filter.providerId) conditions.push(eq(services.providerId, filter.providerId));
  const [r] = await db
    .select({
      calls: sql<number>`count(*)::int`,
      delivered: sql<number>`count(*) filter (where (${escrows.verdict} ->> 'passed') = 'true')::int`,
      failed: sql<number>`count(*) filter (where (${escrows.verdict} ->> 'passed') = 'false')::int`,
      refunded: sql<number>`count(*) filter (where ${escrows.status} in ('refund_pending', 'refunded', 'reclaimed'))::int`,
      disputed: sql<number>`count(*) filter (where exists (select 1 from ${disputes} d where d.escrow_id = ${escrows.id}))::int`,
      p50: sql<number | null>`percentile_cont(0.5) within group (order by ${escrows.latencyMs}) filter (where ${escrows.latencyMs} is not null)`,
      p95: sql<number | null>`percentile_cont(0.95) within group (order by ${escrows.latencyMs}) filter (where ${escrows.latencyMs} is not null)`,
      volume: sql<string>`coalesce(sum(${escrows.amountAtomic}) filter (where ${escrows.status} in ('released', 'release_pending', 'split')), 0)::text`,
    })
    .from(escrows)
    .innerJoin(services, eq(escrows.serviceId, services.id))
    .where(and(...conditions));
  const calls = Number(r?.calls ?? 0);
  const judged = Number(r?.delivered ?? 0) + Number(r?.failed ?? 0);
  return {
    calls,
    delivered: Number(r?.delivered ?? 0),
    failed: Number(r?.failed ?? 0),
    disputed: Number(r?.disputed ?? 0),
    refundRate: calls ? Number(r!.refunded) / calls : null,
    deliveryRate: judged ? Number(r!.delivered) / judged : null,
    p50LatencyMs: r?.p50 == null ? null : Math.round(Number(r.p50)),
    p95LatencyMs: r?.p95 == null ? null : Math.round(Number(r.p95)),
    volume: formatUsdc(BigInt(r?.volume ?? "0")),
    windowDays,
  };
}

/** Parse ?status=a,b into known statuses, ignoring anything unrecognised. */
export function statusFilter(url: URL): EscrowStatus[] | undefined {
  const raw = url.searchParams.get("status");
  if (!raw) return undefined;
  return raw.split(",").filter((s): s is EscrowStatus => (ESCROW_STATUSES as readonly string[]).includes(s));
}
