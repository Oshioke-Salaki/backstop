import { describe, expect, it } from "vitest";
import { feeFor, formatUsdc, parseAtomic, parseUsdc, settlementFor } from "../src/money";

describe("parseUsdc", () => {
  it.each([
    ["0", 0n],
    ["1", 1_000_000n],
    ["0.25", 250_000n],
    ["0.000001", 1n],
    ["12.5", 12_500_000n],
    [" 3.10 ", 3_100_000n],
  ])("parses %s", (input, expected) => {
    expect(parseUsdc(input)).toBe(expected);
  });

  it.each(["", "-1", "+1", "1e6", "0.0000001", "01", ".5", "1.", "1,000", "NaN", "Infinity", "0x10", "1 000"])(
    "rejects %j",
    (input) => {
      expect(() => parseUsdc(input)).toThrow(RangeError);
    },
  );
});

describe("formatUsdc", () => {
  it.each([
    [0n, "0.00"],
    [1n, "0.000001"],
    [250_000n, "0.25"],
    [1_000_000n, "1.00"],
    [12_340_000n, "12.34"],
    [-5_000_000n, "-5.00"],
  ])("formats %s", (input, expected) => {
    expect(formatUsdc(input)).toBe(expected);
  });

  it("round-trips through parse", () => {
    for (const v of [1n, 99n, 123_456n, 1_000_001n, 987_654_321_000n]) {
      expect(parseUsdc(formatUsdc(v))).toBe(v);
    }
  });
});

describe("parseAtomic", () => {
  it("accepts canonical integers only", () => {
    expect(parseAtomic("0")).toBe(0n);
    expect(parseAtomic("1000000")).toBe(1_000_000n);
    for (const bad of ["", "01", "-1", "1.0", "1e3", " 1", "0x1"]) expect(() => parseAtomic(bad)).toThrow();
  });
});

describe("fees", () => {
  it("mirrors the contract's floor rounding", () => {
    expect(feeFor(10_000_000n, 100)).toBe(100_000n);
    expect(feeFor(99n, 100)).toBe(0n);
    expect(feeFor(101n, 100)).toBe(1n);
    expect(feeFor(1n, 500)).toBe(0n);
  });

  it("rejects out-of-range rates", () => {
    expect(() => feeFor(1n, 501)).toThrow();
    expect(() => feeFor(1n, -1)).toThrow();
    expect(() => feeFor(1n, 1.5)).toThrow();
  });

  it("conserves funds on every settlement path", () => {
    for (const amount of [1n, 7n, 1_000_000n, 123_456_789n]) {
      for (const bps of [0, 1, 100, 250, 500]) {
        for (const kind of ["release", "refund"] as const) {
          const s = settlementFor(kind, amount, bps);
          expect(s.payer + s.payee + s.fee).toBe(amount);
        }
        for (const share of [0n, 1n, amount / 2n, amount]) {
          const s = settlementFor("split", amount, bps, share);
          expect(s.payer + s.payee + s.fee).toBe(amount);
          expect(s.payer).toBe(share);
        }
      }
    }
  });

  it("never charges a fee on refunds", () => {
    expect(settlementFor("refund", 5_000_000n, 500).fee).toBe(0n);
  });

  it("rejects invalid split shares and amounts", () => {
    expect(() => settlementFor("split", 10n, 100, 11n)).toThrow();
    expect(() => settlementFor("split", 10n, 100, -1n)).toThrow();
    expect(() => settlementFor("release", 0n, 100)).toThrow();
  });
});
