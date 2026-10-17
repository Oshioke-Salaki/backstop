import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { proposeX402, x402OutputSchema } from "./paybox.js";

/**
 * Backstop for PayBox: pay for APIs through escrow, and get refunded automatically when the provider
 * fails to deliver what it promised.
 *
 * Every tool talks to one Backstop deployment over HTTPS. Set the non-sensitive variable BACKSTOP_URL
 * in the portal to switch deployments; add its hostname under network access. No secrets are needed.
 */

const PROTOCOL_VERSION = "2026-07-28";
const DEFAULT_BACKSTOP_URL = "https://backstop-six-nu.vercel.app";
// Hosted calls get 10s in total; leave room for sandbox startup but survive a serverless cold start.
const REQUEST_TIMEOUT_MS = 6_500;
const BASE_MAINNET = "eip155:8453";

class BackstopError extends Error {}

function backstopOrigin(): URL {
  const raw = process.env.BACKSTOP_URL?.trim() || DEFAULT_BACKSTOP_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BackstopError("BACKSTOP_URL is not a valid URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password) throw new BackstopError("BACKSTOP_URL must be an https origin.");
  return new URL(url.origin);
}

async function api(path: string, init: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<unknown> {
  const url = new URL(path, backstopOrigin());
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method ?? "GET",
      headers: { accept: "application/json", ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: "error",
    });
  } catch {
    throw new BackstopError(`Backstop at ${url.host} did not answer. Check the plugin's network access and retry explicitly.`);
  }
  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    // fall through with null
  }
  if (!response.ok) {
    const message = (data as { error?: { message?: unknown } } | null)?.error?.message;
    throw new BackstopError(typeof message === "string" ? message : `Backstop returned HTTP ${response.status}.`);
  }
  return data;
}

function failure(err: unknown) {
  const text = err instanceof BackstopError || err instanceof z.ZodError ? (err instanceof z.ZodError ? "Backstop returned an unexpected response." : err.message) : "The request failed. Retry explicitly.";
  return { isError: true as const, content: [{ type: "text" as const, text }] };
}

function ok<T extends Record<string, unknown>>(text: string, structuredContent: T) {
  return { content: [{ type: "text" as const, text }], structuredContent };
}

/** A payment link looks like https://<backstop>/p/<escrowId>?t=<token>. */
function parsePaymentLink(link: string): { id: string; token: string } {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new BackstopError("paymentUrl is not a URL. Use the x-backstop-payment-url value from the paid response.");
  }
  if (url.origin !== backstopOrigin().origin) throw new BackstopError(`paymentUrl must point at ${backstopOrigin().host}.`);
  const match = /^\/p\/(0x[0-9a-fA-F]{64})$/.exec(url.pathname);
  const token = url.searchParams.get("t");
  if (!match || !token) throw new BackstopError("paymentUrl must look like /p/<escrow id>?t=<token>.");
  return { id: match[1]!, token };
}

// --- Backstop API response shapes (validated before use) -------------------------------------

const assertion = z.object({ op: z.string(), path: z.string(), value: z.unknown().optional() });
const sla = z.object({
  maxLatencyMs: z.number(),
  maxResponseBytes: z.number(),
  expectStatus: z.array(z.number()),
  contentType: z.string(),
  outputSchema: z.unknown().optional(),
  assertions: z.array(assertion),
});
const serviceView = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  method: z.enum(["GET", "POST"]),
  price: z.string(),
  priceAtomic: z.string(),
  sla,
  disputeWindowSeconds: z.number(),
  status: z.string(),
  provider: z.object({ name: z.string() }),
  resource: z.string(),
});
const scorecard = z.object({
  calls: z.number(),
  delivered: z.number(),
  failed: z.number(),
  disputed: z.number(),
  refundRate: z.number().nullable(),
  deliveryRate: z.number().nullable(),
  p50LatencyMs: z.number().nullable(),
  p95LatencyMs: z.number().nullable(),
  windowDays: z.number(),
});
const config = z.object({ network: z.object({ name: z.string(), caip2: z.string() }) });
const paymentView = z.object({
  id: z.string(),
  status: z.string(),
  service: z.object({ slug: z.string(), name: z.string(), providerName: z.string() }),
  amount: z.string(),
  outcome: z.object({ payer: z.string(), payee: z.string(), fee: z.string() }).nullable(),
  verdict: z.object({ passed: z.boolean(), reason: z.string().nullable() }).nullable(),
  failureReason: z.string().nullable(),
  releaseAt: z.string().nullable(),
  canDispute: z.boolean(),
  dispute: z.object({ status: z.string(), resolution: z.string().nullable(), respondBy: z.string() }).nullable(),
});

