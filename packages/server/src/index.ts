import "./env.js";
import { serve } from "@hono/node-server";
import { createNodeApp } from "./api/app.js";
import { api } from "./api/routes.js";
import { startScheduler } from "./engine/scheduler.js";
import { startEmbeddingWorker } from "./engine/workers/embedding-worker.js";
import { recoverInterruptedJobs } from "./engine/sync-queue.js";
import { startNativeCaptureWorker } from "./engine/native-capture.js";
import { startDashboardRebuildWorker } from "./engine/dashboard-rebuild.js";
import { startDashboardStatisticsRefresh } from "./engine/dashboard-data.js";
import { stopEmbeddingWorker, warmEmbeddings } from "./engine/embedding-process.js";

// A process that survived an uncaught fault is not the process that was
// deployed. Exit and let Kubernetes start a clean one instead of serving
// requests from an unknown state.
process.on("uncaughtException", (err) => {
  console.error("[RetainDB] Uncaught Exception:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("[RetainDB] Unhandled Rejection:", reason);
  process.exit(1);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    stopEmbeddingWorker().finally(() => process.exit(0));
  });
}

const app = createNodeApp({ routeApp: api });
const port = Number(process.env.PORT || 3000);

/**
 * Warm the embedding child process, never this process: model loading blocks
 * the JavaScript thread, and /health has to answer while it happens.
 */
async function preloadEmbeddings() {
  const mode = process.env.EMBEDDING_MODE || (process.env.OPENAI_API_KEY ? "openai" : "local");
  if (mode !== "local" && mode !== "hybrid") return;
  try {
    const { LOCAL_EMBEDDING_MODEL } = await import("./engine/embeddings-local.js");
    console.log(`[Startup] Pre-loading local embedding process (${LOCAL_EMBEDDING_MODEL})...`);
    await warmEmbeddings();
    console.log("[Startup] ✓ Local embedding process ready");
  } catch (err) {
    console.warn("[Startup] Local model pre-load failed (will load on first request):", err);
  }
}

serve({ fetch: app.fetch, port }, async () => {
  console.log(`\n🧠 RetainDB running on http://localhost:${port}\n`);

  if (process.send) process.send("ready");
  startNativeCaptureWorker();
  if (process.env.RETAINDB_DASHBOARD_ORIGIN) {
    startDashboardRebuildWorker();
    startDashboardStatisticsRefresh();
  }

  // Start async embedding worker
  startEmbeddingWorker().catch((err) =>
    console.error("[Startup] Failed to start embedding worker:", err)
  );

  // Warm the model in its own process (fire-and-forget)
  preloadEmbeddings().catch(() => {});

  // Recover any jobs interrupted by a previous crash
  recoverInterruptedJobs().catch((err) =>
    console.warn("[Startup] Job recovery error:", err)
  );

  // Start the scheduled sync runner
  if (process.env.DISABLE_SCHEDULER !== "true") {
    startScheduler();
  }
});

export default app;
