import { createHash } from "node:crypto";
import { Ajv, type ValidateFunction } from "ajv";
import { z } from "zod";

/**
 * A service-level agreement is the provider's machine-checkable promise.
 * Backstop releases payment only when a response keeps it.
 */

export const MAX_SCHEMA_BYTES = 32 * 1024;
export const MAX_SCHEMA_DEPTH = 24;
export const MAX_RESPONSE_BYTES_LIMIT = 5 * 1024 * 1024;
export const MAX_LATENCY_LIMIT_MS = 60_000;

/** Keywords that run provider-controlled regexes (ReDoS) or reach outside the schema. */
const FORBIDDEN_KEYWORDS = new Set(["pattern", "patternProperties", "$dynamicRef", "$recursiveRef", "$id"]);

const assertionSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("exists"), path: z.string().max(256) }).strict(),
  z.object({ op: z.literal("nonEmpty"), path: z.string().max(256) }).strict(),
  z
    .object({
      op: z.literal("equals"),
      path: z.string().max(256),
      value: z.union([z.string().max(1024), z.number(), z.boolean(), z.null()]),
    })
    .strict(),
  z.object({ op: z.literal("minItems"), path: z.string().max(256), value: z.number().int().min(0) }).strict(),
  z.object({ op: z.literal("maxItems"), path: z.string().max(256), value: z.number().int().min(0) }).strict(),
  z.object({ op: z.literal("minLength"), path: z.string().max(256), value: z.number().int().min(0) }).strict(),
  z.object({ op: z.literal("gte"), path: z.string().max(256), value: z.number() }).strict(),
  z.object({ op: z.literal("lte"), path: z.string().max(256), value: z.number() }).strict(),
  z
    .object({
      op: z.literal("oneOf"),
      path: z.string().max(256),
      value: z.array(z.union([z.string().max(256), z.number(), z.boolean()])).min(1).max(50),
    })
    .strict(),
]);

export type Assertion = z.infer<typeof assertionSchema>;

const jsonSchemaObject = z
  .record(z.unknown())
  .superRefine((schema, ctx) => {
    const problem = inspectJsonSchema(schema);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
  });

export const slaSchema = z
  .object({
    maxLatencyMs: z.number().int().min(100).max(MAX_LATENCY_LIMIT_MS),
    maxResponseBytes: z.number().int().min(1).max(MAX_RESPONSE_BYTES_LIMIT),
    expectStatus: z.array(z.number().int().min(200).max(299)).min(1).max(10).default([200]),
    contentType: z
      .string()
      .regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i, "must be a media type like application/json")
      .default("application/json"),
    outputSchema: jsonSchemaObject.optional(),
    assertions: z.array(assertionSchema).max(20).default([]),
  })
  .strict()
  .superRefine((sla, ctx) => {
    const json = isJsonMediaType(sla.contentType);
    if (!json && (sla.outputSchema || sla.assertions.length > 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "outputSchema and assertions require a JSON content type",
        path: ["contentType"],
      });
    }
    sla.assertions.forEach((a, i) => {
      if (!isValidPointer(a.path)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "path must be a JSON pointer", path: ["assertions", i] });
      }
    });
  });

export type Sla = z.infer<typeof slaSchema>;
export const inputSchemaSchema = jsonSchemaObject;

