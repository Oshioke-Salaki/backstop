import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Hex } from "viem";
import { decodeBase64Json, escrowAbi, parseUsdc, verifyProviderRequest, verifyReceipt, type EncodedReceipt } from "@backstop/core";
import { accounts, balanceOf, callGateway, chainTime, FEE_BPS, setupWorld, signPayment, type World } from "./harness";

let world: World;
const services: Record<string, { id: string; slug: string }> = {};
let signingSecret: string;

const PRICE = parseUsdc("0.05");
const FEE = (PRICE * BigInt(FEE_BPS)) / 10_000n;

const forecastSla = {
  maxLatencyMs: 800,
  maxResponseBytes: 10_000,
  outputSchema: {
    type: "object",
    required: ["city", "temperature"],
    properties: { city: { type: "string" }, temperature: { type: "number" } },
  },
  assertions: [{ op: "nonEmpty", path: "/city" }],
};

async function tick() {
  const { tick } = await import("@/server/worker");
  return tick();
}

async function escrowRow(id: string) {
  const { getDb } = await import("@/server/db/client");
  const { escrows } = await import("@/server/db/schema");
  const db = await getDb();
  const [row] = await db.select().from(escrows).where(eq(escrows.id, id)).limit(1);
  return row!;
}

async function onchain(id: string) {
  return world.publicClient.readContract({ address: world.escrow, abi: escrowAbi, functionName: "getEscrow", args: [id as Hex] });
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  world = await setupWorld();
  const { createProvider } = await import("@/server/providers");
  const { createService, setServiceStatus } = await import("@/server/services");

  const { provider, signingSecret: secret } = await createProvider({ address: accounts.provider.address, isAdmin: false }, { name: "Skyline Weather" });
  signingSecret = secret;
  const report = await tick(); // approves the payout address on-chain
  expect(report.jobsRun).toBe(1);

  const make = async (slug: string, upstreamPath: string, extra: Record<string, unknown> = {}) => {
    const s = await createService(provider.id, {
      slug,
      name: slug,
      description: "Current conditions for a city.",
      upstreamUrl: `${world.upstream}${upstreamPath}`,
      method: "GET",
      price: PRICE,
      sla: { expectStatus: [200], contentType: "application/json", ...forecastSla },
      inputSchema: null,
      disputeWindowSeconds: 0,
      ...extra,
    } as never);
    await setServiceStatus(provider.id, s.id, "active");
    services[slug] = { id: s.id, slug };
  };
  await make("forecast", "/api/forecast", {
    inputSchema: { type: "object", required: ["city"], properties: { city: { type: "string", minLength: 2 } }, additionalProperties: false },
  });
  await make("broken", "/api/broken");
  await make("slow", "/api/slow");
  await make("erroring", "/api/error");
  await make("greedy", "/api/charge-again");
  await make("echo", "/api/echo", { method: "POST" });
});

afterAll(async () => {
  vi.useRealTimers();
  await world?.close();
});

describe("before payment", () => {
  it("answers 402 with v1 body and v2 header naming the escrow", async () => {
    const res = await callGateway("forecast", { query: "city=Lagos" });
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.x402Version).toBe(1);
    const req = body.accepts[0];
    expect(req.payTo.toLowerCase()).toBe(world.escrow.toLowerCase());
    expect(req.asset.toLowerCase()).toBe(world.usdc.toLowerCase());
    expect(req.maxAmountRequired).toBe(PRICE.toString());
    expect(req.network).toBe("localhost");
    expect(req.extra.backstop.protected).toBe(true);
    const v2 = decodeBase64Json(res.headers.get("payment-required")!) as { accepts: Array<Record<string, string>> };
    expect(v2.accepts[0]!).toMatchObject({ network: "eip155:31337", amount: PRICE.toString() });
    expect(v2.accepts[0]!.payTo!.toLowerCase()).toBe(world.escrow.toLowerCase());
  });

  it("rejects bad input before taking any money", async () => {
    const before = await balanceOf(world, accounts.payer.address);
    const payment = await signPayment(world, { amount: PRICE });
    const res = await callGateway("forecast", { query: "city=X", payment });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_input");
    expect(await balanceOf(world, accounts.payer.address)).toBe(before);
  });

  it("404s unknown services, 405s wrong methods, 400s traversal and GET bodies", async () => {
    expect((await callGateway("nope")).status).toBe(404);
    expect((await callGateway("forecast", { method: "POST", body: "{}" })).status).toBe(405);
    expect((await callGateway("broken", { path: [".."] })).status).toBe(400);
    expect((await callGateway("broken", { path: ["a%2Fb"] })).status).toBe(400);
  });
});

