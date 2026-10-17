import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  assertSafeUrl,
  BlockedDestinationError,
  callUpstream,
  evaluate,
  formatUsdc,
  inputSchemaSchema,
  parseUsdc,
  signProviderRequest,
  slaSchema,
  ESCROW_HEADER,
  SIGNATURE_HEADER,
  type Verdict,
} from "@backstop/core";
import { getConfig } from "./config";
import { decrypt } from "./crypto";
import { getDb } from "./db/client";
import { escrows, providers, services, type Service, type ServiceStatus } from "./db/schema";
import { ApiError } from "./http";

export const MIN_PRICE = parseUsdc("0.001");
export const MAX_PRICE = parseUsdc("1000");
export const MAX_DISPUTE_WINDOW = 7 * 86400;
const MAX_SERVICES_PER_PROVIDER = 50;
const RESERVED_SLUGS = new Set(["api", "admin", "new", "edit", "docs", "settings", "backstop", "x402", "mcp", "well-known"]);

const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/, "Use 3–48 lowercase letters, numbers and dashes.")
  .refine((s) => !s.includes("--"), "Avoid double dashes.")
  .refine((s) => !RESERVED_SLUGS.has(s), "That name is reserved.");

const price = z
  .string()
  .trim()
  .transform((v, ctx) => {
    try {
      return parseUsdc(v);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Enter a price like 0.05." });
      return z.NEVER;
    }
  })
  .refine((v) => v >= MIN_PRICE, `Minimum price is ${formatUsdc(MIN_PRICE)} USDC.`)
  .refine((v) => v <= MAX_PRICE, `Maximum price is ${formatUsdc(MAX_PRICE)} USDC.`);

const upstreamUrl = z
  .string()
  .trim()
  .max(500)
  .superRefine((v, ctx) => {
    try {
      const url = assertSafeUrl(v, { allowPrivateNetworks: getConfig().ALLOW_PRIVATE_UPSTREAMS });
      if (url.search) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Leave the query string off the base URL." });
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: err instanceof BlockedDestinationError ? capitalize(err.message) + "." : "Enter a valid URL.",
      });
    }
  });

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const serviceInput = z
  .object({
    slug,
    name: z.string().trim().min(2, "Name is too short.").max(80, "Name is too long."),
    description: z.string().trim().min(10, "Describe what the agent gets, in a sentence or two.").max(500, "Keep it under 500 characters."),
    upstreamUrl,
    method: z.enum(["GET", "POST"]),
    price,
    sla: slaSchema,
    inputSchema: inputSchemaSchema.nullable().optional(),
    disputeWindowSeconds: z.number().int().min(0).max(MAX_DISPUTE_WINDOW, "Dispute windows can be at most 7 days."),
  })
  .strict();

export type ServiceInput = z.infer<typeof serviceInput>;

export interface ServiceView {
  id: string;
  slug: string;
  name: string;
  description: string;
  method: "GET" | "POST";
  price: string;
  priceAtomic: string;
  sla: Service["sla"];
  inputSchema: Record<string, unknown> | null;
  disputeWindowSeconds: number;
  status: ServiceStatus;
  provider: { id: string; name: string; website: string | null };
  resource: string;
  upstreamUrl?: string;
  createdAt: Date;
  updatedAt: Date;
}

