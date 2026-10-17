import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { Check, Sla } from "@backstop/core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const users = pgTable("users", {
  address: text("address").primaryKey(),
  createdAt: createdAt(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
});

export const providers = pgTable("providers", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerAddress: text("owner_address")
    .notNull()
    .unique()
    .references(() => users.address),
  name: text("name").notNull(),
  website: text("website"),
  payoutAddress: text("payout_address").notNull(),
  /** Whether the payout address is approved as a payee in the escrow contract. */
  payoutApproved: boolean("payout_approved").notNull().default(false),
  /** HMAC secret for signing upstream requests, encrypted at rest. */
  signingSecret: text("signing_secret").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    prefix: text("prefix").notNull(),
    hash: text("hash").notNull().unique(),
    createdAt: createdAt(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("api_keys_provider_idx").on(t.providerId)],
);

export type ServiceStatus = "draft" | "active" | "paused";

export const services = pgTable(
  "services",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "restrict" }),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    upstreamUrl: text("upstream_url").notNull(),
    method: text("method").notNull().$type<"GET" | "POST">(),
    priceAtomic: bigint("price_atomic", { mode: "bigint" }).notNull(),
    sla: jsonb("sla").notNull().$type<Sla>(),
    inputSchema: jsonb("input_schema").$type<Record<string, unknown> | null>(),
    disputeWindowSeconds: integer("dispute_window_seconds").notNull(),
    status: text("status").notNull().$type<ServiceStatus>().default("draft"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("services_provider_idx").on(t.providerId), index("services_status_idx").on(t.status)],
);

export interface StoredVerdict {
  passed: boolean;
  reason: string | null;
  checks: Check[];
}

export const escrows = pgTable(
  "escrows",
  {
    /** keccak256(abi.encode(payer, nonce)), identical to the on-chain id. */
    id: text("id").primaryKey(),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id),
    payer: text("payer").notNull(),
    payee: text("payee").notNull(),
    amountAtomic: bigint("amount_atomic", { mode: "bigint" }).notNull(),
    feeBps: integer("fee_bps"),
    nonce: text("nonce").notNull(),
    validBefore: bigint("valid_before", { mode: "bigint" }).notNull(),
    requestHash: text("request_hash").notNull(),
    status: text("status").notNull(),
    failureReason: text("failure_reason"),
    verdict: jsonb("verdict").$type<StoredVerdict | null>(),
    upstreamStatus: integer("upstream_status"),
    latencyMs: integer("latency_ms"),
    responseHash: text("response_hash"),
    depositTx: text("deposit_tx"),
    settleTx: text("settle_tx"),
    releaseAt: timestamp("release_at", { withTimezone: true }),
    deadline: timestamp("deadline", { withTimezone: true }),
    hardDeadline: timestamp("hard_deadline", { withTimezone: true }),
    receipt: jsonb("receipt").$type<Record<string, unknown> | null>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("escrows_status_release_idx").on(t.status, t.releaseAt),
    index("escrows_service_created_idx").on(t.serviceId, t.createdAt),
    index("escrows_payer_created_idx").on(t.payer, t.createdAt),
    index("escrows_status_updated_idx").on(t.status, t.updatedAt),
  ],
);

/** Encrypted copy of what the agent received: replayed on idempotent retries and kept as dispute evidence. */
export const responses = pgTable(
  "responses",
  {
    escrowId: text("escrow_id")
      .primaryKey()
      .references(() => escrows.id, { onDelete: "cascade" }),
    httpStatus: integer("http_status").notNull(),
    headers: jsonb("headers").notNull().$type<Record<string, string>>(),
    bodyCipher: text("body_cipher").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("responses_expires_idx").on(t.expiresAt)],
);

export type DisputeResolution = "release" | "refund" | "split";

export const disputes = pgTable(
  "disputes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    escrowId: text("escrow_id")
      .notNull()
      .unique()
      .references(() => escrows.id),
    reason: text("reason").notNull(),
    payerStatement: text("payer_statement").notNull(),
    providerStatement: text("provider_statement"),
    providerRespondedAt: timestamp("provider_responded_at", { withTimezone: true }),
    respondBy: timestamp("respond_by", { withTimezone: true }).notNull(),
    status: text("status").notNull().$type<"open" | "resolved">().default("open"),
    resolution: text("resolution").$type<DisputeResolution | null>(),
    payerAmount: bigint("payer_amount", { mode: "bigint" }),
    resolvedBy: text("resolved_by"),
    resolutionNote: text("resolution_note"),
    createdAt: createdAt(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [index("disputes_status_idx").on(t.status, t.respondBy)],
);

export type JobKind = "approve_payee" | "release" | "refund" | "split" | "extend";
export type JobStatus = "pending" | "running" | "done" | "failed";

export const jobs = pgTable(
  "jobs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    kind: text("kind").notNull().$type<JobKind>(),
    /** Prevents queueing the same settlement twice. */
    dedupeKey: text("dedupe_key").notNull(),
    escrowId: text("escrow_id"),
    payload: jsonb("payload").notNull().$type<Record<string, unknown>>().default(sql`'{}'::jsonb`),
    status: text("status").notNull().$type<JobStatus>().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    txHash: text("tx_hash"),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("jobs_dedupe_idx").on(t.dedupeKey), index("jobs_due_idx").on(t.status, t.runAt)],
);

export const events = pgTable(
  "events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    escrowId: text("escrow_id").notNull(),
    type: text("type").notNull(),
    data: jsonb("data").notNull().$type<Record<string, unknown>>().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [index("events_escrow_idx").on(t.escrowId, t.id)],
);

/** Cross-instance mutual exclusion, e.g. one settlement pass at a time per signer key. */
export const leases = pgTable("leases", {
  name: text("name").primaryKey(),
  holder: text("holder").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export type Service = typeof services.$inferSelect;
export type Provider = typeof providers.$inferSelect;
export type Escrow = typeof escrows.$inferSelect;
export type Dispute = typeof disputes.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type EscrowEvent = typeof events.$inferSelect;
