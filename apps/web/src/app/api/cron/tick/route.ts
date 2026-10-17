import { timingSafeEqual } from "node:crypto";
import { getConfig } from "@/server/config";
import { ApiError, json, route } from "@/server/http";
import { tick } from "@/server/worker";

/** For hosts without a long-running worker: call this from a scheduler every minute. */
export const POST = route(async (req: Request) => {
  const secret = getConfig().CRON_SECRET;
  const given = Buffer.from(req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "");
  if (!secret || given.length !== Buffer.byteLength(secret) || !timingSafeEqual(given, Buffer.from(secret))) {
    throw new ApiError(401, "unauthenticated", "Invalid cron secret.");
  }
  return json({ report: await tick() });
});

export const GET = POST;
