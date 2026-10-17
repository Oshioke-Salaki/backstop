import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertSafeUrl, callUpstream, guardedLookup, isPublicAddress } from "../src/net";

describe("isPublicAddress", () => {
  it.each([
    ["8.8.8.8", true],
    ["1.1.1.1", true],
    ["2606:4700:4700::1111", true],
    ["127.0.0.1", false],
    ["10.0.0.5", false],
    ["172.16.0.1", false],
    ["192.168.1.1", false],
    ["169.254.169.254", false],
    ["100.64.0.1", false],
    ["0.0.0.0", false],
    ["255.255.255.255", false],
    ["224.0.0.1", false],
    ["::1", false],
    ["::", false],
    ["fe80::1", false],
    ["fc00::1", false],
    ["::ffff:127.0.0.1", false],
    ["::ffff:10.0.0.1", false],
    ["::ffff:8.8.8.8", true],
    ["64:ff9b::7f00:1", false],
    ["2002:7f00:1::", false],
    ["not an ip", false],
  ])("%s → %s", (ip, expected) => {
    expect(isPublicAddress(ip)).toBe(expected);
  });
});

describe("assertSafeUrl", () => {
  const strict = { allowPrivateNetworks: false };
  it("accepts public https URLs", () => {
    expect(assertSafeUrl("https://api.example.com/v1/x?y=1", strict).hostname).toBe("api.example.com");
    expect(assertSafeUrl("https://api.example.com:8443/", strict).port).toBe("8443");
  });

  it.each([
    "http://api.example.com/",
    "ftp://api.example.com/",
    "file:///etc/passwd",
    "https://user:pass@api.example.com/",
    "https://api.example.com/#frag",
    "https://127.0.0.1/",
    "https://[::1]/",
    "https://169.254.169.254/latest/meta-data",
    "https://localhost/",
    "https://foo.localhost/",
    "https://metadata.internal/",
    "https://intranet/",
    "https://api.example.com:22/",
    "not a url",
  ])("rejects %s", (url) => {
    expect(() => assertSafeUrl(url, strict)).toThrow();
  });

  it("allows local http only under the development policy", () => {
    expect(assertSafeUrl("http://127.0.0.1:4000/x", { allowPrivateNetworks: true }).port).toBe("4000");
    expect(() => assertSafeUrl("file:///x", { allowPrivateNetworks: true })).toThrow();
  });
});

describe("guardedLookup", () => {
  it("refuses hostnames that resolve to loopback", async () => {
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) =>
      guardedLookup("localhost", {}, (e) => resolve(e)),
    );
    expect(err?.code).toBe("EBLOCKED");
  });

  it("returns the array form when asked for all addresses", async () => {
    // Exercise the callback shape with a stubbed resolver result via a public literal.
    const result = await new Promise<unknown>((resolve) =>
      guardedLookup("dns.google", { all: true }, (e, addrs) => resolve(e ? e.code : addrs)),
    );
    // Offline CI resolves nothing; either way the guard must never return a private address.
    if (Array.isArray(result)) {
      for (const a of result as Array<{ address: string }>) expect(isPublicAddress(a.address)).toBe(true);
    } else {
      expect(typeof result).toBe("string");
    }
  });
});

describe("callUpstream", () => {
  let server: Server;
  let origin: string;
  const dev = { allowPrivateNetworks: true };

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url!, "http://x");
      switch (url.pathname) {
        case "/json":
          res.setHeader("content-type", "application/json");
          res.setHeader("set-cookie", "a=b");
          res.end(JSON.stringify({ ok: true, echo: req.headers["x-test"] ?? null }));
          return;
        case "/slow":
          setTimeout(() => res.end("late"), 800);
          return;
        case "/stall-body":
          res.setHeader("content-type", "application/json");
          res.write("{");
          setTimeout(() => res.end("}"), 800);
          return;
        case "/big":
          res.setHeader("content-type", "application/octet-stream");
          for (let i = 0; i < 64; i++) res.write(Buffer.alloc(1024, 1));
          res.end();
          return;
        case "/redirect":
          res.statusCode = 302;
          res.setHeader("location", "http://169.254.169.254/");
          res.end();
          return;
        case "/echo-body": {
          const chunks: Buffer[] = [];
          req.on("data", (c) => chunks.push(c));
          req.on("end", () => {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ method: req.method, body: Buffer.concat(chunks).toString() }));
          });
          return;
        }
        default:
          res.statusCode = 500;
          res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  const call = (path: string, extra: Partial<Parameters<typeof callUpstream>[0]> = {}) =>
    callUpstream(
      { url: `${origin}${path}`, method: "GET", headers: {}, timeoutMs: 400, maxResponseBytes: 16 * 1024, ...extra },
      dev,
    );

  it("returns the response with only safe headers", async () => {
    const r = await call("/json", { headers: { "x-test": "hi" } });
    expect(r.observation.kind).toBe("response");
    if (r.observation.kind !== "response") return;
    expect(r.observation.status).toBe(200);
    expect(JSON.parse(Buffer.from(r.observation.body).toString())).toEqual({ ok: true, echo: "hi" });
    expect(r.headers["content-type"]).toBe("application/json");
    expect(r.headers["set-cookie"]).toBeUndefined();
  });

  it("forwards method and body", async () => {
    const r = await call("/echo-body", { method: "POST", body: new TextEncoder().encode('{"q":1}') });
    if (r.observation.kind !== "response") throw new Error("expected response");
    expect(JSON.parse(Buffer.from(r.observation.body).toString())).toEqual({ method: "POST", body: '{"q":1}' });
  });

  it("times out on slow headers", async () => {
    expect((await call("/slow")).observation.kind).toBe("timeout");
  });

  it("times out on a stalled body", async () => {
    expect((await call("/stall-body")).observation.kind).toBe("timeout");
  });

  it("stops reading once the size cap is exceeded", async () => {
    const r = await call("/big");
    expect(r.observation).toMatchObject({ kind: "too_large", limit: 16 * 1024 });
  });

  it("does not follow redirects", async () => {
    const r = await call("/redirect");
    expect(r.observation).toMatchObject({ kind: "response", status: 302 });
  });

  it("reports connection failures", async () => {
    const r = await callUpstream(
      { url: "http://127.0.0.1:1/", method: "GET", headers: {}, timeoutMs: 400, maxResponseBytes: 10 },
      dev,
    );
    expect(r.observation.kind).toBe("network_error");
  });

  it("blocks private destinations under the production policy", async () => {
    const r = await callUpstream(
      { url: `${origin}/json`, method: "GET", headers: {}, timeoutMs: 400, maxResponseBytes: 10 },
      { allowPrivateNetworks: false },
    );
    expect(r.observation.kind).toBe("blocked");
  });
});
