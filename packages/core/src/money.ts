/** USDC amounts are handled as bigint base units (6 decimals) end to end. Floats never touch money. */
export const USDC_DECIMALS = 6;
const SCALE = 10n ** BigInt(USDC_DECIMALS);
const BPS = 10_000n;
export const MAX_FEE_BPS = 500;

const DECIMAL_RE = /^(0|[1-9]\d{0,14})(?:\.(\d{1,6}))?$/;

/** Parse a human amount like "0.25" into base units. Rejects signs, exponents, and >6 decimals. */
export function parseUsdc(input: string): bigint {
  const match = DECIMAL_RE.exec(input.trim());
  if (!match) throw new RangeError(`Invalid USDC amount: ${JSON.stringify(input)}`);
  const whole = BigInt(match[1]!);
  const frac = BigInt((match[2] ?? "").padEnd(USDC_DECIMALS, "0"));
  return whole * SCALE + frac;
}

/** Format base units as a decimal string, trimming trailing zeros but keeping two places. */
export function formatUsdc(amount: bigint): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const whole = abs / SCALE;
  let frac = (abs % SCALE).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${frac}`;
}

/** Parse a base-unit integer string as sent on the wire. */
export function parseAtomic(input: string): bigint {
  if (!/^(0|[1-9]\d{0,38})$/.test(input)) throw new RangeError(`Invalid atomic amount: ${JSON.stringify(input)}`);
  return BigInt(input);
}

/** Mirrors BackstopEscrow.feeFor: floor(amount * bps / 10000). */
export function feeFor(payeeAmount: bigint, feeBps: number): bigint {
  assertFeeBps(feeBps);
  if (payeeAmount < 0n) throw new RangeError("Amount must be non-negative");
  return (payeeAmount * BigInt(feeBps)) / BPS;
}

export interface Settlement {
  payer: bigint;
  payee: bigint;
  fee: bigint;
}

/** Exact on-chain outcome of each settlement path, for display and reconciliation. */
export function settlementFor(
  kind: "release" | "refund" | "split",
  amount: bigint,
  feeBps: number,
  payerShare = 0n,
): Settlement {
  if (amount <= 0n) throw new RangeError("Amount must be positive");
  switch (kind) {
    case "release": {
      const fee = feeFor(amount, feeBps);
      return { payer: 0n, payee: amount - fee, fee };
    }
    case "refund":
      return { payer: amount, payee: 0n, fee: 0n };
    case "split": {
      if (payerShare < 0n || payerShare > amount) throw new RangeError("Payer share out of range");
      const payeeGross = amount - payerShare;
      const fee = feeFor(payeeGross, feeBps);
      return { payer: payerShare, payee: payeeGross - fee, fee };
    }
  }
}

export function assertFeeBps(feeBps: number): void {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > MAX_FEE_BPS) {
    throw new RangeError(`Fee must be an integer between 0 and ${MAX_FEE_BPS} bps`);
  }
}
