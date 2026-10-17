import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, nonceManager } from "viem/accounts";
import { base, baseSepolia, foundry } from "viem/chains";
import { escrowAbi } from "@backstop/core";
import { getConfig } from "./config";

function chainFor(chainId: number, rpcUrl: string): Chain {
  const known = [base, baseSepolia, foundry].find((c) => c.id === chainId);
  const template = known ?? defineChain({ id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  return { ...template, rpcUrls: { default: { http: [rpcUrl] } } };
}

export type Role = "depositor" | "settler" | "registrar";

interface ChainContext {
  chain: Chain;
  publicClient: PublicClient;
  wallets: Partial<Record<Role, WalletClient & { account: Account }>>;
  receiptAccount: ReturnType<typeof privateKeyToAccount>;
}

let ctx: ChainContext | undefined;

export function getChainContext(): ChainContext {
  if (ctx) return ctx;
  const config = getConfig();
  const chain = chainFor(config.network.chainId, config.RPC_URL);
  const transport = http(config.RPC_URL, { timeout: 15_000, retryCount: 2, retryDelay: 250 });
  const publicClient = createPublicClient({ chain, transport, pollingInterval: config.network.chainId === 31337 ? 100 : 1_000 }) as PublicClient;
  const wallet = (key: Hex) =>
    createWalletClient({ chain, transport, account: privateKeyToAccount(key, { nonceManager }) }) as WalletClient & {
      account: Account;
    };
  ctx = {
    chain,
    publicClient,
    wallets: {
      depositor: wallet(config.DEPOSITOR_PRIVATE_KEY),
      settler: wallet(config.SETTLER_PRIVATE_KEY),
      ...(config.REGISTRAR_PRIVATE_KEY ? { registrar: wallet(config.REGISTRAR_PRIVATE_KEY) } : {}),
    },
    receiptAccount: privateKeyToAccount(config.RECEIPT_PRIVATE_KEY),
  };
  return ctx;
}

export function resetChainForTesting(): void {
  ctx = undefined;
  queues.clear();
}

/** Per-signer send queue: submissions from one key never race for a nonce inside this process. */
const queues = new Map<Role, Promise<unknown>>();

async function serialized<T>(role: Role, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(role) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(fn);
  queues.set(role, next);
  return next;
}

export type EscrowWrite =
  | { functionName: "deposit"; args: readonly [unknown, Hex, number] }
  | { functionName: "release"; args: readonly [Hex] }
  | { functionName: "refund"; args: readonly [Hex] }
  | { functionName: "split"; args: readonly [Hex, bigint] }
  | { functionName: "extend"; args: readonly [Hex, number] }
  | { functionName: "setPayee"; args: readonly [Hex, boolean] };

export class ContractRevert extends Error {
  constructor(
    message: string,
    readonly errorName: string | undefined,
  ) {
    super(message);
    this.name = "ContractRevert";
  }
}

/** Simulate first so reverts surface as typed errors without spending gas, then submit. Returns the tx hash. */
export async function sendEscrowTx(role: Role, write: EscrowWrite): Promise<Hex> {
  const { publicClient, wallets } = getChainContext();
  const wallet = wallets[role];
  if (!wallet) throw new Error(`no ${role} key configured`);
  const address = getConfig().ESCROW_ADDRESS;

  return serialized(role, async () => {
    let request;
    try {
      ({ request } = await publicClient.simulateContract({
        address,
        abi: escrowAbi,
        functionName: write.functionName,
        args: write.args as never,
        account: wallet.account,
      }));
    } catch (err) {
      throw toRevert(err);
    }
    try {
      return await wallet.writeContract(request as never);
    } catch (err) {
      // A stale nonce after a restart is the one send failure worth an immediate retry.
      if (/nonce/i.test((err as Error).message)) {
        nonceManager.reset({ address: wallet.account.address, chainId: publicClient.chain!.id });
        return wallet.writeContract(request as never);
      }
      throw err;
    }
  });
}

/** Errors the token can raise inside deposit; the escrow ABI alone cannot decode them. */
const TOKEN_ERROR_SELECTORS: Record<string, string> = {
  "0xe450d38c": "ERC20InsufficientBalance",
  "0xfb8f41b2": "ERC20InsufficientAllowance",
};

/**
 * A failed simulation is a definitive "this would revert": classify it as ContractRevert even when
 * the revert data cannot be decoded. Anything else (RPC down, timeout) stays a plain error.
 */
function toRevert(err: unknown): Error {
  let node = err as { name?: string; shortMessage?: string; message: string; cause?: unknown; data?: { errorName?: string }; reason?: string; signature?: string } | undefined;
  const top = node!;
  while (node) {
    if (node.name === "ContractFunctionRevertedError") {
      const name = node.data?.errorName ?? node.reason ?? (node.signature ? TOKEN_ERROR_SELECTORS[node.signature] : undefined) ?? node.signature;
      return new ContractRevert(top.shortMessage ?? top.message, name);
    }
    node = node.cause as typeof node;
  }
  return err as Error;
}

export async function waitForTx(hash: Hex, timeoutMs = 60_000) {
  const { publicClient } = getChainContext();
  return publicClient.waitForTransactionReceipt({
    hash,
    confirmations: getConfig().CONFIRMATIONS,
    timeout: timeoutMs,
  });
}

export interface OnchainEscrow {
  payer: Hex;
  amount: bigint;
  payee: Hex;
  deadline: number;
  hardDeadline: number;
  feeBps: number;
  status: number;
}

export async function readEscrow(id: Hex): Promise<OnchainEscrow> {
  const { publicClient } = getChainContext();
  const e = await publicClient.readContract({
    address: getConfig().ESCROW_ADDRESS,
    abi: escrowAbi,
    functionName: "getEscrow",
    args: [id],
  });
  return {
    payer: e.payer,
    amount: e.amount,
    payee: e.payee,
    deadline: Number(e.deadline),
    hardDeadline: Number(e.hardDeadline),
    feeBps: Number(e.feeBps),
    status: Number(e.status),
  };
}

/** Whether a Refunded escrow was reclaimed by deadline, read from its Refunded event. */
export async function wasReclaimed(id: Hex): Promise<boolean> {
  const { publicClient } = getChainContext();
  const logs = await publicClient.getContractEvents({
    address: getConfig().ESCROW_ADDRESS,
    abi: escrowAbi,
    eventName: "Refunded",
    args: { id },
    fromBlock: "earliest",
  });
  return logs.some((l) => l.args.reclaimedByDeadline === true);
}

export async function chainNow(): Promise<number> {
  const { publicClient } = getChainContext();
  const block = await publicClient.getBlock({ blockTag: "latest" });
  return Number(block.timestamp);
}
