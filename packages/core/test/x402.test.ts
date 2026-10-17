import { describe, expect, it } from "vitest";
import {
  buildPaymentRequired,
  buildSettlementHeader,
  decodeBase64Json,
  decodePayment,
  encodeBase64Json,
  matchesNetwork,
  NETWORKS,
  PaymentDecodeError,
  readPaymentHeader,
} from "../src/x402";

const authorization = {
  from: "0x1111111111111111111111111111111111111111",
  to: "0x2222222222222222222222222222222222222222",
  value: "250000",
  validAfter: "0",
  validBefore: "1999999999",
  nonce: `0x${"ab".repeat(32)}`,
};
const signature = `0x${"11".repeat(64)}1b`;

describe("decodePayment", () => {
  it("decodes v1", () => {
    const raw = encodeBase64Json({ x402Version: 1, scheme: "exact", network: "base", payload: { signature, authorization } });
    const p = decodePayment(raw);
    expect(p.version).toBe(1);
    expect(p.network).toBe("base");
    expect(p.authorization.value).toBe("250000");
    // addresses come back checksummed
    expect(p.authorization.from).toBe("0x1111111111111111111111111111111111111111");
  });

  it("decodes v2 from the accepted requirement", () => {
    const raw = encodeBase64Json({
      x402Version: 2,
      accepted: { scheme: "exact", network: "eip155:8453", amount: "250000" },
      payload: { signature, authorization },
    });
    const p = decodePayment(raw);
    expect(p.version).toBe(2);
    expect(p.network).toBe("eip155:8453");
  });

  it("accepts base64url encoding", () => {
    const raw = encodeBase64Json({ x402Version: 1, scheme: "exact", network: "base", payload: { signature, authorization } })
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    expect(decodePayment(raw).version).toBe(1);
  });

  const bad: Array<[string, unknown]> = [
    ["unknown version", { x402Version: 3, scheme: "exact", network: "base", payload: { signature, authorization } }],
    ["missing payload", { x402Version: 1, scheme: "exact", network: "base" }],
    ["short signature", { x402Version: 1, scheme: "exact", network: "base", payload: { signature: "0x1234", authorization } }],
    [
      "bad address",
      { x402Version: 1, scheme: "exact", network: "base", payload: { signature, authorization: { ...authorization, from: "0x123" } } },
    ],
    [
      "negative value",
      { x402Version: 1, scheme: "exact", network: "base", payload: { signature, authorization: { ...authorization, value: "-1" } } },
    ],
    [
      "decimal value",
      { x402Version: 1, scheme: "exact", network: "base", payload: { signature, authorization: { ...authorization, value: "1.5" } } },
    ],
    [
      "short nonce",
      { x402Version: 1, scheme: "exact", network: "base", payload: { signature, authorization: { ...authorization, nonce: "0x01" } } },
    ],
    [
      "extra authorization field",
      {
        x402Version: 1,
        scheme: "exact",
        network: "base",
        payload: { signature, authorization: { ...authorization, extra: "x" } },
      },
    ],
    ["null", null],
    ["array", []],
  ];
  it.each(bad)("rejects %s", (_name, value) => {
    expect(() => decodePayment(encodeBase64Json(value))).toThrow(PaymentDecodeError);
  });

  it("rejects non-base64 and non-JSON input", () => {
    expect(() => decodePayment("not base64 !!")).toThrow(PaymentDecodeError);
    expect(() => decodePayment(Buffer.from("not json").toString("base64"))).toThrow(PaymentDecodeError);
  });

  it("rejects oversized headers before decoding", () => {
    expect(() => decodeBase64Json("A".repeat(9000))).toThrow(/too large/);
  });
});

describe("readPaymentHeader", () => {
  it("prefers v2 and falls back to v1", () => {
    expect(readPaymentHeader(new Headers({ "x-payment": "a" }))).toEqual({ raw: "a", version: 1 });
    expect(readPaymentHeader(new Headers({ "x-payment": "a", "payment-signature": "b" }))).toEqual({ raw: "b", version: 2 });
    expect(readPaymentHeader(new Headers())).toBeNull();
  });
});

describe("buildPaymentRequired", () => {
  const input = {
    network: NETWORKS.base,
    amount: 250_000n,
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const,
    payTo: "0x2222222222222222222222222222222222222222" as const,
    resource: "https://backstop.example/x/weather/today",
    description: "Weather",
    mimeType: "application/json",
    maxTimeoutSeconds: 120,
    assetName: "USD Coin",
    assetVersion: "2",
    method: "GET",
    terms: { holdSeconds: 600 },
  };

  it("emits a v1 body and a v2 header describing the same payment", () => {
    const res = buildPaymentRequired(input, "payment required");
    const v1 = (res.body.accepts as Array<Record<string, unknown>>)[0]!;
    expect(res.body.x402Version).toBe(1);
    expect(v1.maxAmountRequired).toBe("250000");
    expect(v1.payTo).toBe(input.payTo);
    expect(v1.network).toBe("base");
    expect((v1.extra as Record<string, unknown>).name).toBe("USD Coin");

    const v2 = decodeBase64Json(res.headers["payment-required"]!) as Record<string, any>;
    expect(v2.x402Version).toBe(2);
    expect(v2.accepts[0].network).toBe("eip155:8453");
    expect(v2.accepts[0].amount).toBe("250000");
    expect(v2.error).toBe("payment required");
  });

  it("settlement header follows the client's version", () => {
    const s = { success: true, transaction: "0xabc" as const, network: NETWORKS.base, payer: input.payTo };
    const v1 = buildSettlementHeader(1, s);
    const v2 = buildSettlementHeader(2, s);
    expect(decodeBase64Json(v1["x-payment-response"]!)).toMatchObject({ network: "base" });
    expect(decodeBase64Json(v2["payment-response"]!)).toMatchObject({ network: "eip155:8453" });
  });
});

describe("matchesNetwork", () => {
  it("accepts both identifiers", () => {
    expect(matchesNetwork("base", NETWORKS.base)).toBe(true);
    expect(matchesNetwork("eip155:8453", NETWORKS.base)).toBe(true);
    expect(matchesNetwork("base-sepolia", NETWORKS.base)).toBe(false);
  });
});