describe("rejected payments cost nothing", () => {
  const cases: Array<[string, () => Promise<{ header: string; headerName: string }>, string]> = [
    ["wrong amount", () => signPayment(world, { amount: PRICE - 1n }), "wrong_amount"],
    ["wrong recipient", () => signPayment(world, { amount: PRICE, to: accounts.provider.address }), "wrong_recipient"],
    ["wrong network", () => signPayment(world, { amount: PRICE, network: "base" }), "wrong_network"],
    ["expiring authorization", () => signPayment(world, { amount: PRICE, validBefore: BigInt(Math.floor(Date.now() / 1000) + 10) }), "expires_too_soon"],
    ["future authorization", () => signPayment(world, { amount: PRICE, validAfter: BigInt(Math.floor(Date.now() / 1000) + 100) }), "not_yet_valid"],
    ["garbage header", async () => ({ header: "not-base64!!", headerName: "x-payment" }), "invalid_payment"],
  ];
  it.each(cases)("%s → 402 %s", async (_name, make, code) => {
    const before = await balanceOf(world, accounts.payer.address);
    const res = await callGateway("forecast", { query: "city=Lagos", payment: await make() });
    expect(res.status).toBe(402);
    expect((await res.json()).code).toBe(code);
    expect(await balanceOf(world, accounts.payer.address)).toBe(before);
  });

  it("refuses a payer without funds and records the failed attempt", async () => {
    const payment = await signPayment(world, { amount: PRICE, payer: "poorPayer" });
    const res = await callGateway("forecast", { query: "city=Lagos", payment });
    expect(res.status).toBe(402);
    expect((await res.json()).code).toBe("insufficient_funds");
    expect(world.upstreamRequests.some((r) => r.path.includes("Lagos") && r.headers["x-backstop-payer"] === accounts.poorPayer.address)).toBe(false);
  });
});

