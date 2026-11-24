/**
 * The database probe has to fail fast and honestly: a monitor that hangs or
 * reports success while PostgreSQL is unreachable is what made the cluster
 * look healthy during the outage.
 */
process.env.DATABASE_URL = "postgresql://retaindb_unused@127.0.0.1:1/retaindb_unused";
process.env.EMBEDDING_MODE = "openai";

import assert from "node:assert/strict";
import { test } from "node:test";

test("an unreachable database is reported unhealthy within the probe budget", async () => {
  const { readReadiness } = await import("../src/health.js");
  const started = Date.now();
  const report = await readReadiness();

  assert.equal(report.status, "unhealthy");
  assert.equal(report.checks.database.status, "down");
  assert.equal(report.checks.embeddings.status, "not_required");
  assert.ok(Date.now() - started < 5_000, "the probe must not wait on Prisma's pool timeout");
});

test("the served health response is a 503 carrying the failing dependency", async () => {
  const { createNodeApp } = await import("../src/api/app.js");
  const response = await createNodeApp({ includeApiRoutes: false }).request("https://retaindb.example.test/health");

  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.status, "unhealthy");
  assert.equal(body.checks.database.status, "down");
});

test("repeated probes share one in-flight database check instead of filling the pool", async () => {
  const { readReadiness } = await import("../src/health.js");
  const reports = await Promise.all(Array.from({ length: 8 }, () => readReadiness()));

  assert.equal(reports.length, 8);
  for (const report of reports) assert.equal(report.checks.database.status, "down");
});
