import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    rpcUrl: string;
  }
}

/** Starts a throwaway anvil chain for the suite and always stops it afterwards. */
let anvil: ChildProcess | undefined;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

export async function setup(project: TestProject) {
  const port = await freePort();
  anvil = spawn("anvil", ["--port", String(port), "--silent", "--chain-id", "31337"], { stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
      if (res.ok) break;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  project.provide("rpcUrl", url);
}

export async function teardown() {
  if (anvil && !anvil.killed) {
    anvil.kill("SIGTERM");
    await new Promise((r) => anvil!.once("exit", r));
  }
}
