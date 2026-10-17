/** Runs once per server process. With WORKER_INLINE=true the settlement worker runs inside the web server. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.WORKER_INLINE !== "true" && process.env.WORKER_INLINE !== "1") return;
  const { startWorkerLoop } = await import("./server/worker");
  startWorkerLoop();
}
