import { requireProviderId, requireUser } from "@/server/auth";
import { json, readJson, route } from "@/server/http";
import { apiKeyInput, createApiKey, listApiKeys } from "@/server/providers";
import { enforce, LIMITS } from "@/server/ratelimit";

export const GET = route(async (req: Request) => {
  const session = await requireUser(req);
  const id = await requireProviderId({ kind: "user", session });
  return json({ keys: await listApiKeys(id) });
});

export const POST = route(async (req: Request) => {
  const session = await requireUser(req);
  const id = await requireProviderId({ kind: "user", session });
  enforce(`api:${id}`, LIMITS.apiPerActor);
  const { label } = apiKeyInput.parse(await readJson(req));
  return json({ key: await createApiKey(id, label) }, { status: 201 });
});
