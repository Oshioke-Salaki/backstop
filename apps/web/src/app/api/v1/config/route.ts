import { getChainContext } from "@/server/chain";
import { getConfig } from "@/server/config";
import { json, route } from "@/server/http";

/** Public parameters agents and verifiers need. */
export const GET = route(async () => {
  const c = getConfig();
  return json({
    network: c.network,
    escrow: c.ESCROW_ADDRESS,
    asset: { address: c.USDC_ADDRESS, name: c.USDC_NAME, version: c.USDC_VERSION, decimals: 6 },
    receiptSigner: getChainContext().receiptAccount.address,
    disputeResponseSeconds: c.DISPUTE_RESPONSE_SECONDS,
    disputeReviewSeconds: c.DISPUTE_REVIEW_SECONDS,
    settlementGraceSeconds: c.SETTLEMENT_GRACE_SECONDS,
  });
});
