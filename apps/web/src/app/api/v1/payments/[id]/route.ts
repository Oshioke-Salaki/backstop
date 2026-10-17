import { resolveViewer } from "@/server/access";
import { json, route } from "@/server/http";
import { getPayment } from "@/server/payments";

export const GET = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const { viewer } = await resolveViewer(req, id);
  return json({ payment: await getPayment(id, viewer), viewer });
});
