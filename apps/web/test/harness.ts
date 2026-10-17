import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { inject, vi } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { encodeBase64Json, escrowAbi, parseUsdc, TRANSFER_WITH_AUTHORIZATION_TYPES } from "@backstop/core";

export const KEYS = {
  owner: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  depositor: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  settler: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  registrar: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  receipt: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  payer: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  provider: "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
  admin: "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
  feeRecipient: "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
  poorPayer: "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
} as const satisfies Record<string, Hex>;

export const accounts = Object.fromEntries(
  Object.entries(KEYS).map(([k, v]) => [k, privateKeyToAccount(v)]),
) as Record<keyof typeof KEYS, ReturnType<typeof privateKeyToAccount>>;

const artifact = (file: string, name: string) =>
  JSON.parse(readFileSync(path.join(__dirname, "../../../contracts/out", file, `${name}.json`), "utf8")) as {
    abi: Abi;
    bytecode: { object: Hex };
  };

export const usdcArtifact = artifact("MockUSDC.sol", "MockUSDC");
const escrowArtifact = artifact("BackstopEscrow.sol", "BackstopEscrow");

export const FEE_BPS = 100;
export const BASE_URL = "http://backstop.test";

export interface World {
  rpcUrl: string;
  usdc: Address;
  escrow: Address;
  publicClient: ReturnType<typeof createPublicClient>;
  upstream: string;
  upstreamRequests: Array<{ path: string; headers: IncomingMessage["headers"]; body: string }>;
  close: () => Promise<void>;
}

/** Simulated provider. Each path misbehaves in one specific way. */
function startUpstream(log: World["upstreamRequests"]): Promise<Server> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url!, "http://x");
      const body = Buffer.concat(chunks).toString();
      log.push({ path: url.pathname + url.search, headers: req.headers, body });
      const send = (status: number, payload: unknown, type = "application/json") => {
        res.statusCode = status;
        res.setHeader("content-type", type);
        res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
      };
      switch (url.pathname) {
        case "/api/forecast":
          return send(200, { city: url.searchParams.get("city") ?? "Lagos", temperature: 29.5 });
        case "/api/broken":
          return send(200, { wrong: true });
        case "/api/slow":
          setTimeout(() => send(200, { city: "Slow", temperature: 1 }), 1500);
          return;
        case "/api/error":
          return send(500, { error: "boom" });
        case "/api/charge-again":
          return send(402, { error: "pay me" });
        case "/api/echo":
          return send(200, { city: "Echo", temperature: 0, received: body ? JSON.parse(body) : null });
        default:
          return send(404, { error: "not found" });
      }
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

export async function setupWorld(): Promise<World> {
  const rpcUrl = inject("rpcUrl");
  const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl), pollingInterval: 50 });
  const owner = createWalletClient({ chain: foundry, transport: http(rpcUrl), account: accounts.owner });

  const deploy = async (a: typeof usdcArtifact, args: unknown[] = []) => {
    const hash = await owner.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args });
    const r = await publicClient.waitForTransactionReceipt({ hash });
    return r.contractAddress!;
  };

  const usdc = await deploy(usdcArtifact);
  const escrow = await deploy(escrowArtifact, [usdc, accounts.owner.address, accounts.feeRecipient.address, FEE_BPS, parseUsdc("10000")]);

  const write = async (address: Address, abi: Abi, functionName: string, args: unknown[]) => {
    const hash = await owner.writeContract({ address, abi, functionName, args } as never);
    await publicClient.waitForTransactionReceipt({ hash });
  };
  await write(escrow, escrowAbi as Abi, "setOperator", [accounts.depositor.address, true]);
  await write(escrow, escrowAbi as Abi, "setOperator", [accounts.settler.address, true]);
  await write(escrow, escrowAbi as Abi, "setRegistrar", [accounts.registrar.address]);
  await write(usdc, usdcArtifact.abi, "mint", [accounts.payer.address, parseUsdc("1000")]);

  // Earlier suites may have moved the shared chain's clock forward. Never let app time lag the chain.
  const chainNowMs = Number((await publicClient.getBlock()).timestamp) * 1000;
  if (chainNowMs + 1000 > Date.now()) vi.setSystemTime(new Date(chainNowMs + 1000));

  const upstreamRequests: World["upstreamRequests"] = [];
  const server = await startUpstream(upstreamRequests);
  const upstream = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  Object.assign(process.env, {
    NODE_ENV: "test",
    PUBLIC_BASE_URL: BASE_URL,
    NETWORK: "localhost",
    RPC_URL: rpcUrl,
    ESCROW_ADDRESS: escrow,
    USDC_ADDRESS: usdc,
    DEPOSITOR_PRIVATE_KEY: KEYS.depositor,
    SETTLER_PRIVATE_KEY: KEYS.settler,
    RECEIPT_PRIVATE_KEY: KEYS.receipt,
    REGISTRAR_PRIVATE_KEY: KEYS.registrar,
    SESSION_SECRET: "test-session-secret-that-is-long-enough-123",
    CAPABILITY_SECRET: "test-capability-secret-that-is-long-enough",
    DATA_KEY: Buffer.alloc(32, 7).toString("base64"),
    ADMIN_ADDRESSES: accounts.admin.address,
    CRON_SECRET: "test-cron-secret-that-is-long-enough-12345",
    ALLOW_PRIVATE_UPSTREAMS: "true",
    WORKER_INLINE: "false",
    SETTLEMENT_GRACE_SECONDS: "3600",
  });

  const { resetConfigForTesting } = await import("@/server/config");
  const { resetChainForTesting } = await import("@/server/chain");
  const { setDbForTesting, openDb } = await import("@/server/db/client");
  const { resetRateLimitsForTesting } = await import("@/server/ratelimit");
  resetConfigForTesting();
  resetChainForTesting();
  resetRateLimitsForTesting();
  const handle = openDb("memory://");
  setDbForTesting(handle);
  await handle;

  return {
    rpcUrl,
    usdc,
    escrow,
    publicClient,
    upstream,
    upstreamRequests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await (await handle).close();
      setDbForTesting(undefined);
    },
  };
}

