import { requireActor, requireProviderId } from "@/server/auth";
import { json, readJson, route } from "@/server/http";
import { getProvider } from "@/server/providers";
import { enforce, LIMITS } from "@/server/ratelimit";
import { createService, listProviderServices, serviceInput, toView } from "@/server/services";

export const GET = route(async (req: Request) => {
  const id = await requireProviderId(await requireActor(req));
  const provider = (await getProvider(id))!;
  const services = await listProviderServices(id);
  return json({ services: services.map((s) => toView(s, provider, true)) });
});

export const POST = route(async (req: Request) => {
  const id = await requireProviderId(await requireActor(req));
  enforce(`api:${id}`, LIMITS.apiPerActor);
  const input = serviceInput.parse(await readJson(req));
  const provider = (await getProvider(id))!;
  return json({ service: toView(await createService(id, input), provider, true) }, { status: 201 });
});
