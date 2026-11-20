import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Hono } from "hono";
import type { AuthContext } from "../src/middleware/auth.js";

const databaseUrl = process.env.RETAINDB_TEST_DATABASE_URL;
const run = databaseUrl ? test : test.skip;
const savedEnvironment = { ...process.env };
if (databaseUrl) {
  process.env.DATABASE_URL = databaseUrl;
}

const adminPath = "../src/api/repo-index-admin.js";
const routerPath = "../src/api/repo-index.js";
const tokenPath = "../src/engine/repo-index/grant-token.js";
const dbPath = "../src/db/index.js";
/** One literal token and its digest, so a change to either side of mint/lookup fails here. */
const KNOWN_TOKEN = "0123456789abcdef0123456789abcdef";
const KNOWN_TOKEN_HASH = "3eb1bd439947eb762998e566ccc2e099c791118b2f40579cc4f7da2b5061b7f9";
/**
 * The admin router builds its Prisma client as it loads, so it needs a well-formed URL even for
 * the checks below that answer before the first query. Nothing reaches this address.
 */
if (!databaseUrl) process.env.DATABASE_URL = "postgresql://admin-test:secret@127.0.0.1:1/unreachable";

/** The org a credential carries. No test sends an org anywhere; production never accepts one. */
const ORG = "default";
/** Header that carries the scope grant token; the scope itself comes from the path. */
const GRANT_HEADER = "X-RetainDB-Repo-Index-Grant";
const scopeIds: string[] = [];
const projectIds: string[] = [];
/** Identity rows this file inserted so a second org's project can exist; removed in `after`. */
const createdOrgIds: string[] = [];
const createdUserIds: string[] = [];

/**
 * The admin router composed the way routes.ts composes it: behind the middleware that sets the
 * credential context. The stub stands in for authMiddleware with a key configured: authType
 * "api_key" and no isAdmin, because this build never sets that flag.
 */
async function adminApp() {
  const { repoIndexAdminRoutes } = await import(adminPath);
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.use("/*", async (c, next) => {
    c.set("auth", { orgId: ORG, authType: "api_key" } satisfies AuthContext);
    await next();
  });
  app.route("/", repoIndexAdminRoutes);
  return app;
}

type AdminApp = Awaited<ReturnType<typeof adminApp>>;

function postInit(body?: unknown): RequestInit {
  const headers = { "content-type": "application/json" };
  if (body === undefined) return { method: "POST", headers };
  return { method: "POST", headers, body: JSON.stringify(body) };
}

async function call(app: AdminApp, path: string, body?: unknown) {
  const response = await app.request(path, postInit(body));
  return { status: response.status, body: (await response.json()) as any };
}

async function dbClient() {
  const { db } = await import(dbPath);
  return db as any;
}

/**
 * A second org cannot exist as a name alone: organizations.ownerId references users(id) and
 * projects.orgId references organizations(id). Creating those rows is what lets the fixture below
 * reach the surface under test instead of failing inside the database.
 */
async function orgFixture(orgId: string) {
  const client = await dbClient();
  const ownerId = `${orgId}-owner`;
  const users = await client.$executeRaw`
    INSERT INTO users (id, email, "updatedAt")
    VALUES (${ownerId}, ${`${ownerId}@example.test`}, NOW())
    ON CONFLICT (id) DO NOTHING`;
  if (users > 0) createdUserIds.push(ownerId);
  const organizations = await client.$executeRaw`
    INSERT INTO organizations (id, name, slug, "ownerId", "updatedAt")
    VALUES (${orgId}, ${orgId}, ${orgId}, ${ownerId}, NOW())
    ON CONFLICT (id) DO NOTHING`;
  if (organizations > 0) createdOrgIds.push(orgId);
}

/** A project the credential's org owns; the surface resolves the body projectId inside that org. */
async function projectFixture(orgId: string = ORG) {
  const client = await dbClient();
  if (orgId !== ORG) await orgFixture(orgId);
  const project = await client.project.create({
    data: { orgId, name: `admin-${randomUUID()}`, slug: `admin-${randomUUID()}` },
  });
  projectIds.push(project.id);
  return project;
}

function scopeBody(projectId: string, id: string = randomUUID()) {
  return {
    projectId,
    repoHost: "github.com",
    repoExternalId: `repo-${id}`,
    worktreePath: `/worktrees/${id}`,
    deviceId: `device-${id}`,
    ref: "refs/heads/main",
    headCommit: "9f1e2d4c7b6a58f30d2e1c0b9a8f7e6d5c4b3a29",
    policyVersion: "policy-1",
    pipelineVersion: "pipeline-1",
  };
}

