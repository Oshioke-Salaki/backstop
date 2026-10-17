import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createWalletClient, http, type Hex } from "viem";
import { foundry } from "viem/chains";
import { createSiweMessage } from "viem/siwe";
import { escrowAbi, parseUsdc } from "@backstop/core";
import { accounts, balanceOf, BASE_URL, callGateway, callRoute, chainTime, FEE_BPS, KEYS, setupWorld, signPayment, travel, type World } from "./harness";

let world: World;
let providerCookie: string;
let payerCookie: string;
let adminCookie: string;
const PRICE = parseUsdc("0.05");

const routes = {
  nonce: () => import("@/app/api/auth/nonce/route"),
  verify: () => import("@/app/api/auth/verify/route"),
  session: () => import("@/app/api/auth/session/route"),
  logout: () => import("@/app/api/auth/logout/route"),
  provider: () => import("@/app/api/v1/provider/route"),
  keys: () => import("@/app/api/v1/provider/keys/route"),
  key: () => import("@/app/api/v1/provider/keys/[id]/route"),
  services: () => import("@/app/api/v1/provider/services/route"),
  service: () => import("@/app/api/v1/provider/services/[id]/route"),
  status: () => import("@/app/api/v1/provider/services/[id]/status/route"),
  test: () => import("@/app/api/v1/provider/services/[id]/test/route"),
  providerPayments: () => import("@/app/api/v1/provider/payments/route"),
  payerPayments: () => import("@/app/api/v1/payer/payments/route"),
  payment: () => import("@/app/api/v1/payments/[id]/route"),
  paymentsByPayer: () => import("@/app/api/v1/payments/route"),
  dispute: () => import("@/app/api/v1/payments/[id]/dispute/route"),
  withdraw: () => import("@/app/api/v1/payments/[id]/withdraw/route"),
  respond: () => import("@/app/api/v1/payments/[id]/respond/route"),
  refund: () => import("@/app/api/v1/payments/[id]/refund/route"),
  resolve: () => import("@/app/api/v1/payments/[id]/resolve/route"),
  publicServices: () => import("@/app/api/v1/services/route"),
  publicService: () => import("@/app/api/v1/services/[slug]/route"),
  receipts: () => import("@/app/api/v1/receipts/verify/route"),
  cron: () => import("@/app/api/cron/tick/route"),
  mcp: () => import("@/app/api/mcp/route"),
  wellKnown: () => import("@/app/.well-known/x402/route"),
  health: () => import("@/app/api/health/route"),
  adminDisputes: () => import("@/app/api/v1/admin/disputes/route"),
};
type RouteKey = keyof typeof routes;

async function call(key: RouteKey, method: string, url: string, opts: Parameters<typeof callRoute>[3] = {}) {
  return callRoute((await routes[key]()) as Record<string, unknown>, method, url, opts);
}

async function login(who: keyof typeof KEYS, domain = "backstop.test"): Promise<string> {
  const n = await call("nonce", "GET", "/api/auth/nonce");
  const nonceCookie = n.headers.get("set-cookie")!.split(";")[0]!;
  const message = createSiweMessage({
    domain,
    address: accounts[who].address,
    statement: "Sign in to Backstop.",
    uri: BASE_URL,
    version: "1",
    chainId: 31337,
    nonce: n.body.nonce,
  });
  const signature = await accounts[who].signMessage({ message });
  const v = await call("verify", "POST", "/api/auth/verify", { body: { message, signature }, cookie: nonceCookie });
  if (v.status !== 200) throw Object.assign(new Error(`login failed: ${JSON.stringify(v.body)}`), { response: v });
  const set = v.headers.getSetCookie().find((c) => c.startsWith("bs_session="))!;
  return set.split(";")[0]!;
}

async function tick() {
  const { tick } = await import("@/server/worker");
  return tick();
}

