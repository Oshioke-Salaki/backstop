/**
 * End-to-end check against a deployed Backstop, with real payments on its chain.
 *
 *   BASE_URL=https://… RPC_URL=… CRON_SECRET=… \
 *   PROVIDER_PRIVATE_KEY=0x… DEMO_PAYER_PRIVATE_KEY=0x… ARBITER_PRIVATE_KEY=0x… pnpm e2e:live
 *
 * It signs in with SIWE, creates (or reuses) a provider and four demo services, dry-runs them, then
 * pays each one and checks every outcome against on-chain balances: delivered, retried without a
 * second charge, refunded on failed checks, rejected bad input without charge, and disputed then split
 * by the arbiter. Costs about 0.35 USDC of the payer's test funds per run (refunds come back).
 */
import { createPublicClient, erc20Abi, getAddress, http, type Address, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { decodeBase64Json, encodeBase64Json, escrowAbi, TRANSFER_WITH_AUTHORIZATION_TYPES, type EncodedReceipt } from "@backstop/core";

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
};
const BASE = env("BASE_URL").replace(/\/$/, "");
const HOST = new URL(BASE).host;
const CRON = env("CRON_SECRET");
const provider = privateKeyToAccount(env("PROVIDER_PRIVATE_KEY") as Hex);
const payer = privateKeyToAccount(env("DEMO_PAYER_PRIVATE_KEY") as Hex);
const arbiter = privateKeyToAccount(env("ARBITER_PRIVATE_KEY") as Hex);

let passed = 0;
function check(cond: unknown, label: string, detail?: unknown): asserts cond {
  if (!cond) {
    console.error(`  ✕ ${label}`, detail === undefined ? "" : JSON.stringify(detail, null, 2).slice(0, 1500));
    throw new Error(`check failed: ${label}`);
  }
  passed++;
  console.log(`  ✓ ${label}`);
}
const step = (title: string) => console.log(`\n${title}`);

async function http_(path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.method && init.method !== "GET") headers.set("origin", BASE);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const res = await fetch(`${BASE}${path}`, { ...init, headers, redirect: "manual" });
  const text = await res.text();
  let body: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any -- response shapes vary per route
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, headers: res.headers, body };
}

async function login(account: PrivateKeyAccount, chainId: number): Promise<string> {
  const n = await http_("/api/auth/nonce");
  const nonceCookie = n.headers.getSetCookie().find((c) => c.startsWith("bs_nonce="))!.split(";")[0]!;
  const message = createSiweMessage({ domain: HOST, address: account.address, statement: "Sign in to Backstop.", uri: BASE, version: "1", chainId, nonce: n.body.nonce });
  const signature = await account.signMessage({ message });
  const v = await http_("/api/auth/verify", { method: "POST", body: JSON.stringify({ message, signature }), cookie: nonceCookie });
  check(v.status === 200, `signed in ${account.address.slice(0, 10)}…`, v.body);
  return v.headers.getSetCookie().find((c) => c.startsWith("bs_session="))!.split(";")[0]!;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run settlement passes until `done` holds, waiting between passes so deferred retries come due. */
async function settleUntil<T>(read: () => Promise<T>, done: (v: T) => boolean, timeoutMs = 120_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < until) {
    await tick();
    value = await read();
    if (!done(value)) await sleep(3_000);
  }
  return value;
}

