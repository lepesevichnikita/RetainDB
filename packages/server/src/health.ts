import { embeddingWorkerState } from "./engine/embedding-process.js";

/**
 * Readiness is what the Service and every monitor see. It must answer within a
 * fixed budget and it must fail when a dependency is unusable: a green health
 * check on a process that cannot reach PostgreSQL or cannot embed text is worse
 * than no monitor at all.
 */

export interface DatabaseCheck { status: "ok" | "down"; latencyMs: number }
export interface EmbeddingCheck { status: "ok" | "warming" | "failed" | "not_required"; mode: string; model: string | null }
export interface ReadinessReport {
  status: "ok" | "degraded" | "unhealthy";
  checks: { database: DatabaseCheck; embeddings: EmbeddingCheck };
  uptimeSeconds: number;
}

const DB_TIMEOUT_MS = Number(process.env.HEALTH_DB_TIMEOUT_MS || 2_000);
const EMBEDDING_MODE = (process.env.EMBEDDING_MODE || "remote").toLowerCase();
const LOCAL_EMBEDDING_REQUIRED = EMBEDDING_MODE === "local" || EMBEDDING_MODE === "hybrid";

let inFlightDatabaseCheck: Promise<DatabaseCheck> | undefined;

async function probeDatabase(): Promise<DatabaseCheck> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>(resolve => {
    timer = setTimeout(() => resolve(false), DB_TIMEOUT_MS);
    timer.unref?.();
  });
  const query = (async () => {
    const { db } = await import("./db/index.js");
    await db.$queryRaw`SELECT 1`;
    return true;
  })().catch(() => false);
  const ok = await Promise.race([query, timeout]);
  if (timer) clearTimeout(timer);
  return { status: ok ? "ok" : "down", latencyMs: Date.now() - started };
}

/** Concurrent probes share one query so a hanging database cannot drain the pool. */
export function checkDatabase(): Promise<DatabaseCheck> {
  if (!inFlightDatabaseCheck) {
    inFlightDatabaseCheck = probeDatabase().finally(() => { inFlightDatabaseCheck = undefined; });
  }
  return inFlightDatabaseCheck;
}

function embeddingCheck(): EmbeddingCheck {
  if (!LOCAL_EMBEDDING_REQUIRED) {
    return { status: "not_required", mode: EMBEDDING_MODE, model: null };
  }
  const state = embeddingWorkerState();
  const status = state === "ready" ? "ok" : state === "failed" ? "failed" : "warming";
  const model = process.env.EMBEDDING_MODEL || "Xenova/multilingual-e5-large";
  return { status, mode: EMBEDDING_MODE, model };
}

export async function readReadiness(): Promise<ReadinessReport> {
  const database = await checkDatabase();
  const embeddings = embeddingCheck();
  const status = database.status === "down" ? "unhealthy" : embeddings.status === "ok" || embeddings.status === "not_required" ? "ok" : "degraded";
  return { status, checks: { database, embeddings }, uptimeSeconds: Math.round(process.uptime()) };
}
