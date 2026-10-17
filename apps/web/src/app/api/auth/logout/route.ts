import { assertSameOrigin, clearSessionCookie } from "@/server/auth";
import { json, route } from "@/server/http";

export const POST = route(async (req: Request) => {
  assertSameOrigin(req);
  return json({ ok: true }, { headers: { "set-cookie": clearSessionCookie() } });
});
