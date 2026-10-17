/** Standalone settlement worker: `pnpm worker`. Run one per deployment (more are safe, jobs use SKIP LOCKED). */
import { drainWorker, startWorkerLoop } from "../src/server/worker";

const stop = startWorkerLoop(Number(process.env.WORKER_INTERVAL_MS ?? 5000));
console.log("backstop worker started");

async function shutdown(signal: string) {
  console.log(`${signal} received, finishing in-flight work`);
  stop();
  await drainWorker();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
