import { requireActor, requireProviderId } from "@/server/auth";
import { json, readJson, route } from "@/server/http";
import { scorecard } from "@/server/payments";
import { getProvider } from "@/server/providers";
import { enforce, LIMITS } from "@/server/ratelimit";
import { deleteService, getOwnedService, serviceInput, toView, updateService } from "@/server/services";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (req: Request, ctx: Ctx) => {
  const providerId = await requireProviderId(await requireActor(req));
  const { id } = await ctx.params;
  const service = await getOwnedService(providerId, id);
  return json({ service: toView(service, (await getProvider(providerId))!, true), scorecard: await scorecard({ serviceId: id }) });
});

export const PUT = route(async (req: Request, ctx: Ctx) => {
  const providerId = await requireProviderId(await requireActor(req));
  enforce(`api:${providerId}`, LIMITS.apiPerActor);
  const { id } = await ctx.params;
  const input = serviceInput.parse(await readJson(req));
  return json({ service: toView(await updateService(providerId, id, input), (await getProvider(providerId))!, true) });
});

export const DELETE = route(async (req: Request, ctx: Ctx) => {
  const providerId = await requireProviderId(await requireActor(req));
  const { id } = await ctx.params;
  await deleteService(providerId, id);
  return json({ ok: true });
});
