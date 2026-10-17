import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Request signing between Backstop and providers, plus capability tokens for payment links.
 * All comparisons are constant-time.
 */

export const SIGNATURE_HEADER = "x-backstop-signature";
export const ESCROW_HEADER = "x-backstop-escrow-id";
export const PAYER_HEADER = "x-backstop-payer";
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export function sha256Hex(data: Uint8Array | string): `0x${string}` {
  return `0x${createHash("sha256").update(data).digest("hex")}`;
}

export function randomSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Canonical request identity: method, path, sorted query, content type, body digest. */
export function requestHash(input: {
  method: string;
  path: string;
  query: URLSearchParams;
  contentType: string | null;
  body: Uint8Array;
}): `0x${string}` {
  const query = [...input.query.entries()]
    .sort(([ak, av], [bk, bv]) => (ak === bk ? (av < bv ? -1 : av > bv ? 1 : 0) : ak < bk ? -1 : 1))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  const canonical = [
    input.method.toUpperCase(),
    input.path,
    query,
    (input.contentType ?? "").split(";")[0]!.trim().toLowerCase(),
    sha256Hex(input.body),
  ].join("\n");
  return sha256Hex(canonical);
}

function signaturePayload(timestamp: number, escrowId: string, method: string, path: string, bodyDigest: string) {
  return `${timestamp}.${escrowId}.${method.toUpperCase()}.${path}.${bodyDigest}`;
}

/** Header value providers verify to know a request really came from Backstop and is paid for. */
export function signProviderRequest(
  secret: string,
  input: { escrowId: string; method: string; path: string; body: Uint8Array; timestamp: number },
): string {
  const mac = createHmac("sha256", secret)
    .update(signaturePayload(input.timestamp, input.escrowId, input.method, input.path, sha256Hex(input.body)))
    .digest("hex");
  return `t=${input.timestamp},v1=${mac}`;
}

export function verifyProviderRequest(
  secret: string,
  header: string | null,
  input: { escrowId: string; method: string; path: string; body: Uint8Array; nowSeconds: number },
): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(",").map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  );
  const timestamp = Number(parts.t);
  if (!Number.isInteger(timestamp) || !parts.v1) return false;
  if (Math.abs(input.nowSeconds - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const expected = createHmac("sha256", secret)
    .update(signaturePayload(timestamp, input.escrowId, input.method, input.path, sha256Hex(input.body)))
    .digest("hex");
  return safeEqual(expected, parts.v1);
}

/** Unguessable token that grants read and dispute access to one payment, for links agents hand to users. */
export function capabilityToken(secret: string, escrowId: string): string {
  return createHmac("sha256", secret).update(`payment:${escrowId.toLowerCase()}`).digest("base64url");
}

export function verifyCapabilityToken(secret: string, escrowId: string, token: string | null | undefined): boolean {
  if (!token) return false;
  return safeEqual(capabilityToken(secret, escrowId), token);
}
