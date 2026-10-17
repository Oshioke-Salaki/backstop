import dns from "node:dns";
import type { LookupAddress, LookupOptions } from "node:dns";
import ipaddr from "ipaddr.js";
import { Agent, request } from "undici";
import type { Observation } from "./sla";

/**
 * Outbound calls to provider upstreams. Provider URLs are untrusted input, so every connection is
 * checked against public address space at connect time (which also defeats DNS rebinding), redirects
 * are never followed, and bodies are capped while streaming.
 */

export interface NetPolicy {
  /** Allow http:// and private/loopback destinations. Local development and tests only. */
  allowPrivateNetworks: boolean;
}

export class BlockedDestinationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedDestinationError";
  }
}

/** True only for globally routable unicast addresses. Unwraps IPv4 embedded in IPv6 forms first. */
export function isPublicAddress(ip: string): boolean {
  if (!ipaddr.isValid(ip)) return false;
  let addr = ipaddr.parse(ip);
  if (addr.kind() === "ipv6") {
    const v6 = addr as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) {
      addr = v6.toIPv4Address();
    } else {
      const range = v6.range();
      // NAT64 / 6to4 / Teredo can tunnel to private IPv4 space; refuse them outright.
      if (range !== "unicast") return false;
    }
  }
  return addr.range() === "unicast";
}

const ALLOWED_PORTS_PROD = new Set(["", "443", "8443"]);

/** Validate a provider upstream URL at registration time and before every call. */
export function assertSafeUrl(raw: string, policy: NetPolicy): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedDestinationError("upstream URL is not a valid URL");
  }
  if (url.username || url.password) throw new BlockedDestinationError("upstream URL must not contain credentials");
  if (url.hash) throw new BlockedDestinationError("upstream URL must not contain a fragment");
  if (policy.allowPrivateNetworks) {
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new BlockedDestinationError("upstream URL must use http or https");
    }
    return url;
  }
  if (url.protocol !== "https:") throw new BlockedDestinationError("upstream URL must use https");
  if (!ALLOWED_PORTS_PROD.has(url.port)) throw new BlockedDestinationError("upstream port must be 443 or 8443");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (ipaddr.isValid(host)) {
    if (!isPublicAddress(host)) throw new BlockedDestinationError("upstream address is not public");
  } else if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || !host.includes(".")) {
    throw new BlockedDestinationError("upstream host is not public");
  }
  return url;
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/** dns.lookup replacement that refuses to hand non-public addresses to the socket. */
export function guardedLookup(hostname: string, options: LookupOptions, callback: LookupCallback): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, []);
    const list = addresses as LookupAddress[];
    if (list.length === 0) return callback(Object.assign(new Error("no addresses"), { code: "ENOTFOUND" }), []);
    const bad = list.find((a) => !isPublicAddress(a.address));
    if (bad) {
      return callback(
        Object.assign(new BlockedDestinationError(`resolved to non-public address`), { code: "EBLOCKED" }),
        [],
      );
    }
    if (options.all) return callback(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
}

const agents = new Map<boolean, Agent>();

function agentFor(policy: NetPolicy): Agent {
  let agent = agents.get(policy.allowPrivateNetworks);
  if (!agent) {
    agent = new Agent({
      connect: policy.allowPrivateNetworks ? {} : { lookup: guardedLookup as never },
      keepAliveTimeout: 10_000,
      connections: 64,
    });
    agents.set(policy.allowPrivateNetworks, agent);
  }
  return agent;
}

export interface UpstreamRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Uint8Array;
  timeoutMs: number;
  maxResponseBytes: number;
}

export interface UpstreamResult {
  observation: Observation;
  /** Response headers safe to hand back to the agent. */
  headers: Record<string, string>;
}

const TIMEOUT_CODES = new Set(["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT", "ETIMEDOUT"]);

function isTimeout(err: unknown): boolean {
  const e = err as { code?: string; name?: string; cause?: { code?: string } };
  return TIMEOUT_CODES.has(e?.code ?? "") || TIMEOUT_CODES.has(e?.cause?.code ?? "") || e?.name === "TimeoutError";
}

const PASSTHROUGH_RESPONSE_HEADERS = ["content-type", "cache-control", "etag", "last-modified", "content-language"];

/** Call the provider and describe what happened, never throwing for upstream misbehaviour. */
export async function callUpstream(req: UpstreamRequest, policy: NetPolicy): Promise<UpstreamResult> {
  try {
    assertSafeUrl(req.url, policy);
  } catch (err) {
    return { observation: { kind: "blocked", detail: (err as Error).message }, headers: {} };
  }

  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const signal = AbortSignal.timeout(req.timeoutMs);

  try {
    const res = await request(req.url, {
      method: req.method as never,
      headers: req.headers,
      body: req.body && req.body.byteLength > 0 ? Buffer.from(req.body) : undefined,
      dispatcher: agentFor(policy),
      signal,
      headersTimeout: req.timeoutMs,
      bodyTimeout: req.timeoutMs,
    });

    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of res.body) {
        size += (chunk as Buffer).byteLength;
        if (size > req.maxResponseBytes) {
          res.body.destroy();
          return {
            observation: { kind: "too_large", latencyMs: elapsed(), limit: req.maxResponseBytes },
            headers: {},
          };
        }
        chunks.push(chunk as Buffer);
      }
    } catch (err) {
      if (signal.aborted || isTimeout(err)) return { observation: { kind: "timeout", latencyMs: elapsed() }, headers: {} };
      throw err;
    }

    const headers: Record<string, string> = {};
    for (const name of PASSTHROUGH_RESPONSE_HEADERS) {
      const value = res.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    const contentType = typeof res.headers["content-type"] === "string" ? res.headers["content-type"] : null;
    return {
      observation: {
        kind: "response",
        status: res.statusCode,
        contentType,
        body: new Uint8Array(Buffer.concat(chunks)),
        latencyMs: elapsed(),
      },
      headers,
    };
  } catch (err) {
    if (signal.aborted || isTimeout(err)) return { observation: { kind: "timeout", latencyMs: elapsed() }, headers: {} };
    const e = err as NodeJS.ErrnoException;
    if (e instanceof BlockedDestinationError || e.code === "EBLOCKED" || (e.cause as { code?: string })?.code === "EBLOCKED") {
      return { observation: { kind: "blocked", detail: "upstream resolved to a non-public address" }, headers: {} };
    }
    return {
      observation: { kind: "network_error", latencyMs: elapsed(), detail: e.code ?? e.name ?? "connection failed" },
      headers: {},
    };
  }
}
