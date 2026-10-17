import { requireViewer, resolveViewer } from "@/server/access";
import { resolve, resolveInput } from "@/server/disputes";
import { json, readJson, route } from "@/server/http";
import { getPayment } from "@/server/payments";

export const POST = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const { viewer, label } = await resolveViewer(req, id);
  requireViewer(viewer, "admin");
  const input = resolveInput.parse(await readJson(req));
  await resolve(id.toLowerCase(), label, input);
  return json({ payment: await getPayment(id, viewer) });
});
