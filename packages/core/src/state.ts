/**
 * Off-chain escrow lifecycle. The contract is the source of truth for money; this tracks
 * everything around it (verification, hold windows, disputes) and must never contradict it.
 */

export const ESCROW_STATUSES = [
  "funding",
  "funding_failed",
  "held",
  "release_pending",
  "refund_pending",
  "disputed",
  "released",
  "refunded",
  "split",
  "reclaimed",
] as const;

export type EscrowStatus = (typeof ESCROW_STATUSES)[number];

const TRANSITIONS: Record<EscrowStatus, readonly EscrowStatus[]> = {
  funding: ["held", "funding_failed"],
  funding_failed: [],
  held: ["release_pending", "refund_pending", "reclaimed"],
  release_pending: ["released", "disputed", "refund_pending", "reclaimed"],
  refund_pending: ["refunded", "reclaimed"],
  disputed: ["released", "refunded", "split", "reclaimed"],
  released: [],
  refunded: [],
  split: [],
  reclaimed: [],
};

export const TERMINAL_STATUSES: readonly EscrowStatus[] = ["funding_failed", "released", "refunded", "split", "reclaimed"];

/** Statuses in which funds sit in the contract. */
export const HELD_STATUSES: readonly EscrowStatus[] = ["held", "release_pending", "refund_pending", "disputed"];

export function canTransition(from: EscrowStatus, to: EscrowStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: EscrowStatus,
    readonly to: EscrowStatus,
  ) {
    super(`cannot move escrow from ${from} to ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function assertTransition(from: EscrowStatus, to: EscrowStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export function isTerminal(status: EscrowStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Mirrors BackstopEscrow.Status. */
export const ONCHAIN_STATUS = { None: 0, Held: 1, Released: 2, Refunded: 3, Split: 4 } as const;

/**
 * Off-chain status implied by an on-chain settlement we did not initiate (or whose receipt we lost).
 * Used by reconciliation so the database converges on the chain.
 */
export function statusFromChain(onchain: number, reclaimedByDeadline: boolean): EscrowStatus | null {
  switch (onchain) {
    case ONCHAIN_STATUS.Released:
      return "released";
    case ONCHAIN_STATUS.Refunded:
      return reclaimedByDeadline ? "reclaimed" : "refunded";
    case ONCHAIN_STATUS.Split:
      return "split";
    default:
      return null;
  }
}

export type DisputeReason =
  | "wrong_content"
  | "incomplete"
  | "not_as_described"
  | "duplicate_charge"
  | "other";

export const DISPUTE_REASONS: Record<DisputeReason, string> = {
  wrong_content: "Response was wrong or fabricated",
  incomplete: "Response was incomplete",
  not_as_described: "Not what the service described",
  duplicate_charge: "Charged twice for the same request",
  other: "Something else",
};