async function enrolledScope(orgId: string = ORG) {
  const project = await projectFixture(orgId);
  const app = await adminApp();
  const res = await call(app, "/v1/repo-index/admin/scopes", scopeBody(project.id));
  const scopeId = res.body.scope.id;
  scopeIds.push(scopeId);
  return { app, res, scopeId, project };
}

function grantsUrl(scopeId: string) {
  return `/v1/repo-index/admin/scopes/${scopeId}/grants`;
}

function grantRevokeUrl(scopeId: string, grantId: string) {
  return `/v1/repo-index/admin/scopes/${scopeId}/grants/${grantId}/revoke`;
}

function scopeActionUrl(scopeId: string, action: "pause" | "resume" | "withdraw") {
  return `/v1/repo-index/admin/scopes/${scopeId}/${action}`;
}

type FakeScopeRow = { id: string; orgId: string; state: string };

/**
 * A scope table that applies an update only when its WHERE clause matches, like the database does.
 * The optional hook runs after the first read and before the write, which is exactly the window in
 * which a competing request can commit.
 */
function fakeScopeTable(initialState: string, afterFirstRead?: (row: FakeScopeRow) => void) {
  const row: FakeScopeRow = { id: "scope-race", orgId: ORG, state: initialState };
  let reads = 0;
  const store = {
    repoIndexScope: {
      findFirst: async () => {
        const snapshot = { ...row };
        reads += 1;
        if (reads === 1) afterFirstRead?.(row);
        return snapshot;
      },
      updateMany: async ({ where, data }: { where: any; data: { state: string } }) => {
        const filter = where.state;
        const matches =
          filter === undefined
            ? true
            : filter.in
              ? filter.in.includes(row.state)
              : row.state === filter;
        if (!matches) return { count: 0 };
        row.state = data.state;
        return { count: 1 };
      },
    },
  };
  return { row, store };
}

/** Mints one grant and returns the plaintext token the response carried. */
async function mintGrant(app: AdminApp, scopeId: string, kind: string, principal: string) {
  const minted = await call(app, grantsUrl(scopeId), { kind, principal });
  assert.equal(minted.status, 201, JSON.stringify(minted.body));
  return minted.body.token as string;
}

// Behaviour: the only value that reaches the grants table is a digest of the token, so a database
// read can never yield the plaintext a client was handed, and the digest is the one repo-index.ts
// computes when it looks a grant up.
test("a minted token is stored only as the sha256 of its plaintext", async () => {
  const { hashGrantToken, mintGrantToken } = await import(adminPath);
  const minted = mintGrantToken();
  assert.match(minted.token, /^[0-9a-f]{32}$/);
  assert.equal(minted.tokenHash, createHash("sha256").update(minted.token, "utf8").digest("hex"));
  assert.equal(minted.tokenHash, hashGrantToken(minted.token));
  assert.notEqual(minted.tokenHash, minted.token);
});

// Behaviour: two mints never hand out the same credential, because 128 random bits make a
// collision the only way that could happen.
test("two minted tokens differ", async () => {
  const { mintGrantToken } = await import(adminPath);
  assert.notEqual(mintGrantToken().token, mintGrantToken().token);
});

// Behaviour: mint and lookup share one hash, pinned to a literal digest. Moving or editing either
// side of that pair fails here without a database, so the only cross-module proof is not DB-gated.
test("the shared grant-token hash matches a fixed vector", async () => {
  const { hashGrantToken, mintGrantToken } = await import(tokenPath);
  assert.equal(hashGrantToken(KNOWN_TOKEN), KNOWN_TOKEN_HASH);
  const minted = mintGrantToken();
  assert.match(minted.token, /^[0-9a-f]{32}$/);
  assert.equal(minted.tokenHash, hashGrantToken(minted.token));
  const admin = await import(adminPath);
  assert.equal(admin.hashGrantToken, hashGrantToken);
  assert.equal(admin.mintGrantToken, mintGrantToken);
});

// Behaviour: the grant kind is a closed set of capabilities, so an unknown one is refused by the
// validator instead of reaching the table as a kind no route can check.
test("the kind validator rejects an unknown kind", async () => {
  const { grantRequestSchema } = await import(adminPath);
  assert.equal(grantRequestSchema.safeParse({ kind: "owner", principal: "ci" }).success, false);
});

