import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";

const databaseUrl = process.env.RETAINDB_TEST_DATABASE_URL;
const run = databaseUrl ? test : test.skip;
const inferenceUrl = "https://traversal-fixture.invalid";
const credential = randomUUID();

if (databaseUrl) {
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl, RETAINDB_API_KEY: credential, ENCRYPTION_KEY: credential,
    EMBEDDING_MODE: "remote", EMBEDDING_INFERENCE_BASE_URL: inferenceUrl,
    REMOTE_INFERENCE_REQUIRED: "true", DISABLE_AUTO_EXTRACTION: "true",
    ALERT_EMAIL_ENABLED: "false", OPENAI_API_KEY: "synthetic-traversal-fixture",
  });
}

/** Distinct one-hot vectors per text, so only a name match can seed the traversal. */
function oneHot(text: string) {
  const index = [...text].reduce((sum, char) => (sum + char.charCodeAt(0)) % 1024, 0);
  return Array.from({ length: 1024 }, (_, position) => (position === index ? 1 : 0));
}

function offlineInference(t: TestContext) {
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, options?: RequestInit) => {
    assert.equal(String(url), `${inferenceUrl}/v1/inference/embeddings`);
    const { inputs } = JSON.parse(String(options?.body)) as { inputs: string[] };
    return Response.json({ embeddings: inputs.map(oneHot), model: "traversal-fixture-model" });
  });
}

const entity = (name: string) => ({ name, entityType: "concept", description: `${name} node` });

const graph = {
  entities: [entity("Snapshot"), entity("Checksum"), entity("Ledger"), entity("Outsider"), entity("Related")],
  relations: [
    { from: entity("Snapshot"), to: entity("Checksum"), type: "depends_on" as const, confidence: 1 },
    { from: entity("Checksum"), to: entity("Ledger"), type: "depends_on" as const, confidence: 1 },
    { from: entity("Snapshot"), to: entity("Ledger"), type: "depends_on" as const, confidence: 0.5 },
    { from: entity("Outsider"), to: entity("Snapshot"), type: "depends_on" as const, confidence: 1 },
    { from: entity("Snapshot"), to: entity("Related"), type: "related_to" as const, confidence: 1 },
  ],
};

async function fixture(t: TestContext) {
  offlineInference(t);
  const { db } = await import("../src/db/index.js");
  const { api } = await import("../src/api/routes.js");
  const name = `traversal-${randomUUID()}`;
  const project = await db.project.create({ data: { name, slug: name, orgId: "default" } });
  t.after(async () => { await db.project.delete({ where: { id: project.id } }); });
  const source = await db.source.create({ data: { projectId: project.id, name: `${name}-source`, type: "text", status: "READY" } });
  const { importSourceVersion } = await import("../src/engine/knowledge/import.js");
  await importSourceVersion({
    sourceId: source.id, projectId: project.id,
    documents: [{
      externalId: "traversal.md", title: "Traversal", path: "docs/traversal.md",
      content: "Snapshot service note about restore procedures. ".repeat(8), graph,
    }],
  });
  const response = await api.request("/v1/graph/search", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${credential}` },
    body: JSON.stringify({ project: project.id, query: "snapshot", depth: 2, top_k: 1 }),
  });
  return { db, project, response };
}

run("traversal follows directed edges forward, crosses symmetric edges both ways and keeps the best path", async (t) => {
  const { response } = await fixture(t);
  assert.equal(response.status, 200);
  const body = await response.json() as { entities: { name: string; score: number }[] };
  const byName = new Map(body.entities.map(({ name, score }) => [name, score]));
  const scores = [...byName.values()];

  assert.equal(byName.get("Snapshot"), 1);
  // One hop at lambda 0.7 over a confidence-1 edge.
  assert.equal(byName.get("Checksum"), 0.7);
  assert.equal(byName.get("Related"), 0.7);
  // Two hops of confidence 1 beat the direct confidence-0.5 edge: 0.7*0.7 = 0.49 > 0.5*0.7 = 0.35.
  assert.equal(byName.get("Ledger"), 0.49);
  // A directed edge pointing into the seed is never followed backwards.
  assert.equal(byName.has("Outsider"), false);
  // Seeds and path scores stay inside [0, 1].
  assert.deepEqual(scores.filter((score) => score > 1 || score < 0), []);
});
