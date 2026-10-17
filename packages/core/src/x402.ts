import { z } from "zod";
import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";

/**
 * x402 wire format, v1 and v2.
 * v1: 402 JSON body `{x402Version:1, accepts}`, client header `X-PAYMENT`, server header `X-PAYMENT-RESPONSE`.
 * v2: 402 header `PAYMENT-REQUIRED`, client header `PAYMENT-SIGNATURE`, server header `PAYMENT-RESPONSE`.
 * Backstop emits both on every 402 so either client generation can pay.
 */

export const HEADER_V1_PAYMENT = "x-payment";
export const HEADER_V1_RESPONSE = "x-payment-response";
export const HEADER_V2_REQUIRED = "payment-required";
export const HEADER_V2_PAYMENT = "payment-signature";
export const HEADER_V2_RESPONSE = "payment-response";

/** Payment headers are small; anything bigger is hostile. */
export const MAX_PAYMENT_HEADER_BYTES = 8 * 1024;

export interface NetworkInfo {
  /** v1 name, e.g. "base". */
  name: string;
  /** CAIP-2 id used by v2, e.g. "eip155:8453". */
  caip2: `eip155:${number}`;
  chainId: number;
}

export const NETWORKS = {
  base: { name: "base", caip2: "eip155:8453", chainId: 8453 },
  "base-sepolia": { name: "base-sepolia", caip2: "eip155:84532", chainId: 84532 },
  localhost: { name: "localhost", caip2: "eip155:31337", chainId: 31337 },
} as const satisfies Record<string, NetworkInfo>;

export type NetworkName = keyof typeof NETWORKS;

export function networkByChainId(chainId: number): NetworkInfo | undefined {
  return Object.values(NETWORKS).find((n) => n.chainId === chainId);
}

/** Accepts either the v1 name or the CAIP-2 id. */
export function matchesNetwork(value: string, network: NetworkInfo): boolean {
  return value === network.name || value === network.caip2;
}

const address = z
  .string()
  .refine((v) => isAddress(v, { strict: false }), "invalid address")
  .transform((v) => getAddress(v));
const uintString = z.string().regex(/^(0|[1-9]\d{0,77})$/, "must be a base-10 unsigned integer");
const bytes32 = z
  .string()
  .refine((v) => isHex(v, { strict: true }) && v.length === 66, "must be 32-byte hex")
  .transform((v) => v.toLowerCase() as Hex);
const signature = z
  .string()
  .refine((v) => isHex(v, { strict: true }) && v.length === 132, "must be a 65-byte signature")
  .transform((v) => v as Hex);

export const authorizationSchema = z
  .object({
    from: address,
    to: address,
    value: uintString,
    validAfter: uintString,
    validBefore: uintString,
    nonce: bytes32,
  })
  .strict();

export type Authorization = {
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
};

const exactPayload = z.object({ signature, authorization: authorizationSchema }).strict();

const paymentV1 = z.object({
  x402Version: z.literal(1),
  scheme: z.string().max(32),
  network: z.string().max(64),
  payload: exactPayload,
});

const paymentV2 = z.object({
  x402Version: z.literal(2),
  accepted: z
    .object({ scheme: z.string().max(32), network: z.string().max(64) })
    .passthrough(),
  resource: z.unknown().optional(),
  payload: exactPayload,
  extensions: z.unknown().optional(),
});

export interface DecodedPayment {
  version: 1 | 2;
  scheme: string;
  network: string;
  signature: Hex;
  authorization: Authorization;
}

export class PaymentDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentDecodeError";
  }
}

const BASE64_RE = /^[A-Za-z0-9+/_-]+={0,2}$/;