async function escrowStatus(id: string) {
  const { getDb } = await import("@/server/db/client");
  const { escrows } = await import("@/server/db/schema");
  const [row] = await (await getDb()).select({ status: escrows.status }).from(escrows).where(eq(escrows.id, id));
  return row?.status;
}

let heldServiceId: string;

/** Pay the held (dispute-window) service and return the escrow id and capability token. */
async function payHeld(city = "Lagos") {
  const payment = await signPayment(world, { amount: PRICE });
  const res = await callGateway("held-forecast", { query: `city=${city}`, payment });
  expect(res.status).toBe(200);
  const link = new URL(res.headers.get("x-backstop-payment-url")!);
  return { id: res.headers.get("x-backstop-escrow-id")!, token: link.searchParams.get("t")!, receiptHeader: res.headers.get("x-backstop-receipt")! };
}

const serviceBody = (slug: string, upstream: string, extra: Record<string, unknown> = {}) => ({
  slug,
  name: "Held forecast",
  description: "Forecasts with a one hour dispute window.",
  upstreamUrl: upstream,
  method: "GET",
  price: "0.05",
  sla: {
    maxLatencyMs: 1000,
    maxResponseBytes: 10000,
    outputSchema: { type: "object", required: ["city"], properties: { city: { type: "string" } } },
  },
  disputeWindowSeconds: 3600,
  ...extra,
});

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  world = await setupWorld();
});

afterAll(async () => {
  vi.useRealTimers();
  await world?.close();
});

describe("sign-in", () => {
  it("signs in with SIWE and reports the session", async () => {
    providerCookie = await login("provider");
    const s = await call("session", "GET", "/api/auth/session", { cookie: providerCookie });
    expect(s.body.session.address).toBe(accounts.provider.address);
    expect(s.body.session.isAdmin).toBe(false);
    adminCookie = await login("admin");
    expect((await call("session", "GET", "/api/auth/session", { cookie: adminCookie })).body.session.isAdmin).toBe(true);
    payerCookie = await login("payer");
  });

  it("rejects a message for another domain", async () => {
    await expect(login("payer", "evil.example")).rejects.toThrow(/another site/);
  });

  it("rejects verification without the nonce cookie", async () => {
    const message = createSiweMessage({ domain: "backstop.test", address: accounts.payer.address, uri: BASE_URL, version: "1", chainId: 31337, nonce: "abcdef12345678" });
    const signature = await accounts.payer.signMessage({ message });
    const v = await call("verify", "POST", "/api/auth/verify", { body: { message, signature } });
    expect(v.status).toBe(401);
    expect(v.body.error.code).toBe("nonce_expired");
  });

  it("rate-limits sign-in attempts per client", async () => {
    let limited = false;
    for (let i = 0; i < 15 && !limited; i++) limited = (await call("nonce", "GET", "/api/auth/nonce")).status === 429;
    expect(limited).toBe(true);
    const { resetRateLimitsForTesting } = await import("@/server/ratelimit");
    resetRateLimitsForTesting();
  });

  it("rejects a signature from a different wallet", async () => {
    const n = await call("nonce", "GET", "/api/auth/nonce");
    const cookie = n.headers.get("set-cookie")!.split(";")[0]!;
    const message = createSiweMessage({ domain: "backstop.test", address: accounts.payer.address, uri: BASE_URL, version: "1", chainId: 31337, nonce: n.body.nonce });
    const signature = await accounts.admin.signMessage({ message });
    expect((await call("verify", "POST", "/api/auth/verify", { body: { message, signature }, cookie })).status).toBe(401);
  });

  it("ignores forged session cookies", async () => {
    const forged = `${providerCookie.slice(0, -4)}AAAA`;
    expect((await call("session", "GET", "/api/auth/session", { cookie: forged })).body.session).toBeNull();
  });

  it("refuses cookie-authenticated writes from another origin", async () => {
    const r = await call("provider", "POST", "/api/v1/provider", { cookie: providerCookie, body: { name: "x" }, origin: "https://evil.example" });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("bad_origin");
    const noOrigin = await call("provider", "POST", "/api/v1/provider", { cookie: providerCookie, body: { name: "x" }, origin: null });
    expect(noOrigin.status).toBe(403);
  });
});