describe("delivered", () => {
  it("holds funds, calls the provider signed, returns its response, then releases", async () => {
    const payerBefore = await balanceOf(world, accounts.payer.address);
    const payeeBefore = await balanceOf(world, accounts.provider.address);
    const payment = await signPayment(world, { amount: PRICE });

    const res = await callGateway("forecast", { query: "city=Accra", payment });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ city: "Accra", temperature: 29.5 });
    const escrowId = res.headers.get("x-backstop-escrow-id")!;
    expect(res.headers.get("x-backstop-status")).toBe("release_pending");
    expect(res.headers.get("x-backstop-payment-url")).toContain(`/p/${escrowId}?t=`);
    expect(decodeBase64Json(res.headers.get("x-payment-response")!)).toMatchObject({ success: true, network: "localhost" });

    // The provider got a request it can verify as paid and from Backstop.
    const call = world.upstreamRequests.findLast((r) => r.path.includes("Accra"))!;
    expect(call.headers["x-backstop-escrow-id"]).toBe(escrowId);
    expect(
      verifyProviderRequest(signingSecret, call.headers["x-backstop-signature"] as string, {
        escrowId,
        method: "GET",
        path: "/api/forecast?city=Accra",
        body: new Uint8Array(),
        nowSeconds: Math.floor(Date.now() / 1000),
      }),
    ).toBe(true);

    // Receipt is signed by the configured receipt key.
    const receipt = decodeBase64Json(res.headers.get("x-backstop-receipt")!) as EncodedReceipt;
    const verified = await verifyReceipt(receipt, { chainId: 31337, escrow: world.escrow }, accounts.receipt.address);
    expect(verified.valid).toBe(true);
    expect(verified.receipt?.passed).toBe(true);

    expect((await onchain(escrowId)).status).toBe(1);
    expect(await balanceOf(world, accounts.payer.address)).toBe(payerBefore - PRICE);

    await tick();
    expect((await escrowRow(escrowId)).status).toBe("released");
    expect((await onchain(escrowId)).status).toBe(2);
    expect(await balanceOf(world, accounts.provider.address)).toBe(payeeBefore + PRICE - FEE);
  });

  it("accepts x402 v2 payments and answers in v2", async () => {
    const payment = await signPayment(world, { amount: PRICE, version: 2 });
    const res = await callGateway("forecast", { query: "city=Kano", payment });
    expect(res.status).toBe(200);
    expect(decodeBase64Json(res.headers.get("payment-response")!)).toMatchObject({ network: "eip155:31337" });
    expect(res.headers.get("x-payment-response")).toBeNull();
  });

  it("replays the same response for a retried payment without charging twice", async () => {
    const payment = await signPayment(world, { amount: PRICE });
    const first = await callGateway("forecast", { query: "city=Abuja", payment });
    expect(first.status).toBe(200);
    const after = await balanceOf(world, accounts.payer.address);
    const calls = world.upstreamRequests.length;

    const again = await callGateway("forecast", { query: "city=Abuja", payment });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(await first.json());
    expect(again.headers.get("x-backstop-escrow-id")).toBe(first.headers.get("x-backstop-escrow-id"));
    expect(await balanceOf(world, accounts.payer.address)).toBe(after);
    expect(world.upstreamRequests.length).toBe(calls);
  });

  it("refuses to reuse a payment for a different request", async () => {
    const payment = await signPayment(world, { amount: PRICE });
    expect((await callGateway("forecast", { query: "city=Ibadan", payment })).status).toBe(200);
    const res = await callGateway("forecast", { query: "city=Benin", payment });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("payment_reused");
  });

  it("charges once when the same payment arrives concurrently", async () => {
    const payment = await signPayment(world, { amount: PRICE });
    const before = await balanceOf(world, accounts.payer.address);
    const results = await Promise.all([1, 2, 3].map(() => callGateway("forecast", { query: "city=Jos", payment })));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    expect(statuses.every((s) => s === 200 || s === 409)).toBe(true);
    expect(await balanceOf(world, accounts.payer.address)).toBe(before - PRICE);
  });

  it("forwards POST bodies", async () => {
    const payment = await signPayment(world, { amount: PRICE });
    const res = await callGateway("echo", { method: "POST", body: JSON.stringify({ q: "hello" }), payment });
    expect(res.status).toBe(200);
    expect((await res.json()).received).toEqual({ q: "hello" });
  });
});

describe("not delivered: refunded in full", () => {
  it.each([
    ["broken", "schema_mismatch"],
    ["slow", "timeout"],
    ["erroring", "upstream_status"],
    ["greedy", "payment_loop"],
  ])("%s → 502 %s, then refunded", async (slug, reason) => {
    const before = await balanceOf(world, accounts.payer.address);
    const payment = await signPayment(world, { amount: PRICE });
    const res = await callGateway(slug, { payment });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe("delivery_failed");
    expect(body.error.reason).toBe(reason);
    expect(body.error.refund.status).toBe("pending");
    const id = body.error.escrowId as string;
    expect(await balanceOf(world, accounts.payer.address)).toBe(before - PRICE);

    await tick();
    expect((await escrowRow(id)).status).toBe("refunded");
    expect((await onchain(id)).status).toBe(3);
    expect(await balanceOf(world, accounts.payer.address)).toBe(before);

    // A retry with the same payment reports the refund instead of charging again.
    const again = await callGateway(slug, { payment });
    expect(again.status).toBe(502);
    expect((await again.json()).error.refund.status).toBe("complete");
  });

  it("never passes a failed body through to the agent", async () => {
    const payment = await signPayment(world, { amount: PRICE });
    const res = await callGateway("broken", { payment });
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain('"wrong":true');
  });
});