/** Returns a description of why a provider-supplied JSON Schema is unsafe, or null when it is acceptable. */
export function inspectJsonSchema(schema: unknown): string | null {
  let serialized: string;
  try {
    serialized = JSON.stringify(schema);
  } catch {
    return "schema must be serializable JSON";
  }
  if (Buffer.byteLength(serialized) > MAX_SCHEMA_BYTES) return `schema exceeds ${MAX_SCHEMA_BYTES} bytes`;

  const stack: Array<{ node: unknown; depth: number }> = [{ node: schema, depth: 0 }];
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (depth > MAX_SCHEMA_DEPTH) return `schema nests deeper than ${MAX_SCHEMA_DEPTH}`;
    if (Array.isArray(node)) {
      for (const child of node) stack.push({ node: child, depth: depth + 1 });
    } else if (node && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) {
        if (FORBIDDEN_KEYWORDS.has(key)) return `schema keyword "${key}" is not allowed`;
        if (key === "$ref" && (typeof child !== "string" || !child.startsWith("#"))) {
          return "only local $ref (starting with #) is allowed";
        }
        stack.push({ node: child, depth: depth + 1 });
      }
    }
  }
  try {
    compile(schema as Record<string, unknown>);
  } catch (err) {
    return `schema does not compile: ${(err as Error).message.slice(0, 200)}`;
  }
  return null;
}

const ajv = new Ajv({
  allErrors: false,
  strict: true,
  strictRequired: false,
  validateFormats: false,
  loadSchema: undefined,
  addUsedSchema: false,
});
const compiled = new Map<string, ValidateFunction>();
const MAX_COMPILED = 500;

function compile(schema: Record<string, unknown>): ValidateFunction {
  const key = createHash("sha256").update(JSON.stringify(schema)).digest("hex");
  let fn = compiled.get(key);
  if (!fn) {
    fn = ajv.compile(schema);
    if (compiled.size >= MAX_COMPILED) compiled.delete(compiled.keys().next().value!);
    compiled.set(key, fn);
  }
  return fn;
}

export function validateAgainstSchema(
  schema: Record<string, unknown>,
  value: unknown,
): { valid: true } | { valid: false; error: string } {
  const fn = compile(schema);
  if (fn(value)) return { valid: true };
  const e = fn.errors?.[0];
  return { valid: false, error: e ? `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}` : "invalid" };
}

export function isJsonMediaType(contentType: string): boolean {
  const base = contentType.split(";")[0]!.trim().toLowerCase();
  return base === "application/json" || base.endsWith("+json");
}

function mediaTypeOf(header: string | null): string {
  return (header ?? "").split(";")[0]!.trim().toLowerCase();
}

// --- JSON pointers (RFC 6901) ------------------------------------------------

export function isValidPointer(pointer: string): boolean {
  return pointer === "" || (pointer.startsWith("/") && !/~[^01]/.test(pointer));
}

const MISSING = Symbol("missing");

export function resolvePointer(doc: unknown, pointer: string): unknown {
  if (pointer === "") return doc;
  let node: unknown = doc;
  for (const raw of pointer.slice(1).split("/")) {
    const token = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(node)) {
      if (!/^(0|[1-9]\d*)$/.test(token)) return MISSING;
      const index = Number(token);
      if (index >= node.length) return MISSING;
      node = node[index];
    } else if (node && typeof node === "object" && Object.prototype.hasOwnProperty.call(node, token)) {
      node = (node as Record<string, unknown>)[token];
    } else {
      return MISSING;
    }
  }
  return node;
}

function checkAssertion(doc: unknown, a: Assertion): string | null {
  const value = resolvePointer(doc, a.path);
  const at = a.path || "(root)";
  if (value === MISSING) return `${at} is missing`;
  switch (a.op) {
    case "exists":
      return null;
    case "nonEmpty":
      if (value === null || value === "") return `${at} is empty`;
      if (Array.isArray(value) && value.length === 0) return `${at} is an empty array`;
      if (typeof value === "object" && Object.keys(value as object).length === 0) return `${at} is an empty object`;
      return null;
    case "equals":
      return value === a.value ? null : `${at} is not ${JSON.stringify(a.value)}`;
    case "minItems":
      return Array.isArray(value) && value.length >= a.value ? null : `${at} has fewer than ${a.value} items`;
    case "maxItems":
      return Array.isArray(value) && value.length <= a.value ? null : `${at} has more than ${a.value} items`;
    case "minLength":
      return typeof value === "string" && [...value].length >= a.value ? null : `${at} is shorter than ${a.value}`;
    case "gte":
      return typeof value === "number" && value >= a.value ? null : `${at} is not >= ${a.value}`;
    case "lte":
      return typeof value === "number" && value <= a.value ? null : `${at} is not <= ${a.value}`;
    case "oneOf":
      return (a.value as unknown[]).includes(value) ? null : `${at} is not one of the allowed values`;
  }
}

