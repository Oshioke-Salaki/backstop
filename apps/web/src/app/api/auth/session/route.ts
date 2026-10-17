import { readCookie, SESSION_COOKIE, sessionFromToken } from "@/server/auth";
import { json, route } from "@/server/http";
import { getProviderForOwner, toPublic } from "@/server/providers";

export const GET = route(async (req: Request) => {
  const session = sessionFromToken(readCookie(req, SESSION_COOKIE));
  if (!session) return json({ session: null });
  const provider = await getProviderForOwner(session.address);
  return json({ session, provider: provider ? toPublic(provider) : null });
});
