import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { getConfig } from "./config";

/** AES-256-GCM with a random 96-bit IV. Format: v1.<iv>.<tag>.<ciphertext>, base64url parts. */
export function encrypt(plain: Uint8Array | string, aad = ""): string {
  const key = Buffer.from(getConfig().DATA_KEY, "base64");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

export function decrypt(token: string, aad = ""): Buffer {
  const [version, iv, tag, ct] = token.split(".");
  if (version !== "v1" || !iv || !tag || ct === undefined) throw new Error("unsupported ciphertext");
  const key = Buffer.from(getConfig().DATA_KEY, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]);
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}
