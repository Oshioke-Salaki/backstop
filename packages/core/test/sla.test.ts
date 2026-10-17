import { describe, expect, it } from "vitest";
import { evaluate, inspectJsonSchema, resolvePointer, slaSchema, type Observation, type Sla } from "../src/sla";

const enc = (v: unknown) => new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v));

const base: Sla = slaSchema.parse({
  maxLatencyMs: 2000,
  maxResponseBytes: 10_000,
  outputSchema: {
    type: "object",
    required: ["temperature", "city"],
    properties: { temperature: { type: "number" }, city: { type: "string" } },
  },
  assertions: [
    { op: "nonEmpty", path: "/city" },
    { op: "gte", path: "/temperature", value: -100 },
  ],
});

const ok = (body: unknown, extra: Partial<Extract<Observation, { kind: "response" }>> = {}): Observation => ({
  kind: "response",
  status: 200,
  contentType: "application/json; charset=utf-8",
  body: enc(body),
  latencyMs: 120,
  ...extra,
});

describe("evaluate", () => {
  it("passes a response that keeps every promise", () => {
    const v = evaluate(base, ok({ temperature: 21.5, city: "Lagos" }));
    expect(v.passed).toBe(true);
    expect(v.reason).toBeNull();
    expect(v.checks.every((c) => c.passed)).toBe(true);
  });

  const failures: Array<[string, Observation, string]> = [
    ["timeout", { kind: "timeout", latencyMs: 2000 }, "timeout"],
    ["network error", { kind: "network_error", latencyMs: 5, detail: "ECONNREFUSED" }, "network_error"],
    ["blocked destination", { kind: "blocked", detail: "private" }, "blocked_destination"],
    ["streamed oversize", { kind: "too_large", latencyMs: 10, limit: 10_000 }, "too_large"],
    ["upstream 500", ok({}, { status: 500 }), "upstream_status"],
    ["upstream 404", ok({}, { status: 404 }), "upstream_status"],
    ["redirect", ok({}, { status: 302 }), "upstream_status"],
    ["payment loop", ok({}, { status: 402 }), "payment_loop"],
    ["oversized body", ok("x".repeat(10_001)), "too_large"],
    ["wrong content type", ok({ temperature: 1, city: "a" }, { contentType: "text/html" }), "content_type"],
    ["missing content type", ok({ temperature: 1, city: "a" }, { contentType: null }), "content_type"],
    ["invalid json", ok("{not json"), "invalid_json"],
    ["invalid utf-8", { ...(ok("") as any), body: new Uint8Array([0x7b, 0xff, 0x7d]) }, "invalid_json"],
    ["schema mismatch", ok({ temperature: "hot", city: "Lagos" }), "schema_mismatch"],
    ["missing field", ok({ city: "Lagos" }), "schema_mismatch"],
    ["empty string assertion", ok({ temperature: 1, city: "" }), "assertion_failed"],
    ["range assertion", ok({ temperature: -500, city: "Lagos" }), "assertion_failed"],
  ];
  it.each(failures)("fails on %s", (_name, obs, reason) => {
    const v = evaluate(base, obs);
    expect(v.passed).toBe(false);
    expect(v.reason).toBe(reason);
    expect(v.checks.at(-1)?.passed).toBe(false);
  });

  it("accepts any listed 2xx status", () => {
    const sla = slaSchema.parse({ maxLatencyMs: 1000, maxResponseBytes: 100, expectStatus: [200, 201] });
    expect(evaluate(sla, ok({}, { status: 201 })).passed).toBe(true);
    expect(evaluate(sla, ok({}, { status: 204 })).passed).toBe(false);
  });

  it("checks only transport and type for non-JSON services", () => {
    const sla = slaSchema.parse({ maxLatencyMs: 1000, maxResponseBytes: 100, contentType: "image/png" });
    expect(evaluate(sla, ok("PNGDATA", { contentType: "image/png" })).passed).toBe(true);
  });

  it("is deterministic", () => {
    const obs = ok({ temperature: 1, city: "x" });
    expect(evaluate(base, obs)).toEqual(evaluate(base, obs));
  });

  it.each([
    [{ op: "exists", path: "/a/0/b" }, { a: [{ b: null }] }, true],
    [{ op: "exists", path: "/a/1" }, { a: [1] }, false],
    [{ op: "equals", path: "/s", value: "ok" }, { s: "ok" }, true],
    [{ op: "equals", path: "/s", value: 1 }, { s: "1" }, false],
    [{ op: "minItems", path: "/a", value: 2 }, { a: [1, 2] }, true],
    [{ op: "minItems", path: "/a", value: 2 }, { a: "ab" }, false],
    [{ op: "maxItems", path: "/a", value: 1 }, { a: [1, 2] }, false],
    [{ op: "minLength", path: "/s", value: 2 }, { s: "😀😀" }, true],
    [{ op: "lte", path: "/n", value: 5 }, { n: 5 }, true],
    [{ op: "oneOf", path: "/c", value: ["a", "b"] }, { c: "b" }, true],
    [{ op: "oneOf", path: "/c", value: ["a", "b"] }, { c: "z" }, false],
    [{ op: "nonEmpty", path: "/o" }, { o: {} }, false],
    [{ op: "nonEmpty", path: "/a" }, { a: [] }, false],
    [{ op: "nonEmpty", path: "" }, { x: 1 }, true],
    [{ op: "exists", path: "/__proto__" }, {}, false],
  ])("assertion %j on %j → %s", (assertion, doc, passed) => {
    const sla = slaSchema.parse({ maxLatencyMs: 1000, maxResponseBytes: 1000, assertions: [assertion] });
    expect(evaluate(sla, ok(doc)).passed).toBe(passed);
  });
});

