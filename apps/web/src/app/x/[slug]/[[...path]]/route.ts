import { handleGateway } from "@/server/gateway";
import { unstable_rethrow } from "next/navigation";
import { errorResponse } from "@/server/http";

type Ctx = { params: Promise<{ slug: string; path?: string[] }> };

async function handle(req: Request, ctx: Ctx) {
  try {
    const { slug, path = [] } = await ctx.params;
    return await handleGateway(req, slug, path);
  } catch (err) {
    unstable_rethrow(err);
    return errorResponse(err);
  }
}

export const GET = handle;
export const POST = handle;

/** Agents in browsers need CORS to send payment headers and read Backstop's. */
export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, accept, x-payment, payment-signature",
      "access-control-max-age": "600",
    },
  });
}

/** Deposit confirmation (up to 60s) plus the slowest allowed provider (60s), with headroom. */
export const maxDuration = 150;