// Behaviour: every documented capability is mappable, including connector, which no route checks
// yet but the grants table documents.
test("every documented grant kind is accepted", async () => {
  const { grantRequestSchema } = await import(adminPath);
  for (const kind of ["reader", "uploader", "connector", "admin"]) {
    assert.equal(grantRequestSchema.safeParse({ kind, principal: "ci" }).success, true, kind);
  }
});

// Behaviour: no credential is minted for a request that never passed the auth middleware, so a
// router mounted without that guard cannot hand out grants.
test("a request that never reached the auth middleware is refused", async () => {
  const { repoIndexAdminRoutes } = await import(adminPath);
  const response = await repoIndexAdminRoutes.request("/v1/repo-index/admin/scopes", postInit(scopeBody("project-1")));
  assert.equal(response.status, 403);
  assert.equal(((await response.json()) as any).error.code, "ADMIN_REQUIRED");
});

// Behaviour: the real app refuses enrolment when the deployment has no credential at all.
// authMiddleware records authType "open" in that case, and this surface mints durable credentials,
// so open access must stop here with 403 rather than reaching validation or a database query.
test("the real app refuses enrolment without a deployment credential", async () => {
  const previousKey = process.env.RETAINDB_API_KEY;
  const previousEncryptionKey = process.env.ENCRYPTION_KEY;
  delete process.env.RETAINDB_API_KEY;
  process.env.ENCRYPTION_KEY ??= "repo-index-admin-test-encryption-key";
  try {
    const { api } = await import("../src/api/routes.js");
    const response = await api.request("/v1/repo-index/admin/scopes", postInit(scopeBody("project-1")));
    assert.equal(response.status, 403);
    assert.equal(((await response.json()) as any).error.code, "ADMIN_REQUIRED");
  } finally {
    if (previousKey === undefined) delete process.env.RETAINDB_API_KEY;
    else process.env.RETAINDB_API_KEY = previousKey;
    if (previousEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = previousEncryptionKey;
  }
});

// Behaviour: an authorised caller reaches the body validator. This is the regression guard for
// anyone who later makes the route require `isAdmin`: this build never sets that flag, so the
// answer would become 403 and enrolment would be unreachable again.
test("the real app lets a credentialed caller reach validation and answers 400", async () => {
  const previousKey = process.env.RETAINDB_API_KEY;
  const previousEncryptionKey = process.env.ENCRYPTION_KEY;
  process.env.RETAINDB_API_KEY = "admin-test-key";
  process.env.ENCRYPTION_KEY ??= "repo-index-admin-test-encryption-key";
  try {
    const { api } = await import("../src/api/routes.js");
    const { worktreePath: _omitted, ...incomplete } = scopeBody("project-1");
    const response = await api.request("/v1/repo-index/admin/scopes", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer admin-test-key" },
      body: JSON.stringify(incomplete),
    });
    assert.equal(response.status, 400);
  } finally {
    if (previousKey === undefined) delete process.env.RETAINDB_API_KEY;
    else process.env.RETAINDB_API_KEY = previousKey;
    if (previousEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = previousEncryptionKey;
  }
});

// Behaviour: minting durable credentials is an admin action even though its path does not start
// with /v1/admin/, so it belongs in the admin telemetry, rate bucket and security flag. authMode
// stays alone on purpose: this build never sets isAdmin, so admin_only would refuse every caller.
test("the admin surface is classified as admin by the route-control matrix", async () => {
  const { buildRouteControlMatrix } = await import("../src/security/route-controls.js");
  const matrix = buildRouteControlMatrix(
    [{ method: "POST", path: "/v1/repo-index/admin/scopes/:scopeId/grants" }],
    "node",
  );
  const control = matrix[0];
  assert.ok(control);
  assert.deepEqual(control.telemetry, ["request", "admin"]);
  assert.equal(control.rateBucket, "admin");
  assert.equal(control.securitySensitive, true);
  assert.equal(control.auditRequired, true);
  assert.equal(control.authMode, "auth_required");
});

// Behaviour: the surface is mounted by routes.ts, so a router registered nowhere cannot keep
// enrolment impossible. This imports the real app, which is the thing that serves every request.
test("the admin surface is mounted on the server app", async () => {
  const previousKey = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY ??= "repo-index-admin-test-encryption-key";
  try {
    const { api } = await import("../src/api/routes.js");
    const routes = ((api as any).routes || []) as Array<{ method: string; path: string }>;
    const mounted = new Set(routes.map((route) => `${route.method} ${route.path}`));
    for (const path of [
      "/v1/repo-index/admin/scopes",
      "/v1/repo-index/admin/scopes/:scopeId/grants",
      "/v1/repo-index/admin/scopes/:scopeId/grants/:grantId/revoke",
      "/v1/repo-index/admin/scopes/:scopeId/pause",
      "/v1/repo-index/admin/scopes/:scopeId/resume",
      "/v1/repo-index/admin/scopes/:scopeId/withdraw",
    ]) {
      assert.equal(mounted.has(`POST ${path}`), true, path);
    }
  } finally {
    if (previousKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = previousKey;
  }
});

// Behaviour: an incomplete enrolment is refused by validation before the handler can write a row.
test("an enrolment without a worktree path is rejected", async () => {
  const app = await adminApp();
  const { worktreePath: _omitted, ...incomplete } = scopeBody("project-1");
  const res = await call(app, "/v1/repo-index/admin/scopes", incomplete);
  assert.equal(res.status, 400);
});

// Behaviour: one worktree has one identity. DNS hosts are case-insensitive and a trailing separator
// does not name a different directory, so the unique key must never see two spellings of the same
// scope. repoExternalId keeps its case: it is the provider's own identifier, not a display name.
test("scope identity is normalised before it reaches the unique key", async () => {
  const { scopeRequestSchema } = await import(adminPath);
  const body = {
    ...scopeBody("project-1"),
    repoHost: "GitHub.COM",
    worktreePath: "/worktrees/w///",
    repoExternalId: "Repo-ABC",
  };
  const parsed = scopeRequestSchema.parse(body);
  assert.equal(parsed.repoHost, "github.com");
  assert.equal(parsed.worktreePath, "/worktrees/w");
  assert.equal(parsed.repoExternalId, "Repo-ABC");
  // A Windows drive root is a root, not a name with a trailing separator.
  assert.equal(scopeRequestSchema.parse({ ...body, worktreePath: "C:\\" }).worktreePath, "C:\\");
  assert.equal(scopeRequestSchema.safeParse({ ...body, worktreePath: "/" }).success, false);
  assert.equal(scopeRequestSchema.safeParse({ ...body, repoHost: "   " }).success, false);
});

// Behaviour: a pause reads active, a withdraw commits, and the pause's write must not put the
// scope back into service as paused. Its fence is the state it read; when that no longer matches,
// the answer comes from the state that actually won.
test("a pause that loses to a withdraw leaves the scope withdrawn", async () => {
  const { applyScopeTransition } = await import(adminPath);
  const { row, store } = fakeScopeTable("active", (scope) => {
    scope.state = "withdrawn";
  });
  const result = await applyScopeTransition(store as any, { orgId: ORG, authType: "api_key" }, row.id, "pause");
  assert.equal(result.code, "PAUSE_REFUSED_WITHDRAWN");
  assert.equal(row.state, "withdrawn");
});

// Behaviour: withdraw is terminal and strictly narrowing, so a pause that commits first cannot
// block the retire.
test("a withdraw still applies when a pause commits first", async () => {
  const { applyScopeTransition } = await import(adminPath);
  const { row, store } = fakeScopeTable("active", (scope) => {
    scope.state = "paused";
  });
  const result = await applyScopeTransition(store as any, { orgId: ORG, authType: "api_key" }, row.id, "withdraw");
  assert.equal(result.code, "WITHDRAW_APPLIED");
  assert.equal(row.state, "withdrawn");
});

// Behaviour: pause cannot resurrect a withdrawn scope either, and the answer says which terminal
// state refused it rather than reporting a transition that did not happen.
test("pausing a withdrawn scope is refused without a write", async () => {
  const { applyScopeTransition } = await import(adminPath);
  const { row, store } = fakeScopeTable("withdrawn");
  const result = await applyScopeTransition(store as any, { orgId: ORG, authType: "api_key" }, row.id, "pause");
  assert.equal(result.code, "PAUSE_REFUSED_WITHDRAWN");
  assert.equal(row.state, "withdrawn");
});

// Behaviour: a state this build does not know is never overwritten. The fence matches nothing and
// the answer reports that the state changed instead of inventing a transition.
test("a scope in an unknown state is not overwritten", async () => {
  const { applyScopeTransition } = await import(adminPath);
  const { row, store } = fakeScopeTable("archived");
  const result = await applyScopeTransition(store as any, { orgId: ORG, authType: "api_key" }, row.id, "pause");
  assert.equal(result.code, "SCOPE_STATE_CHANGED");
  assert.equal(row.state, "archived");
});

// Behaviour: pause is reversible, so resume puts a paused scope back in service.
test("resuming a paused scope makes it active again", async () => {
  const { applyScopeTransition } = await import(adminPath);
  const { row, store } = fakeScopeTable("paused");
  const result = await applyScopeTransition(store as any, { orgId: ORG, authType: "api_key" }, row.id, "resume");
  assert.equal(result.code, "RESUME_APPLIED");
  assert.equal(row.state, "active");
});

// Behaviour: resume cannot undo a withdraw, because withdraw is terminal.
test("resuming a withdrawn scope is refused", async () => {
  const { applyScopeTransition } = await import(adminPath);
  const { row, store } = fakeScopeTable("withdrawn");
  const result = await applyScopeTransition(store as any, { orgId: ORG, authType: "api_key" }, row.id, "resume");
  assert.equal(result.code, "RESUME_REFUSED_WITHDRAWN");
  assert.equal(row.state, "withdrawn");
});

// Behaviour: resuming an active scope changes nothing and says so, so a retried resume is safe.
test("resuming an active scope reports that it is already active", async () => {
  const { applyScopeTransition } = await import(adminPath);
  const { row, store } = fakeScopeTable("active");
  const result = await applyScopeTransition(store as any, { orgId: ORG, authType: "api_key" }, row.id, "resume");
  assert.equal(result.code, "RESUME_ALREADY_APPLIED");
  assert.equal(row.state, "active");
});

// Behaviour: one call enrols a worktree into an active scope at generation zero, owned by the org
// the credential carries rather than by anything in the request.
run("enrolling a worktree creates an active scope at generation zero", async () => {
  const { res, scopeId } = await enrolledScope();
  assert.equal(res.status, 201);
  assert.equal(res.body.code, "SCOPE_CREATED");
  const scope = await (await dbClient()).repoIndexScope.findUnique({ where: { id: scopeId } });
  assert.equal(scope.state, "active");
  assert.equal(scope.activeGeneration, 0);
  assert.equal(scope.orgId, ORG);
});

// Behaviour: the unique (orgId, repoHost, repoExternalId, worktreePath) is reported as a duplicate
// outcome instead of escaping as a server error, and the first scope keeps standing.
run("enrolling the same worktree twice is refused as a duplicate", async () => {
  const project = await projectFixture();
  const body = scopeBody(project.id);
  const app = await adminApp();
  const first = await call(app, "/v1/repo-index/admin/scopes", body);
  assert.equal(first.status, 201);
  scopeIds.push(first.body.scope.id);
  const second = await call(app, "/v1/repo-index/admin/scopes", body);
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, "SCOPE_DUPLICATE");
  // The refusal names the row that owns the identity, not just the fact of a conflict.
  assert.equal(second.body.error.scope.id, first.body.scope.id);
  assert.equal(second.body.error.scope.state, "active");
});

// Behaviour: a paused scope still owns its identity, and the refusal names it so the caller can
// resume or withdraw that row instead of guessing. Re-spelling the host and trailing the path also
// proves the identity was normalised before the duplicate check.
run("a duplicate enrolment reports the paused scope that blocks it", async () => {
  const project = await projectFixture();
  const body = scopeBody(project.id);
  const app = await adminApp();
  const first = await call(app, "/v1/repo-index/admin/scopes", body);
  assert.equal(first.status, 201);
  scopeIds.push(first.body.scope.id);
  await call(app, scopeActionUrl(first.body.scope.id, "pause"));
  const second = await call(app, "/v1/repo-index/admin/scopes", {
    ...body,
    repoHost: "GitHub.COM",
    worktreePath: `${body.worktreePath}//`,
  });
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, "SCOPE_DUPLICATE");
  assert.equal(second.body.error.scope.id, first.body.scope.id);
  assert.equal(second.body.error.scope.state, "paused");
});

