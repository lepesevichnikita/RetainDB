import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";

const databaseUrl = process.env.RETAINDB_TEST_DATABASE_URL;
const run = databaseUrl ? test : test.skip;
const vector = [1, ...Array<number>(1023).fill(0)];
const inferenceUrl = "https://import-fixture.invalid";
const credential = randomUUID();

if (databaseUrl) {
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl, RETAINDB_API_KEY: credential, ENCRYPTION_KEY: credential,
    EMBEDDING_MODE: "remote", EMBEDDING_INFERENCE_BASE_URL: inferenceUrl,
    REMOTE_INFERENCE_REQUIRED: "true", DISABLE_AUTO_EXTRACTION: "true",
    ALERT_EMAIL_ENABLED: "false", OPENAI_API_KEY: "synthetic-import-fixture",
  });
}

const graph = {
  entities: [
    { name: "Snapshot", entityType: "concept", description: "A database snapshot" },
    { name: "Checksum", entityType: "concept", description: "A verification checksum" },
  ],
  relations: [{ from: { name: "Snapshot", entityType: "concept" }, to: { name: "Checksum", entityType: "concept" }, type: "references" as const }],
};

function offlineInference(t: TestContext) {
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, options?: RequestInit) => {
    assert.equal(String(url), `${inferenceUrl}/v1/inference/embeddings`);
    const { inputs } = JSON.parse(String(options?.body)) as { inputs: string[] };
    return Response.json({ embeddings: inputs.map(() => vector), model: "import-fixture-model" });
  });
}

async function fixture(t: TestContext) {
  offlineInference(t);
  const { db } = await import("../src/db/index.js");
  const name = `import-${randomUUID()}`;
  const project = await db.project.create({ data: { name, slug: name, orgId: "default" } });
  t.after(async () => { await db.project.delete({ where: { id: project.id } }); });
  const source = await db.source.create({ data: { projectId: project.id, name: `${name}-source`, type: "text", status: "READY" } });
  return { db, project, source };
}

type ImportFixture = Awaited<ReturnType<typeof fixture>>;

const document = (content: string) => ({
  externalId: "restore.md", title: "Restore", content, path: "docs/restore.md", url: "https://example.test/restore", graph,
});

async function evidenceFor(f: ImportFixture, relationId: string) {
  const { relationEvidence } = await import("../src/engine/knowledge/claims.js");
  return (await relationEvidence(f.project.id, [relationId], 3)).get(relationId) ?? [];
}

run("imported content stores its graph with import origin and evidence openable by path", async (t) => {
  const f = await fixture(t);
  const { importSourceVersion } = await import("../src/engine/knowledge/import.js");
  const result = await importSourceVersion({ sourceId: f.source.id, projectId: f.project.id, documents: [document("Snapshot checksum guide. ".repeat(20))] });

  const source = await f.db.source.findUniqueOrThrow({ where: { id: f.source.id } });
  assert.equal(source.activeVersionId, result.sourceVersionId);
  const [stored] = await f.db.document.findMany({ where: { sourceId: f.source.id } });
  assert.equal(stored.sourceVersionId, result.sourceVersionId);

  const [relation] = await f.db.entityRelation.findMany({ where: { projectId: f.project.id } });
  assert.equal(relation.origin, "import");
  assert.equal(relation.isManual, false);
  assert.equal(relation.weight, 1);
  const entity = await f.db.entity.findFirstOrThrow({ where: { projectId: f.project.id, name: "Snapshot" } });
  assert.equal(entity.origin, "import");
  assert.equal(entity.isManual, false);

  const evidence = await evidenceFor(f, relation.id);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].origin, "import");
  assert.equal(evidence[0].confidence, 0.8);
  assert.equal(evidence[0].path, "docs/restore.md");
  assert.equal(evidence[0].url, "https://example.test/restore");
  assert.equal((await f.db.claim.count({ where: { evidence: { source: { projectId: f.project.id } } } })), 3);
});

