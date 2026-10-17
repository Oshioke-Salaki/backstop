import { randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { getAddress, isAddress, isAddressEqual, zeroAddress, type Address } from "viem";
import { randomSecret } from "@backstop/core";
import { getConfig } from "./config";
import { encrypt, hashApiKey } from "./crypto";
import { getDb } from "./db/client";
import { apiKeys, providers, users, type Provider } from "./db/schema";
import { enqueue } from "./escrow-store";
import { ApiError } from "./http";
import type { Session } from "./auth";

const payoutAddress = z
  .string()
  .trim()
  .refine((v) => isAddress(v), "Enter a valid wallet address.")
  .transform((v) => getAddress(v));

export const providerInput = z
  .object({
    name: z.string().trim().min(2, "Name is too short.").max(80, "Name is too long."),
    website: z
      .string()
      .trim()
      .max(200)
      .url("Enter a full URL, like https://example.com.")
      .refine((v) => v.startsWith("https://"), "Website must use https.")
      .optional()
      .or(z.literal("").transform(() => undefined)),
    payoutAddress: payoutAddress.optional(),
  })
  .strict();

function assertPayoutAllowed(address: Address) {
  const config = getConfig();
  for (const forbidden of [zeroAddress, config.ESCROW_ADDRESS, config.USDC_ADDRESS]) {
    if (isAddressEqual(address, forbidden)) throw new ApiError(400, "invalid_payout", "That address cannot receive payouts.");
  }
}

export interface PublicProvider {
  id: string;
  name: string;
  website: string | null;
  ownerAddress: string;
  payoutAddress: string;
  payoutApproved: boolean;
  createdAt: Date;
}

export function toPublic(p: Provider): PublicProvider {
  return {
    id: p.id,
    name: p.name,
    website: p.website,
    ownerAddress: p.ownerAddress,
    payoutAddress: p.payoutAddress,
    payoutApproved: p.payoutApproved,
    createdAt: p.createdAt,
  };
}

export async function getProviderForOwner(owner: Address): Promise<Provider | null> {
  const db = await getDb();
  const [row] = await db.select().from(providers).where(eq(providers.ownerAddress, owner)).limit(1);
  return row ?? null;
}

export async function getProvider(id: string): Promise<Provider | null> {
  const db = await getDb();
  const [row] = await db.select().from(providers).where(eq(providers.id, id)).limit(1);
  return row ?? null;
}

/** Create the caller's provider profile. Returns the request-signing secret, which is shown only once. */
export async function createProvider(session: Session, input: z.infer<typeof providerInput>) {
  const db = await getDb();
  if (await getProviderForOwner(session.address)) {
    throw new ApiError(409, "provider_exists", "You already have a provider profile.");
  }
  const payout = input.payoutAddress ?? session.address;
  assertPayoutAllowed(payout);
  const id = randomUUID();
  const secret = randomSecret();
  await db.insert(users).values({ address: session.address }).onConflictDoNothing({ target: users.address });
  const [row] = await db
    .insert(providers)
    .values({
      id,
      ownerAddress: session.address,
      name: input.name,
      website: input.website ?? null,
      payoutAddress: payout,
      signingSecret: encrypt(secret, id),
    })
    .returning();
  await enqueue(db, "approve_payee", payout, { payload: { address: payout } });
  return { provider: row!, signingSecret: secret };
}

export async function updateProvider(providerId: string, input: z.infer<typeof providerInput>) {
  const db = await getDb();
  const current = await getProvider(providerId);
  if (!current) throw new ApiError(404, "no_provider", "Provider not found.");
  const patch: Partial<typeof providers.$inferInsert> = { name: input.name, website: input.website ?? null, updatedAt: new Date() };
  if (input.payoutAddress && !isAddressEqual(input.payoutAddress, current.payoutAddress as Address)) {
    assertPayoutAllowed(input.payoutAddress);
    // Payments already in escrow stay bound to the old address on-chain; new ones wait for approval.
    patch.payoutAddress = input.payoutAddress;
    patch.payoutApproved = false;
  }
  const [row] = await db.update(providers).set(patch).where(eq(providers.id, providerId)).returning();
  if (patch.payoutAddress) await enqueue(db, "approve_payee", patch.payoutAddress, { payload: { address: patch.payoutAddress } });
  return row!;
}

export async function rotateSigningSecret(providerId: string): Promise<string> {
  const db = await getDb();
  const secret = randomSecret();
  await db
    .update(providers)
    .set({ signingSecret: encrypt(secret, providerId), updatedAt: new Date() })
    .where(eq(providers.id, providerId));
  return secret;
}

// --- API keys ---------------------------------------------------------------

export const apiKeyInput = z.object({ label: z.string().trim().min(1, "Give the key a name.").max(60) }).strict();
const MAX_ACTIVE_KEYS = 10;

export async function createApiKey(providerId: string, label: string) {
  const db = await getDb();
  const active = await db.select({ id: apiKeys.id }).from(apiKeys).where(and(eq(apiKeys.providerId, providerId), isNull(apiKeys.revokedAt)));
  if (active.length >= MAX_ACTIVE_KEYS) {
    throw new ApiError(409, "too_many_keys", `You can have up to ${MAX_ACTIVE_KEYS} active keys. Revoke one first.`);
  }
  const key = `bsk_${randomBytes(24).toString("base64url")}`;
  const [row] = await db
    .insert(apiKeys)
    .values({ providerId, label, prefix: key.slice(0, 10), hash: hashApiKey(key) })
    .returning({ id: apiKeys.id, label: apiKeys.label, prefix: apiKeys.prefix, createdAt: apiKeys.createdAt });
  return { ...row!, key };
}

export async function listApiKeys(providerId: string) {
  const db = await getDb();
  return db
    .select({
      id: apiKeys.id,
      label: apiKeys.label,
      prefix: apiKeys.prefix,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
      revokedAt: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.providerId, providerId))
    .orderBy(desc(apiKeys.createdAt));
}

export async function revokeApiKey(providerId: string, keyId: string) {
  const db = await getDb();
  const [row] = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.providerId, providerId), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id });
  if (!row) throw new ApiError(404, "not_found", "Key not found or already revoked.");
}
