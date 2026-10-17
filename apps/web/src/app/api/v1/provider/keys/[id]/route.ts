import { requireProviderId, requireUser } from "@/server/auth";
import { json, route } from "@/server/http";
import { revokeApiKey } from "@/server/providers";

export const DELETE = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const session = await requireUser(req);
  const providerId = await requireProviderId({ kind: "user", session });
  const { id } = await ctx.params;
  await revokeApiKey(providerId, id);
  return json({ ok: true });
});
