import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { randomUUID } from "crypto";
import { latencyTraceMiddleware } from "../middleware/latency-trace.js";
import { maybeSendAlertEmail } from "../engine/alert-email.js";
import { createDashboard, DASHBOARD_PATH, isDashboardPath } from "../dashboard.js";
import { readReadiness, type ReadinessReport } from "../health.js";

const STACK_NAME = process.env.RETAINDB_STACK || "ec2";

export function getTraceIdFromRequest(c: { req: { header: (name: string) => string | undefined } }) {
  return c.req.header("x-trace-id") || c.req.header("x-request-id") || randomUUID();
}

export function bigIntJson(value: any): any {
  if (value === null || value === undefined) return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(bigIntJson);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, bigIntJson(entry)]));
  }
  return value;
}

function errorPayload(params: {
  code: string;
  message: string;
  traceId: string;
  details?: string;
}) {
  return bigIntJson({
    success: false,
    error: {
      code: params.code,
      message: params.message,
      ...(params.details ? { details: params.details } : {}),
    },
    trace_id: params.traceId,
  });
}

async function parseErrorResponse(response: Response) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) return {};
  try {
    const payload = await response.clone().json();
    return {
      code:
        payload?.error?.code ||
        (typeof payload?.error === "string" ? payload.error : "") ||
        payload?.code ||
        "",
      message:
        payload?.error?.message ||
        (typeof payload?.error === "string" ? payload.error : "") ||
        payload?.message ||
        "",
      details: payload?.error?.details || payload?.details || "",
    };
  } catch {
    return {};
  }
}


async function maybeAlertRequestError(c: any) {
  const path = c.req?.path || "";
  const status = Number(c.res?.status || 0);
  if (!path.startsWith("/v1/") || status < 400) return;
  const traceId = getTraceIdFromRequest(c);
  const parsed = await parseErrorResponse(c.res);
  const auth = typeof c.get === "function" ? c.get("auth") : undefined;
  await maybeSendAlertEmail("request.error", {
    severity: status >= 500 ? "critical" : "warning",
    status,
    method: c.req?.method || "",
    path,
    errorCode: parsed.code || `HTTP_${status}`,
    error: parsed.message || `HTTP ${status}`,
    details: parsed.details || "",
    traceId,
    orgId: auth?.orgId || "",
    userId: auth?.userId || auth?.id || "",
  });
}

