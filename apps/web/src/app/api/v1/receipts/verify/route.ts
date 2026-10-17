import { z } from "zod";
import { decodeBase64Json, verifyReceipt, type EncodedReceipt } from "@backstop/core";
import { getChainContext } from "@/server/chain";
import { getConfig } from "@/server/config";
import { ApiError, clientIp, json, readJson, route } from "@/server/http";
import { enforce, LIMITS } from "@/server/ratelimit";

const body = z.union([z.object({ header: z.string().max(8192) }), z.object({ receipt: z.record(z.unknown()), signature: z.string() })]);

/** Check a receipt against Backstop's receipt signer. Accepts the raw header value or the decoded JSON. */
export const POST = route(async (req: Request) => {
  enforce(`read:${clientIp(req)}`, LIMITS.publicReadPerIp);
  const input = body.parse(await readJson(req));
  let encoded: EncodedReceipt;
  try {
    encoded = ("header" in input ? decodeBase64Json(input.header) : input) as EncodedReceipt;
  } catch {
    throw new ApiError(400, "invalid_receipt", "That is not a Backstop receipt.");
  }
  const config = getConfig();
  const result = await verifyReceipt(encoded, { chainId: config.network.chainId, escrow: config.ESCROW_ADDRESS }, getChainContext().receiptAccount.address);
  return json({ valid: result.valid, receipt: result.valid ? encoded.receipt : null });
});
