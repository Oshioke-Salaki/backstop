/**
 * One command for a complete local Backstop: `pnpm local`.
 *
 *   1. starts anvil (local chain) unless one is already on :8545
 *   2. deploys MockUSDC + BackstopEscrow and wires operator keys
 *   3. starts a mock provider API on :4010
 *   4. seeds a provider, services and real payments in every state, through the real gateway
 *   5. runs `next dev` on :3000 with the settlement worker inline
 *
 * Ctrl+C stops everything this script started. Pass --seed-only to stop after step 4.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { createPublicClient, createWalletClient, http, type Abi, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

const ROOT = path.resolve(__dirname, "..");
const RPC = "http://127.0.0.1:8545";
const APP = "http://localhost:3000";
const UPSTREAM_PORT = 4010;
const children: ChildProcess[] = [];

const KEYS = {
  owner: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  depositor: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  settler: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  registrar: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  receipt: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  payer: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  provider: "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
  admin: "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
  feeRecipient: "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
} as const satisfies Record<string, Hex>;
const acct = (k: keyof typeof KEYS) => privateKeyToAccount(KEYS[k]);

function cleanup() {
  for (const c of children) if (!c.killed) c.kill("SIGTERM");
}
process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});
process.on("exit", cleanup);

async function rpcUp(): Promise<boolean> {
  try {
    const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
    return r.ok;
  } catch {
    return false;
  }
}

async function startChain() {
  if (await rpcUp()) {
    console.log("· using the chain already running on :8545");
    return;
  }
  const anvil = spawn("anvil", ["--port", "8545", "--silent", "--chain-id", "31337"], { stdio: "ignore" });
  children.push(anvil);
  for (let i = 0; i < 100 && !(await rpcUp()); i++) await new Promise((r) => setTimeout(r, 100));
  console.log("· anvil started on :8545");
}

const artifact = (file: string, name: string) =>
  JSON.parse(readFileSync(path.join(ROOT, "../../contracts/out", file, `${name}.json`), "utf8")) as { abi: Abi; bytecode: { object: Hex } };

async function deploy() {
  const publicClient = createPublicClient({ chain: foundry, transport: http(RPC) });
  const owner = createWalletClient({ chain: foundry, transport: http(RPC), account: acct("owner") });
  const usdcA = artifact("MockUSDC.sol", "MockUSDC");
  const escrowA = artifact("BackstopEscrow.sol", "BackstopEscrow");
  const wait = (hash: Hex) => publicClient.waitForTransactionReceipt({ hash });

  const usdc = (await wait(await owner.deployContract({ abi: usdcA.abi, bytecode: usdcA.bytecode.object }))).contractAddress!;
  const escrow = (
    await wait(await owner.deployContract({ abi: escrowA.abi, bytecode: escrowA.bytecode.object, args: [usdc, acct("owner").address, acct("feeRecipient").address, 100, 10_000_000_000n] }))
  ).contractAddress!;
  const call = async (address: Address, abi: Abi, functionName: string, args: unknown[]) => wait(await owner.writeContract({ address, abi, functionName, args } as never));
  await call(escrow, escrowA.abi, "setOperator", [acct("depositor").address, true]);
  await call(escrow, escrowA.abi, "setOperator", [acct("settler").address, true]);
  await call(escrow, escrowA.abi, "setRegistrar", [acct("registrar").address]);
  await call(usdc, usdcA.abi, "mint", [acct("payer").address, 1_000_000_000n]);
  console.log(`· deployed USDC ${usdc} and escrow ${escrow}`);
  return { usdc, escrow };
}

function startUpstream() {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url!, "http://x");
      const send = (status: number, body: unknown) => {
        res.statusCode = status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(body));
      };
      if (url.pathname === "/forecast") return send(200, { city: url.searchParams.get("city") ?? "Lagos", temperature: 29.5, conditions: "Humid, scattered showers", updatedAt: new Date().toISOString() });
      if (url.pathname === "/fx") return send(200, { pair: url.searchParams.get("pair") ?? "USD/NGN", rate: 1532.4, source: "interbank close" });
      if (url.pathname === "/summarize") {
        const text = (JSON.parse(Buffer.concat(chunks).toString() || "{}").text as string | undefined) ?? "";
        return send(200, { summary: text.split(/\s+/).slice(0, 12).join(" ") + (text ? "…" : ""), words: text.split(/\s+/).filter(Boolean).length });
      }
      if (url.pathname === "/headlines") return send(200, { error: "feed temporarily unavailable" });
      send(404, { error: "not found" });
    });
  });
  server.listen(UPSTREAM_PORT, "127.0.0.1");
  console.log(`· mock provider API on :${UPSTREAM_PORT}`);
  return server;
}

function writeEnv(addresses: { usdc: Address; escrow: Address }) {
  const env = {
    PUBLIC_BASE_URL: APP,
    NETWORK: "localhost",
    RPC_URL: RPC,
    ESCROW_ADDRESS: addresses.escrow,
    USDC_ADDRESS: addresses.usdc,
    DEPOSITOR_PRIVATE_KEY: KEYS.depositor,
    SETTLER_PRIVATE_KEY: KEYS.settler,
    RECEIPT_PRIVATE_KEY: KEYS.receipt,
    REGISTRAR_PRIVATE_KEY: KEYS.registrar,
    SESSION_SECRET: "local-session-secret-not-for-production-0001",
    CAPABILITY_SECRET: "local-capability-secret-not-for-production-01",
    DATA_KEY: Buffer.alloc(32, 9).toString("base64"),
    ADMIN_ADDRESSES: acct("admin").address,
    CRON_SECRET: "local-cron-secret-not-for-production-000000001",
    ALLOW_PRIVATE_UPSTREAMS: "true",
    WORKER_INLINE: "true",
    DATABASE_URL: `file://${path.join(ROOT, ".data", "local")}`,
    SETTLEMENT_GRACE_SECONDS: "3600",
  };
  writeFileSync(path.join(ROOT, ".env.local"), Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  Object.assign(process.env, env);
  console.log("· wrote apps/web/.env.local");
}

async function seed() {
  rmSync(path.join(ROOT, ".data", "local"), { recursive: true, force: true });
  const { encodeBase64Json, TRANSFER_WITH_AUTHORIZATION_TYPES, parseUsdc } = await import("@backstop/core");
  const { createProvider } = await import("../src/server/providers");
  const { createService, setServiceStatus } = await import("../src/server/services");
  const { tick } = await import("../src/server/worker");
  const { openDispute, respondToDispute } = await import("../src/server/disputes");
  const gateway = await import("../src/app/x/[slug]/[[...path]]/route");
  const up = `http://127.0.0.1:${UPSTREAM_PORT}`;

  const { provider } = await createProvider({ address: acct("provider").address, isAdmin: false }, { name: "Skyline Data", website: "https://skyline.example" });
  const other = privateKeyToAccount(generatePrivateKey());
  const { provider: kite } = await createProvider({ address: other.address, isAdmin: false }, { name: "Kite Language", payoutAddress: other.address });
  await tick();

  const json = "application/json";
  const svc = async (providerId: string, input: Record<string, unknown>) => {
    const s = await createService(providerId, input as never);
    await setServiceStatus(providerId, s.id, "active");
    return s;
  };
  await svc(provider.id, {
    slug: "skyline-forecast",
    name: "City forecast",
    description: "Current temperature and conditions for any city, refreshed every 10 minutes.",
    upstreamUrl: `${up}/forecast`,
    method: "GET",
    price: parseUsdc("0.05"),
    disputeWindowSeconds: 3600,
    inputSchema: { type: "object", required: ["city"], properties: { city: { type: "string", minLength: 2 } } },
    sla: {
      maxLatencyMs: 2000,
      maxResponseBytes: 16384,
      expectStatus: [200],
      contentType: json,
      outputSchema: { type: "object", required: ["city", "temperature"], properties: { city: { type: "string" }, temperature: { type: "number" } } },
      assertions: [{ op: "nonEmpty", path: "/city" }, { op: "gte", path: "/temperature", value: -90 }],
    },
  });
  await svc(provider.id, {
    slug: "skyline-fx",
    name: "FX rate",
    description: "Interbank closing rate for a currency pair, settled the moment checks pass.",
    upstreamUrl: `${up}/fx`,
    method: "GET",
    price: parseUsdc("0.02"),
    disputeWindowSeconds: 0,
    inputSchema: null,
    sla: { maxLatencyMs: 1000, maxResponseBytes: 4096, expectStatus: [200], contentType: json, outputSchema: { type: "object", required: ["pair", "rate"], properties: { rate: { type: "number" } } }, assertions: [{ op: "gte", path: "/rate", value: 0 }] },
  });
  await svc(provider.id, {
    slug: "skyline-headlines",
    name: "Market headlines",
    description: "Top five market headlines with sources.",
    upstreamUrl: `${up}/headlines`,
    method: "GET",
    price: parseUsdc("0.01"),
    disputeWindowSeconds: 900,
    inputSchema: null,
    sla: { maxLatencyMs: 2000, maxResponseBytes: 32768, expectStatus: [200], contentType: json, outputSchema: { type: "object", required: ["headlines"], properties: { headlines: { type: "array" } } }, assertions: [{ op: "minItems", path: "/headlines", value: 1 }] },
  });
  await svc(kite.id, {
    slug: "kite-summarize",
    name: "Summarize text",
    description: "A one-line summary of up to 5,000 words, with a word count.",
    upstreamUrl: `${up}/summarize`,
    method: "POST",
    price: parseUsdc("0.25"),
    disputeWindowSeconds: 86400,
    inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string", minLength: 1, maxLength: 40000 } } },
    sla: { maxLatencyMs: 5000, maxResponseBytes: 65536, expectStatus: [200], contentType: json, outputSchema: { type: "object", required: ["summary"], properties: { summary: { type: "string" } } }, assertions: [{ op: "minLength", path: "/summary", value: 1 }] },
  });

  const payer = acct("payer");
  let n = 0;
  const pay = async (slug: string, opts: { query?: string; body?: string; amount: bigint }) => {
    const now = BigInt(Math.floor(Date.now() / 1000));
    const nonce = `0x${(++n).toString(16).padStart(64, "0")}` as Hex;
    const message = { from: payer.address, to: process.env.ESCROW_ADDRESS as Address, value: opts.amount, validAfter: now - 60n, validBefore: now + 600n, nonce };
    const signature = await payer.signTypedData({
      domain: { name: "USD Coin", version: "2", chainId: 31337, verifyingContract: process.env.USDC_ADDRESS as Address },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message,
    });
    const header = encodeBase64Json({
      x402Version: 1,
      scheme: "exact",
      network: "localhost",
      payload: { signature, authorization: { ...message, value: message.value.toString(), validAfter: message.validAfter.toString(), validBefore: message.validBefore.toString() } },
    });
    const method = opts.body ? "POST" : "GET";
    const req = new Request(`${APP}/x/${slug}${opts.query ? `?${opts.query}` : ""}`, {
      method,
      headers: { "x-payment": header, ...(opts.body ? { "content-type": json } : {}) },
      body: opts.body,
    });
    const handler = (gateway as unknown as Record<string, (r: Request, c: unknown) => Promise<Response>>)[method]!;
    const res = await handler(req, { params: Promise.resolve({ slug, path: [] }) });
    return { status: res.status, id: res.headers.get("x-backstop-escrow-id")!, link: res.headers.get("x-backstop-payment-url")! };
  };

  for (const city of ["Lagos", "Accra", "Nairobi"]) await pay("skyline-forecast", { query: `city=${city}`, amount: parseUsdc("0.05") });
  for (const pair of ["USD/NGN", "EUR/USD"]) await pay("skyline-fx", { query: `pair=${encodeURIComponent(pair)}`, amount: parseUsdc("0.02") });
  for (let i = 0; i < 2; i++) await pay("skyline-headlines", { amount: parseUsdc("0.01") });
  await pay("kite-summarize", { body: JSON.stringify({ text: "Backstop holds agent payments in escrow until the provider delivers what it promised, then releases or refunds." }), amount: parseUsdc("0.25") });
  const answered = await pay("skyline-forecast", { query: "city=Kano", amount: parseUsdc("0.05") });
  const open = await pay("skyline-forecast", { query: "city=Abuja", amount: parseUsdc("0.05") });
  await tick();

  await openDispute(answered.id, "seed", { reason: "wrong_content", statement: "The temperature reported for Kano was 29.5C, but the local station read 36C at the same hour." });
  await respondToDispute(answered.id, provider.id, { statement: "Our reading comes from the airport station, which reported 29.5C at 14:00 local time. Logs attached on request." });
  await openDispute(open.id, "seed", { reason: "incomplete", statement: "Conditions were returned, but the humidity field promised in the description was missing." });
  await tick();

  console.log("· seeded 2 providers, 4 services, 10 payments (paid, held, refunded, disputed)");
  return { disputedLink: answered.link, openLink: open.link };
}

async function main() {
  const seedOnly = process.argv.includes("--seed-only");
  await startChain();
  const addresses = await deploy();
  writeEnv(addresses);
  const upstream = startUpstream();
  const links = await seed();

  const { setDbForTesting } = await import("../src/server/db/client");
  const g = globalThis as unknown as { __backstopDb?: Promise<{ close: () => Promise<void> }> };
  await (await g.__backstopDb)?.close();
  setDbForTesting(undefined);

  console.log(`
Backstop is ready.

  App            ${APP}
  Disputed link  ${links.disputedLink}
  Open dispute   ${links.openLink}

  Sign in by importing these anvil keys into a browser wallet (local chain id 31337, RPC ${RPC}):
    provider  ${KEYS.provider}
    arbiter   ${KEYS.admin}
    payer     ${KEYS.payer}
`);
  if (seedOnly) {
    upstream.close();
    cleanup();
    process.exit(0);
  }
  const next = spawn("pnpm", ["exec", "next", "dev", "-p", "3000"], { cwd: ROOT, stdio: "inherit", env: process.env });
  children.push(next);
  next.on("exit", (code) => {
    upstream.close();
    cleanup();
    process.exit(code ?? 0);
  });
}

main().catch((err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
