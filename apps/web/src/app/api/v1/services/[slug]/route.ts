import { ApiError, clientIp, json, route } from "@/server/http";
import { scorecard } from "@/server/payments";
import { enforce, LIMITS } from "@/server/ratelimit";
import { getPublicService } from "@/server/services";

export const GET = route(async (req: Request, ctx: { params: Promise<{ slug: string }> }) => {
  enforce(`read:${clientIp(req)}`, LIMITS.publicReadPerIp);
  const { slug } = await ctx.params;
  const service = await getPublicService(slug);
  if (!service) throw new ApiError(404, "not_found", "Service not found.");
  return json({ service, scorecard: await scorecard({ serviceId: service.id }) });
});
