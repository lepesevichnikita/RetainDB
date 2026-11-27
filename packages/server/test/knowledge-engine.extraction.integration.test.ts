import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import OpenAI from "openai";

const databaseUrl = process.env.RETAINDB_TEST_DATABASE_URL;
const run = databaseUrl ? test : test.skip;
const vector = [1, ...Array<number>(1023).fill(0)];
const inferenceUrl = "https://extraction-claims-fixture.invalid";
const model = "extraction-claims-model";
const credential = randomUUID();
const content = "Verify the snapshot checksum before restoring database partitions. ".repeat(5);

if (databaseUrl) {
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl, RETAINDB_API_KEY: credential, ENCRYPTION_KEY: credential,
    EMBEDDING_MODE: "remote", EMBEDDING_INFERENCE_BASE_URL: inferenceUrl,
    REMOTE_INFERENCE_REQUIRED: "true", DISABLE_AUTO_EXTRACTION: "false",
    ALERT_EMAIL_ENABLED: "false", OPENAI_API_KEY: "synthetic-extraction-fixture",
  });
}

// One entity carries a model confidence, the other omits it (extracted prior = 0.6); the edge has its own.
const claims = {
  entities: [
    { name: "Snapshot", type: "concept", description: "A database snapshot", confidence: 0.9 },
    { name: "Checksum", type: "concept", description: "A verification checksum" },
  ],
  relations: [{ from: "Snapshot", fromType: "concept", to: "Checksum", toType: "concept", relation: "references", confidence: 0.75 }],
};

function offlineInference(t: TestContext) {
  t.mock.method(OpenAI.Chat.Completions.prototype, "create", async () => ({
    choices: [{ finish_reason: "stop", message: { content: JSON.stringify(claims) } }],
  }));
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, options?: RequestInit) => {
    assert.equal(String(url), `${inferenceUrl}/v1/inference/embeddings`);
    const { inputs } = JSON.parse(String(options?.body)) as { inputs: string[] };
    return Response.json({ embeddings: inputs.map(() => vector), model });
  });
}

async function fixture(t: TestContext) {
  offlineInference(t);
  const { db } = await import("../src/db/index.js");
  const { api } = await import("../src/api/routes.js");
  const name = `extraction-${randomUUID()}`;
  const project = await db.project.create({ data: { name, slug: name, orgId: "default" } });
  t.after(async () => { await db.project.delete({ where: { id: project.id } }); });
  const headers = { "content-type": "application/json", authorization: `Bearer ${credential}` };
  const response = () => api.request("/v1/learn", {
    method: "POST", headers,
    body: JSON.stringify({ project: project.id, mode: "text", title: "Restore", content, options: { async: false, strategy_override: "fixed" } }),
  });
  return { db, project, learn: response };
}

type ExtractionFixture = Awaited<ReturnType<typeof fixture>>;

async function awaitClaims(f: ExtractionFixture) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const rows = await f.db.claim.findMany({ where: { evidence: { source: { projectId: f.project.id } } } });
    if (rows.length >= 3) return rows;
    await delay(75);
  }
  return [];
}

run("extraction stores one evidence row per chunk and a claim per entity and relation", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.learn()).status, 200);
  const stored = await awaitClaims(f);
  assert.equal(stored.length, 3);

  const [evidence] = await f.db.evidence.findMany({ where: { source: { projectId: f.project.id } } });
  // The digest a claim points at is exactly the stored chunk's content hash, so the claim stays active.
  const chunks = await f.db.chunk.findMany({ where: { document: { projectId: f.project.id } } });
  assert.equal(chunks.filter((chunk) => chunk.contentHash === evidence.contentDigest).length, 1);
  assert.equal(evidence.text, chunks.find((chunk) => chunk.contentHash === evidence.contentDigest)?.content);

  const entities = await f.db.entity.findMany({ where: { projectId: f.project.id }, orderBy: { name: "asc" } });
  assert.deepEqual(entities.map(({ name }) => name), ["Checksum", "Snapshot"]);
  const byName = new Map(entities.map((entity) => [entity.name, entity.id]));
  const claimOf = (id: string) => stored.find((claim) => claim.entityId === id || claim.relationId === id);
  assert.equal(claimOf(byName.get("Snapshot")!)?.confidence, 0.9);
  assert.equal(claimOf(byName.get("Snapshot")!)?.origin, "extracted");
  assert.equal(claimOf(byName.get("Checksum")!)?.confidence, 0.6);

  const [relation] = await f.db.entityRelation.findMany({ where: { projectId: f.project.id } });
  assert.equal(claimOf(relation.id)?.confidence, 0.75);
  assert.equal(claimOf(relation.id)?.origin, "extracted");
  assert.equal(stored.filter((claim) => claim.evidenceId === evidence.id).length, 3);

  // Manual weight is untouched by extraction.
  assert.equal(relation.weight, 1);
});
