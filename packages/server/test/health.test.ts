import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReadinessReport } from "../src/health.js";

const origin = "https://retaindb.example.test";

async function appWith(readinessCheck: () => Promise<ReadinessReport>) {
  const { createNodeApp } = await import("../src/api/app.js");
  return createNodeApp({ includeApiRoutes: false, readinessCheck });
}

function report(status: "ok" | "degraded" | "unhealthy", database: "ok" | "down", embeddings: "ok" | "warming" | "failed" | "not_required"): ReadinessReport {
  return {
    status,
    checks: {
      database: { status: database, latencyMs: 4 },
      embeddings: { status: embeddings, mode: "local", model: "Xenova/multilingual-e5-large" },
    },
    uptimeSeconds: 12,
  };
}

test("the readiness endpoint reports healthy only when every dependency is ready", async () => {
  const app = await appWith(async () => report("ok", "ok", "ok"));
  const response = await app.request(`${origin}/health`);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.status, "ok");
  assert.equal(body.checks.database.status, "ok");
  assert.equal(body.checks.embeddings.status, "ok");
});

test("a degraded dependency is served as 503 with the reason instead of a success", async () => {
  const app = await appWith(async () => report("degraded", "ok", "warming"));
  const response = await app.request(`${origin}/health`);

  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.status, "degraded");
  assert.equal(body.checks.embeddings.status, "warming");
});

test("an unreachable database makes readiness unhealthy and blocks traffic", async () => {
  const app = await appWith(async () => report("unhealthy", "down", "ok"));
  const response = await app.request(`${origin}/health`);

  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.status, "unhealthy");
  assert.equal(body.checks.database.status, "down");
});

test("liveness stays green while readiness fails, so a dependency outage does not restart the process", async () => {
  const app = await appWith(async () => report("unhealthy", "down", "failed"));
  const live = await app.request(`${origin}/livez`);
  const ready = await app.request(`${origin}/health`);

  assert.equal(live.status, 200);
  assert.deepEqual(await live.json(), { status: "ok" });
  assert.equal(ready.status, 503);
});

test("a readiness check that throws is reported as unhealthy rather than an internal error", async () => {
  const app = await appWith(async () => { throw new Error("probe exploded"); });
  const response = await app.request(`${origin}/health`);

  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.status, "unhealthy");
  assert.match(body.checks.database.status, /down/);
});