export function toView(s: Service, p: { id: string; name: string; website: string | null }, includePrivate = false): ServiceView {
  return {
    id: s.id,
    slug: s.slug,
    name: s.name,
    description: s.description,
    method: s.method,
    price: formatUsdc(s.priceAtomic),
    priceAtomic: s.priceAtomic.toString(),
    sla: s.sla,
    inputSchema: s.inputSchema ?? null,
    disputeWindowSeconds: s.disputeWindowSeconds,
    status: s.status,
    provider: { id: p.id, name: p.name, website: p.website },
    resource: `${getConfig().PUBLIC_BASE_URL}/x/${s.slug}`,
    ...(includePrivate ? { upstreamUrl: s.upstreamUrl } : {}),
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

function values(input: ServiceInput) {
  return {
    slug: input.slug,
    name: input.name,
    description: input.description,
    upstreamUrl: input.upstreamUrl,
    method: input.method,
    priceAtomic: input.price,
    sla: input.sla,
    inputSchema: input.inputSchema ?? null,
    disputeWindowSeconds: input.disputeWindowSeconds,
  };
}

export async function createService(providerId: string, input: ServiceInput): Promise<Service> {
  const db = await getDb();
  const [{ n }] = (await db.select({ n: count() }).from(services).where(eq(services.providerId, providerId))) as [{ n: number }];
  if (n >= MAX_SERVICES_PER_PROVIDER) throw new ApiError(409, "too_many_services", `You can list up to ${MAX_SERVICES_PER_PROVIDER} services.`);
  const [taken] = await db.select({ id: services.id }).from(services).where(eq(services.slug, input.slug)).limit(1);
  if (taken) throw new ApiError(409, "slug_taken", "That service name is taken.", [{ path: "slug", message: "That name is taken." }]);
  try {
    const [row] = await db.insert(services).values({ providerId, ...values(input) }).returning();
    return row!;
  } catch (err) {
    if (/unique/i.test(String((err as Error).message))) throw new ApiError(409, "slug_taken", "That service name is taken.");
    throw err;
  }
}

export async function getOwnedService(providerId: string, id: string): Promise<Service> {
  const db = await getDb();
  const [row] = await db.select().from(services).where(and(eq(services.id, id), eq(services.providerId, providerId))).limit(1);
  if (!row) throw new ApiError(404, "not_found", "Service not found.");
  return row;
}

export async function updateService(providerId: string, id: string, input: ServiceInput): Promise<Service> {
  const current = await getOwnedService(providerId, id);
  if (current.slug !== input.slug) {
    const db = await getDb();
    const [used] = await db.select({ id: escrows.id }).from(escrows).where(eq(escrows.serviceId, id)).limit(1);
    if (used) throw new ApiError(409, "slug_locked", "A service's name cannot change after it has been paid for. Agents rely on its URL.");
  }
  const db = await getDb();
  try {
    const [row] = await db
      .update(services)
      .set({ ...values(input), updatedAt: new Date() })
      .where(and(eq(services.id, id), eq(services.providerId, providerId)))
      .returning();
    return row!;
  } catch (err) {
    if (/unique/i.test(String((err as Error).message))) throw new ApiError(409, "slug_taken", "That service name is taken.");
    throw err;
  }
}

export async function setServiceStatus(providerId: string, id: string, status: ServiceStatus): Promise<Service> {
  const db = await getDb();
  const service = await getOwnedService(providerId, id);
  if (status === "active") {
    const [p] = await db.select({ approved: providers.payoutApproved }).from(providers).where(eq(providers.id, providerId)).limit(1);
    if (!p?.approved) throw new ApiError(409, "payout_pending", "Your payout address is still being approved. Try again in a minute.");
  }
  if (status === "draft" && service.status !== "draft") {
    throw new ApiError(409, "invalid_status", "A published service can be paused, not returned to draft.");
  }
  const [row] = await db.update(services).set({ status, updatedAt: new Date() }).where(eq(services.id, id)).returning();
  return row!;
}

export async function deleteService(providerId: string, id: string): Promise<void> {
  const db = await getDb();
  await getOwnedService(providerId, id);
  const [used] = await db.select({ id: escrows.id }).from(escrows).where(eq(escrows.serviceId, id)).limit(1);
  if (used) throw new ApiError(409, "service_in_use", "This service has payment history, so it can be paused but not deleted.");
  await db.delete(services).where(eq(services.id, id));
}

export async function listProviderServices(providerId: string): Promise<Service[]> {
  const db = await getDb();
  return db.select().from(services).where(eq(services.providerId, providerId)).orderBy(desc(services.createdAt));
}

export async function listPublicServices(opts: { query?: string; limit?: number } = {}) {
  const db = await getDb();
  const rows = await db
    .select({ service: services, provider: { id: providers.id, name: providers.name, website: providers.website } })
    .from(services)
    .innerJoin(providers, eq(services.providerId, providers.id))
    .where(and(inArray(services.status, ["active", "paused"]), eq(providers.payoutApproved, true)))
    .orderBy(asc(services.name))
    .limit(Math.min(opts.limit ?? 100, 200));
  const q = opts.query?.trim().toLowerCase();
  const filtered = q
    ? rows.filter((r) => [r.service.name, r.service.slug, r.service.description, r.provider.name].some((f) => f.toLowerCase().includes(q)))
    : rows;
  return filtered.map((r) => toView(r.service, r.provider));
}

export async function getPublicService(slugValue: string): Promise<ServiceView | null> {
  const db = await getDb();
  const [row] = await db
    .select({ service: services, provider: { id: providers.id, name: providers.name, website: providers.website } })
    .from(services)
    .innerJoin(providers, eq(services.providerId, providers.id))
    .where(eq(services.slug, slugValue))
    .limit(1);
  if (!row || row.service.status === "draft") return null;
  return toView(row.service, row.provider);
}

// --- Dry run ---------------------------------------------------------------

export const testInput = z
  .object({
    path: z.string().max(1024).default(""),
    query: z.string().max(4096).default(""),
    body: z.string().max(64 * 1024).optional(),
  })
  .strict();

export interface DryRunResult {
  verdict: Verdict;
  status: number | null;
  latencyMs: number;
  bodyPreview: string;
  url: string;
}

/**
 * Call the provider's own upstream exactly as the gateway would, without payment, and report whether
 * the response would pass. Lets providers fix their SLA before an agent ever pays.
 */
export async function dryRun(providerId: string, id: string, input: z.infer<typeof testInput>): Promise<DryRunResult> {
  const config = getConfig();
  const db = await getDb();
  const service = await getOwnedService(providerId, id);
  const [provider] = await db.select().from(providers).where(eq(providers.id, providerId)).limit(1);

  const url = new URL(service.upstreamUrl);
  const segments = input.path.split("/").filter(Boolean);
  if (segments.some((s) => s === "." || s === "..")) throw new ApiError(400, "invalid_path", "Path is not valid.");
  if (segments.length) url.pathname = `${url.pathname.replace(/\/+$/, "")}/${segments.map(encodeURIComponent).join("/")}`;
  for (const [k, v] of new URLSearchParams(input.query)) url.searchParams.append(k, v);

  const body = service.method === "POST" ? new TextEncoder().encode(input.body ?? "") : new Uint8Array();
  const escrowId = "dry-run";
  const result = await callUpstream(
    {
      url: url.toString(),
      method: service.method,
      headers: {
        "user-agent": "Backstop/1.0 (dry run)",
        // Unpaid: providers must not treat this as a real, paid request.
        "x-backstop-dry-run": "1",
        [ESCROW_HEADER]: escrowId,
        [SIGNATURE_HEADER]: signProviderRequest(decrypt(provider!.signingSecret, provider!.id).toString("utf8"), {
          escrowId,
          method: service.method,
          path: url.pathname + url.search,
          body,
          timestamp: Math.floor(Date.now() / 1000),
        }),
        ...(service.method === "POST" ? { "content-type": "application/json" } : {}),
      },
      body,
      timeoutMs: service.sla.maxLatencyMs,
      maxResponseBytes: service.sla.maxResponseBytes,
    },
    { allowPrivateNetworks: config.ALLOW_PRIVATE_UPSTREAMS },
  );
  const obs = result.observation;
  return {
    verdict: evaluate(service.sla, obs),
    status: obs.kind === "response" ? obs.status : null,
    latencyMs: "latencyMs" in obs ? obs.latencyMs : 0,
    bodyPreview: obs.kind === "response" ? new TextDecoder().decode(obs.body.slice(0, 4096)) : "",
    url: url.toString(),
  };
}