export function decodeBase64Json(value: string): unknown {
  if (value.length > MAX_PAYMENT_HEADER_BYTES) throw new PaymentDecodeError("payment header too large");
  const trimmed = value.trim();
  if (!BASE64_RE.test(trimmed)) throw new PaymentDecodeError("payment header is not base64");
  let text: string;
  try {
    text = Buffer.from(trimmed.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    throw new PaymentDecodeError("payment header is not base64");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new PaymentDecodeError("payment header is not JSON");
  }
}

export function encodeBase64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

/** Pull the client's payment from either header generation. v2 wins if both are present. */
export function readPaymentHeader(headers: Headers): { raw: string; version: 1 | 2 } | null {
  const v2 = headers.get(HEADER_V2_PAYMENT);
  if (v2) return { raw: v2, version: 2 };
  const v1 = headers.get(HEADER_V1_PAYMENT);
  if (v1) return { raw: v1, version: 1 };
  return null;
}

export function decodePayment(raw: string): DecodedPayment {
  const json = decodeBase64Json(raw);
  const version = (json as { x402Version?: unknown } | null)?.x402Version;
  if (version === 1) {
    const parsed = paymentV1.safeParse(json);
    if (!parsed.success) throw new PaymentDecodeError(`invalid payment: ${formatIssues(parsed.error)}`);
    const p = parsed.data;
    return {
      version: 1,
      scheme: p.scheme,
      network: p.network,
      signature: p.payload.signature,
      authorization: p.payload.authorization as Authorization,
    };
  }
  if (version === 2) {
    const parsed = paymentV2.safeParse(json);
    if (!parsed.success) throw new PaymentDecodeError(`invalid payment: ${formatIssues(parsed.error)}`);
    const p = parsed.data;
    return {
      version: 2,
      scheme: p.accepted.scheme,
      network: p.accepted.network,
      signature: p.payload.signature,
      authorization: p.payload.authorization as Authorization,
    };
  }
  throw new PaymentDecodeError("unsupported x402Version");
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

export interface RequirementsInput {
  network: NetworkInfo;
  amount: bigint;
  asset: Address;
  /** Always the escrow contract: funds never go to the provider directly. */
  payTo: Address;
  resource: string;
  description: string;
  mimeType: string;
  maxTimeoutSeconds: number;
  /** EIP-712 domain of the asset, needed by clients to sign. */
  assetName: string;
  assetVersion: string;
  /** Bazaar discovery metadata. */
  method: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  /** Terms the payer is buying, surfaced for agents that read them. */
  terms: Record<string, unknown>;
}

export interface PaymentRequiredResponse {
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

export function buildPaymentRequired(input: RequirementsInput, error?: string): PaymentRequiredResponse {
  const extra = { name: input.assetName, version: input.assetVersion, backstop: input.terms };
  const v1Requirement = {
    scheme: "exact",
    network: input.network.name,
    maxAmountRequired: input.amount.toString(),
    resource: input.resource,
    description: input.description,
    mimeType: input.mimeType,
    payTo: input.payTo,
    maxTimeoutSeconds: input.maxTimeoutSeconds,
    asset: input.asset,
    outputSchema: {
      input: {
        type: "http",
        method: input.method,
        discoverable: true,
        ...(input.inputSchema ? { bodySchema: input.inputSchema } : {}),
      },
      ...(input.outputSchema ? { output: input.outputSchema } : {}),
    },
    extra,
  };
  const v2 = {
    x402Version: 2,
    ...(error ? { error } : {}),
    resource: { url: input.resource, description: input.description, mimeType: input.mimeType },
    accepts: [
      {
        scheme: "exact",
        network: input.network.caip2,
        amount: input.amount.toString(),
        asset: input.asset,
        payTo: input.payTo,
        maxTimeoutSeconds: input.maxTimeoutSeconds,
        extra,
      },
    ],
  };
  return {
    body: { x402Version: 1, accepts: [v1Requirement], ...(error ? { error } : {}) },
    headers: { [HEADER_V2_REQUIRED]: encodeBase64Json(v2) },
  };
}

export interface SettlementResponse {
  success: boolean;
  transaction: Hex | "";
  network: NetworkInfo;
  payer: Address;
  errorReason?: string;
}

/** Header telling the client how its payment was settled, in the generation it paid with. */
export function buildSettlementHeader(version: 1 | 2, s: SettlementResponse): Record<string, string> {
  const value = encodeBase64Json({
    success: s.success,
    transaction: s.transaction,
    network: version === 2 ? s.network.caip2 : s.network.name,
    payer: s.payer,
    ...(s.errorReason ? { errorReason: s.errorReason } : {}),
  });
  return { [version === 2 ? HEADER_V2_RESPONSE : HEADER_V1_RESPONSE]: value };
}
