import { requireUser } from "@/server/auth";
import { json, route } from "@/server/http";
import { listPayments, statusFilter } from "@/server/payments";

export const GET = route(async (req: Request) => {
  const session = await requireUser(req);
  const url = new URL(req.url);
  return json(await listPayments({ payer: session.address, status: statusFilter(url), cursor: url.searchParams.get("cursor") }));
});
