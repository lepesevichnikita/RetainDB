import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";
import {
  assertRouteControlCoverage,
  buildRouteControlMatrix,
} from "../src/security/route-controls.js";

// The real app is imported below, so PrismaClient must be constructible. Nothing connects: coverage
// reads the router's registered route table and never touches the database.
const savedDatabaseUrl = process.env.DATABASE_URL;
const savedEncryptionKey = process.env.ENCRYPTION_KEY;
process.env.DATABASE_URL = "postgresql://localhost:1/retaindb_unused";
process.env.ENCRYPTION_KEY = randomBytes(32).toString("hex");

after(async () => {
  const { db } = await import("../src/db/index.js");
  await db.$disconnect();
  if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedDatabaseUrl;
  if (savedEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = savedEncryptionKey;
});

// Behaviour: the assertion is satisfied by the app it protects, so the reviewed inventory is not
// drifting away from the server's real route table.
test("the real app's registered routes all carry a reviewed control", async () => {
  const { api } = await import("../src/api/routes.js");
  const routes = ((api as any).routes || []) as Array<{ method: string; path: string }>;
  const matrix = buildRouteControlMatrix(routes, "node");
  assert.ok(routes.length > 0, "the server must register routes");
  assert.doesNotThrow(() => assertRouteControlCoverage(matrix, routes, "node"));
});

// Behaviour: a route the matrix was built from is not automatically covered. Until the route has a
// reviewed entry, coverage fails: adding a route cannot silently ship without a control.
test("a route with no reviewed entry is reported even though the matrix contains it", () => {
  const routes = [{ method: "GET", path: "/v1/unreviewed-surface" }];
  const matrix = buildRouteControlMatrix(routes, "node");
  assert.equal(matrix.length, 1, "the matrix is built from the same route, so it does contain a control");
  assert.throws(
    () => assertRouteControlCoverage(matrix, routes, "node"),
    /undeclared route GET \/v1\/unreviewed-surface/
  );
});

// Behaviour: a reviewed route whose control never reached the matrix is reported. This is the case
// the previous assertion could not see, because it compared the matrix with the list it came from.
test("a reviewed route with no control in the matrix is reported", () => {
  const routes = [
    { method: "GET", path: "/v1/projects" },
    { method: "GET", path: "/v1/sources" },
  ];
  const matrix = buildRouteControlMatrix([{ method: "GET", path: "/v1/projects" }], "node");
  assert.throws(
    () => assertRouteControlCoverage(matrix, routes, "node"),
    /no control for GET \/v1\/sources/
  );
});

// Behaviour: a control whose classification drifted from its reviewed entry is reported, so a
// mis-derived control cannot pass as covered just because some control exists for the path.
test("a control classified differently from its reviewed entry is reported", () => {
  const routes = [{ method: "GET", path: "/v1/projects" }];
  const [control] = buildRouteControlMatrix(routes, "node");
  assert.equal(control.authMode, "auth_required", "the reviewed classification of this route");
  const drifted = [{ ...control, authMode: "admin_only" as const }];
  assert.throws(
    () => assertRouteControlCoverage(drifted, routes, "node"),
    /GET \/v1\/projects is classified admin_only, reviewed as auth_required/
  );
});

// Behaviour: the inventory is pinned in both directions, so removing a route forces its reviewed
// entry to be removed too instead of leaving a declaration no route serves.
test("a reviewed route the router no longer serves is reported", () => {
  const matrix = buildRouteControlMatrix([{ method: "GET", path: "/v1/projects" }], "node");
  assert.throws(
    () => assertRouteControlCoverage(matrix, [], "node"),
    /reviewed route not served GET \/v1\/projects/
  );
});
