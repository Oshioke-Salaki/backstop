import { clientIp, json, route } from "@/server/http";
import { enforce, LIMITS } from "@/server/ratelimit";
import { listPublicServices } from "@/server/services";

export const GET = route(async (req: Request) => {
  enforce(`read:${clientIp(req)}`, LIMITS.publicReadPerIp);
  const q = new URL(req.url).searchParams.get("q")?.slice(0, 100) ?? undefined;
  return json({ services: await listPublicServices({ query: q }) });
});
