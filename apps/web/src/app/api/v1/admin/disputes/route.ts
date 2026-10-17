import { requireAdmin } from "@/server/auth";
import { listOpenDisputes } from "@/server/disputes";
import { json, route } from "@/server/http";

export const GET = route(async (req: Request) => {
  await requireAdmin(req);
  const rows = await listOpenDisputes();
  return json({
    disputes: rows.map((r) => ({
      id: r.dispute.id,
      escrowId: r.escrow.id,
      service: { name: r.serviceName, slug: r.serviceSlug },
      amountAtomic: r.escrow.amountAtomic.toString(),
      reason: r.dispute.reason,
      respondBy: r.dispute.respondBy,
      providerResponded: !!r.dispute.providerRespondedAt,
      createdAt: r.dispute.createdAt,
    })),
  });
});
