import { z } from "zod";
import { assertSameOrigin, clearNonceCookie, verifySiwe } from "@/server/auth";
import { clientIp, json, readJson, route } from "@/server/http";
import { enforce, LIMITS } from "@/server/ratelimit";

const body = z.object({
  message: z.string().min(1).max(4096),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/).max(20_000),
});

export const POST = route(async (req: Request) => {
  assertSameOrigin(req);
  enforce(`auth:${clientIp(req)}`, LIMITS.authPerIp);
  const input = body.parse(await readJson(req, 32 * 1024));
  const { address, cookie } = await verifySiwe(req, input.message, input.signature as `0x${string}`);
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  headers.append("set-cookie", cookie);
  headers.append("set-cookie", clearNonceCookie());
  return new Response(JSON.stringify({ address }), { headers });
});

export const GET = () => json({ error: { code: "method_not_allowed", message: "Use POST." } }, { status: 405 });
