import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  capabilityToken,
  requestHash,
  sha256Hex,
  signProviderRequest,
  verifyCapabilityToken,
  verifyProviderRequest,
} from "../src/signing";
import { encodeReceipt, signReceipt, verifyReceipt, ZERO_HASH, type Receipt } from "../src/receipt";
import {
  assertTransition,
  canTransition,
  ESCROW_STATUSES,
  HELD_STATUSES,
  InvalidTransitionError,
  isTerminal,
  statusFromChain,
  TERMINAL_STATUSES,
} from "../src/state";

describe("provider request signatures", () => {
  const secret = "s3cret";
  const body = new TextEncoder().encode('{"a":1}');
  const input = { escrowId: "0xabc", method: "post", path: "/v1/run", body };

  it("verifies its own signatures", () => {
    const header = signProviderRequest(secret, { ...input, timestamp: 1000 });
    expect(verifyProviderRequest(secret, header, { ...input, nowSeconds: 1100 })).toBe(true);
  });

  it("rejects tampering, wrong secrets, stale timestamps and junk", () => {
    const header = signProviderRequest(secret, { ...input, timestamp: 1000 });
    expect(verifyProviderRequest("other", header, { ...input, nowSeconds: 1000 })).toBe(false);
    expect(verifyProviderRequest(secret, header, { ...input, path: "/v1/other", nowSeconds: 1000 })).toBe(false);
    expect(verifyProviderRequest(secret, header, { ...input, body: new Uint8Array([1]), nowSeconds: 1000 })).toBe(false);
    expect(verifyProviderRequest(secret, header, { ...input, escrowId: "0xdef", nowSeconds: 1000 })).toBe(false);
    expect(verifyProviderRequest(secret, header, { ...input, nowSeconds: 1301 })).toBe(false);
    expect(verifyProviderRequest(secret, header, { ...input, nowSeconds: 699 })).toBe(false);
    expect(verifyProviderRequest(secret, null, { ...input, nowSeconds: 1000 })).toBe(false);
    expect(verifyProviderRequest(secret, "garbage", { ...input, nowSeconds: 1000 })).toBe(false);
    expect(verifyProviderRequest(secret, "t=1000,v1=00", { ...input, nowSeconds: 1000 })).toBe(false);
  });
});

describe("requestHash", () => {
  const base = { method: "GET", path: "/x", query: new URLSearchParams("b=2&a=1"), contentType: null, body: new Uint8Array() };
  it("is order-insensitive for query parameters", () => {
    expect(requestHash(base)).toBe(requestHash({ ...base, query: new URLSearchParams("a=1&b=2") }));
  });
  it("changes with method, path, query, type and body", () => {
    const h = requestHash(base);
    expect(requestHash({ ...base, method: "POST" })).not.toBe(h);
    expect(requestHash({ ...base, path: "/y" })).not.toBe(h);
    expect(requestHash({ ...base, query: new URLSearchParams("a=1&b=3") })).not.toBe(h);
    expect(requestHash({ ...base, contentType: "application/json" })).not.toBe(h);
    expect(requestHash({ ...base, body: new Uint8Array([1]) })).not.toBe(h);
  });
  it("ignores media type parameters and case", () => {
    expect(requestHash({ ...base, contentType: "Application/JSON; charset=utf-8" })).toBe(
      requestHash({ ...base, contentType: "application/json" }),
    );
  });
  it("produces 32-byte hex", () => {
    expect(requestHash(base)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(sha256Hex("")).toBe("0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("capability tokens", () => {
  it("bind to one escrow, case-insensitively", () => {
    const t = capabilityToken("k", "0xABC");
    expect(verifyCapabilityToken("k", "0xabc", t)).toBe(true);
    expect(verifyCapabilityToken("k", "0xabd", t)).toBe(false);
    expect(verifyCapabilityToken("other", "0xabc", t)).toBe(false);
    expect(verifyCapabilityToken("k", "0xabc", "")).toBe(false);
    expect(verifyCapabilityToken("k", "0xabc", undefined)).toBe(false);
    expect(verifyCapabilityToken("k", "0xabc", t.slice(1))).toBe(false);
  });
});

describe("receipts", () => {
  const signer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
  const domain = { chainId: 8453, escrow: "0x2222222222222222222222222222222222222222" as const };
  const receipt: Receipt = {
    escrowId: `0x${"aa".repeat(32)}`,
    service: "weather-today",
    payer: "0x1111111111111111111111111111111111111111",
    payee: "0x3333333333333333333333333333333333333333",
    amount: 250_000n,
    passed: true,
    reason: "",
    requestHash: `0x${"bb".repeat(32)}`,
    responseHash: ZERO_HASH,
    latencyMs: 140,
    issuedAt: 1_750_000_000n,
  };

  it("round-trips through JSON and verifies", async () => {
    const encoded = JSON.parse(JSON.stringify(encodeReceipt(receipt, await signReceipt(signer, domain, receipt))));
    const result = await verifyReceipt(encoded, domain, signer.address);
    expect(result.valid).toBe(true);
    expect(result.receipt?.amount).toBe(250_000n);
  });

  it("fails when any field, the domain or the signer differs", async () => {
    const sig = await signReceipt(signer, domain, receipt);
    const tampered = encodeReceipt({ ...receipt, passed: false }, sig);
    expect((await verifyReceipt(tampered, domain, signer.address)).valid).toBe(false);
    expect((await verifyReceipt(encodeReceipt(receipt, sig), { ...domain, chainId: 1 }, signer.address)).valid).toBe(false);
    expect(
      (await verifyReceipt(encodeReceipt(receipt, sig), domain, "0x1111111111111111111111111111111111111111")).valid,
    ).toBe(false);
    expect((await verifyReceipt({ receipt: {} as never, signature: "0x" }, domain, signer.address)).valid).toBe(false);
  });
});

describe("escrow state machine", () => {
  it("terminal statuses have no exits", () => {
    for (const t of TERMINAL_STATUSES) {
      expect(isTerminal(t)).toBe(true);
      for (const s of ESCROW_STATUSES) expect(canTransition(t, s)).toBe(false);
    }
  });

  it("every held status can still be reclaimed on-chain", () => {
    for (const s of HELD_STATUSES) expect(canTransition(s, "reclaimed")).toBe(true);
  });

  it("does not let a failed delivery be released", () => {
    expect(canTransition("refund_pending", "released")).toBe(false);
    expect(canTransition("refund_pending", "disputed")).toBe(false);
  });

  it("does not skip verification", () => {
    expect(canTransition("funding", "released")).toBe(false);
    expect(canTransition("held", "released")).toBe(false);
    expect(canTransition("held", "disputed")).toBe(false);
  });

  it("throws a typed error on invalid transitions", () => {
    expect(() => assertTransition("released", "refunded")).toThrow(InvalidTransitionError);
    expect(() => assertTransition("held", "release_pending")).not.toThrow();
  });

  it("maps chain outcomes", () => {
    expect(statusFromChain(2, false)).toBe("released");
    expect(statusFromChain(3, false)).toBe("refunded");
    expect(statusFromChain(3, true)).toBe("reclaimed");
    expect(statusFromChain(4, false)).toBe("split");
    expect(statusFromChain(1, false)).toBeNull();
    expect(statusFromChain(0, false)).toBeNull();
  });
});