// Behaviour: a body projectId only selects a project inside the credential's org, so another org's
// project is refused exactly like a missing one.
run("an enrolment naming another org's project is refused", async () => {
  const foreign = await projectFixture("someone-else");
  const app = await adminApp();
  const res = await call(app, "/v1/repo-index/admin/scopes", scopeBody(foreign.id));
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, "PROJECT_NOT_FOUND");
});

// Behaviour: minting hands the plaintext back once and persists only its hash, so nothing read
// from the table can be replayed as a credential.
run("minting a grant returns the plaintext once and stores only its hash", async () => {
  const { app, scopeId } = await enrolledScope();
  const minted = await call(app, grantsUrl(scopeId), { kind: "reader", principal: "ci-reader" });
  assert.equal(minted.status, 201);
  assert.equal(minted.body.code, "GRANT_CREATED");
  assert.match(minted.body.token, /^[0-9a-f]{32}$/);
  const row = await (await dbClient()).repoIndexGrant.findFirst({ where: { scopeId, principal: "ci-reader" } });
  assert.equal(row.kind, "reader");
  assert.equal(row.tokenHash, createHash("sha256").update(minted.body.token, "utf8").digest("hex"));
  assert.notEqual(row.tokenHash, minted.body.token);
  assert.equal(JSON.stringify(row).includes(minted.body.token), false);
});

