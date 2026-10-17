import { clientIp, json, readJson, route } from "@/server/http";
import { handleRpc } from "@/server/mcp";
import { enforce, LIMITS } from "@/server/ratelimit";

export const POST = route(async (req: Request) => {
  enforce(`mcp:${clientIp(req)}`, LIMITS.publicReadPerIp);
  const body = await readJson(req, 64 * 1024);
  if (Array.isArray(body)) {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Batch requests are not supported" } }, { status: 400 });
  }
  const result = await handleRpc(body);
  if (!result) return new Response(null, { status: 202 });
  return json(result);
});

/** Stateless server: no server-initiated stream. */
export function GET() {
  return new Response(null, { status: 405, headers: { allow: "POST" } });
}

export function DELETE() {
  return new Response(null, { status: 405, headers: { allow: "POST" } });
}
