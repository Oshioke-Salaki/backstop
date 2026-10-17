import { z } from "zod";
import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";
import { NETWORKS, type NetworkInfo, type NetworkName } from "@backstop/core";

const address = z
  .string()
  .refine((v) => isAddress(v), "must be an address")
  .transform((v) => getAddress(v) as Address);
const privateKey = z
  .string()
  .refine((v) => isHex(v) && v.length === 66, "must be a 32-byte hex private key")
  .transform((v) => v as Hex);
const secret = z.string().min(32, "must be at least 32 characters");
const bool = z
  .enum(["true", "false", "1", "0"])
  .default("false")
  .transform((v) => v === "true" || v === "1");

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PUBLIC_BASE_URL: z.string().url(),
    NETWORK: z.enum(Object.keys(NETWORKS) as [NetworkName, ...NetworkName[]]),
    RPC_URL: z.string().url(),
    ESCROW_ADDRESS: address,
    USDC_ADDRESS: address,
    USDC_NAME: z.string().default("USD Coin"),
    USDC_VERSION: z.string().default("2"),
    /** Sends deposits from the gateway. Give each web instance its own key so nonces never collide. */
    DEPOSITOR_PRIVATE_KEY: privateKey,
    SETTLER_PRIVATE_KEY: privateKey,
    RECEIPT_PRIVATE_KEY: privateKey,
    /** Approves provider payout addresses on-chain. Optional: without it, approvals are done by ops. */
    REGISTRAR_PRIVATE_KEY: privateKey.optional(),
    SESSION_SECRET: secret,
    CAPABILITY_SECRET: secret,
    /** 32 bytes, base64. Encrypts stored responses and provider signing secrets. */
    DATA_KEY: z
      .string()
      .refine((v) => Buffer.from(v, "base64").length === 32, "must be 32 bytes, base64-encoded"),
    ADMIN_ADDRESSES: z
      .string()
      .default("")
      .transform((v) =>
        v
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => getAddress(s)),
      ),
    CRON_SECRET: secret.optional(),
    CONFIRMATIONS: z.coerce.number().int().min(1).max(64).default(1),
    /** Seconds added past the release time before the payer's on-chain reclaim right opens. */
    SETTLEMENT_GRACE_SECONDS: z.coerce.number().int().min(600).max(7 * 86400).default(6 * 3600),
    /** How long a disputed escrow may be held for review. */
    DISPUTE_REVIEW_SECONDS: z.coerce.number().int().min(3600).max(20 * 86400).default(7 * 86400),
    /** Time a provider has to answer a dispute before it auto-refunds. */
    DISPUTE_RESPONSE_SECONDS: z.coerce.number().int().min(600).max(7 * 86400).default(72 * 3600),
    /** Time the payer's authorization must remain valid for a deposit to be attempted. */
    MIN_AUTHORIZATION_SECONDS: z.coerce.number().int().min(10).max(3600).default(45),
    MAX_REQUEST_BYTES: z.coerce.number().int().min(1024).max(10 * 1024 * 1024).default(1024 * 1024),
    MAX_OPEN_DISPUTES_PER_PAYER: z.coerce.number().int().min(1).max(100).default(5),
    RESPONSE_RETENTION_SECONDS: z.coerce.number().int().min(3600).default(30 * 86400),
    ALLOW_PRIVATE_UPSTREAMS: bool,
    WORKER_INLINE: bool,
  })
  .superRefine((c, ctx) => {
    if (c.NODE_ENV === "production" && c.ALLOW_PRIVATE_UPSTREAMS) {
      ctx.addIssue({ code: "custom", path: ["ALLOW_PRIVATE_UPSTREAMS"], message: "must be false in production" });
    }
    if (c.NODE_ENV === "production" && !c.PUBLIC_BASE_URL.startsWith("https://")) {
      ctx.addIssue({ code: "custom", path: ["PUBLIC_BASE_URL"], message: "must be https in production" });
    }
    const keys = [c.DEPOSITOR_PRIVATE_KEY, c.SETTLER_PRIVATE_KEY];
    if (new Set(keys.map((k) => k.toLowerCase())).size !== keys.length) {
      ctx.addIssue({
        code: "custom",
        path: ["SETTLER_PRIVATE_KEY"],
        message: "depositor and settler must be different keys so their nonces never collide",
      });
    }
  });

export type Config = z.infer<typeof schema> & { network: NetworkInfo };

let cached: Config | undefined;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function getConfig(): Config {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ConfigError(`Invalid Backstop configuration. ${detail}`);
  }
  cached = { ...parsed.data, network: NETWORKS[parsed.data.NETWORK] };
  return cached;
}

export function resetConfigForTesting(): void {
  cached = undefined;
}