// Behaviour: the hash this surface stores is the one repo-index.ts looks up, proved by the real
// router resolving the minted token instead of refusing it as missing.
run("a minted token resolves the grant the repo-index router looks up", async () => {
  const { app, scopeId } = await enrolledScope();
  const token = await mintGrant(app, scopeId, "reader", "ci-reader");
  const { repoIndexRoutes } = await import(routerPath);
  const url = `/v1/repo-index/scopes/${scopeId}/manifest`;
  const granted = await repoIndexRoutes.request(url, { headers: { [GRANT_HEADER]: token } });
  // The scope has published no generation, so a granted caller stops at that and not at the grant.
  assert.equal(granted.status, 404);
  assert.equal(((await granted.json()) as any).error.code, "NO_GENERATION_PUBLISHED");
  const anonymous = await repoIndexRoutes.request(url, {});
  assert.equal(anonymous.status, 403);
  assert.equal(((await anonymous.json()) as any).error.code, "GRANT_MISSING");
});

// Behaviour: one live capability per principal, so a repeated mint is refused instead of rotating a
// credential another holder may still be using. The refusal names the live grant that holds it.
run("minting the same kind for the same principal twice is refused", async () => {
  const { app, scopeId } = await enrolledScope();
  await mintGrant(app, scopeId, "uploader", "ci-uploader");
  const live = await (await dbClient()).repoIndexGrant.findFirst({
    where: { scopeId, principal: "ci-uploader", revokedAt: null },
  });
  const second = await call(app, grantsUrl(scopeId), { kind: "uploader", principal: "ci-uploader" });
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, "GRANT_DUPLICATE");
  assert.equal(second.body.error.grant.id, live.id);
});

