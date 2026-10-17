import { requireViewer, resolveViewer } from "@/server/access";
import { withdrawDispute } from "@/server/disputes";
import { json, route } from "@/server/http";
import { getPayment } from "@/server/payments";

export const POST = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const { viewer, label } = await resolveViewer(req, id);
  requireViewer(viewer, "payer");
  await withdrawDispute(id.toLowerCase(), label);
  return json({ payment: await getPayment(id, viewer) });
});