describe("slaSchema", () => {
  it("applies defaults", () => {
    const sla = slaSchema.parse({ maxLatencyMs: 1000, maxResponseBytes: 1000 });
    expect(sla.expectStatus).toEqual([200]);
    expect(sla.contentType).toBe("application/json");
    expect(sla.assertions).toEqual([]);
  });

  it.each([
    [{ maxLatencyMs: 50, maxResponseBytes: 1 }, "latency below floor"],
    [{ maxLatencyMs: 60_001, maxResponseBytes: 1 }, "latency above ceiling"],
    [{ maxLatencyMs: 1000, maxResponseBytes: 6 * 1024 * 1024 }, "size above ceiling"],
    [{ maxLatencyMs: 1000, maxResponseBytes: 1, expectStatus: [404] }, "non-2xx expected status"],
    [{ maxLatencyMs: 1000, maxResponseBytes: 1, contentType: "json" }, "bad media type"],
    [{ maxLatencyMs: 1000, maxResponseBytes: 1, contentType: "text/plain", assertions: [{ op: "exists", path: "/a" }] }, "assertions on text"],
    [{ maxLatencyMs: 1000, maxResponseBytes: 1, assertions: [{ op: "exists", path: "a" }] }, "non-pointer path"],
    [{ maxLatencyMs: 1000, maxResponseBytes: 1, assertions: [{ op: "regex", path: "/a" }] }, "unknown op"],
    [{ maxLatencyMs: 1000, maxResponseBytes: 1, unknown: true }, "unknown key"],
  ] as Array<[unknown, string]>)("rejects %j (%s)", (input) => {
    expect(slaSchema.safeParse(input).success).toBe(false);
  });
});

describe("inspectJsonSchema", () => {
  it("allows ordinary schemas and local refs", () => {
    expect(
      inspectJsonSchema({
        type: "object",
        definitions: { n: { type: "number" } },
        properties: { a: { $ref: "#/definitions/n" } },
      }),
    ).toBeNull();
  });

  it.each([
    [{ type: "string", pattern: "(a+)+$" }, /pattern/],
    [{ type: "object", patternProperties: { "^x": {} } }, /patternProperties/],
    [{ $ref: "https://evil.example/schema.json" }, /local \$ref/],
    [{ $id: "https://x" }, /\$id/],
    [{ type: "nope" }, /does not compile/],
    [{ type: "string", madeUpKeyword: 1 }, /does not compile/],
  ])("rejects %j", (schema, message) => {
    expect(inspectJsonSchema(schema)).toMatch(message);
  });

  it("rejects deeply nested schemas", () => {
    let s: Record<string, unknown> = { type: "number" };
    for (let i = 0; i < 30; i++) s = { type: "array", items: s };
    expect(inspectJsonSchema(s)).toMatch(/nests deeper/);
  });

  it("rejects oversized schemas", () => {
    const props = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`field_${i}`, { type: "string" }]));
    expect(inspectJsonSchema({ type: "object", properties: props })).toMatch(/exceeds/);
  });
});

describe("resolvePointer", () => {
  it("follows RFC 6901 escaping", () => {
    const doc = { "a/b": { "c~d": 1 }, list: [10, 20] };
    expect(resolvePointer(doc, "/a~1b/c~0d")).toBe(1);
    expect(resolvePointer(doc, "/list/1")).toBe(20);
  });

  it("does not walk prototypes or loose indices", () => {
    expect(typeof resolvePointer({}, "/constructor")).toBe("symbol");
    expect(typeof resolvePointer({ list: [1] }, "/list/01")).toBe("symbol");
    expect(typeof resolvePointer({ list: [1] }, "/list/-1")).toBe("symbol");
  });
});
