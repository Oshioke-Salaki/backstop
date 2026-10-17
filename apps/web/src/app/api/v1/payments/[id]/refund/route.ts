import { requireViewer, resolveViewer } from "@/server/access";
import { requireProviderId } from "@/server/auth";
import { providerRefund } from "@/server/disputes";
import { ApiError, json, route } from "@/server/http";
import { getPayment } from "@/server/payments";

export const POST = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const { viewer, actor } = await resolveViewer(req, id);
  requireViewer(viewer, "provider");
  if (!actor) throw new ApiError(401, "unauthenticated", "Sign in to continue.");
  await providerRefund(id.toLowerCase(), await requireProviderId(actor));
  return json({ payment: await getPayment(id, viewer) });
});