// Behaviour: a paused scope accepts nothing, including new credentials.
run("a grant cannot be minted for a paused scope", async () => {
  const { app, scopeId } = await enrolledScope();
  await call(app, scopeActionUrl(scopeId, "pause"));
  const refused = await call(app, grantsUrl(scopeId), { kind: "reader", principal: "ci-reader" });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, "SCOPE_NOT_ACTIVE");
});

// Behaviour: a withdrawn scope accepts nothing either, and says so as not active.
run("a grant cannot be minted for a withdrawn scope", async () => {
  const { app, scopeId } = await enrolledScope();
  await call(app, scopeActionUrl(scopeId, "withdraw"));
  const refused = await call(app, grantsUrl(scopeId), { kind: "reader", principal: "ci-reader" });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, "SCOPE_NOT_ACTIVE");
});

// Behaviour: revoking stamps revokedAt and the token stops resolving on the router that reads it.
run("revoking a grant stamps revokedAt and its token stops resolving", async () => {
  const { app, scopeId } = await enrolledScope();
  const token = await mintGrant(app, scopeId, "reader", "ci-reader");
  const grant = await (await dbClient()).repoIndexGrant.findFirst({ where: { scopeId, principal: "ci-reader" } });
  const revoked = await call(app, grantRevokeUrl(scopeId, grant.id));
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.code, "GRANT_REVOKED");
  const row = await (await dbClient()).repoIndexGrant.findUnique({ where: { id: grant.id } });
  assert.equal(row.revokedAt instanceof Date, true);
  const { repoIndexRoutes } = await import(routerPath);
  const denied = await repoIndexRoutes.request(`/v1/repo-index/scopes/${scopeId}/manifest`, {
    headers: { [GRANT_HEADER]: token },
  });
  assert.equal(denied.status, 403);
  assert.equal(((await denied.json()) as any).error.code, "GRANT_MISSING");
});