describe("provider onboarding", () => {
  it("requires sign-in", async () => {
    expect((await call("provider", "GET", "/api/v1/provider")).status).toBe(401);
  });

  it("creates a profile once and returns the signing secret once", async () => {
    const r = await call("provider", "POST", "/api/v1/provider", { cookie: providerCookie, body: { name: "Skyline Weather", website: "https://skyline.example" } });
    expect(r.status).toBe(201);
    expect(r.body.signingSecret).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(r.body.provider.payoutApproved).toBe(false);
    const again = await call("provider", "POST", "/api/v1/provider", { cookie: providerCookie, body: { name: "Again" } });
    expect(again.status).toBe(409);
    const got = await call("provider", "GET", "/api/v1/provider", { cookie: providerCookie });
    expect(JSON.stringify(got.body)).not.toContain("signingSecret");
  });

  it("validates profile input", async () => {
    const r = await call("provider", "PATCH", "/api/v1/provider", { cookie: providerCookie, body: { name: "S", website: "http://insecure.example" } });
    expect(r.status).toBe(400);
    expect(r.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual(["name", "website"]);
    const bad = await call("provider", "PATCH", "/api/v1/provider", { cookie: providerCookie, body: { name: "Skyline", payoutAddress: world.escrow } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("invalid_payout");
  });

  it("validates services field by field", async () => {
    const r = await call("services", "POST", "/api/v1/provider/services", {
      cookie: providerCookie,
      body: { ...serviceBody("A", "ftp://x"), price: "0.0001", disputeWindowSeconds: 999999, sla: { maxLatencyMs: 10, maxResponseBytes: 1 } },
    });
    expect(r.status).toBe(400);
    const paths = r.body.error.details.map((d: { path: string }) => d.path);
    for (const p of ["slug", "upstreamUrl", "price", "disputeWindowSeconds", "sla.maxLatencyMs"]) expect(paths).toContain(p);
  });

  it("rejects provider schemas that could hang the verifier", async () => {
    const r = await call("services", "POST", "/api/v1/provider/services", {
      cookie: providerCookie,
      body: serviceBody("regex-svc", `${world.upstream}/api/forecast`, { sla: { maxLatencyMs: 1000, maxResponseBytes: 100, outputSchema: { type: "string", pattern: "(a+)+$" } } }),
    });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain("pattern");
  });

  it("creates a draft, refuses activation until the payout is approved, then activates", async () => {
    const r = await call("services", "POST", "/api/v1/provider/services", { cookie: providerCookie, body: serviceBody("held-forecast", `${world.upstream}/api/forecast`) });
    expect(r.status).toBe(201);
    expect(r.body.service.status).toBe("draft");
    expect(r.body.service.upstreamUrl).toBeDefined();
    heldServiceId = r.body.service.id;

    const dup = await call("services", "POST", "/api/v1/provider/services", { cookie: providerCookie, body: serviceBody("held-forecast", `${world.upstream}/api/forecast`) });
    expect(dup.status).toBe(409);

    expect((await callGateway("held-forecast")).status).toBe(404); // drafts are invisible

    const early = await call("status", "POST", `/api/v1/provider/services/${heldServiceId}/status`, { cookie: providerCookie, params: { id: heldServiceId }, body: { status: "active" } });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("payout_pending");

    await tick(); // registrar approves the payout address on-chain
    const isPayee = await world.publicClient.readContract({ address: world.escrow, abi: escrowAbi, functionName: "isPayee", args: [accounts.provider.address] });
    expect(isPayee).toBe(true);

    const ok = await call("status", "POST", `/api/v1/provider/services/${heldServiceId}/status`, { cookie: providerCookie, params: { id: heldServiceId }, body: { status: "active" } });
    expect(ok.status).toBe(200);
    expect(ok.body.service.status).toBe("active");
  });

  it("dry-runs the upstream against the SLA without payment", async () => {
    const r = await call("test", "POST", `/api/v1/provider/services/${heldServiceId}/test`, { cookie: providerCookie, params: { id: heldServiceId }, body: { query: "city=Enugu" } });
    expect(r.status).toBe(200);
    expect(r.body.result.verdict.passed).toBe(true);
    expect(r.body.result.bodyPreview).toContain("Enugu");
    const call0 = world.upstreamRequests.findLast((q) => q.path.includes("Enugu"))!;
    expect(call0.headers["x-backstop-dry-run"]).toBe("1");
  });

  it("does not let other users see or edit the service", async () => {
    expect((await call("service", "GET", `/api/v1/provider/services/${heldServiceId}`, { cookie: payerCookie, params: { id: heldServiceId } })).status).toBe(404);
  });

  it("issues API keys that work as bearer tokens and stop working when revoked", async () => {
    const k = await call("keys", "POST", "/api/v1/provider/keys", { cookie: providerCookie, body: { label: "ci" } });
    expect(k.status).toBe(201);
    const key = k.body.key.key as string;
    expect(key.startsWith("bsk_")).toBe(true);
    const listed = await call("services", "GET", "/api/v1/provider/services", { headers: { authorization: `Bearer ${key}` } });
    expect(listed.status).toBe(200);
    expect(listed.body.services).toHaveLength(1);
    const keys = await call("keys", "GET", "/api/v1/provider/keys", { cookie: providerCookie });
    expect(JSON.stringify(keys.body)).not.toContain(key);
    expect((await call("key", "DELETE", `/api/v1/provider/keys/${k.body.key.id}`, { cookie: providerCookie, params: { id: k.body.key.id } })).status).toBe(200);
    expect((await call("services", "GET", "/api/v1/provider/services", { headers: { authorization: `Bearer ${key}` } })).status).toBe(401);
  });
});

describe("payment views", () => {
  it("is visible with the capability link and to the right sessions only", async () => {
    const { id, token } = await payHeld();
    const viaToken = await call("payment", "GET", `/api/v1/payments/${id}?t=${token}`, { params: { id } });
    expect(viaToken.status).toBe(200);
    expect(viaToken.body.viewer).toBe("payer");
    expect(viaToken.body.payment.status).toBe("release_pending");
    expect(viaToken.body.payment.canDispute).toBe(true);
    expect(viaToken.body.payment.outcome.payee).toBe("0.0495");

    expect((await call("payment", "GET", `/api/v1/payments/${id}?t=nope`, { params: { id } })).status).toBe(404);
    expect((await call("payment", "GET", `/api/v1/payments/${id}`, { params: { id } })).status).toBe(404);
    expect((await call("payment", "GET", `/api/v1/payments/${id}`, { params: { id }, cookie: providerCookie })).body.viewer).toBe("provider");
    expect((await call("payment", "GET", `/api/v1/payments/${id}`, { params: { id }, cookie: adminCookie })).body.viewer).toBe("admin");
    expect((await call("payment", "GET", `/api/v1/payments/${id}`, { params: { id }, cookie: payerCookie })).body.viewer).toBe("payer");
  });

  it("lists payments for payer and provider with pagination", async () => {
    const payer = await call("payerPayments", "GET", "/api/v1/payer/payments", { cookie: payerCookie });
    expect(payer.status).toBe(200);
    expect(payer.body.items.length).toBeGreaterThan(0);
    const provider = await call("providerPayments", "GET", "/api/v1/provider/payments?status=release_pending", { cookie: providerCookie });
    expect(provider.body.items.every((i: { status: string }) => i.status === "release_pending")).toBe(true);
    expect((await call("providerPayments", "GET", "/api/v1/provider/payments?cursor=garbage", { cookie: providerCookie })).status).toBe(400);
  });

  it("lists a wallet's recent payments, status only, without capability tokens", async () => {
    const { id } = await payHeld("Onitsha");
    const r = await call("paymentsByPayer", "GET", `/api/v1/payments?payer=${accounts.payer.address.toLowerCase()}&limit=5`);
    expect(r.status).toBe(200);
    expect(r.body.payer).toBe(accounts.payer.address);
    expect(r.body.payments.length).toBeLessThanOrEqual(5);
    expect(r.body.payments[0]).toMatchObject({ id, status: "release_pending", amount: "0.05", service: { slug: "held-forecast" } });
    const raw = JSON.stringify(r.body);
    expect(raw).not.toMatch(/[?&]t=|"token"|paymentUrl/);
    expect((await call("paymentsByPayer", "GET", "/api/v1/payments?payer=nope")).status).toBe(400);
    const other = await call("paymentsByPayer", "GET", `/api/v1/payments?payer=${accounts.admin.address}`);
    expect(other.body.payments).toEqual([]);
  });

  it("verifies receipts and rejects tampered ones", async () => {
    const { receiptHeader } = await payHeld("Kaduna");
    const ok = await call("receipts", "POST", "/api/v1/receipts/verify", { body: { header: receiptHeader } });
    expect(ok.body.valid).toBe(true);
    const decoded = JSON.parse(Buffer.from(receiptHeader, "base64").toString());
    decoded.receipt.amount = "1";
    expect((await call("receipts", "POST", "/api/v1/receipts/verify", { body: decoded })).body.valid).toBe(false);
  });
});

describe("disputes", () => {
  it("holds funds, extends the deadline, lets the provider answer, and settles an arbiter's split", async () => {
    const { id, token } = await payHeld("Owerri");
    const before = (await world.publicClient.readContract({ address: world.escrow, abi: escrowAbi, functionName: "getEscrow", args: [id as Hex] })).deadline;
    const payerBefore = await balanceOf(world, accounts.payer.address);
    const payeeBefore = await balanceOf(world, accounts.provider.address);

    const short = await call("dispute", "POST", `/api/v1/payments/${id}/dispute?t=${token}`, { params: { id }, body: { reason: "wrong_content", statement: "too short" }, origin: null });
    expect(short.status).toBe(400);

    const opened = await call("dispute", "POST", `/api/v1/payments/${id}/dispute?t=${token}`, {
      params: { id },
      body: { reason: "wrong_content", statement: "The temperature is fabricated; it was 24C, not 29.5C." },
      origin: null,
    });
    expect(opened.status).toBe(201);
    expect(opened.body.payment.status).toBe("disputed");
    expect(opened.body.payment.canWithdraw).toBe(true);

    const twice = await call("dispute", "POST", `/api/v1/payments/${id}/dispute?t=${token}`, { params: { id }, body: { reason: "other", statement: "Filing a second time to test the guard." }, origin: null });
    expect(twice.body.error.code).toBe("already_disputed");

    await tick(); // extend job
    const after = (await world.publicClient.readContract({ address: world.escrow, abi: escrowAbi, functionName: "getEscrow", args: [id as Hex] })).deadline;
    expect(after).toBeGreaterThan(before);

    // Only the provider can answer; only an arbiter can decide.
    expect((await call("respond", "POST", `/api/v1/payments/${id}/respond`, { params: { id }, cookie: payerCookie, body: { statement: "I am not the provider." } })).status).toBe(403);
    const answered = await call("respond", "POST", `/api/v1/payments/${id}/respond`, { params: { id }, cookie: providerCookie, body: { statement: "Our station reported 29.5C at 14:00." } });
    expect(answered.status).toBe(200);
    expect(answered.body.payment.dispute.providerStatement).toContain("29.5C");
    expect((await call("resolve", "POST", `/api/v1/payments/${id}/resolve`, { params: { id }, cookie: providerCookie, body: { decision: "release", note: "self-serving" } })).status).toBe(403);

    const queue = await call("adminDisputes", "GET", "/api/v1/admin/disputes", { cookie: adminCookie });
    expect(queue.body.disputes.some((d: { escrowId: string }) => d.escrowId === id)).toBe(true);
    expect((await call("adminDisputes", "GET", "/api/v1/admin/disputes", { cookie: payerCookie })).status).toBe(403);

    const tooMuch = await call("resolve", "POST", `/api/v1/payments/${id}/resolve`, { params: { id }, cookie: adminCookie, body: { decision: "split", payerAmount: "50001", note: "invalid split" } });
    expect(tooMuch.body.error.code).toBe("invalid_split");

    const resolved = await call("resolve", "POST", `/api/v1/payments/${id}/resolve`, { params: { id }, cookie: adminCookie, body: { decision: "split", payerAmount: "20000", note: "Partly accurate." } });
    expect(resolved.status).toBe(200);
    await tick();
    expect(await escrowStatus(id)).toBe("split");
    const payeeShare = 30_000n - (30_000n * BigInt(FEE_BPS)) / 10_000n;
    expect(await balanceOf(world, accounts.payer.address)).toBe(payerBefore + 20_000n);
    expect(await balanceOf(world, accounts.provider.address)).toBe(payeeBefore + payeeShare);
  });

  it("refunds automatically when the provider ignores a dispute", async () => {
    const { id, token } = await payHeld("Uyo");
    const before = await balanceOf(world, accounts.payer.address);
    await call("dispute", "POST", `/api/v1/payments/${id}/dispute?t=${token}`, { params: { id }, body: { reason: "incomplete", statement: "The forecast omitted the humidity data." }, origin: null });
    const { getDb } = await import("@/server/db/client");
    const { disputes } = await import("@/server/db/schema");
    await (await getDb()).update(disputes).set({ respondBy: new Date(Date.now() - 1000) }).where(eq(disputes.escrowId, id));
    await tick();
    expect(await escrowStatus(id)).toBe("refunded");
    expect(await balanceOf(world, accounts.payer.address)).toBe(before + PRICE);
  });

  it("lets the payer withdraw, paying the provider", async () => {
    const { id, token } = await payHeld("Ilorin");
    await call("dispute", "POST", `/api/v1/payments/${id}/dispute?t=${token}`, { params: { id }, body: { reason: "other", statement: "Filed by mistake, will withdraw." }, origin: null });
    const w = await call("withdraw", "POST", `/api/v1/payments/${id}/withdraw?t=${token}`, { params: { id }, origin: null });
    expect(w.status).toBe(200);
    await tick();
    expect(await escrowStatus(id)).toBe("released");
  });

  it("lets the provider refund voluntarily during the hold", async () => {
    const { id } = await payHeld("Yola");
    const before = await balanceOf(world, accounts.payer.address);
    const r = await call("refund", "POST", `/api/v1/payments/${id}/refund`, { params: { id }, cookie: providerCookie });
    expect(r.status).toBe(200);
    await tick();
    expect(await escrowStatus(id)).toBe("refunded");
    expect(await balanceOf(world, accounts.payer.address)).toBe(before + PRICE);
    const again = await call("refund", "POST", `/api/v1/payments/${id}/refund`, { params: { id }, cookie: providerCookie });
    expect(again.body.error.code).toBe("not_refundable");
  });
});

describe("agents over MCP", () => {
  const rpc = (body: unknown) => call("mcp", "POST", "/api/mcp", { body, origin: null });

  it("initializes and lists tools", async () => {
    const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    expect(init.body.result.serverInfo.name).toBe("backstop");
    expect((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    const tools = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(tools.body.result.tools.map((t: { name: string }) => t.name).sort()).toEqual(
      ["get_payment", "get_service", "open_dispute", "search_services", "verify_receipt", "withdraw_dispute"].sort(),
    );
  });

  it("finds services and checks payments with the capability token", async () => {
    const found = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_services", arguments: { query: "forecast" } } });
    expect(found.body.result.structuredContent.services[0].slug).toBe("held-forecast");
    const { id, token } = await payHeld("Bauchi");
    const p = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_payment", arguments: { escrowId: id, token } } });
    expect(p.body.result.isError).toBe(false);
    expect(p.body.result.structuredContent.status).toBe("release_pending");
    const denied = await rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "get_payment", arguments: { escrowId: id, token: "wrong-token-value" } } });
    expect(denied.body.result.isError).toBe(true);
  });

  it("reports tool and protocol errors properly", async () => {
    expect((await rpc({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "nope" } })).body.error.code).toBe(-32602);
    expect((await rpc({ jsonrpc: "2.0", id: 7, method: "bogus" })).body.error.code).toBe(-32601);
    expect((await rpc([{ jsonrpc: "2.0", id: 8, method: "ping" }])).status).toBe(400);
    const invalid = await rpc({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "open_dispute", arguments: { escrowId: "0x1", token: "x" } } });
    expect(invalid.body.result.isError).toBe(true);
  });
});

