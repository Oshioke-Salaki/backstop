import { requireViewer, resolveViewer } from "@/server/access";
import { openDispute, openDisputeInput } from "@/server/disputes";
import { json, readJson, route } from "@/server/http";
import { getPayment } from "@/server/payments";
import { enforce, LIMITS } from "@/server/ratelimit";

export const POST = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const { viewer, label } = await resolveViewer(req, id);
  requireViewer(viewer, "payer");
  enforce(`dispute:${id}`, LIMITS.disputePerActor);
  const input = openDisputeInput.parse(await readJson(req));
  await openDispute(id.toLowerCase(), label, input);
  return json({ payment: await getPayment(id, viewer) }, { status: 201 });
});
