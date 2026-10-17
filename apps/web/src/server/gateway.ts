import { eq } from "drizzle-orm";
import { encodeAbiParameters, keccak256, parseEventLogs, type Address, type Hex } from "viem";
import {
  AuthorizationRejected,
  buildPaymentRequired,
  buildSettlementHeader,
  callUpstream,
  capabilityToken,
  decodePayment,
  encodeBase64Json,
  encodeReceipt,
  ESCROW_HEADER,
  escrowAbi,
  evaluate,
  PAYER_HEADER,
  PaymentDecodeError,
  readPaymentHeader,
  requestHash as hashRequest,
  sha256Hex,
  SIGNATURE_HEADER,
  signProviderRequest,
  signReceipt,
  validateAgainstSchema,
  verifyAuthorization,
  ZERO_HASH,
  type DecodedPayment,
  type Verdict,
} from "@backstop/core";
import { ContractRevert, getChainContext, sendEscrowTx, waitForTx } from "./chain";
import { getConfig, type Config } from "./config";
import { decrypt, encrypt } from "./crypto";
import { getDb, type Db } from "./db/client";
import { escrows, providers, responses, services, type Escrow, type Provider, type Service } from "./db/schema";
import { enqueue, getEscrow, recordEvent, transition } from "./escrow-store";
import { clientIp, json, readBody } from "./http";
import { LIMITS, take } from "./ratelimit";
import { settleSoon } from "./worker";

const MAX_PATH_SEGMENTS = 16;
const MAX_PATH_LENGTH = 1024;
const MAX_QUERY_LENGTH = 4096;
const FORWARDED_REQUEST_HEADERS = ["content-type", "accept", "accept-language"];

export const BACKSTOP_STATUS_HEADER = "x-backstop-status";
export const BACKSTOP_RECEIPT_HEADER = "x-backstop-receipt";
export const BACKSTOP_LINK_HEADER = "x-backstop-payment-url";

const EXPOSED = [
  ESCROW_HEADER,
  BACKSTOP_STATUS_HEADER,
  BACKSTOP_RECEIPT_HEADER,
  BACKSTOP_LINK_HEADER,
  "x-payment-response",
  "payment-response",
  "payment-required",
].join(", ");

export function escrowIdFor(payer: Address, nonce: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [payer, nonce]));
}

export function paymentUrl(config: Config, escrowId: string): string {
  return `${config.PUBLIC_BASE_URL}/p/${escrowId}?t=${capabilityToken(config.CAPABILITY_SECRET, escrowId)}`;
}

function problem(status: number, code: string, message: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return json({ error: { code, message, ...extra } }, { status, headers: { "access-control-expose-headers": EXPOSED, ...headers } });
}

interface Target {
  service: Service;
  provider: Provider;
  upstreamUrl: URL;
  body: Uint8Array;
  requestHash: Hex;
  resource: string;
}

