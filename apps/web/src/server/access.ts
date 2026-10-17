import { getActor, type Actor } from "./auth";
import { ApiError } from "./http";
import { viewerFor, type Viewer } from "./payments";

export const TOKEN_HEADER = "x-backstop-token";

/** Who is acting on a payment: from a capability token (?t= or header), a session, or a provider API key. */
export async function resolveViewer(req: Request, id: string): Promise<{ viewer: Viewer; actor: Actor | null; label: string }> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(id)) throw new ApiError(404, "not_found", "Payment not found.");
  const token = new URL(req.url).searchParams.get("t") ?? req.headers.get(TOKEN_HEADER);
  const actor = await getActor(req);
  const viewer = await viewerFor(id, {
    token,
    session: actor?.kind === "user" ? actor.session : null,
    providerId: actor?.kind === "apiKey" ? actor.providerId : null,
  });
  if (!viewer) throw new ApiError(404, "not_found", "Payment not found.");
  const label =
    actor?.kind === "user" ? actor.session.address : actor?.kind === "apiKey" ? `provider:${actor.providerId}` : "payer-link";
  return { viewer, actor, label };
}

export function requireViewer(viewer: Viewer, ...allowed: Viewer[]) {
  if (!allowed.includes(viewer)) throw new ApiError(403, "forbidden", "You cannot do that on this payment.");
}