describe("public surfaces", () => {
  it("lists services, scorecards, and the x402 discovery document", async () => {
    const list = await call("publicServices", "GET", "/api/v1/services?q=forecast");
    expect(list.body.services).toHaveLength(1);
    expect(list.body.services[0].upstreamUrl).toBeUndefined();
    const detail = await call("publicService", "GET", "/api/v1/services/held-forecast", { params: { slug: "held-forecast" } });
    expect(detail.body.scorecard.calls).toBeGreaterThan(0);
    expect(detail.body.scorecard.deliveryRate).toBe(1);
    const wk = await call("wellKnown", "GET", "/.well-known/x402");
    expect(wk.body.resources[0].resource).toBe(`${BASE_URL}/x/held-forecast`);
    expect((await call("health", "GET", "/api/health")).body.ok).toBe(true);
  });

  it("protects the cron endpoint", async () => {
    expect((await call("cron", "POST", "/api/cron/tick", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    const ok = await call("cron", "POST", "/api/cron/tick", { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
    expect(ok.status).toBe(200);
    expect(ok.body.report).toBeDefined();
  });
});

describe("deadlines (run last: moves the clock)", () => {
  it("closes the dispute window, then releases", async () => {
    const { id, token } = await payHeld("Sokoto");
    await travel(world, 3601);
    const late = await call("dispute", "POST", `/api/v1/payments/${id}/dispute?t=${token}`, { params: { id }, body: { reason: "other", statement: "Too late to be filing this one." }, origin: null });
    expect(late.body.error.code).toBe("window_closed");
    await tick();
    expect(await escrowStatus(id)).toBe("released");
  });

  it("picks up a payer's own on-chain reclaim after the deadline", async () => {
    const { id } = await payHeld("Zaria");
    // Simulate the worker being down for the whole hold and grace period.
    await travel(world, 3600 + 3600 + 60);
    const payer = createWalletClient({ chain: foundry, transport: http(world.rpcUrl), account: accounts.payer });
    const hash = await payer.writeContract({ address: world.escrow, abi: escrowAbi, functionName: "reclaim", args: [id as Hex] });
    await world.publicClient.waitForTransactionReceipt({ hash });
    await tick();
    expect(await escrowStatus(id)).toBe("reclaimed");
  });

  it("refunds an escrow whose deadline passed with nobody acting", async () => {
    const { id } = await payHeld("Minna");
    const before = await balanceOf(world, accounts.payer.address);
    // Pretend the release job was lost, so only the expiry sweep can rescue the funds.
    const { getDb } = await import("@/server/db/client");
    const { jobs } = await import("@/server/db/schema");
    await (await getDb()).update(jobs).set({ status: "failed" }).where(eq(jobs.escrowId, id));
    await travel(world, 3600 + 3600 + 60);
    expect(await chainTime(world)).toBeGreaterThan(0);
    await tick();
    expect(await escrowStatus(id)).toBe("refunded");
    expect(await balanceOf(world, accounts.payer.address)).toBe(before + PRICE);
  });
});