run("an identical re-import reuses the same digest and keeps its claims active", async (t) => {
  const f = await fixture(t);
  const { importSourceVersion } = await import("../src/engine/knowledge/import.js");
  const content = "Snapshot checksum guide. ".repeat(20);
  await importSourceVersion({ sourceId: f.source.id, projectId: f.project.id, documents: [document(content)] });
  const [first] = await f.db.document.findMany({ where: { sourceId: f.source.id } });
  const [relation] = await f.db.entityRelation.findMany({ where: { projectId: f.project.id } });
  const evidenceBefore = await evidenceFor(f, relation.id);
  assert.equal(evidenceBefore.length, 1);

  await importSourceVersion({ sourceId: f.source.id, projectId: f.project.id, documents: [document(content)] });
  const source = await f.db.source.findUniqueOrThrow({ where: { id: f.source.id } });
  const active = await f.db.document.findFirstOrThrow({ where: { sourceId: f.source.id, sourceVersionId: source.activeVersionId } });
  // The active version holds the identical content under the identical digest, so nothing is rebound.
  assert.notEqual(active.id, first.id);
  assert.equal(active.contentHash, first.contentHash);
  assert.equal(await f.db.evidence.count({ where: { source: { projectId: f.project.id } } }), 1);
  const evidenceAfter = await evidenceFor(f, relation.id);
  assert.deepEqual(evidenceAfter.map(({ snippet }) => snippet), evidenceBefore.map(({ snippet }) => snippet));
  assert.deepEqual(evidenceAfter.map(({ contentDigest }) => contentDigest), evidenceBefore.map(({ contentDigest }) => contentDigest));
});

run("changed content deactivates the old digest and leaves the previous evidence behind", async (t) => {
  const f = await fixture(t);
  const { importSourceVersion } = await import("../src/engine/knowledge/import.js");
  await importSourceVersion({ sourceId: f.source.id, projectId: f.project.id, documents: [document("Snapshot checksum guide. ".repeat(20))] });
  const [relation] = await f.db.entityRelation.findMany({ where: { projectId: f.project.id } });
  const old = await evidenceFor(f, relation.id);

  await importSourceVersion({ sourceId: f.source.id, projectId: f.project.id, documents: [document("Rewritten checksum guide with new wording. ".repeat(20))] });
  const current = await evidenceFor(f, relation.id);
  assert.equal(current.length, 1);
  assert.notEqual(current[0].snippet, old[0].snippet);
  // History stays: two evidence rows for the source, but only the active digest is returned.
  assert.equal(await f.db.evidence.count({ where: { source: { projectId: f.project.id } } }), 2);
});

run("re-importing the original content reactivates its claims without duplicating rows", async (t) => {
  const f = await fixture(t);
  const { importSourceVersion } = await import("../src/engine/knowledge/import.js");
  const original = "Snapshot checksum guide. ".repeat(20);
  await importSourceVersion({ sourceId: f.source.id, projectId: f.project.id, documents: [document(original)] });
  const [relation] = await f.db.entityRelation.findMany({ where: { projectId: f.project.id } });
  const first = await evidenceFor(f, relation.id);
  const evidenceRows = await f.db.evidence.count({ where: { source: { projectId: f.project.id } } });

  await importSourceVersion({ sourceId: f.source.id, projectId: f.project.id, documents: [document("Rewritten checksum guide. ".repeat(20))] });
  assert.equal((await evidenceFor(f, relation.id))[0].contentDigest === first[0].contentDigest, false);

  // Rolling back to the original content: the old digest is present again, so its claims reactivate.
  await importSourceVersion({ sourceId: f.source.id, projectId: f.project.id, documents: [document(original)] });
  const restored = await evidenceFor(f, relation.id);
  assert.deepEqual(restored.map(({ contentDigest }) => contentDigest), first.map(({ contentDigest }) => contentDigest));
  assert.equal(await f.db.evidence.count({ where: { source: { projectId: f.project.id } } }), evidenceRows + 1);
  assert.equal(await f.db.claim.count({ where: { evidence: { source: { projectId: f.project.id } } } }), 6);
});

run("a failed import leaves no partial version behind", async (t) => {
  const f = await fixture(t);
  const { importSourceVersion } = await import("../src/engine/knowledge/import.js");
  await importSourceVersion({ sourceId: f.source.id, projectId: f.project.id, documents: [document("Snapshot checksum guide. ".repeat(20))] });
  const source = await f.db.source.findUniqueOrThrow({ where: { id: f.source.id } });
  const active = source.activeVersionId;

  // An empty document is refused by ingestion, so the whole staged batch must roll back.
  await assert.rejects(importSourceVersion({
    sourceId: f.source.id, projectId: f.project.id,
    documents: [document("Another guide. ".repeat(10)), { ...document(""), externalId: "broken.md" }],
  }));
  const after = await f.db.source.findUniqueOrThrow({ where: { id: f.source.id } });
  assert.equal(after.activeVersionId, active);
  assert.equal(await f.db.document.count({ where: { sourceId: f.source.id } }), 1);
  const versions = await f.db.sourceVersion.findMany({ where: { sourceId: f.source.id } });
  assert.deepEqual(versions.map(({ status }) => status).sort(), ["ACTIVE", "FAILED"]);
});
