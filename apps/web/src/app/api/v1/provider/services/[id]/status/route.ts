import { z } from "zod";
import { requireActor, requireProviderId } from "@/server/auth";
import { json, readJson, route } from "@/server/http";
import { getProvider } from "@/server/providers";
import { setServiceStatus, toView } from "@/server/services";

const body = z.object({ status: z.enum(["active", "paused"]) }).strict();

export const POST = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const providerId = await requireProviderId(await requireActor(req));
  const { id } = await ctx.params;
  const { status } = body.parse(await readJson(req));
  return json({ service: toView(await setServiceStatus(providerId, id, status), (await getProvider(providerId))!, true) });
});