// Behaviour: revoking twice is not an error, because a retried revoke must not fail the caller.
run("revoking the same grant twice is not an error", async () => {
  const { app, scopeId } = await enrolledScope();
  await mintGrant(app, scopeId, "reader", "ci-reader");
  const grant = await (await dbClient()).repoIndexGrant.findFirst({ where: { scopeId, principal: "ci-reader" } });
  const first = await call(app, grantRevokeUrl(scopeId, grant.id));
  assert.equal(first.status, 200);
  assert.equal(first.body.code, "GRANT_REVOKED");
  const second = await call(app, grantRevokeUrl(scopeId, grant.id));
  assert.equal(second.status, 200);
  assert.equal(second.body.code, "GRANT_ALREADY_REVOKED");
});

// Behaviour: revoking a leaked token does not burn the principal's slot forever. The replacement
// is a new live row, the revoked row stays as history, and the old token stays dead.
run("a revoked grant can be replaced for the same principal", async () => {
  const { app, scopeId } = await enrolledScope();
  const firstToken = await mintGrant(app, scopeId, "reader", "ci-reader");
  const first = await (await dbClient()).repoIndexGrant.findFirst({ where: { scopeId, principal: "ci-reader" } });
  const revoked = await call(app, grantRevokeUrl(scopeId, first.id));
  assert.equal(revoked.status, 200);
  const replacement = await call(app, grantsUrl(scopeId), { kind: "reader", principal: "ci-reader" });
  assert.equal(replacement.status, 201, JSON.stringify(replacement.body));
  assert.equal(replacement.body.code, "GRANT_CREATED");
  assert.notEqual(replacement.body.token, firstToken);
  const rows = await (await dbClient()).repoIndexGrant.findMany({
    where: { scopeId, principal: "ci-reader" },
    orderBy: { createdAt: "asc" },
  });
  assert.equal(rows.length, 2);
  assert.equal(rows.filter((row: any) => row.revokedAt === null).length, 1);
  const { repoIndexRoutes } = await import(routerPath);
  const old = await repoIndexRoutes.request(`/v1/repo-index/scopes/${scopeId}/manifest`, {
    headers: { [GRANT_HEADER]: firstToken },
  });
  assert.equal(old.status, 403);
  assert.equal(((await old.json()) as any).error.code, "GRANT_MISSING");
  const fresh = await repoIndexRoutes.request(`/v1/repo-index/scopes/${scopeId}/manifest`, {
    headers: { [GRANT_HEADER]: replacement.body.token },
  });
  assert.equal(fresh.status, 404);
  assert.equal(((await fresh.json()) as any).error.code, "NO_GENERATION_PUBLISHED");
});

// Behaviour: revoking an unknown grant of a real scope is a refusal, not a write.
run("revoking a grant that does not exist is refused", async () => {
  const { app, scopeId } = await enrolledScope();
  const res = await call(app, grantRevokeUrl(scopeId, randomUUID()));
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, "GRANT_NOT_FOUND");
});

// Behaviour: pausing is the reversible stop, and it takes an active scope out of service.
run("pausing an active scope makes it paused", async () => {
  const { app, scopeId } = await enrolledScope();
  const res = await call(app, scopeActionUrl(scopeId, "pause"));
  assert.equal(res.status, 200);
  assert.equal(res.body.code, "PAUSE_APPLIED");
  const scope = await (await dbClient()).repoIndexScope.findUnique({ where: { id: scopeId } });
  assert.equal(scope.state, "paused");
});

// Behaviour: pausing twice ends in the same state, so a retried pause is not an error.
run("pausing twice reports that the scope is already paused", async () => {
  const { app, scopeId } = await enrolledScope();
  await call(app, scopeActionUrl(scopeId, "pause"));
  const second = await call(app, scopeActionUrl(scopeId, "pause"));
  assert.equal(second.status, 200);
  assert.equal(second.body.code, "PAUSE_ALREADY_APPLIED");
});

