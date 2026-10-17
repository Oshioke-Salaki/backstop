import { requireActor, requireProviderId } from "@/server/auth";
import { json, route } from "@/server/http";
import { listPayments, statusFilter } from "@/server/payments";

export const GET = route(async (req: Request) => {
  const providerId = await requireProviderId(await requireActor(req));
  const url = new URL(req.url);
  return json(await listPayments({ providerId, status: statusFilter(url), cursor: url.searchParams.get("cursor") }));
});
