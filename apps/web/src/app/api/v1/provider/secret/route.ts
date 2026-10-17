import { requireProviderId, requireUser } from "@/server/auth";
import { json, route } from "@/server/http";
import { rotateSigningSecret } from "@/server/providers";
import { enforce, LIMITS } from "@/server/ratelimit";

/** Rotating takes effect immediately. Wallet sessions only, so a leaked API key cannot lock the owner out. */
export const POST = route(async (req: Request) => {
  const session = await requireUser(req);
  const id = await requireProviderId({ kind: "user", session });
  enforce(`api:${id}`, LIMITS.apiPerActor);
  return json({ signingSecret: await rotateSigningSecret(id) });
});
