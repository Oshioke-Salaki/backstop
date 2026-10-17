import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { getAddress, isAddressEqual, type Address, type Hex } from "viem";
import { parseSiweMessage } from "viem/siwe";
import { getChainContext } from "./chain";
import { getConfig } from "./config";
import { hashApiKey } from "./crypto";
import { getDb } from "./db/client";
import { apiKeys, providers, users } from "./db/schema";
import { ApiError } from "./http";

export const SESSION_COOKIE = "bs_session";
export const NONCE_COOKIE = "bs_nonce";
const SESSION_TTL_SECONDS = 7 * 86400;
const NONCE_TTL_SECONDS = 10 * 60;

function sign(value: string): string {
  return createHmac("sha256", getConfig().SESSION_SECRET).update(value).digest("base64url");
}

function seal(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body)}`;
}

function unseal<T>(token: string | undefined | null): T | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(body));
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

function cookieAttrs(maxAge: number): string {
  const secure = getConfig().PUBLIC_BASE_URL.startsWith("https://") ? "; Secure" : "";
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

// --- SIWE ------------------------------------------------------------------

export function issueNonce(): { nonce: string; cookie: string } {
  const nonce = randomBytes(16).toString("hex");
  const token = seal({ n: nonce, exp: Math.floor(Date.now() / 1000) + NONCE_TTL_SECONDS });
  return { nonce, cookie: `${NONCE_COOKIE}=${token}; ${cookieAttrs(NONCE_TTL_SECONDS)}` };
}

export const clearNonceCookie = () => `${NONCE_COOKIE}=; ${cookieAttrs(0)}`;
export const clearSessionCookie = () => `${SESSION_COOKIE}=; ${cookieAttrs(0)}`;

/** Verify a signed SIWE message against the nonce we issued and start a session. */
export async function verifySiwe(req: Request, message: string, signature: Hex): Promise<{ address: Address; cookie: string }> {
  const issued = unseal<{ n: string; exp: number }>(readCookie(req, NONCE_COOKIE));
  if (!issued || issued.exp < Date.now() / 1000) {
    throw new ApiError(401, "nonce_expired", "Sign-in expired. Start again.");
  }
  if (message.length > 4096) throw new ApiError(400, "invalid_request", "Message is too long.");

  const config = getConfig();
  const expectedHost = new URL(config.PUBLIC_BASE_URL).host;
  const parsed = parseSiweMessage(message);
  if (!parsed.address || parsed.nonce !== issued.n) {
    throw new ApiError(401, "invalid_signature", "Sign-in message does not match this session.");
  }
  if (parsed.domain !== expectedHost) throw new ApiError(401, "invalid_signature", "Sign-in message is for another site.");
  if (parsed.chainId !== config.network.chainId) {
    throw new ApiError(401, "wrong_network", `Sign in on ${config.network.name}.`);
  }

  const { publicClient } = getChainContext();
  const valid = await publicClient
    .verifySiweMessage({ message, signature, nonce: issued.n, domain: expectedHost })
    .catch(() => false);
  if (!valid) throw new ApiError(401, "invalid_signature", "Signature could not be verified.");

  const address = getAddress(parsed.address);
  const db = await getDb();
  await db
    .insert(users)
    .values({ address, lastLoginAt: new Date() })
    .onConflictDoUpdate({ target: users.address, set: { lastLoginAt: new Date() } });

  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  return { address, cookie: `${SESSION_COOKIE}=${seal({ a: address, exp })}; ${cookieAttrs(SESSION_TTL_SECONDS)}` };
}

export interface Session {
  address: Address;
  isAdmin: boolean;
}

export function sessionFromToken(token: string | undefined | null): Session | null {
  const s = unseal<{ a: string; exp: number }>(token);
  if (!s || s.exp < Date.now() / 1000) return null;
  try {
    const address = getAddress(s.a);
    return { address, isAdmin: getConfig().ADMIN_ADDRESSES.some((a) => isAddressEqual(a, address)) };
  } catch {
    return null;
  }
}

// --- Request actors ----------------------------------------------------------

export type Actor =
  | { kind: "user"; session: Session }
  | { kind: "apiKey"; providerId: string; keyId: string };

/**
 * Cookie-authenticated writes must come from our own origin. Browsers always send Origin on
 * cross-site POSTs, and SameSite=Lax keeps the cookie off most of them anyway.
 */
export function assertSameOrigin(req: Request): void {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return;
  const origin = req.headers.get("origin");
  const expected = new URL(getConfig().PUBLIC_BASE_URL).origin;
  if (origin) {
    if (origin !== expected) throw new ApiError(403, "bad_origin", "Cross-site request refused.");
    return;
  }
  if (req.headers.get("sec-fetch-site") === "same-origin") return;
  throw new ApiError(403, "bad_origin", "Cross-site request refused.");
}

export async function getActor(req: Request): Promise<Actor | null> {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer bsk_")) {
    const key = auth.slice("Bearer ".length).trim();
    const db = await getDb();
    const [row] = await db
      .select({ id: apiKeys.id, providerId: apiKeys.providerId })
      .from(apiKeys)
      .where(and(eq(apiKeys.hash, hashApiKey(key)), isNull(apiKeys.revokedAt)))
      .limit(1);
    if (!row) throw new ApiError(401, "invalid_api_key", "API key is invalid or revoked.");
    await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.id));
    return { kind: "apiKey", providerId: row.providerId, keyId: row.id };
  }
  const session = sessionFromToken(readCookie(req, SESSION_COOKIE));
  if (!session) return null;
  assertSameOrigin(req);
  return { kind: "user", session };
}

export async function requireActor(req: Request): Promise<Actor> {
  const actor = await getActor(req);
  if (!actor) throw new ApiError(401, "unauthenticated", "Sign in to continue.");
  return actor;
}

export async function requireUser(req: Request): Promise<Session> {
  const actor = await requireActor(req);
  if (actor.kind !== "user") throw new ApiError(403, "forbidden", "This action needs a signed-in wallet.");
  return actor.session;
}

export async function requireAdmin(req: Request): Promise<Session> {
  const session = await requireUser(req);
  if (!session.isAdmin) throw new ApiError(403, "forbidden", "Only Backstop arbiters can do this.");
  return session;
}

/** The provider an actor controls, or null when they have not registered one. */
export async function providerIdFor(actor: Actor): Promise<string | null> {
  if (actor.kind === "apiKey") return actor.providerId;
  const db = await getDb();
  const [row] = await db
    .select({ id: providers.id })
    .from(providers)
    .where(eq(providers.ownerAddress, actor.session.address))
    .limit(1);
  return row?.id ?? null;
}

export async function requireProviderId(actor: Actor): Promise<string> {
  const id = await providerIdFor(actor);
  if (!id) throw new ApiError(404, "no_provider", "Set up your provider profile first.");
  return id;
}
