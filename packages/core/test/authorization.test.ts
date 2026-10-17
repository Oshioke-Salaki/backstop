import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { parseSignature, serializeSignature, type Hex } from "viem";
import { AuthorizationRejected, TRANSFER_WITH_AUTHORIZATION_TYPES, verifyAuthorization, type Expected } from "../src/authorization";
import { NETWORKS, type DecodedPayment } from "../src/x402";

const payer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const other = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const asset = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const escrow = "0x2222222222222222222222222222222222222222" as const;
const payee = "0x3333333333333333333333333333333333333333" as const;
const now = 1_750_000_000;

const expected: Expected = {
  network: NETWORKS.base,
  asset,
  assetName: "USD Coin",
  assetVersion: "2",
  escrow,
  amount: 250_000n,
  payee,
  minValiditySeconds: 60,
  nowSeconds: now,
};

async function payment(
  overrides: Partial<{ to: Hex; value: string; validAfter: string; validBefore: string; network: string; scheme: string }> = {},
  signer = payer,
): Promise<DecodedPayment> {
  const authorization = {
    from: payer.address,
    to: (overrides.to ?? escrow) as `0x${string}`,
    value: overrides.value ?? "250000",
    validAfter: overrides.validAfter ?? String(now - 10),
    validBefore: overrides.validBefore ?? String(now + 600),
    nonce: `0x${"cd".repeat(32)}` as Hex,
  };
  const signature = await signer.signTypedData({
    domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: asset },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      ...authorization,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
    },
  });
  return {
    version: 1,
    scheme: overrides.scheme ?? "exact",
    network: overrides.network ?? "base",
    signature,
    authorization,
  };
}

async function rejection(p: Promise<DecodedPayment> | DecodedPayment, exp: Expected = expected) {
  try {
    await verifyAuthorization(await p, exp);
  } catch (err) {
    expect(err).toBeInstanceOf(AuthorizationRejected);
    return (err as AuthorizationRejected).code;
  }
  throw new Error("expected rejection");
}

describe("verifyAuthorization", () => {
  it("accepts a correct payment and splits the signature", async () => {
    const v = await verifyAuthorization(await payment(), expected);
    expect(v.from).toBe(payer.address);
    expect(v.value).toBe(250_000n);
    expect([27, 28]).toContain(v.v);
    expect(v.r).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("accepts the CAIP-2 network id", async () => {
    await expect(verifyAuthorization(await payment({ network: "eip155:8453" }), expected)).resolves.toBeTruthy();
  });

  it("rejects other schemes", async () => {
    expect(await rejection(payment({ scheme: "upto" }))).toBe("unsupported_scheme");
  });

  it("rejects the wrong network", async () => {
    expect(await rejection(payment({ network: "base-sepolia" }))).toBe("wrong_network");
  });

  it("rejects payments addressed to anyone but the escrow", async () => {
    expect(await rejection(payment({ to: payee }))).toBe("wrong_recipient");
  });

  it("rejects under- and over-payment", async () => {
    expect(await rejection(payment({ value: "249999" }))).toBe("wrong_amount");
    expect(await rejection(payment({ value: "250001" }))).toBe("wrong_amount");
  });

  it("rejects authorizations not yet valid, including validAfter == now", async () => {
    expect(await rejection(payment({ validAfter: String(now) }))).toBe("not_yet_valid");
    expect(await rejection(payment({ validAfter: String(now + 100) }))).toBe("not_yet_valid");
  });

  it("rejects authorizations that expire before a deposit can land", async () => {
    expect(await rejection(payment({ validBefore: String(now + 59) }))).toBe("expires_too_soon");
    expect(await rejection(payment({ validBefore: String(now - 1) }))).toBe("expires_too_soon");
    await expect(verifyAuthorization(await payment({ validBefore: String(now + 60) }), expected)).resolves.toBeTruthy();
  });

  it("rejects a signature from someone other than the payer", async () => {
    expect(await rejection(payment({}, other))).toBe("invalid_signature");
  });

  it("rejects a valid signature over different terms", async () => {
    const p = await payment();
    p.authorization = { ...p.authorization, validBefore: String(now + 700) };
    expect(await rejection(p)).toBe("invalid_signature");
  });

  it("rejects a signature for another chain's domain", async () => {
    expect(await rejection(payment(), { ...expected, network: { ...NETWORKS.base, chainId: 1 } })).toBe("invalid_signature");
  });

  it("rejects malleable high-s signatures", async () => {
    const p = await payment();
    const sig = parseSignature(p.signature);
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const highS = `0x${(n - BigInt(sig.s)).toString(16).padStart(64, "0")}` as Hex;
    p.signature = serializeSignature({ r: sig.r, s: highS, yParity: sig.yParity === 0 ? 1 : 0 });
    expect(await rejection(p)).toBe("invalid_signature");
  });

  it("rejects a payer paying themselves", async () => {
    expect(await rejection(payment(), { ...expected, payee: payer.address })).toBe("self_payment");
  });

  it("rejects garbage signatures without throwing anything else", async () => {
    const p = await payment();
    p.signature = `0x${"00".repeat(65)}`;
    expect(await rejection(p)).toBe("invalid_signature");
  });
});
