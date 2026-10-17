import { getAddress, isAddress } from "viem";
import { ApiError, clientIp, json, route } from "@/server/http";
import { listPayments } from "@/server/payments";
import { enforce, LIMITS } from "@/server/ratelimit";
import { FAILURE_LABELS } from "@/lib/status";

/**
 * Recent payments from one wallet, status only. Lets an agent that paid through PayBox (which may not
 * surface Backstop's response headers) see what happened. Deliberately excludes capability tokens: this
 * grants no access to act on a payment, and every field here is already public through escrow events.
 */
export const GET = route(async (req: Request) => {
  enforce(`read:${clientIp(req)}`, LIMITS.publicReadPerIp);
  const url = new URL(req.url);
  const payer = url.searchParams.get("payer") ?? "";
  if (!isAddress(payer)) throw new ApiError(400, "invalid_payer", "Pass ?payer= with the paying wallet's address.");
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 10) || 10, 1), 25);
  const page = await listPayments({ payer: getAddress(payer) });
  return json({
    payer: getAddress(payer),
    payments: page.items.slice(0, limit).map((p) => ({
      id: p.id,
      status: p.status,
      service: { slug: p.serviceSlug, name: p.serviceName },
      amount: p.amount,
      createdAt: p.createdAt,
      releaseAt: p.releaseAt,
      failureReason: p.reason,
      failureText: p.reason ? (FAILURE_LABELS[p.reason] ?? p.reason) : null,
    })),
  });
});
