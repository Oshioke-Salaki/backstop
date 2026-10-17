import { isAddressEqual, recoverTypedDataAddress, type Address, type Hex, type LocalAccount } from "viem";

/**
 * Signed delivery receipts. Anyone can check one offline against Backstop's published receipt signer,
 * which makes the verdict portable evidence for disputes and for reputation systems built on top.
 */

export const RECEIPT_TYPES = {
  Receipt: [
    { name: "escrowId", type: "bytes32" },
    { name: "service", type: "string" },
    { name: "payer", type: "address" },
    { name: "payee", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "passed", type: "bool" },
    { name: "reason", type: "string" },
    { name: "requestHash", type: "bytes32" },
    { name: "responseHash", type: "bytes32" },
    { name: "latencyMs", type: "uint32" },
    { name: "issuedAt", type: "uint64" },
  ],
} as const;

export interface Receipt {
  escrowId: Hex;
  service: string;
  payer: Address;
  payee: Address;
  amount: bigint;
  passed: boolean;
  reason: string;
  requestHash: Hex;
  responseHash: Hex;
  latencyMs: number;
  issuedAt: bigint;
}

export interface ReceiptDomain {
  chainId: number;
  escrow: Address;
}

function domain(d: ReceiptDomain) {
  return { name: "Backstop", version: "1", chainId: d.chainId, verifyingContract: d.escrow } as const;
}

export const ZERO_HASH = `0x${"0".repeat(64)}` as Hex;

export async function signReceipt(account: LocalAccount, d: ReceiptDomain, receipt: Receipt): Promise<Hex> {
  return account.signTypedData({ domain: domain(d), types: RECEIPT_TYPES, primaryType: "Receipt", message: receipt });
}

export interface EncodedReceipt {
  receipt: Omit<Receipt, "amount" | "issuedAt"> & { amount: string; issuedAt: string };
  signature: Hex;
}

export function encodeReceipt(receipt: Receipt, signature: Hex): EncodedReceipt {
  return {
    receipt: { ...receipt, amount: receipt.amount.toString(), issuedAt: receipt.issuedAt.toString() },
    signature,
  };
}

export async function verifyReceipt(
  encoded: EncodedReceipt,
  d: ReceiptDomain,
  expectedSigner: Address,
): Promise<{ valid: boolean; receipt: Receipt | null }> {
  try {
    const receipt: Receipt = {
      ...encoded.receipt,
      amount: BigInt(encoded.receipt.amount),
      issuedAt: BigInt(encoded.receipt.issuedAt),
    };
    const signer = await recoverTypedDataAddress({
      domain: domain(d),
      types: RECEIPT_TYPES,
      primaryType: "Receipt",
      message: receipt,
      signature: encoded.signature,
    });
    return { valid: isAddressEqual(signer, expectedSigner), receipt };
  } catch {
    return { valid: false, receipt: null };
  }
}
