export type RouteSurface = "node" | "edge";
export type RouteAuthMode =
  | "public"
  | "auth_required"
  | "api_key_or_admin"
  | "admin_only";
export type RouteOrgRule = "public" | "auth_org" | "admin_override" | "header_org";
export type RouteTelemetryKind =
  | "request"
  | "retrieval"
  | "ingest"
  | "sync"
  | "webhook"
  | "admin";

export interface RouteControl {
  method: string;
  path: string;
  surface: RouteSurface;
  authMode: RouteAuthMode;
  orgRule: RouteOrgRule;
  adminOverride: boolean;
  rateBucket: string;
  auditRequired: boolean;
  idempotencyRequired: boolean;
  telemetry: RouteTelemetryKind[];
  securitySensitive: boolean;
}

function normalizeMethod(method: string): string {
  return method.toUpperCase();
}

function pathToRegex(path: string): RegExp {
  const escaped = path
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/:([A-Za-z0-9_]+)/g, "[^/]+");
  return new RegExp(`^${escaped}$`);
}

/**
 * The repository-index admin surface mints durable credentials, so it is admin work even though
 * its path is namespaced under /v1/repo-index/. authMode is deliberately not derived from this:
 * this build never sets isAdmin, so classifying it admin_only would refuse every caller.
 */
function isRepoIndexAdmin(path: string): boolean {
  return path.startsWith("/v1/repo-index/admin/");
}

function deriveAuthMode(path: string): RouteAuthMode {
  if (path === "/" || path === "/health" || path.startsWith("/v1/contracts/meta")) return "public";
  if (path.startsWith("/v1/wizard/auth/device/") || path === "/v1/wizard/events") return "public";
  if (path.startsWith("/v1/admin/")) return "admin_only";
  if (
    path === "/v1/memory" ||
    path === "/v1/memory/bulk" ||
    path === "/v1/memory/ingest/session" ||
    path === "/v1/memory/search" ||
    path === "/v1/context/query" ||
    path === "/v1/learn" ||
    path === "/v1/index" ||
    path === "/v1/index/bundle"
  ) {
    return "api_key_or_admin";
  }
  return "auth_required";
}

function deriveOrgRule(path: string): RouteOrgRule {
  if (path === "/" || path === "/health" || path.startsWith("/v1/contracts/meta")) return "public";
  if (path.startsWith("/v1/admin/")) return "admin_override";
  return "auth_org";
}

function deriveTelemetry(path: string): RouteTelemetryKind[] {
  if (path.startsWith("/v1/admin/") || isRepoIndexAdmin(path)) return ["request", "admin"];
  if (path.includes("/sync") || path.includes("/sources")) return ["request", "sync"];
  if (path === "/v1/learn") return ["request", "ingest"];
  if (path === "/v1/index") return ["request", "ingest"];
  if (path.includes("/ingest")) return ["request", "ingest"];
  if (path.includes("/webhooks")) return ["request", "webhook"];
  if (path.includes("/query") || path.includes("/search") || path.includes("/oracle")) {
    return ["request", "retrieval"];
  }
  return ["request"];
}

function deriveRateBucket(path: string): string {
  if (path.startsWith("/v1/admin/") || isRepoIndexAdmin(path)) return "admin";
  if (path.includes("/sync")) return "sync";
  if (path === "/v1/learn") return "ingest";
  if (path === "/v1/index") return "ingest";
  if (path.includes("/ingest")) return "ingest";
  if (path.includes("/query") || path.includes("/search")) return "query";
  if (path.includes("/memory")) return "memory";
  return "general";
}

function deriveIdempotency(method: string, path: string): boolean {
  const normalizedMethod = normalizeMethod(method);
  if (
    normalizedMethod !== "POST" &&
    normalizedMethod !== "PUT" &&
    normalizedMethod !== "PATCH" &&
    normalizedMethod !== "DELETE"
  ) {
    return false;
  }
  return (
    path === "/v1/projects/:projectId/sources" ||
    path === "/v1/projects/:projectId/add_source" ||
    path === "/v1/sources/:sourceId/sync" ||
    path === "/v1/projects/:projectId/ingest" ||
    path === "/v1/learn" ||
    path === "/v1/index" ||
    path === "/v1/webhooks/:id/redeliver" ||
    path === "/v1/admin/sources/rehydrate" ||
    path === "/v1/admin/config/import" ||
    path === "/v1/sources/:sourceId/restore"
  );
}