export async function balanceOf(world: World, who: Address): Promise<bigint> {
  return world.publicClient.readContract({ address: world.usdc, abi: usdcArtifact.abi, functionName: "balanceOf", args: [who] }) as Promise<bigint>;
}

let nonceCounter = 0;

/** Sign an EIP-3009 authorization to the escrow and wrap it as an x402 payment header. */
export async function signPayment(
  world: World,
  opts: { amount: bigint; payer?: keyof typeof KEYS; to?: Address; validAfter?: bigint; validBefore?: bigint; nonce?: Hex; version?: 1 | 2; network?: string },
): Promise<{ header: string; headerName: string; nonce: Hex }> {
  const account = accounts[opts.payer ?? "payer"];
  const now = BigInt(Math.floor(Date.now() / 1000));
  const nonce = opts.nonce ?? (`0x${(++nonceCounter).toString(16).padStart(8, "0")}${Date.now().toString(16).padStart(56, "0")}` as Hex);
  const message = {
    from: account.address,
    to: opts.to ?? world.escrow,
    value: opts.amount,
    validAfter: opts.validAfter ?? now - 60n,
    validBefore: opts.validBefore ?? now + 600n,
    nonce,
  };
  const signature = await account.signTypedData({
    domain: { name: "USD Coin", version: "2", chainId: 31337, verifyingContract: world.usdc },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message,
  });
  const authorization = {
    from: message.from,
    to: message.to,
    value: message.value.toString(),
    validAfter: message.validAfter.toString(),
    validBefore: message.validBefore.toString(),
    nonce,
  };
  const version = opts.version ?? 1;
  const header =
    version === 1
      ? encodeBase64Json({ x402Version: 1, scheme: "exact", network: opts.network ?? "localhost", payload: { signature, authorization } })
      : encodeBase64Json({ x402Version: 2, accepted: { scheme: "exact", network: opts.network ?? "eip155:31337" }, payload: { signature, authorization } });
  return { header, headerName: version === 1 ? "x-payment" : "payment-signature", nonce };
}

type Handler = (req: Request, ctx: { params: Promise<Record<string, unknown>> }) => Promise<Response>;

export async function callGateway(
  slug: string,
  opts: { path?: string[]; query?: string; payment?: { header: string; headerName: string }; method?: "GET" | "POST"; body?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  const mod = (await import("@/app/x/[slug]/[[...path]]/route")) as unknown as Record<string, Handler>;
  const method = opts.method ?? "GET";
  const sub = opts.path?.length ? `/${opts.path.join("/")}` : "";
  const url = `${BASE_URL}/x/${slug}${sub}${opts.query ? `?${opts.query}` : ""}`;
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.payment) headers[opts.payment.headerName] = opts.payment.header;
  if (opts.body) headers["content-type"] ??= "application/json";
  const req = new Request(url, { method, headers, body: opts.body });
  return mod[method]!(req, { params: Promise.resolve({ slug, path: opts.path }) });
}

/** Call any route module's handler with a JSON body and optional cookie/token auth. */
export async function callRoute(
  mod: Record<string, unknown>,
  method: string,
  url: string,
  opts: { params?: Record<string, unknown>; body?: unknown; cookie?: string; origin?: string | null; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: any; headers: Headers }> { // eslint-disable-line @typescript-eslint/no-explicit-any -- response shapes vary per route
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.origin !== null && method !== "GET") headers.origin = opts.origin ?? BASE_URL;
  const req = new Request(`${BASE_URL}${url}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const res = await (mod[method] as Handler)(req, { params: Promise.resolve(opts.params ?? {}) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

/** Move both the chain and the application clock forward together. */
export async function travel(world: World, seconds: number) {
  await world.publicClient.request({ method: "evm_increaseTime" as never, params: [seconds] as never });
  await world.publicClient.request({ method: "evm_mine" as never, params: [] as never });
  vi.setSystemTime(new Date(Date.now() + seconds * 1000));
}

export async function chainTime(world: World): Promise<number> {
  const b = await world.publicClient.getBlock();
  return Number(b.timestamp);
}
