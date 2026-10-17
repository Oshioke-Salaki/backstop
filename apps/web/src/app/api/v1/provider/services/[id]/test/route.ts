import { requireActor, requireProviderId } from "@/server/auth";
import { json, readJson, route } from "@/server/http";
import { enforce } from "@/server/ratelimit";
import { dryRun, testInput } from "@/server/services";

export const POST = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const providerId = await requireProviderId(await requireActor(req));
  enforce(`test:${providerId}`, { burst: 10, perSecond: 0.2 });
  const { id } = await ctx.params;
  const input = testInput.parse(await readJson(req));
  return json({ result: await dryRun(providerId, id, input) });
});
