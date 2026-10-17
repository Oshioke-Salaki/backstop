import type { EscrowStatus } from "@backstop/core";

export type Tone = "held" | "released" | "refunded" | "failed" | "disputed" | "neutral";

interface StatusMeta {
  label: string;
  tone: Tone;
  /** For the person who paid. */
  payer: string;
  /** For the provider being paid. */
  provider: string;
  live: boolean;
}

export const STATUS: Record<EscrowStatus, StatusMeta> = {
  funding: {
    label: "Confirming payment",
    tone: "neutral",
    payer: "Your payment is being confirmed on-chain. Nothing has been sent to the provider.",
    provider: "Payment is confirming on-chain. The request has not reached you yet.",
    live: true,
  },
  funding_failed: {
    label: "Not charged",
    tone: "neutral",
    payer: "The payment could not be taken, so you were not charged.",
    provider: "The payment never landed. No request was sent to you.",
    live: false,
  },
  held: {
    label: "Checking delivery",
    tone: "held",
    payer: "Funds are in escrow while Backstop checks the provider's response.",
    provider: "Funds are in escrow while Backstop checks your response.",
    live: true,
  },
  release_pending: {
    label: "Held for review",
    tone: "held",
    payer: "Delivery passed every check. Funds release to the provider when the dispute window closes.",
    provider: "Your response passed every check. Funds release when the dispute window closes.",
    live: true,
  },
  refund_pending: {
    label: "Refunding",
    tone: "refunded",
    payer: "Delivery failed a check. Your full payment is on its way back.",
    provider: "Your response failed a check, so the payer is being refunded.",
    live: true,
  },
  disputed: {
    label: "In dispute",
    tone: "disputed",
    payer: "You disputed this delivery. Funds stay in escrow until it is resolved.",
    provider: "The payer disputed this delivery. Respond with your side before the deadline.",
    live: true,
  },
  released: {
    label: "Paid to provider",
    tone: "released",
    payer: "Delivery was accepted and the provider has been paid.",
    provider: "You have been paid.",
    live: false,
  },
  refunded: {
    label: "Refunded",
    tone: "refunded",
    payer: "Your payment was refunded in full.",
    provider: "The payer was refunded.",
    live: false,
  },
  split: {
    label: "Settled by arbiter",
    tone: "disputed",
    payer: "An arbiter split this payment. See the outcome below.",
    provider: "An arbiter split this payment. See the outcome below.",
    live: false,
  },
  reclaimed: {
    label: "Reclaimed",
    tone: "refunded",
    payer: "The escrow deadline passed and the funds returned to you.",
    provider: "The settlement deadline passed and the payer reclaimed the funds.",
    live: false,
  },
};

export const TONE_CLASSES: Record<Tone, { text: string; soft: string; dot: string }> = {
  held: { text: "text-held", soft: "bg-held-soft", dot: "bg-held" },
  released: { text: "text-released", soft: "bg-released-soft", dot: "bg-released" },
  refunded: { text: "text-refunded", soft: "bg-refunded-soft", dot: "bg-refunded" },
  failed: { text: "text-failed", soft: "bg-failed-soft", dot: "bg-failed" },
  disputed: { text: "text-disputed", soft: "bg-disputed-soft", dot: "bg-disputed" },
  neutral: { text: "text-ink-2", soft: "bg-sunken", dot: "bg-ink-3" },
};

/** Human wording for the timeline. */
export const EVENT_LABELS: Record<string, string> = {
  payment_received: "Payment authorized",
  payment_failed: "Payment could not be taken",
  deposit_uncertain: "Deposit confirmation delayed",
  funds_held: "Funds locked in escrow",
  delivery_verified: "Delivery passed every check",
  delivery_failed: "Delivery failed a check",
  refund_started: "Refund started",
  refunded: "Refunded to payer",
  released: "Paid to provider",
  release_missed: "Release window missed, refunding",
  split: "Split settled",
  dispute_opened: "Dispute opened",
  dispute_answered: "Provider responded",
  dispute_resolved: "Dispute resolved",
  deadline_extended: "Escrow deadline extended for review",
  provider_refunded: "Provider refunded voluntarily",
  chain_sync: "Updated from the chain",
  chain_override: "Corrected from the chain",
  settlement_retry: "Settlement retrying",
  settlement_stuck: "Settlement needs attention",
};

export const FAILURE_LABELS: Record<string, string> = {
  timeout: "The provider did not answer in time",
  network_error: "The provider could not be reached",
  blocked_destination: "The provider's address is not allowed",
  upstream_status: "The provider returned an error",
  payment_loop: "The provider asked for a second payment",
  too_large: "The response was larger than promised",
  content_type: "The response was the wrong format",
  invalid_json: "The response was not valid JSON",
  schema_mismatch: "The response did not match its promised shape",
  assertion_failed: "A promised field was missing or wrong",
  delivery_not_attempted: "The provider was never called",
  delivery_interrupted: "Delivery was interrupted",
  refunded_by_provider: "The provider refunded it",
  settlement_deadline_missed: "Settlement deadline passed",
};