const STATUS_TEXT: Record<string, string> = {
  funding: "confirming the payment on-chain",
  funding_failed: "not charged: the payment could not be taken",
  held: "in escrow while the response is checked",
  release_pending: "delivered and passed every check; held until the dispute window closes",
  refund_pending: "failed a check; a full refund is being sent",
  disputed: "in dispute; funds stay in escrow until it is resolved",
  released: "paid to the provider",
  refunded: "refunded in full",
  split: "split by an arbiter",
  reclaimed: "returned to the payer after the escrow deadline",
};

function describeRules(rules: z.infer<typeof assertion>[]): string[] {
  return rules.map((r) => `${r.path || "(response)"} ${r.op}${r.value === undefined ? "" : ` ${JSON.stringify(r.value)}`}`);
}

// --- Tools ----------------------------------------------------------------------------------

function createServer() {
  const server = new McpServer({ name: "backstop", version: "1.0.0" }, { supportedProtocolVersions: [PROTOCOL_VERSION] });

  server.registerTool(
    "find_protected_services",
    {
      title: "Find escrow-protected APIs",
      description:
        "Search paid APIs whose payments are held in Backstop escrow and refunded automatically if the response fails the provider's own promised checks (status, latency, size, format, JSON schema, field rules). Use pay_protected_service to call one.",
      inputSchema: z.object({ query: z.string().max(100).optional().describe("Keywords, e.g. 'weather' or 'fx'. Omit to list everything.") }).strict(),
      outputSchema: z
        .object({
          services: z.array(
            z
              .object({
                slug: z.string(),
                name: z.string(),
                description: z.string(),
                provider: z.string(),
                priceUsdc: z.string(),
                method: z.enum(["GET", "POST"]),
                maxLatencyMs: z.number(),
                disputeWindowSeconds: z.number(),
                available: z.boolean(),
              })
              .strict(),
          ),
        })
        .strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ query }) => {
      try {
        const data = z.object({ services: z.array(serviceView) }).parse(await api(`/api/v1/services${query ? `?q=${encodeURIComponent(query)}` : ""}`));
        const services = data.services.slice(0, 25).map((s) => ({
          slug: s.slug,
          name: s.name,
          description: s.description,
          provider: s.provider.name,
          priceUsdc: s.price,
          method: s.method,
          maxLatencyMs: s.sla.maxLatencyMs,
          disputeWindowSeconds: s.disputeWindowSeconds,
          available: s.status === "active",
        }));
        const text = services.length
          ? services.map((s) => `${s.slug}: ${s.name} by ${s.provider}, ${s.priceUsdc} USDC${s.available ? "" : " (paused)"}`).join("\n")
          : "No protected services match.";
        return ok(text, { services });
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "get_service",
    {
      title: "Read a service's promise and track record",
      description: "Full terms of one protected service: price, what every response is checked for, dispute window, and its 30-day delivery and refund record.",
      inputSchema: z.object({ slug: z.string().regex(/^[a-z0-9-]{3,48}$/).describe("Service slug from find_protected_services.") }).strict(),
      outputSchema: z
        .object({
          slug: z.string(),
          name: z.string(),
          provider: z.string(),
          priceUsdc: z.string(),
          method: z.enum(["GET", "POST"]),
          available: z.boolean(),
          promise: z
            .object({
              maxLatencyMs: z.number(),
              maxResponseBytes: z.number(),
              expectStatus: z.array(z.number()),
              contentType: z.string(),
              checksResponseShape: z.boolean(),
              fieldRules: z.array(z.string()),
            })
            .strict(),
          disputeWindowSeconds: z.number(),
          record: z
            .object({
              paidCalls: z.number(),
              deliveryRate: z.number().nullable(),
              refundRate: z.number().nullable(),
              medianLatencyMs: z.number().nullable(),
              disputes: z.number(),
              windowDays: z.number(),
            })
            .strict(),
        })
        .strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ slug }) => {
      try {
        const data = z.object({ service: serviceView, scorecard }).parse(await api(`/api/v1/services/${slug}`));
        const s = data.service;
        const c = data.scorecard;
        const out = {
          slug: s.slug,
          name: s.name,
          provider: s.provider.name,
          priceUsdc: s.price,
          method: s.method,
          available: s.status === "active",
          promise: {
            maxLatencyMs: s.sla.maxLatencyMs,
            maxResponseBytes: s.sla.maxResponseBytes,
            expectStatus: s.sla.expectStatus,
            contentType: s.sla.contentType,
            checksResponseShape: s.sla.outputSchema !== undefined,
            fieldRules: describeRules(s.sla.assertions),
          },
          disputeWindowSeconds: s.disputeWindowSeconds,
          record: {
            paidCalls: c.calls,
            deliveryRate: c.deliveryRate,
            refundRate: c.refundRate,
            medianLatencyMs: c.p50LatencyMs,
            disputes: c.disputed,
            windowDays: c.windowDays,
          },
        };
        const rate = c.deliveryRate === null ? "no paid calls yet" : `${Math.round(c.deliveryRate * 1000) / 10}% delivered over ${c.calls} paid calls`;
        return ok(`${s.name} by ${s.provider.name}: ${s.price} USDC, answers within ${s.sla.maxLatencyMs} ms, ${rate}.`, out);
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "pay_protected_service",
    {
      title: "Pay for a call, protected by escrow",
      description:
        "Propose an x402 payment for one call to a protected service. Funds go to the Backstop escrow, not the provider: if the response fails any promised check the agent gets a 502 with the reason and a full refund. Keep the x-backstop-payment-url from the paid response to check status or dispute later. Requires the user's approval in PayBox.",
      inputSchema: z
        .object({
          slug: z.string().regex(/^[a-z0-9-]{3,48}$/),
          path: z.string().max(512).regex(/^[A-Za-z0-9._~\-/]*$/).optional().describe("Extra path after the service URL, without a leading slash."),
          query: z.record(z.string().max(64), z.string().max(512)).optional().describe("Query parameters, e.g. {\"city\":\"Lagos\"}."),
          body: z.record(z.string(), z.json()).optional().describe("JSON body, for POST services only."),
        })
        .strict(),
      outputSchema: x402OutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ slug, path, query, body }) => {
      try {
        const [serviceData, configData] = await Promise.all([api(`/api/v1/services/${slug}`), api("/api/v1/config")]);
        const s = z.object({ service: serviceView }).parse(serviceData).service;
        const network = config.parse(configData).network;
        if (network.caip2 !== BASE_MAINNET) {
          throw new BackstopError(`This Backstop deployment settles on ${network.name}. PayBox x402 payments run on Base mainnet, so point BACKSTOP_URL at a Base mainnet deployment to pay.`);
        }
        if (s.status !== "active") throw new BackstopError(`${s.name} is paused by its provider. You have not been charged.`);
        if (s.method === "GET" && body !== undefined) throw new BackstopError(`${s.name} takes GET requests; put inputs in query, not body.`);
        if (path && (path.startsWith("/") || path.split("/").some((seg) => seg === ".." || seg === "."))) throw new BackstopError("path must be relative, without . or .. segments.");

        const url = new URL(s.resource);
        if (url.origin !== backstopOrigin().origin) throw new BackstopError("Service resource is not on the configured Backstop host.");
        if (path) url.pathname = `${url.pathname.replace(/\/+$/, "")}/${path}`;
        for (const [k, v] of Object.entries(query ?? {})) url.searchParams.append(k, v);

        return proposeX402({
          chain: BASE_MAINNET,
          url: url.toString(),
          method: s.method,
          ...(s.method === "POST" ? { body: body ?? {} } : {}),
          maxAmount: s.priceAtomic,
        });
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "check_payment",
    {
      title: "Check a protected payment",
      description: "Where the money is for one Backstop payment: delivered and held, released, refunded or disputed, with the exact split. Pass the x-backstop-payment-url from the paid response.",
      inputSchema: z.object({ paymentUrl: z.string().max(512) }).strict(),
      outputSchema: z
        .object({
          id: z.string(),
          status: z.string(),
          summary: z.string(),
          service: z.string(),
          amountUsdc: z.string(),
          delivered: z.boolean().nullable(),
          failureReason: z.string().nullable(),
          outcome: z.object({ payerUsdc: z.string(), providerUsdc: z.string(), feeUsdc: z.string() }).strict().nullable(),
          releaseAt: z.string().nullable(),
          canDispute: z.boolean(),
          dispute: z.object({ status: z.string(), resolution: z.string().nullable(), providerMustRespondBy: z.string() }).strict().nullable(),
        })
        .strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ paymentUrl }) => {
      try {
        const { id, token } = parsePaymentLink(paymentUrl);
        const p = z.object({ payment: paymentView }).parse(await api(`/api/v1/payments/${id}?t=${encodeURIComponent(token)}`)).payment;
        const summary = STATUS_TEXT[p.status] ?? p.status;
        return ok(`${p.amount} USDC to ${p.service.name}: ${summary}.`, {
          id: p.id,
          status: p.status,
          summary,
          service: p.service.name,
          amountUsdc: p.amount,
          delivered: p.verdict ? p.verdict.passed : null,
          failureReason: p.verdict && !p.verdict.passed ? p.verdict.reason : p.failureReason,
          outcome: p.outcome ? { payerUsdc: p.outcome.payer, providerUsdc: p.outcome.payee, feeUsdc: p.outcome.fee } : null,
          releaseAt: p.releaseAt,
          canDispute: p.canDispute,
          dispute: p.dispute ? { status: p.dispute.status, resolution: p.dispute.resolution, providerMustRespondBy: p.dispute.respondBy } : null,
        });
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "dispute_payment",
    {
      title: "Dispute a delivery",
      description:
        "Contest a delivery that passed the automatic checks but was still wrong (fabricated, incomplete, not as described). Only during the service's dispute window. Funds stay in escrow until the provider answers and it is resolved. Ask the user before filing.",
      inputSchema: z
        .object({
          paymentUrl: z.string().max(512),
          reason: z.enum(["wrong_content", "incomplete", "not_as_described", "duplicate_charge", "other"]),
          statement: z.string().min(20).max(2000).describe("What was wrong, specifically."),
        })
        .strict(),
      outputSchema: z.object({ id: z.string(), status: z.string(), providerMustRespondBy: z.string().nullable() }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ paymentUrl, reason, statement }) => {
      try {
        const { id, token } = parsePaymentLink(paymentUrl);
        const p = z
          .object({ payment: paymentView })
          .parse(await api(`/api/v1/payments/${id}/dispute?t=${encodeURIComponent(token)}`, { method: "POST", body: { reason, statement } })).payment;
        const respondBy = p.dispute?.respondBy ?? null;
        return ok(`Dispute filed. Funds stay in escrow${respondBy ? `; the provider must respond by ${respondBy}` : ""}.`, { id: p.id, status: p.status, providerMustRespondBy: respondBy });
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "verify_receipt",
    {
      title: "Verify a delivery receipt",
      description: "Check that an x-backstop-receipt header was signed by Backstop, and read the verdict it attests.",
      inputSchema: z.object({ receipt: z.string().min(10).max(8192).describe("The x-backstop-receipt header value.") }).strict(),
      outputSchema: z
        .object({
          valid: z.boolean(),
          delivered: z.boolean().nullable(),
          service: z.string().nullable(),
          escrowId: z.string().nullable(),
          amountAtomicUsdc: z.string().nullable(),
          reason: z.string().nullable(),
        })
        .strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ receipt }) => {
      try {
        const r = z
          .object({
            valid: z.boolean(),
            receipt: z.object({ passed: z.boolean(), service: z.string(), escrowId: z.string(), amount: z.string(), reason: z.string() }).nullable(),
          })
          .parse(await api("/api/v1/receipts/verify", { method: "POST", body: { header: receipt } }));
        return ok(r.valid ? `Genuine Backstop receipt: ${r.receipt?.passed ? "delivered as promised" : `failed (${r.receipt?.reason})`}.` : "Not a valid Backstop receipt.", {
          valid: r.valid,
          delivered: r.receipt?.passed ?? null,
          service: r.receipt?.service ?? null,
          escrowId: r.receipt?.escrowId ?? null,
          amountAtomicUsdc: r.receipt?.amount ?? null,
          reason: r.receipt ? r.receipt.reason || null : null,
        });
      } catch (err) {
        return failure(err);
      }
    },
  );

  return server;
}

serveStdio(createServer, { legacy: "reject" });
