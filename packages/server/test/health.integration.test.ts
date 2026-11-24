import assert from "node:assert/strict";
import { after, test } from "node:test";

const databaseUrl = process.env.RETAINDB_TEST_DATABASE_URL;
const run = databaseUrl ? test : test.skip;

if (databaseUrl) {
  process.env.DATABASE_URL = databaseUrl;
  process.env.EMBEDDING_MODE = "openai";
}

after(async () => {
  if (databaseUrl) await (await import("../src/db/index.js")).db.$disconnect();
});

run("a migrated database is reported ready and served as 200", async () => {
  const { readReadiness } = await import("../src/health.js");
  const report = await readReadiness();

  assert.equal(report.status, "ok");
  assert.equal(report.checks.database.status, "ok");
  assert.ok(report.checks.database.latencyMs >= 0);
  assert.equal(report.checks.embeddings.status, "not_required");

  const { createNodeApp } = await import("../src/api/app.js");
  const response = await createNodeApp({ includeApiRoutes: false }).request("https://retaindb.example.test/health");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "ok");
});
