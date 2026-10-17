import { requireActor, requireProviderId, requireUser } from "@/server/auth";
import { json, readJson, route } from "@/server/http";
import { createProvider, getProvider, providerInput, toPublic, updateProvider } from "@/server/providers";
import { enforce, LIMITS } from "@/server/ratelimit";
import { scorecard } from "@/server/payments";

export const GET = route(async (req: Request) => {
  const actor = await requireActor(req);
  const id = await requireProviderId(actor);
  const provider = await getProvider(id);
  return json({ provider: toPublic(provider!), scorecard: await scorecard({ providerId: id }) });
});

/** Create the signed-in wallet's provider profile. The signing secret is returned once and never again. */
export const POST = route(async (req: Request) => {
  const session = await requireUser(req);
  enforce(`api:${session.address}`, LIMITS.apiPerActor);
  const input = providerInput.parse(await readJson(req));
  const { provider, signingSecret } = await createProvider(session, input);
  return json({ provider: toPublic(provider), signingSecret }, { status: 201 });
});

export const PATCH = route(async (req: Request) => {
  const actor = await requireActor(req);
  const id = await requireProviderId(actor);
  enforce(`api:${id}`, LIMITS.apiPerActor);
  const input = providerInput.parse(await readJson(req));
  return json({ provider: toPublic(await updateProvider(id, input)) });
});
