import { unstable_rethrow } from "next/navigation";
import { ZodError } from "zod";
import { ConfigError } from "./config";
import { settleSoon } from "./worker";

/** An error meant for the caller: stable code, safe message, HTTP status. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const BASE_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

export function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json; charset=utf-8", ...BASE_HEADERS, ...init.headers },
  });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) {
    return json(
      { error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) } },
      { status: err.status, headers: err.headers },
    );
  }
  if (err instanceof ZodError) {
    return json(
      {
        error: {
          code: "invalid_request",
          message: "Some fields are invalid.",
          details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
      },
      { status: 400 },
    );
  }
  if (err instanceof ConfigError) {
    console.error(err.message);
    return json({ error: { code: "misconfigured", message: "Backstop is not configured correctly." } }, { status: 503 });
  }
  console.error("unhandled error", err);
  return json({ error: { code: "internal", message: "Something went wrong on our side." } }, { status: 500 });
}

/**
 * Wrap a route handler so every failure becomes a consistent JSON error. Touching the request up front
 * keeps every API route request-time (never prerendered at build), and Next's own control-flow
 * signals are rethrown rather than reported as errors.
 */
export function route<Args extends unknown[]>(fn: (...args: Args) => Promise<Response>) {
  return async (...args: Args): Promise<Response> => {
    try {
      const req = args[0];
      if (req instanceof Request) void req.headers.get("accept");
      const res = await fn(...args);
      // API traffic doubles as a settlement heartbeat on hosts without a worker process.
      settleSoon();
      return res;
    } catch (err) {
      unstable_rethrow(err);
      return errorResponse(err);
    }
  };
}

/** Read a JSON body with a hard size cap, without trusting Content-Length. */
export async function readJson(req: Request, maxBytes = 64 * 1024): Promise<unknown> {
  const body = await readBody(req, maxBytes);
  if (body.byteLength === 0) throw new ApiError(400, "invalid_request", "Request body is required.");
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new ApiError(400, "invalid_json", "Request body is not valid JSON.");
  }
}

export async function readBody(req: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new ApiError(413, "payload_too_large", `Request body exceeds ${maxBytes} bytes.`);
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new ApiError(413, "payload_too_large", `Request body exceeds ${maxBytes} bytes.`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}