export function createNodeApp(options: { includeApiRoutes?: boolean; routeApp?: Hono<any, any, any>; readinessCheck?: () => Promise<ReadinessReport> } = {}) {
  const { includeApiRoutes = true, routeApp, readinessCheck = readReadiness } = options;
  const app = new Hono();
  const dashboard = createDashboard();
  const apiCors = cors();
  const apiLogger = logger();

  app.use("*", (c, next) => isDashboardPath(c.req.path) ? next() : apiCors(c, next));
  app.use("*", (c, next) => isDashboardPath(c.req.path) ? next() : apiLogger(c, next));
  app.use("*", async (c, next) => {
    const traceId = getTraceIdFromRequest(c);
    c.header("x-trace-id", traceId);
    c.header("x-request-id", traceId);
    await next();
  });
  app.use("*", latencyTraceMiddleware);
  app.use("*", async (c, next) => {
    c.header("x-retaindb-stack", STACK_NAME);
    c.header("x-whisper-stack", STACK_NAME);
    await next();
    try {
      await maybeAlertRequestError(c);
    } catch (error) {
      console.error("[request-error-email] Failed to send request.error alert:", error);
    }
  });

  app.get("/", (c) => {
    if (dashboard) c.header("Vary", "Accept, Host", { append: true });
    if (dashboard?.wantsPage(c)) {
      c.header("Cache-Control", "no-store");
      return c.redirect(DASHBOARD_PATH);
    }
    return c.json({
      name: "RetainDB - SOTA Memory & Context System",
      version: "2.1.0",
      docs: "https://context.retaindb.com/docs",
      message: "Canonical memory API: use /v1/memory* endpoints. Legacy /v1/memories* routes remain available with deprecation headers.",
      endpoints: {
        query: "POST /v1/context/query",
        oracle_search: "POST /v1/oracle/search",
        autosubscribe: "POST /v1/autosubscribe",
        context_share: "POST /v1/context/share",
        context_resume: "POST /v1/context/resume",
        memory_write: "POST /v1/memory",
        memory_bulk: "POST /v1/memory/bulk",
        memory_search: "POST /v1/memory/search",
        memory_ingest: "POST /v1/memory/ingest/session",
        memory_jobs: "GET /v1/memory/jobs/:jobId",
        memory_versions: "GET /v1/memory/:id/versions",
        memory_relations: "GET /v1/memory/:id/relations",
        user_profile: "GET /v1/memory/profile/:userId",
        session_memories: "GET /v1/memory/session/:sessionId",
        update_memory: "PUT /v1/memory/:memoryId",
        delete_memory: "DELETE /v1/memory/:memoryId",
        consolidate: "POST /v1/memory/consolidate",
        decay_update: "POST /v1/memory/decay/update",
        cache_stats: "GET /v1/cache/stats",
        cost_summary: "GET /v1/cost/summary",
        cost_savings: "GET /v1/cost/savings",
        projects: "GET /v1/projects",
        sources: "POST /v1/projects/:id/sources",
        add_source: "POST /v1/projects/:id/add_source",
        source_status: "GET /v1/sources/:id/status",
        ingest: "POST /v1/projects/:id/ingest",
        learn: "POST /v1/learn",
        index: "POST /v1/index",
        index_bundle: "POST /v1/index/bundle",
        sync: "POST /v1/sources/:id/sync",
        webhooks: "POST /v1/webhooks",
        files: "POST /v1/files",
        agent_tasks: "GET /v1/agent-tasks",
        research: "POST /v1/research",
        _legacy_memories_write: "POST /v1/memories [DEPRECATED - use /v1/memory]",
        _legacy_memories_search: "POST /v1/memories/search [DEPRECATED - use /v1/memory/search]",
        _legacy_memories_list: "GET /v1/memories [DEPRECATED - use /v1/memory/profile/:userId or /v1/memory/session/:sessionId]",
        _legacy_memories_update: "PUT /v1/memories/:id [DEPRECATED - use /v1/memory/:memoryId]",
        _legacy_memories_delete: "DELETE /v1/memories/:id [DEPRECATED - use /v1/memory/:memoryId]",
      },
    });
  });

  // Liveness answers as long as this process can serve a request. Readiness
  // additionally proves the dependencies the API needs; a failed dependency
  // removes the pod from the Service without restarting a healthy process.
  app.get("/livez", (c) => c.json({ status: "ok" }));
  app.get("/health", async (c) => {
    c.header("Cache-Control", "no-store");
    try {
      const report = await readinessCheck();
      return c.json(report, report.status === "ok" ? 200 : 503);
    } catch (error) {
      console.error("[health] Readiness check failed:", error);
      return c.json(
        {
          status: "unhealthy",
          checks: {
            database: { status: "down", latencyMs: 0 },
            embeddings: { status: "failed", mode: process.env.EMBEDDING_MODE || "remote", model: null },
          },
          uptimeSeconds: Math.round(process.uptime()),
        },
        503
      );
    }
  });
  if (dashboard) {
    app.use("/v1/*", dashboard.logRequest);
    app.route(DASHBOARD_PATH, dashboard.routes);
  }
  if (includeApiRoutes && routeApp) {
    app.route("/", routeApp);
  }

  app.notFound((c) => {
    const traceId = getTraceIdFromRequest(c);
    return c.json(
      errorPayload({
        code: "NOT_FOUND",
        message: "Route not found",
        traceId,
      }),
      404
    );
  });

  app.onError((err, c) => {
    const traceId = getTraceIdFromRequest(c);
    console.error(`[${traceId}] Unhandled error:`, err);
    return c.json(
      errorPayload({
        code: "INTERNAL_ERROR",
        message: "Internal server error",
        traceId,
        details: err instanceof Error ? err.message : String(err),
      }),
      500
    );
  });

  return app;
}