describe("service availability", () => {
  it("rejects paused services before payment", async () => {
    const { setServiceStatus } = await import("@/server/services");
    const { getProviderForOwner } = await import("@/server/providers");
    const p = (await getProviderForOwner(accounts.provider.address))!;
    await setServiceStatus(p.id, services.broken!.id, "paused");
    const res = await callGateway("broken", { payment: await signPayment(world, { amount: PRICE }) });
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("service_paused");
    await setServiceStatus(p.id, services.broken!.id, "active");
  });
});

describe("reconciliation", () => {
  it("refunds a deposit that landed while the gateway was down", async () => {
    const { getDb } = await import("@/server/db/client");
    const { escrows } = await import("@/server/db/schema");
    const { escrowIdFor } = await import("@/server/gateway");
    const { verifyAuthorization } = await import("@backstop/core");
    const { sendEscrowTx, waitForTx } = await import("@/server/chain");
    const { decodePayment, NETWORKS } = await import("@backstop/core");

    await tick(); // settle anything earlier tests left pending, so balances below are exact
    const before = await balanceOf(world, accounts.payer.address);
    const payment = await signPayment(world, { amount: PRICE });
    const decoded = decodePayment(payment.header);
    const v = await verifyAuthorization(decoded, {
      network: NETWORKS.localhost,
      asset: world.usdc,
      assetName: "USD Coin",
      assetVersion: "2",
      escrow: world.escrow,
      amount: PRICE,
      payee: accounts.provider.address,
      minValiditySeconds: 10,
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    const id = escrowIdFor(v.from, v.nonce);
    const db = await getDb();
    const stale = new Date(Date.now() - 10 * 60_000);
    await db.insert(escrows).values({
      id,
      serviceId: services.forecast!.id,
      payer: v.from,
      payee: accounts.provider.address,
      amountAtomic: v.value,
      nonce: v.nonce,
      validBefore: v.validBefore,
      requestHash: `0x${"00".repeat(32)}`,
      status: "funding",
      createdAt: stale,
      updatedAt: stale,
    });
    // Deposit lands on-chain, but the process "crashes" before recording it.
    const hash = await sendEscrowTx("depositor", {
      functionName: "deposit",
      args: [{ from: v.from, value: v.value, validAfter: v.validAfter, validBefore: v.validBefore, nonce: v.nonce, v: v.v, r: v.r, s: v.s }, accounts.provider.address, (await chainTime(world)) + 7200],
    });
    expect((await waitForTx(hash)).status).toBe("success");
    expect(await balanceOf(world, accounts.payer.address)).toBe(before - PRICE);

    await tick(); // funding → held → refund_pending, and the refund job runs in the same pass
    expect((await escrowRow(id)).status).toBe("refunded");
    expect(await balanceOf(world, accounts.payer.address)).toBe(before);
  });

  it("marks a never-landed deposit as failed once its authorization expires", async () => {
    const { getDb } = await import("@/server/db/client");
    const { escrows } = await import("@/server/db/schema");
    const db = await getDb();
    const id = `0x${"ab".repeat(32)}`;
    const old = new Date(Date.now() - 60 * 60_000);
    await db.insert(escrows).values({
      id,
      serviceId: services.forecast!.id,
      payer: accounts.payer.address,
      payee: accounts.provider.address,
      amountAtomic: PRICE,
      nonce: `0x${"cd".repeat(32)}`,
      validBefore: BigInt(Math.floor(old.getTime() / 1000)),
      requestHash: `0x${"00".repeat(32)}`,
      status: "funding",
      createdAt: old,
      updatedAt: old,
    });
    await tick();
    expect((await escrowRow(id)).status).toBe("funding_failed");
  });
});