function buildControl(
  surface: RouteSurface,
  method: string,
  path: string
): RouteControl {
  const authMode = deriveAuthMode(path);
  return {
    method: normalizeMethod(method),
    path,
    surface,
    authMode,
    orgRule: deriveOrgRule(path),
    adminOverride: authMode === "admin_only",
    rateBucket: deriveRateBucket(path),
    auditRequired:
      authMode === "admin_only" ||
      isRepoIndexAdmin(path) ||
      ["POST", "PUT", "PATCH", "DELETE"].includes(normalizeMethod(method)),
    idempotencyRequired: deriveIdempotency(method, path),
    telemetry: deriveTelemetry(path),
    securitySensitive:
      authMode === "admin_only" ||
      isRepoIndexAdmin(path) ||
      path.includes("/keys") ||
      path.includes("/webhooks") ||
      path.includes("/restore") ||
      path.includes("/config/import"),
  };
}

export function buildRouteControlMatrix(
  routes: Array<{ method: string; path: string }>,
  surface: RouteSurface
): RouteControl[] {
  const unique = new Map<string, RouteControl>();
  for (const route of routes) {
    const key = `${normalizeMethod(route.method)} ${route.path}`;
    if (unique.has(key)) continue;
    unique.set(key, buildControl(surface, route.method, route.path));
  }
  return [...unique.values()].sort((a, b) =>
    `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`)
  );
}

export function getRouteControl(
  matrix: RouteControl[],
  method: string,
  path: string
): RouteControl | null {
  const normalizedMethod = normalizeMethod(method);
  for (const control of matrix) {
    if (control.method !== normalizedMethod) continue;
    if (pathToRegex(control.path).test(path)) return control;
  }
  return null;
}

/**
 * The reviewed route inventory: the independent source of truth for coverage.
 *
 * The matrix is derived from whatever the router registers, so on its own it can never report a
 * missing control: buildRouteControlMatrix invents one for every route it is handed. This inventory
 * is the contract a route is added to, with the classification it was reviewed for, so coverage
 * fails when the router serves a route that is not listed, when a control's classification drifted
 * from the listing, and when a listed route is no longer served.
 *
 * `POST /v1/repo-index/admin/scopes*` is reviewed as auth_required on purpose: it is admin work for
 * telemetry, rate limiting and auditing (see isRepoIndexAdmin), but this build never sets isAdmin,
 * so classifying it admin_only would refuse the caller that has to enrol a scope.
 */