/** Resolve and pre-validate the request. Nothing here costs the payer anything. */
async function resolveTarget(db: Db, req: Request, slug: string, segments: string[]): Promise<Target | Response> {
  const config = getConfig();
  const [row] = await db
    .select({ service: services, provider: providers })
    .from(services)
    .innerJoin(providers, eq(services.providerId, providers.id))
    .where(eq(services.slug, slug))
    .limit(1);
  if (!row || row.service.status === "draft") return problem(404, "service_not_found", "No service with that name.");
  const { service, provider } = row;
  if (service.status === "paused") {
    return problem(503, "service_paused", "This service is paused by its provider.", {}, { "retry-after": "300" });
  }
  if (!provider.payoutApproved) {
    return problem(503, "provider_not_ready", "This provider cannot accept payments yet.", {}, { "retry-after": "60" });
  }
  if (req.method !== service.method) {
    return problem(405, "method_not_allowed", `Use ${service.method}.`, {}, { allow: service.method });
  }

  const url = new URL(req.url);
  if (url.search.length > MAX_QUERY_LENGTH) return problem(414, "query_too_long", "Query string is too long.");
  if (segments.length > MAX_PATH_SEGMENTS) return problem(414, "path_too_long", "Path has too many segments.");
  const decoded: string[] = [];
  for (const s of segments) {
    let part: string;
    try {
      part = decodeURIComponent(s);
    } catch {
      return problem(400, "invalid_path", "Path is not valid.");
    }
    if (part === "" || part === "." || part === ".." || /[/\\\u0000-\u001f\u007f]/.test(part)) {
      return problem(400, "invalid_path", "Path is not valid.");
    }
    decoded.push(part);
  }
  const subpath = decoded.map(encodeURIComponent).join("/");
  if (subpath.length > MAX_PATH_LENGTH) return problem(414, "path_too_long", "Path is too long.");

  const upstreamUrl = new URL(service.upstreamUrl);
  if (subpath) upstreamUrl.pathname = `${upstreamUrl.pathname.replace(/\/+$/, "")}/${subpath}`;
  for (const [k, v] of url.searchParams) upstreamUrl.searchParams.append(k, v);

  let body: Uint8Array;
  try {
    body = await readBody(req, config.MAX_REQUEST_BYTES);
  } catch {
    return problem(413, "payload_too_large", `Request body exceeds ${config.MAX_REQUEST_BYTES} bytes.`);
  }
  if (service.method === "GET" && body.byteLength > 0) return problem(400, "unexpected_body", "GET requests must not have a body.");

  if (service.inputSchema) {
    let input: unknown;
    if (service.method === "GET") {
      input = Object.fromEntries(url.searchParams);
    } else {
      const type = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (type !== "application/json") return problem(415, "unsupported_media_type", "Send a JSON body.");
      try {
        input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
      } catch {
        return problem(400, "invalid_json", "Request body is not valid JSON.");
      }
    }
    const result = validateAgainstSchema(service.inputSchema, input);
    if (!result.valid) {
      return problem(400, "invalid_input", "Input does not match what this service accepts. You have not been charged.", {
        detail: result.error,
      });
    }
  }

  const resourceUrl = new URL(req.url);
  const resource = `${config.PUBLIC_BASE_URL}${resourceUrl.pathname}`;
  return {
    service,
    provider,
    upstreamUrl,
    body,
    resource,
    requestHash: hashRequest({
      method: req.method,
      path: resourceUrl.pathname,
      query: url.searchParams,
      contentType: req.headers.get("content-type"),
      body,
    }),
  };
}

function paymentRequired(config: Config, target: Target, error?: string, code?: string) {
  const { service } = target;
  const built = buildPaymentRequired(
    {
      network: config.network,
      amount: service.priceAtomic,
      asset: config.USDC_ADDRESS,
      payTo: config.ESCROW_ADDRESS,
      resource: target.resource,
      description: `${service.name}. ${service.description}`.slice(0, 500),
      mimeType: service.sla.contentType,
      maxTimeoutSeconds: Math.ceil(service.sla.maxLatencyMs / 1000) + 60,
      assetName: config.USDC_NAME,
      assetVersion: config.USDC_VERSION,
      method: service.method,
      inputSchema: service.inputSchema ?? undefined,
      outputSchema: service.sla.outputSchema,
      terms: {
        protected: true,
        disputeWindowSeconds: service.disputeWindowSeconds,
        refundOn: "failed delivery checks",
        sla: { maxLatencyMs: service.sla.maxLatencyMs, contentType: service.sla.contentType },
        terms: `${config.PUBLIC_BASE_URL}/services/${service.slug}`,
      },
    },
    error,
  );
  const body = code ? { ...built.body, code } : built.body;
  return json(body, { status: 402, headers: { ...built.headers, "access-control-expose-headers": EXPOSED } });
}

