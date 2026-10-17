import { isAddressEqual, parseSignature, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { matchesNetwork, type DecodedPayment, type NetworkInfo } from "./x402";

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** secp256k1 n / 2. USDC's ECRecover rejects signatures with s above this. */
const HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

export type AuthorizationError =
  | "unsupported_scheme"
  | "wrong_network"
  | "wrong_recipient"
  | "wrong_amount"
  | "not_yet_valid"
  | "expires_too_soon"
  | "invalid_signature"
  | "self_payment";

export class AuthorizationRejected extends Error {
  constructor(
    readonly code: AuthorizationError,
    message: string,
  ) {
    super(message);
    this.name = "AuthorizationRejected";
  }
}

export interface Expected {
  network: NetworkInfo;
  asset: Address;
  assetName: string;
  assetVersion: string;
  escrow: Address;
  amount: bigint;
  payee: Address;
  /** Seconds the authorization must stay valid for so the deposit can land on-chain. */
  minValiditySeconds: number;
  nowSeconds: number;
}

export interface VerifiedAuthorization {
  from: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
  v: number;
  r: Hex;
  s: Hex;
}

/** Check a decoded x402 payment against what Backstop asked for, including the signature itself. */
export async function verifyAuthorization(payment: DecodedPayment, expected: Expected): Promise<VerifiedAuthorization> {
  const a = payment.authorization;

  if (payment.scheme !== "exact") {
    throw new AuthorizationRejected("unsupported_scheme", `scheme "${payment.scheme}" is not supported`);
  }
  if (!matchesNetwork(payment.network, expected.network)) {
    throw new AuthorizationRejected("wrong_network", `expected network ${expected.network.name}`);
  }
  if (!isAddressEqual(a.to, expected.escrow)) {
    throw new AuthorizationRejected("wrong_recipient", "payment must be authorized to the Backstop escrow");
  }
  const value = BigInt(a.value);
  if (value !== expected.amount) {
    throw new AuthorizationRejected("wrong_amount", `expected exactly ${expected.amount} base units`);
  }
  if (isAddressEqual(a.from, expected.payee) || isAddressEqual(a.from, expected.escrow)) {
    throw new AuthorizationRejected("self_payment", "payer cannot be the payee or the escrow");
  }

  const now = BigInt(expected.nowSeconds);
  const validAfter = BigInt(a.validAfter);
  const validBefore = BigInt(a.validBefore);
  // The token requires block.timestamp > validAfter, so equality with now is not yet valid.
  if (validAfter >= now) {
    throw new AuthorizationRejected("not_yet_valid", "authorization is not valid yet");
  }
  if (validBefore < now + BigInt(expected.minValiditySeconds)) {
    throw new AuthorizationRejected(
      "expires_too_soon",
      `authorization must stay valid for at least ${expected.minValiditySeconds}s`,
    );
  }

  let parts: ReturnType<typeof parseSignature>;
  try {
    parts = parseSignature(payment.signature);
  } catch {
    throw new AuthorizationRejected("invalid_signature", "signature is malformed");
  }
  if (BigInt(parts.s) > HALF_N) {
    throw new AuthorizationRejected("invalid_signature", "signature is not in canonical low-s form");
  }
  const v = parts.v !== undefined ? Number(parts.v) : 27 + parts.yParity;
  if (v !== 27 && v !== 28) throw new AuthorizationRejected("invalid_signature", "signature has an invalid v");

  let signer: Address;
  try {
    signer = await recoverTypedDataAddress({
      domain: {
        name: expected.assetName,
        version: expected.assetVersion,
        chainId: expected.network.chainId,
        verifyingContract: expected.asset,
      },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: { from: a.from, to: a.to, value, validAfter, validBefore, nonce: a.nonce },
      signature: payment.signature,
    });
  } catch {
    throw new AuthorizationRejected("invalid_signature", "signature could not be recovered");
  }
  if (!isAddressEqual(signer, a.from)) {
    throw new AuthorizationRejected("invalid_signature", "signature does not match the payer");
  }

  return { from: a.from, value, validAfter, validBefore, nonce: a.nonce, v, r: parts.r, s: parts.s };
}
