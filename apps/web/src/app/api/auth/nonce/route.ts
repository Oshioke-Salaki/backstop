import { issueNonce } from "@/server/auth";
import { clientIp, json, route } from "@/server/http";
import { enforce, LIMITS } from "@/server/ratelimit";

export const GET = route(async (req: Request) => {
  enforce(`auth:${clientIp(req)}`, LIMITS.authPerIp);
  const { nonce, cookie } = issueNonce();
  return json({ nonce }, { headers: { "set-cookie": cookie } });
});