/** Map token and escrow reverts onto messages an agent can act on. */
function describeRevert(err: ContractRevert): { code: string; message: string } {
  const reason = `${err.errorName ?? ""} ${err.message}`;
  if (/InsufficientBalance|exceeds balance/i.test(reason)) return { code: "insufficient_funds", message: "The paying wallet does not have enough USDC." };
  if (/authorization is used|EscrowExists/i.test(reason)) return { code: "authorization_used", message: "This payment authorization was already used. Sign a new one." };
  if (/expired/i.test(reason)) return { code: "authorization_expired", message: "This payment authorization has expired. Sign a new one." };
  if (/not yet valid/i.test(reason)) return { code: "not_yet_valid", message: "This payment authorization is not valid yet." };
  if (/invalid signature/i.test(reason)) return { code: "invalid_signature", message: "The payment signature is invalid." };
  if (/EnforcedPause/i.test(reason)) return { code: "paused", message: "Backstop is temporarily not accepting new payments." };
  if (/InvalidAmount/i.test(reason)) return { code: "amount_not_allowed", message: "This amount is outside what Backstop can hold." };
  if (/PayeeNotAllowed/i.test(reason)) return { code: "provider_not_ready", message: "This provider cannot accept payments yet." };
  return { code: "payment_failed", message: "The payment could not be taken." };
}

/** What a repeat of an already-handled payment gets back: the original outcome, never a second charge. */
async function replay(db: Db, config: Config, escrow: Escrow, payment: DecodedPayment, hash: Hex): Promise<Response> {
  if (escrow.requestHash !== hash) {
    return problem(409, "payment_reused", "This payment was already used for a different request. Sign a new one.");
  }
  const link = paymentUrl(config, escrow.id);
  const common = {
    [ESCROW_HEADER]: escrow.id,
    [BACKSTOP_STATUS_HEADER]: escrow.status,
    [BACKSTOP_LINK_HEADER]: link,
  };
  switch (escrow.status) {
    case "funding":
    case "held":
      return problem(409, "payment_in_progress", "This payment is still being processed. Retry shortly.", { escrowId: escrow.id }, { ...common, "retry-after": "2" });
    case "funding_failed":
      return paymentRequired(config, await targetFromEscrow(db, escrow), escrow.failureReason ?? "Payment could not be taken.", "payment_failed");
  }
  const [stored] = await db.select().from(responses).where(eq(responses.escrowId, escrow.id)).limit(1);
  const settlement = buildSettlementHeader(payment.version, {
    success: true,
    transaction: (escrow.depositTx ?? "") as Hex,
    network: config.network,
    payer: escrow.payer as Address,
  });
  if (escrow.verdict?.passed && stored && stored.expiresAt > new Date()) {
    return new Response(new Uint8Array(decrypt(stored.bodyCipher, escrow.id)), {
      status: stored.httpStatus,
      headers: {
        ...stored.headers,
        ...settlement,
        ...common,
        ...(escrow.receipt ? { [BACKSTOP_RECEIPT_HEADER]: encodeBase64Json(escrow.receipt) } : {}),
        "cache-control": "no-store",
        "access-control-expose-headers": EXPOSED,
      },
    });
  }
  if (escrow.verdict?.passed) {
    return problem(410, "response_expired", "This request was delivered, but the stored response has expired.", { escrowId: escrow.id, paymentUrl: link }, { ...common, ...settlement });
  }
  return failureResponse(escrow, link, settlement, common);
}

function failureResponse(escrow: Escrow, link: string, settlement: Record<string, string>, common: Record<string, string>) {
  return problem(
    502,
    "delivery_failed",
    "The provider did not deliver what it promised. Your payment is being refunded in full.",
    {
      escrowId: escrow.id,
      reason: escrow.verdict?.reason ?? escrow.failureReason,
      checks: escrow.verdict?.checks ?? [],
      refund: { status: escrow.status === "refunded" || escrow.status === "reclaimed" ? "complete" : "pending" },
      paymentUrl: link,
    },
    { ...common, ...settlement },
  );
}