async function tick() {
  const r = await http_("/api/cron/tick", { method: "POST", headers: { authorization: `Bearer ${CRON}` } });
  if (r.status !== 200) throw new Error(`tick failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.report;
}

async function main() {
  const config = (await http_("/api/v1/config")).body;
  const chain = createPublicClient({ transport: http(env("RPC_URL")) });
  check((await chain.getChainId()) === config.network.chainId, `RPC is chain ${config.network.chainId}`);
  const usdc = getAddress(config.asset.address) as Address;
  const escrow = getAddress(config.escrow) as Address;
  const balance = () => chain.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [payer.address] });

  step("1. Health and configuration");
  const health = await http_("/api/health");
  check(health.body?.ok === true, "database and chain reachable", health.body);

  step("2. Provider onboarding");
  const providerCookie = await login(provider, config.network.chainId);
  let profile = await http_("/api/v1/provider", { cookie: providerCookie });
  if (profile.status === 404) {
    const created = await http_("/api/v1/provider", { method: "POST", cookie: providerCookie, body: JSON.stringify({ name: "Skyline Data (demo)", website: "https://github.com/Oshioke-Salaki/backstop" }) });
    check(created.status === 201 && created.body.signingSecret, "provider profile created, signing secret shown once", created.body);
    profile = await http_("/api/v1/provider", { cookie: providerCookie });
  } else {
    check(profile.status === 200, "provider profile exists (re-run)");
  }
  profile = await settleUntil(() => http_("/api/v1/provider", { cookie: providerCookie }), (p) => p.body.provider.payoutApproved);
  check(profile.body.provider.payoutApproved, "payout address approved on-chain");
  check(await chain.readContract({ address: escrow, abi: escrowAbi, functionName: "isPayee", args: [provider.address] }), "escrow lists the provider as payee");

  step("3. Services: create, dry-run, publish");
  const json = "application/json";
  const specs = [
    {
      slug: "skyline-forecast",
      name: "City forecast",
      description: "Current temperature and conditions for any city.",
      upstreamUrl: `${BASE}/demo-provider/forecast`,
      method: "GET",
      price: "0.05",
      disputeWindowSeconds: 3600,
      inputSchema: { type: "object", required: ["city"], properties: { city: { type: "string", minLength: 2 } } },
      sla: {
        maxLatencyMs: 10000,
        maxResponseBytes: 16384,
        contentType: json,
        outputSchema: { type: "object", required: ["city", "temperature"], properties: { city: { type: "string" }, temperature: { type: "number" } } },
        assertions: [{ op: "nonEmpty", path: "/city" }, { op: "gte", path: "/temperature", value: -90 }],
      },
      dry: { query: "city=Lagos", pass: true },
    },
    {
      slug: "skyline-fx",
      name: "FX rate",
      description: "Interbank closing rate for a currency pair, paid the moment checks pass.",
      upstreamUrl: `${BASE}/demo-provider/fx`,
      method: "GET",
      price: "0.02",
      disputeWindowSeconds: 0,
      sla: { maxLatencyMs: 10000, maxResponseBytes: 4096, contentType: json, outputSchema: { type: "object", required: ["pair", "rate"], properties: { rate: { type: "number" } } }, assertions: [{ op: "gte", path: "/rate", value: 0 }] },
      dry: { query: "pair=USD/NGN", pass: true },
    },
    {
      slug: "skyline-headlines",
      name: "Market headlines",
      description: "Top market headlines. Currently broken on purpose, to demonstrate refunds.",
      upstreamUrl: `${BASE}/demo-provider/headlines`,
      method: "GET",
      price: "0.01",
      disputeWindowSeconds: 900,
      sla: { maxLatencyMs: 10000, maxResponseBytes: 32768, contentType: json, outputSchema: { type: "object", required: ["headlines"], properties: { headlines: { type: "array" } } }, assertions: [{ op: "minItems", path: "/headlines", value: 1 }] },
      dry: { query: "", pass: false },
    },
    {
      slug: "kite-summarize",
      name: "Summarize text",
      description: "A one-line summary of a passage, with its word count.",
      upstreamUrl: `${BASE}/demo-provider/summarize`,
      method: "POST",
      price: "0.25",
      disputeWindowSeconds: 86400,
      inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string", minLength: 1 } } },
      sla: { maxLatencyMs: 10000, maxResponseBytes: 65536, contentType: json, outputSchema: { type: "object", required: ["summary"], properties: { summary: { type: "string" } } }, assertions: [{ op: "minLength", path: "/summary", value: 1 }] },
      dry: { query: "", body: JSON.stringify({ text: "Backstop holds payments until delivery is verified." }), pass: true },
    },
  ];
  const existing = (await http_("/api/v1/provider/services", { cookie: providerCookie })).body.services as Array<{ id: string; slug: string; status: string }>;
  for (const spec of specs) {
    const { dry, ...body } = spec;
    let svc = existing.find((s) => s.slug === spec.slug);
    if (!svc) {
      const created = await http_("/api/v1/provider/services", { method: "POST", cookie: providerCookie, body: JSON.stringify(body) });
      check(created.status === 201, `created ${spec.slug}`, created.body);
      svc = created.body.service;
    }
    const test = await http_(`/api/v1/provider/services/${svc!.id}/test`, { method: "POST", cookie: providerCookie, body: JSON.stringify({ query: dry.query, ...(dry.body ? { body: dry.body } : {}) }) });
    check(test.status === 200 && test.body.result.verdict.passed === dry.pass, `dry-run ${spec.slug} ${dry.pass ? "passes" : "fails as designed"}`, test.body);
    if (svc!.status !== "active") {
      const on = await http_(`/api/v1/provider/services/${svc!.id}/status`, { method: "POST", cookie: providerCookie, body: JSON.stringify({ status: "active" }) });
      check(on.status === 200, `published ${spec.slug}`, on.body);
    }
  }

  let counter = 0;
  async function pay(slug: string, opts: { query?: string; body?: string } = {}) {
    const path = `/x/${slug}${opts.query ? `?${opts.query}` : ""}`;
    const method = opts.body ? "POST" : "GET";
    const first = await http_(path, { method, body: opts.body });
    check(first.status === 402, `${slug}: 402 with escrow terms`, first.body);
    const req = first.body.accepts[0];
    check(getAddress(req.payTo) === escrow && getAddress(req.asset) === usdc, `${slug}: payTo is the escrow, asset is USDC`);
    check(first.headers.get("payment-required"), `${slug}: x402 v2 PAYMENT-REQUIRED header present`);
    const now = BigInt(Math.floor(Date.now() / 1000));
    const nonce = `0x${Date.now().toString(16).padStart(16, "0")}${(++counter).toString(16).padStart(8, "0")}${"0".repeat(40)}` as Hex;
    const message = { from: payer.address, to: escrow, value: BigInt(req.maxAmountRequired), validAfter: now - 60n, validBefore: now + 600n, nonce };
    const signature = await payer.signTypedData({
      domain: { name: req.extra.name, version: req.extra.version, chainId: config.network.chainId, verifyingContract: usdc },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message,
    });
    const header = encodeBase64Json({
      x402Version: 1,
      scheme: "exact",
      network: req.network,
      payload: { signature, authorization: { ...message, value: message.value.toString(), validAfter: message.validAfter.toString(), validBefore: message.validBefore.toString() } },
    });
    const paid = await http_(path, { method, body: opts.body, headers: { "x-payment": header } });
    return { paid, header, path, method, amount: message.value };
  }
  const link = (res: { headers: Headers }) => new URL(res.headers.get("x-backstop-payment-url")!);
  const payment = async (u: URL) => (await http_(`/api/v1/payments/${u.pathname.split("/").pop()}?t=${u.searchParams.get("t")}`)).body.payment;

  step("4. Rejected input costs nothing");
  {
    const before = await balance();
    const r = await http_("/x/skyline-forecast?city=X");
    check(r.status === 400 && r.body.error.code === "invalid_input", "bad input refused before payment", r.body);
    check((await balance()) === before, "payer balance unchanged");
  }

  step("5. Delivered: held in escrow, then retried safely");
  const startBalance = await balance();
  const forecast = await pay("skyline-forecast", { query: "city=Lagos" });
  check(forecast.paid.status === 200, "forecast delivered", forecast.paid.body);
  check(forecast.paid.body.city === "Lagos", "agent received the provider's response");
  check(forecast.paid.headers.get("x-backstop-status") === "release_pending", "status: held for review");
  const receipt = decodeBase64Json(forecast.paid.headers.get("x-backstop-receipt")!) as EncodedReceipt;
  const verified = await http_("/api/v1/receipts/verify", { method: "POST", body: JSON.stringify(receipt) });
  check(verified.body.valid === true && verified.body.receipt.passed === true, "signed receipt verifies");
  check((await balance()) === startBalance - forecast.amount, "0.05 USDC moved from payer into escrow");
  const escrowId = forecast.paid.headers.get("x-backstop-escrow-id") as Hex;
  check((await chain.readContract({ address: escrow, abi: escrowAbi, functionName: "getEscrow", args: [escrowId] })).status === 1, "escrow shows Held on-chain");
  const again = await http_(forecast.path, { method: forecast.method, headers: { "x-payment": forecast.header } });
  check(again.status === 200 && JSON.stringify(again.body) === JSON.stringify(forecast.paid.body), "retry replays the same response");
  check((await balance()) === startBalance - forecast.amount, "retry charged nothing");
  const reuse = await http_("/x/skyline-forecast?city=Accra", { headers: { "x-payment": forecast.header } });
  check(reuse.status === 409 && reuse.body.error.code === "payment_reused", "same payment for another request refused");

  step("6. Instant release");
  const fx = await pay("skyline-fx", { query: `pair=${encodeURIComponent("USD/NGN")}` });
  check(fx.paid.status === 200 && fx.paid.body.rate > 0, "fx delivered", fx.paid.body);
  const fxState = await settleUntil(() => payment(link(fx.paid)), (p) => p.status === "released");
  check(fxState.status === "released" && fxState.settleTx, "released to provider on-chain", fxState);

  step("7. Failed delivery: refunded in full");
  const beforeBroken = await balance();
  const broken = await pay("skyline-headlines");
  check(broken.paid.status === 502 && broken.paid.body.error.reason === "schema_mismatch", "502 with the failed check", broken.paid.body);
  check(!JSON.stringify(broken.paid.body).includes("feed temporarily unavailable"), "failing body withheld from the agent");
  const brokenState = await settleUntil(() => payment(link(broken.paid)), (p) => p.status === "refunded");
  check(brokenState.status === "refunded", "refund settled on-chain", brokenState);
  check((await balance()) === beforeBroken, "payer balance fully restored");

  step("8. POST service");
  const sum = await pay("kite-summarize", { body: JSON.stringify({ text: "Agents pay into escrow and Backstop refunds them automatically when a provider fails to deliver what it promised." }) });
  check(sum.paid.status === 200 && sum.paid.body.summary.length > 0, "summary delivered", sum.paid.body);

  step("9. Dispute, provider answer, arbiter split");
  const disputed = await pay("skyline-forecast", { query: "city=Kano" });
  check(disputed.paid.status === 200, "paid for a forecast to dispute");
  const dLink = link(disputed.paid);
  const dId = dLink.pathname.split("/").pop()!;
  const opened = await http_(`/api/v1/payments/${dId}/dispute?t=${dLink.searchParams.get("t")}`, {
    method: "POST",
    body: JSON.stringify({ reason: "wrong_content", statement: "The temperature for Kano does not match the local station reading." }),
  });
  check(opened.status === 201 && opened.body.payment.status === "disputed", "dispute opened with the payment link", opened.body);
  const answered = await http_(`/api/v1/payments/${dId}/respond`, { method: "POST", cookie: providerCookie, body: JSON.stringify({ statement: "Our figure comes from the airport station at 14:00 local time." }) });
  check(answered.status === 200, "provider responded", answered.body);
  const disputedEscrow = dId as Hex;
  const before = (await chain.readContract({ address: escrow, abi: escrowAbi, functionName: "getEscrow", args: [disputedEscrow] })).deadline;
  const extended = await settleUntil(
    async () => (await chain.readContract({ address: escrow, abi: escrowAbi, functionName: "getEscrow", args: [disputedEscrow] })).deadline,
    (d) => d > before,
  );
  check(extended > before, "escrow deadline extended on-chain for review");
  const arbiterCookie = await login(arbiter, config.network.chainId);
  const queue = await http_("/api/v1/admin/disputes", { cookie: arbiterCookie });
  check(queue.body.disputes.some((d: { escrowId: string }) => d.escrowId === dId), "dispute in the arbiter queue");
  const beforeSplit = await balance();
  const resolved = await http_(`/api/v1/payments/${dId}/resolve`, { method: "POST", cookie: arbiterCookie, body: JSON.stringify({ decision: "split", payerAmount: "20000", note: "Partly accurate; refunding 0.02." }) });
  check(resolved.status === 200, "arbiter resolved with a split", resolved.body);
  const dState = await settleUntil(() => payment(dLink), (p) => p.status === "split");
  check(dState.status === "split", "split settled on-chain", dState);
  check((await balance()) === beforeSplit + 20_000n, "payer received 0.02 back");

  step("10. Agents over MCP");
  const tools = await http_("/api/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  check(tools.body.result.tools.length === 6, "six MCP tools listed");
  const search = await http_("/api/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_services", arguments: { query: "forecast" } } }) });
  check(search.body.result.structuredContent.services.some((s: { slug: string }) => s.slug === "skyline-forecast"), "search_services finds the forecast");
  const fLink = link(forecast.paid);
  const status = await http_("/api/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_payment", arguments: { escrowId, token: fLink.searchParams.get("t") } } }) });
  check(status.body.result.structuredContent.status === "release_pending", "get_payment reports the held forecast");

  console.log(`\nAll ${passed} checks passed.`);
  console.log(`Held payment:     ${fLink}`);
  console.log(`Refunded payment: ${link(broken.paid)}`);
  console.log(`Split dispute:    ${dLink}`);
}

main().catch((err) => {
  console.error(`\nFAILED after ${passed} checks:`, (err as Error).message);
  process.exit(1);
});