// --- Verification ------------------------------------------------------------

export type FailureReason =
  | "timeout"
  | "network_error"
  | "blocked_destination"
  | "upstream_status"
  | "payment_loop"
  | "too_large"
  | "content_type"
  | "invalid_json"
  | "schema_mismatch"
  | "assertion_failed";

export interface Check {
  name: string;
  passed: boolean;
  detail: string;
}

export interface Verdict {
  passed: boolean;
  reason: FailureReason | null;
  checks: Check[];
}

/** What the gateway observed from the upstream call. */
export type Observation =
  | {
      kind: "response";
      status: number;
      contentType: string | null;
      body: Uint8Array;
      latencyMs: number;
    }
  | { kind: "timeout"; latencyMs: number }
  | { kind: "too_large"; latencyMs: number; limit: number }
  | { kind: "blocked"; detail: string }
  | { kind: "network_error"; latencyMs: number; detail: string };

/** Decide whether an upstream response kept the SLA. Pure: same observation, same verdict. */
export function evaluate(sla: Sla, obs: Observation): Verdict {
  const checks: Check[] = [];
  const fail = (reason: FailureReason, name: string, detail: string): Verdict => {
    checks.push({ name, passed: false, detail });
    return { passed: false, reason, checks };
  };
  const pass = (name: string, detail: string) => checks.push({ name, passed: true, detail });

  switch (obs.kind) {
    case "blocked":
      return fail("blocked_destination", "destination", obs.detail);
    case "timeout":
      return fail("timeout", "latency", `no response within ${sla.maxLatencyMs}ms`);
    case "network_error":
      return fail("network_error", "connection", obs.detail);
    case "too_large":
      return fail("too_large", "size", `response exceeded ${obs.limit} bytes`);
  }

  pass("latency", `${obs.latencyMs}ms of ${sla.maxLatencyMs}ms`);

  if (obs.status === 402) return fail("payment_loop", "status", "upstream asked for payment again");
  if (!sla.expectStatus.includes(obs.status)) {
    return fail("upstream_status", "status", `got ${obs.status}, expected ${sla.expectStatus.join(" or ")}`);
  }
  pass("status", String(obs.status));

  if (obs.body.byteLength > sla.maxResponseBytes) {
    return fail("too_large", "size", `${obs.body.byteLength} bytes exceeds ${sla.maxResponseBytes}`);
  }
  pass("size", `${obs.body.byteLength} bytes`);

  const actualType = mediaTypeOf(obs.contentType);
  if (actualType !== mediaTypeOf(sla.contentType)) {
    return fail("content_type", "content type", `got ${actualType || "none"}, expected ${mediaTypeOf(sla.contentType)}`);
  }
  pass("content type", actualType);

  if (!isJsonMediaType(sla.contentType)) return { passed: true, reason: null, checks };

  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(obs.body));
  } catch {
    return fail("invalid_json", "json", "body is not valid UTF-8 JSON");
  }
  pass("json", "parsed");

  if (sla.outputSchema) {
    const result = validateAgainstSchema(sla.outputSchema, doc);
    if (!result.valid) return fail("schema_mismatch", "schema", result.error);
    pass("schema", "matches output schema");
  }

  for (const a of sla.assertions) {
    const problem = checkAssertion(doc, a);
    const name = `assert ${a.op} ${a.path || "(root)"}`;
    if (problem) return fail("assertion_failed", name, problem);
    pass(name, "ok");
  }

  return { passed: true, reason: null, checks };
}