const REVIEWED_ROUTES: Record<RouteAuthMode, readonly string[]> = {
  public: [],
  api_key_or_admin: [
    "POST /v1/context/query",
    "POST /v1/index",
    "POST /v1/index/bundle",
    "POST /v1/learn",
    "POST /v1/memory",
    "POST /v1/memory/bulk",
    "POST /v1/memory/ingest/session",
    "POST /v1/memory/search",
  ],
  admin_only: [
    "GET /v1/admin/extraction/alerts",
    "GET /v1/admin/extraction/config",
    "GET /v1/admin/extraction/gates",
    "GET /v1/admin/extraction/stats",
    "GET /v1/admin/latency/config",
    "GET /v1/admin/latency/gates",
    "GET /v1/admin/latency/stats",
    "GET /v1/admin/ops/alerts",
    "GET /v1/admin/ops/connectors",
    "GET /v1/admin/ops/counters",
    "GET /v1/admin/ops/queues",
    "GET /v1/admin/ops/retrieval",
    "GET /v1/admin/ops/routes",
    "GET /v1/admin/ops/sources",
    "GET /v1/admin/ops/webhooks",
    "POST /v1/admin/extraction/reset",
    "POST /v1/admin/latency/reset",
    "POST /v1/admin/memory/cleanup",
    "POST /v1/admin/sources/rehydrate",
  ],
  auth_required: [
    "ALL /*",
    "DELETE /v1/agent/credentials/:id",
    "DELETE /v1/agent/runs/:id",
    "DELETE /v1/agent/tasks/:id",
    "DELETE /v1/cache/clear",
    "DELETE /v1/files/:fileId",
    "DELETE /v1/memories/:id",
    "DELETE /v1/memory/:memoryId",
    "DELETE /v1/projects/:id",
    "DELETE /v1/sources/:sourceId",
    "DELETE /v1/webhooks/:id",
    "GET /v1/agent-events/:eventId",
    "GET /v1/agent/browse/context",
    "GET /v1/agent/credentials",
    "GET /v1/agent/insights",
    "GET /v1/agent/runs",
    "GET /v1/agent/runs/:id",
    "GET /v1/agent/tasks",
    "GET /v1/agent/tasks/:id",
    "GET /v1/agent/templates",
    "GET /v1/cache/stats",
    "GET /v1/context/shared/:shareId",
    "GET /v1/conversations",
    "GET /v1/conversations/:id",
    "GET /v1/cost/breakdown",
    "GET /v1/cost/savings",
    "GET /v1/cost/summary",
    "GET /v1/files",
    "GET /v1/files/:fileId",
    "GET /v1/files/:fileId/content",
    "GET /v1/jobs/:jobId",
    "GET /v1/memories",
    "GET /v1/memories/:id",
    "GET /v1/memory/:memoryId",
    "GET /v1/memory/:memoryId/versions",
    "GET /v1/memory/agent/:agentId/model",
    "GET /v1/memory/decay/stats",
    "GET /v1/memory/graph",
    "GET /v1/memory/graph/conversation/:sessionId",
    "GET /v1/memory/jobs/:jobId",
    "GET /v1/memory/profile/:userId",
    "GET /v1/memory/session/:sessionId",
    "GET /v1/memory/user-model/:userId",
    "GET /v1/projects",
    "GET /v1/projects/:id",
    "GET /v1/projects/:id/stats",
    "GET /v1/projects/:projectId/sources",
    "GET /v1/projects/resolve",
    "GET /v1/repo-index/scopes/:scopeId/manifest",
    "GET /v1/repo-index/scopes/:scopeId/receipt",
    "GET /v1/sources",
    "GET /v1/sources/:sourceId/status",
    "GET /v1/sources/:sourceId/versions",
    "GET /v1/sources/:sourceId/versions/:versionId",
    "GET /v1/sync-jobs/:jobId",
    "GET /v1/webhooks",
    "POST /retaindb/observe",
    "POST /v1/agent-events",
    "POST /v1/agent/browse",
    "POST /v1/agent/credentials",
    "POST /v1/agent/research",
    "POST /v1/agent/runs",
    "POST /v1/agent/runs/:id/resume",
    "POST /v1/agent/tasks",
    "POST /v1/agent/tasks/:id/run",
    "POST /v1/autosubscribe",
    "POST /v1/cache/warm",
    "POST /v1/context/compress-output",
    "POST /v1/context/delta",
    "POST /v1/context/pack",
    "POST /v1/context/resume",
    "POST /v1/context/share",
    "POST /v1/conversations",
    "POST /v1/conversations/:conversationId/messages",
    "POST /v1/entities",
    "POST /v1/files",
    "POST /v1/files/:fileId/ingest",
    "POST /v1/graph/search",
    "POST /v1/learn/batch",
    "POST /v1/memories",
    "POST /v1/memories/search",
    "POST /v1/memory/:memoryId/confirm",
    "POST /v1/memory/agent/:agentId/seed",
    "POST /v1/memory/bulk-delete",
    "POST /v1/memory/consolidate",
    "POST /v1/memory/decay/update",
    "POST /v1/memory/dialectic",
    "POST /v1/memory/extract",
    "POST /v1/memory/extract/session",
    "POST /v1/memory/profile/:userId/gaps",
    "POST /v1/oracle/search",
    "POST /v1/projects/:projectId/add_source",
    "POST /v1/projects/:projectId/ingest",
    "POST /v1/projects/:projectId/sources",
    "POST /v1/projects/:projectId/sources/github-tarball",
    "POST /v1/relations",
    "POST /v1/repo-index/admin/scopes",
    "POST /v1/repo-index/admin/scopes/:scopeId/grants",
    "POST /v1/repo-index/admin/scopes/:scopeId/grants/:grantId/revoke",
    "POST /v1/repo-index/admin/scopes/:scopeId/pause",
    "POST /v1/repo-index/admin/scopes/:scopeId/resume",
    "POST /v1/repo-index/admin/scopes/:scopeId/withdraw",
    "POST /v1/repo-index/scopes/:scopeId/generations/:attemptId/abandon",
    "POST /v1/repo-index/scopes/:scopeId/generations/:attemptId/finalize",
    "POST /v1/search/files",
    "POST /v1/search/semantic",
    "POST /v1/sources/:sourceId/restore",
    "POST /v1/sources/:sourceId/sync",
    "POST /v1/sync-jobs/:jobId/cancel",
    "POST /v1/webhooks",
    "POST /v1/webhooks/:id/redeliver",
    "PUT /v1/files/:fileId",
    "PUT /v1/memories/:id",
    "PUT /v1/memory/:memoryId",
    "PUT /v1/repo-index/scopes/:scopeId/generations/:attemptId",
    "PUT /v1/repo-index/scopes/:scopeId/generations/:attemptId/parts/:partNo",
    "PUT /v1/sources/:sourceId",
  ],
};