async function targetFromEscrow(db: Db, escrow: Escrow): Promise<Target> {
  const [row] = await db
    .select({ service: services, provider: providers })
    .from(services)
    .innerJoin(providers, eq(services.providerId, providers.id))
    .where(eq(services.id, escrow.serviceId))
    .limit(1);
  const config = getConfig();
  return {
    ...row!,
    upstreamUrl: new URL(row!.service.upstreamUrl),
    body: new Uint8Array(),
    requestHash: escrow.requestHash as Hex,
    resource: `${config.PUBLIC_BASE_URL}/x/${row!.service.slug}`,
  };
}

export async function handleGateway(req: Request, slug: string, segments: string[]): Promise<Response> {
  const config = getConfig();
  const db = await getDb();

  const ipLimit = take(`gw:ip:${clientIp(req)}`, LIMITS.gatewayPerIp);
  if (!ipLimit.ok) return problem(429, "rate_limited", "Too many requests.", {}, { "retry-after": String(ipLimit.retryAfter) });

  const resolved = await resolveTarget(db, req, slug, segments);
  if (resolved instanceof Response) return resolved;
  const target = resolved;
  const { service, provider } = target;

  const header = readPaymentHeader(req.headers);
  if (!header) return paymentRequired(config, target, "Payment required. This request is protected by Backstop escrow.");

  let payment: DecodedPayment;
  try {
    payment = decodePayment(header.raw);
  } catch (err) {
    if (err instanceof PaymentDecodeError) return paymentRequired(config, target, err.message, "invalid_payment");
    throw err;
  }

  const payer = payment.authorization.from;
  const payerLimit = take(`gw:payer:${payer.toLowerCase()}`, LIMITS.gatewayPerPayer);
  if (!payerLimit.ok) return problem(429, "rate_limited", "Too many requests from this wallet.", {}, { "retry-after": String(payerLimit.retryAfter) });

  const escrowId = escrowIdFor(payer, payment.authorization.nonce);
  const existing = await getEscrow(db, escrowId);
  if (existing) return replay(db, config, existing, payment, target.requestHash);

  let verified;
  try {
    verified = await verifyAuthorization(payment, {
      network: config.network,
      asset: config.USDC_ADDRESS,
      assetName: config.USDC_NAME,
      assetVersion: config.USDC_VERSION,
      escrow: config.ESCROW_ADDRESS,
      amount: service.priceAtomic,
      payee: provider.payoutAddress as Address,
      minValiditySeconds: config.MIN_AUTHORIZATION_SECONDS,
      nowSeconds: Math.floor(Date.now() / 1000),
    });
  } catch (err) {
    if (err instanceof AuthorizationRejected) return paymentRequired(config, target, err.message, err.code);
    throw err;
  }

  // Claim the authorization. The primary key makes concurrent duplicates lose here, before any chain call.
  const inserted = await db
    .insert(escrows)
    .values({
      id: escrowId,
      serviceId: service.id,
      payer,
      payee: provider.payoutAddress,
      amountAtomic: verified.value,
      nonce: verified.nonce,
      validBefore: verified.validBefore,
      requestHash: target.requestHash,
      status: "funding",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing({ target: escrows.id })
    .returning({ id: escrows.id });
  if (inserted.length === 0) {
    const raced = await getEscrow(db, escrowId);
    return replay(db, config, raced!, payment, target.requestHash);
  }
  await recordEvent(db, escrowId, "payment_received", { amount: verified.value, payer, service: service.slug });

  // 1. Pull funds into escrow. The provider is never called unless this lands on-chain.
  const nowSec = Math.floor(Date.now() / 1000);
  const releaseAt = nowSec + service.disputeWindowSeconds;
  const deadline = releaseAt + config.SETTLEMENT_GRACE_SECONDS;
  let depositTx: Hex;
  try {
    depositTx = await sendEscrowTx("depositor", {
      functionName: "deposit",
      args: [
        {
          from: verified.from,
          value: verified.value,
          validAfter: verified.validAfter,
          validBefore: verified.validBefore,
          nonce: verified.nonce,
          v: verified.v,
          r: verified.r,
          s: verified.s,
        },
        provider.payoutAddress as Hex,
        deadline,
      ],
    });
  } catch (err) {
    if (err instanceof ContractRevert) {
      const d = describeRevert(err);
      await transition(db, escrowId, ["funding"], "funding_failed", { failureReason: d.message }, { type: "payment_failed", data: { code: d.code } });
      return paymentRequired(config, target, d.message, d.code);
    }
    // Simulation passed but the send errored, so it may or may not have been broadcast. Leave it in
    // `funding`: the reconciler reads the chain and either refunds the deposit or marks it failed.
    console.error("deposit send failed", escrowId, err);
    await recordEvent(db, escrowId, "deposit_uncertain", { message: (err as Error).message.slice(0, 200) });
    return problem(
      503,
      "payment_unconfirmed",
      "Backstop could not confirm your payment. If it was taken, it will be refunded automatically. Sign a new payment to retry.",
      { escrowId, paymentUrl: paymentUrl(config, escrowId) },
      { [ESCROW_HEADER]: escrowId, "retry-after": "5" },
    );
  }

  await db.update(escrows).set({ depositTx, updatedAt: new Date() }).where(eq(escrows.id, escrowId));

  let receipt;
  try {
    receipt = await waitForTx(depositTx);
  } catch (err) {
    // Broadcast but unconfirmed. The reconciler settles this once the chain answers: if the deposit
    // landed, it refunds (delivery was never attempted); if not, it marks the payment failed.
    console.error("deposit confirmation timed out", escrowId, err);
    return problem(503, "payment_unconfirmed", "Your payment is taking longer than usual to confirm. If it lands, it will be refunded automatically.", { escrowId, paymentUrl: paymentUrl(config, escrowId) }, { [ESCROW_HEADER]: escrowId, "retry-after": "10" });
  }
  if (receipt.status !== "success") {
    await transition(db, escrowId, ["funding"], "funding_failed", { failureReason: "Deposit transaction reverted." }, { type: "payment_failed", data: { code: "reverted", tx: depositTx } });
    return paymentRequired(config, target, "The payment could not be taken.", "payment_failed");
  }
  const deposited = parseEventLogs({ abi: escrowAbi, eventName: "Deposited", logs: receipt.logs }).find((l) => l.args.id === escrowId);
  const held = await transition(
    db,
    escrowId,
    ["funding"],
    "held",
    {
      feeBps: deposited ? Number(deposited.args.feeBps) : null,
      deadline: new Date(deadline * 1000),
      hardDeadline: new Date((nowSec + 30 * 86400) * 1000),
      releaseAt: new Date(releaseAt * 1000),
    },
    { type: "funds_held", data: { tx: depositTx } },
  );
  if (!held) {
    // Reconciliation already took over (only possible if confirmation was extremely slow).
    return problem(503, "payment_unconfirmed", "Your payment is being reconciled. Check its status link.", { escrowId, paymentUrl: paymentUrl(config, escrowId) });
  }

  // 2. Call the provider, signed so it can verify the call is paid and from Backstop.
  const ts = Math.floor(Date.now() / 1000);
  const upstreamHeaders: Record<string, string> = {
    "user-agent": "Backstop/1.0",
    [ESCROW_HEADER]: escrowId,
    [PAYER_HEADER]: payer,
    [SIGNATURE_HEADER]: signProviderRequest(decrypt(provider.signingSecret, provider.id).toString("utf8"), {
      escrowId,
      method: service.method,
      path: target.upstreamUrl.pathname + target.upstreamUrl.search,
      body: target.body,
      timestamp: ts,
    }),
  };
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const v = req.headers.get(name);
    if (v && v.length < 512) upstreamHeaders[name] = v;
  }
  const upstream = await callUpstream(
    {
      url: target.upstreamUrl.toString(),
      method: service.method,
      headers: upstreamHeaders,
      body: target.body,
      timeoutMs: service.sla.maxLatencyMs,
      maxResponseBytes: service.sla.maxResponseBytes,
    },
    { allowPrivateNetworks: config.ALLOW_PRIVATE_UPSTREAMS },
  );

  // 3. Judge the delivery against the provider's own promise.
  const verdict: Verdict = evaluate(service.sla, upstream.observation);
  const obs = upstream.observation;
  const responseBody = obs.kind === "response" ? obs.body : new Uint8Array();
  const responseHash = obs.kind === "response" ? sha256Hex(obs.body) : ZERO_HASH;
  const latencyMs = "latencyMs" in obs ? obs.latencyMs : 0;

  const { receiptAccount } = getChainContext();
  const receiptBody = {
    escrowId,
    service: service.slug,
    payer,
    payee: provider.payoutAddress as Address,
    amount: verified.value,
    passed: verdict.passed,
    reason: verdict.reason ?? "",
    requestHash: target.requestHash,
    responseHash,
    latencyMs,
    issuedAt: BigInt(Math.floor(Date.now() / 1000)),
  };
  const encodedReceipt = encodeReceipt(
    receiptBody,
    await signReceipt(receiptAccount, { chainId: config.network.chainId, escrow: config.ESCROW_ADDRESS }, receiptBody),
  );

  const patch = {
    verdict: { passed: verdict.passed, reason: verdict.reason, checks: verdict.checks },
    upstreamStatus: obs.kind === "response" ? obs.status : null,
    latencyMs,
    responseHash,
    receipt: encodedReceipt as unknown as Record<string, unknown>,
    failureReason: verdict.passed ? null : verdict.reason,
  };

  const outcome = await db.transaction(async (tx) => {
    if (verdict.passed) {
      const row = await transition(tx, escrowId, ["held"], "release_pending", patch, {
        type: "delivery_verified",
        data: { latencyMs, checks: verdict.checks.length },
      });
      if (!row) return null;
      await tx.insert(responses).values({
        escrowId,
        httpStatus: obs.kind === "response" ? obs.status : 200,
        headers: upstream.headers,
        bodyCipher: encrypt(responseBody, escrowId),
        expiresAt: new Date(Date.now() + config.RESPONSE_RETENTION_SECONDS * 1000),
      });
      await enqueue(tx, "release", escrowId, { escrowId, runAt: new Date(releaseAt * 1000) });
      return row;
    }
    const row = await transition(tx, escrowId, ["held"], "refund_pending", patch, {
      type: "delivery_failed",
      data: { reason: verdict.reason },
    });
    if (!row) return null;
    await enqueue(tx, "refund", escrowId, { escrowId });
    return row;
  });

  settleSoon(!verdict.passed);

  const link = paymentUrl(config, escrowId);
  const settlement = buildSettlementHeader(payment.version, {
    success: true,
    transaction: depositTx,
    network: config.network,
    payer,
  });
  const common = {
    [ESCROW_HEADER]: escrowId,
    [BACKSTOP_LINK_HEADER]: link,
    [BACKSTOP_RECEIPT_HEADER]: encodeBase64Json(encodedReceipt),
  };

  if (!outcome) {
    const current = (await getEscrow(db, escrowId))!;
    return failureResponse(current, link, settlement, { ...common, [BACKSTOP_STATUS_HEADER]: current.status });
  }
  if (!verdict.passed) {
    return failureResponse(outcome, link, settlement, { ...common, [BACKSTOP_STATUS_HEADER]: outcome.status });
  }
  return new Response(new Uint8Array(responseBody), {
    status: obs.kind === "response" ? obs.status : 200,
    headers: {
      ...upstream.headers,
      ...settlement,
      ...common,
      [BACKSTOP_STATUS_HEADER]: outcome.status,
      "cache-control": "no-store",
      "access-control-expose-headers": EXPOSED,
    },
  });
}
