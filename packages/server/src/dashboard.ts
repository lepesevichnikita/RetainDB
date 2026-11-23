import { readFile } from "node:fs/promises";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";
import { z } from "zod";

export const DASHBOARD_PATH = "/dashboard";
const ASSETS = new URL("../dashboard/", import.meta.url);
const SESSION_COOKIE = /^[!#$%&'*+.^_`|~\w-]+$/;
const LOG_LIMIT = 200;
const PATH_PREFIX = "/v1/";
const CONTENT_TYPES = {
  "index.html": "text/html; charset=utf-8",
  "dashboard.css": "text/css; charset=utf-8",
  "dashboard.js": "text/javascript; charset=utf-8",
  "visuals.js": "text/javascript; charset=utf-8",
};

interface Settings { host: string; authUrl: URL; cookieName: string }
interface RequestLog { at: string; method: string; route: string; status: number; durationMs: number }
type DashboardRole = "Administrator" | "Read-only";
type DashboardEnv = { Variables: { dashboardRole: DashboardRole } };

function httpsUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password && !url.hash) return url;
  } catch {
    return undefined;
  }
}

function settings(): Settings | undefined {
  const { RETAINDB_DASHBOARD_ORIGIN: origin, RETAINDB_DASHBOARD_AUTH_URL: authUrl } = process.env;
  if (!origin && !authUrl) return;
  const cookieName = process.env.RETAINDB_DASHBOARD_SESSION_COOKIE ?? "authelia_session";
  const url = httpsUrl(origin ?? "");
  const authorization = httpsUrl(authUrl ?? "");
  if (url?.pathname === "/" && !url.search && authorization && SESSION_COOKIE.test(cookieName)) {
    return { host: url.host, authUrl: authorization, cookieName };
  }
  console.error("[dashboard] Disabled: configure the HTTPS dashboard origin, authorization URL and a valid session cookie name.");
}

export function isDashboardPath(path: string) {
  return path === DASHBOARD_PATH || path.startsWith(`${DASHBOARD_PATH}/`);
}

function matchesHost(c: Context, config: Settings) {
  return new URL(c.req.url).host === config.host;
}

function sessionCookie(raw: string | undefined, name: string) {
  const entries = raw?.split(";").map((entry) => entry.trim()).filter((entry) => entry.startsWith(`${name}=`));
  return entries?.length === 1 && entries[0].length > name.length + 1 ? entries[0] : undefined;
}

function secureHeaders(c: Context) {
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Cross-Origin-Resource-Policy", "same-origin");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
}

function verifySession(config: Settings, cookie: string, request: { method: string; path: string }) {
  return fetch(config.authUrl, {
    redirect: "manual", signal: AbortSignal.timeout(4000),
    headers: { cookie, "X-Forwarded-Host": config.host, "X-Forwarded-Proto": "https", "X-Forwarded-Method": request.method, "X-Forwarded-URI": request.path },
  });
}

function protect(config: Settings): MiddlewareHandler<DashboardEnv> {
  return async (c, next) => {
    secureHeaders(c);
    if (!matchesHost(c, config)) return c.notFound();
    const cookie = sessionCookie(c.req.header("Cookie"), config.cookieName);
    if (!cookie) return c.json({ error: "Sign in to RetainDB." }, 401);
    const decision = await verifySession(config, cookie, c.req).catch(() => null);
    const allowed = decision?.ok && decision.headers.get("Remote-User")?.trim();
    const status = !decision || decision.status >= 500 ? 503 : decision.status === 403 ? 403 : 401;
    await decision?.body?.cancel().catch(() => {});
    if (!allowed) return c.json({ error: status === 503 ? "Sign-in service unavailable." : "Dashboard access requires a valid session." }, status);
    const groups = decision?.headers.get("Remote-Groups")?.split(",").map((group) => group.trim());
    c.set("dashboardRole", groups?.includes("admins") ? "Administrator" : "Read-only");
    await next();
  };
}

function recordRequests(rows: RequestLog[]): MiddlewareHandler {
  return async (c, next) => {
    const start = performance.now();
    await next();
    const route = matchedRoutes(c)[c.req.routeIndex];
    const template = route?.method === c.req.method && route.path.startsWith(PATH_PREFIX) ? route.path : "Unmatched API route";
    rows.unshift({ at: new Date().toISOString(), method: c.req.method, route: template, status: c.res.status, durationMs: Math.round(performance.now() - start) });
    if (rows.length > LOG_LIMIT) rows.pop();
  };
}

function serveAsset(c: Context, file: keyof typeof CONTENT_TYPES) {
  return readFile(new URL(file, ASSETS), "utf8").then((body) => c.body(body, 200, { "Content-Type": CONTENT_TYPES[file] }));
}