/** The organisation rule each reviewed classification implies. */
const REVIEWED_ORG_RULE: Record<RouteAuthMode, RouteOrgRule> = {
  public: "public",
  api_key_or_admin: "auth_org",
  admin_only: "admin_override",
  auth_required: "auth_org",
};

const REVIEWED_AUTH_MODE: ReadonlyMap<string, RouteAuthMode> = new Map(
  Object.entries(REVIEWED_ROUTES).flatMap(([authMode, routes]) =>
    routes.map((route) => [route, authMode as RouteAuthMode] as const)
  )
);

function routeKey(route: { method: string; path: string }): string {
  return `${normalizeMethod(route.method)} ${route.path}`;
}

/** One entry per route, so a route registered twice is not reported twice. */
function uniqueRoutes(routes: Array<{ method: string; path: string }>) {
  return [...new Map(routes.map((route) => [routeKey(route), route])).values()];
}

/** Routes the router serves that the inventory does not declare. */
function undeclaredRoutes(routes: Array<{ method: string; path: string }>): string[] {
  return routes
    .map(routeKey)
    .filter((key) => !REVIEWED_AUTH_MODE.has(key))
    .map((key) => `undeclared route ${key}`);
}

/** Declared routes the router no longer serves. */
function unservedReviews(served: Set<string>): string[] {
  return [...REVIEWED_AUTH_MODE.keys()]
    .filter((key) => !served.has(key))
    .map((key) => `reviewed route not served ${key}`);
}

/** Served routes that reached the matrix without a control. */
function missingControls(
  matrix: RouteControl[],
  routes: Array<{ method: string; path: string }>
): string[] {
  return routes
    .filter((route) => !getRouteControl(matrix, route.method, route.path))
    .map((route) => `no control for ${routeKey(route)}`);
}

/** Controls whose classification drifted from the reviewed entry that covers them. */
function driftedControls(matrix: RouteControl[]): string[] {
  const drifted: string[] = [];
  for (const control of matrix) {
    const reviewed = REVIEWED_AUTH_MODE.get(routeKey(control));
    if (reviewed === undefined) continue;
    if (control.authMode !== reviewed) {
      drifted.push(`${routeKey(control)} is classified ${control.authMode}, reviewed as ${reviewed}`);
    }
    if (control.orgRule !== REVIEWED_ORG_RULE[reviewed]) {
      drifted.push(
        `${routeKey(control)} carries org rule ${control.orgRule}, reviewed as ${REVIEWED_ORG_RULE[reviewed]}`
      );
    }
    if (control.adminOverride !== (reviewed === "admin_only")) {
      drifted.push(
        `${routeKey(control)} sets adminOverride ${control.adminOverride} for a ${reviewed} route`
      );
    }
  }
  return drifted;
}

export function assertRouteControlCoverage(
  matrix: RouteControl[],
  routes: Array<{ method: string; path: string }>,
  surface: RouteSurface
) {
  const served = uniqueRoutes(routes);
  const servedKeys = new Set(served.map(routeKey));
  const gaps = [
    ...missingControls(matrix, served),
    ...undeclaredRoutes(served),
    ...unservedReviews(servedKeys),
    ...driftedControls(matrix),
  ];
  if (gaps.length === 0) return;
  throw new Error(`[route-controls:${surface}] ${gaps.join("; ")}`);
}