// Behaviour: resume is the documented way back from pause, so "reversible" is true at the boundary
// a caller actually uses rather than only in the comment.
run("resuming a paused scope makes it active", async () => {
  const { app, scopeId } = await enrolledScope();
  await call(app, scopeActionUrl(scopeId, "pause"));
  const res = await call(app, scopeActionUrl(scopeId, "resume"));
  assert.equal(res.status, 200);
  assert.equal(res.body.code, "RESUME_APPLIED");
  const scope = await (await dbClient()).repoIndexScope.findUnique({ where: { id: scopeId } });
  assert.equal(scope.state, "active");
});

// Behaviour: resuming an already active scope changes nothing, so a retried resume is not an error.
run("resuming an active scope reports that it is already active", async () => {
  const { app, scopeId } = await enrolledScope();
  const res = await call(app, scopeActionUrl(scopeId, "resume"));
  assert.equal(res.status, 200);
  assert.equal(res.body.code, "RESUME_ALREADY_APPLIED");
});

// Behaviour: resume cannot undo the terminal state either.
run("resuming a withdrawn scope is refused and leaves it withdrawn", async () => {
  const { app, scopeId } = await enrolledScope();
  await call(app, scopeActionUrl(scopeId, "withdraw"));
  const refused = await call(app, scopeActionUrl(scopeId, "resume"));
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, "RESUME_REFUSED_WITHDRAWN");
  const scope = await (await dbClient()).repoIndexScope.findUnique({ where: { id: scopeId } });
  assert.equal(scope.state, "withdrawn");
});

// Behaviour: withdraw is terminal and strictly narrowing, so it is allowed from paused as well as
// from active; a paused scope can still be retired.
run("withdrawing a paused scope retires it", async () => {
  const { app, scopeId } = await enrolledScope();
  await call(app, scopeActionUrl(scopeId, "pause"));
  const res = await call(app, scopeActionUrl(scopeId, "withdraw"));
  assert.equal(res.status, 200);
  assert.equal(res.body.code, "WITHDRAW_APPLIED");
  const scope = await (await dbClient()).repoIndexScope.findUnique({ where: { id: scopeId } });
  assert.equal(scope.state, "withdrawn");
});

// Behaviour: the withdrawn state cannot be undone, so a later pause is refused and the scope stays
// withdrawn instead of quietly becoming serviceable again.
run("pausing a withdrawn scope is refused and leaves it withdrawn", async () => {
  const { app, scopeId } = await enrolledScope();
  await call(app, scopeActionUrl(scopeId, "withdraw"));
  const refused = await call(app, scopeActionUrl(scopeId, "pause"));
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, "PAUSE_REFUSED_WITHDRAWN");
  const scope = await (await dbClient()).repoIndexScope.findUnique({ where: { id: scopeId } });
  assert.equal(scope.state, "withdrawn");
});

// Behaviour: withdrawing twice ends in the same state, so a retried withdraw is not an error.
run("withdrawing twice reports that the scope is already withdrawn", async () => {
  const { app, scopeId } = await enrolledScope();
  await call(app, scopeActionUrl(scopeId, "withdraw"));
  const second = await call(app, scopeActionUrl(scopeId, "withdraw"));
  assert.equal(second.status, 200);
  assert.equal(second.body.code, "WITHDRAW_ALREADY_APPLIED");
});

// Behaviour: a scope belonging to another org is invisible here, so the path parameter cannot be
// used to pause someone else's repository.
run("a scope from another org is not found", async () => {
  const project = await projectFixture("someone-else");
  const client = await dbClient();
  const scope = await client.repoIndexScope.create({ data: { ...scopeBody(project.id), orgId: "someone-else" } });
  scopeIds.push(scope.id);
  const app = await adminApp();
  const res = await call(app, scopeActionUrl(scope.id, "pause"));
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, "SCOPE_NOT_FOUND");
  const row = await client.repoIndexScope.findUnique({ where: { id: scope.id } });
  assert.equal(row.state, "active");
});

after(async () => {
  if (!databaseUrl) return;
  const client = await dbClient();
  if (scopeIds.length > 0) await client.repoIndexScope.deleteMany({ where: { id: { in: scopeIds } } });
  if (projectIds.length > 0) await client.project.deleteMany({ where: { id: { in: projectIds } } });
  // Organizations first: organizations.ownerId references users(id) with ON DELETE RESTRICT.
  for (const orgId of createdOrgIds) await client.$executeRaw`DELETE FROM organizations WHERE id = ${orgId}`;
  for (const ownerId of createdUserIds) await client.$executeRaw`DELETE FROM users WHERE id = ${ownerId}`;
  await client.$disconnect();
  process.env = savedEnvironment;
});