async function serveDashboard(c: Context<DashboardEnv>) {
  const page = await readFile(new URL("index.html", ASSETS), "utf8");
  const role = c.get("dashboardRole");
  return c.html(page.replace("<!-- dashboard-role -->", role).replace('data-admin="false"', `data-admin="${role === "Administrator"}"`));
}

const textParam = (max: number) => z.string().min(1).max(max).refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const projectParam = { project: textParam(120) };
const knowledgeScope = { project: projectParam.project.optional(), scope: z.literal("shared").optional() };
const schemas = {
  overview: z.object(knowledgeScope).strict(),
  graph: z.object({ ...knowledgeScope, q: textParam(120).optional() }).strict(),
  vectors: z.object({ ...knowledgeScope, model: textParam(256).optional() }).strict(),
  queue: z.object(knowledgeScope).strict(),
};

function queryParams(c: Context) {
  const params = new URL(c.req.url).searchParams;
  return [...params].length === new Set(params.keys()).size ? Object.fromEntries(params) : undefined;
}

function projectView(view: keyof typeof schemas) {
  return async (c: Context) => {
    const input = schemas[view].safeParse(queryParams(c));
    if (!input.success) return c.json({ error: "Invalid project or filter." }, 400);
    const { project } = input.data;
    const shared = "scope" in input.data && input.data.scope === "shared";
    if (Boolean(project) === shared) return c.json({ error: "Select a project or shared knowledge." }, 400);
    const data = await import("./engine/dashboard-data.js");
    if (project && !await data.dashboardProject(project)) return c.json({ error: "Project not found." }, 404);
    const result = await data.readDashboardView(view, input.data);
    return result === null
      ? c.json({ code: "EMBEDDING_MODEL_NOT_FOUND", error: "Embedding model not found." }, 404)
      : c.json(result);
  };
}

const rebuildInput = z.object({ ...knowledgeScope, kind: z.enum(["graph", "knowledge"]) }).strict();

function rebuildRoute(config: Settings) {
  return async (c: Context<DashboardEnv>) => {
    if (c.get("dashboardRole") !== "Administrator" || c.req.header("Origin") !== `https://${config.host}`) {
      return c.json({ error: "Rebuilding requires a same-origin administrator session." }, 403);
    }
    if (c.req.header("Content-Type")?.split(";", 1)[0].trim() !== "application/json") {
      return c.json({ error: "Expected JSON." }, 415);
    }
    const input = rebuildInput.safeParse(await c.req.json().catch(() => undefined));
    if (!input.success || Boolean(input.data.project) === (input.data.scope === "shared")) {
      return c.json({ error: "Select a rebuild and either a project or All projects." }, 400);
    }
    return submitRebuild(c, input.data);
  };
}

async function submitRebuild(c: Context, { project, kind }: z.infer<typeof rebuildInput>) {
  const { dashboardProject, OSS_ORG } = await import("./engine/dashboard-data.js");
  if (project && !await dashboardProject(project)) return c.json({ error: "Project not found." }, 404);
  const { enqueueDashboardRebuild, graphRebuildConfigured } = await import("./engine/dashboard-rebuild.js");
  if (kind === "graph" && !graphRebuildConfigured()) return c.json({ error: "Graph extraction provider and model are not configured." }, 503);
  const job = await enqueueDashboardRebuild(OSS_ORG, project, kind);
  if (!job) return c.json({ error: "A rebuild is already queued or running. Open Queue to check its progress." }, 409);
  return c.json(job, 202);
}

function dashboardRoutes(config: Settings, rows: RequestLog[]) {
  const app = new Hono<DashboardEnv>();
  app.use("*", protect(config));
  app.get("/", serveDashboard);
  app.get("/assets/:file", (c) => {
    const file = c.req.param("file");
    if (file === "index.html" || !Object.hasOwn(CONTENT_TYPES, file)) return c.notFound();
    return serveAsset(c, file as keyof typeof CONTENT_TYPES);
  });
  app.get("/data/projects", async (c) => c.json({ projects: await (await import("./engine/dashboard-data.js")).dashboardProjects() }));
  app.get("/data/logs", (c) => c.json({ rows, limit: LOG_LIMIT }));
  app.get("/data/overview", projectView("overview"));
  app.get("/data/graph", projectView("graph"));
  app.get("/data/vectors", projectView("vectors"));
  app.get("/data/queue", projectView("queue"));
  app.post("/rebuilds", rebuildRoute(config));
  app.onError((_error, c) => c.json({ error: "RetainDB could not complete the dashboard request." }, 500));
  return app;
}

export function createDashboard() {
  const config = settings();
  if (!config) return;
  const rows: RequestLog[] = [];
  return {
    routes: dashboardRoutes(config, rows),
    logRequest: recordRequests(rows),
    wantsPage: (c: Context) => matchesHost(c, config) && /(?:^|,)\s*text\/html\b/i.test(c.req.header("Accept") ?? ""),
  };
}
