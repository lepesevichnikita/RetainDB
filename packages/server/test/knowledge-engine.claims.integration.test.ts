import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";

const databaseUrl = process.env.RETAINDB_TEST_DATABASE_URL;
const run = databaseUrl ? test : test.skip;

if (databaseUrl) {
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl, RETAINDB_API_KEY: randomUUID(), ENCRYPTION_KEY: randomUUID(),
    EMBEDDING_MODE: "remote", EMBEDDING_INFERENCE_BASE_URL: "https://claims-fixture.invalid",
    ALERT_EMAIL_ENABLED: "false", DISABLE_AUTO_EXTRACTION: "true",
  });
}

type Fixture = {
  db: typeof import("../src/db/index.js").db;
  projectId: string;
  sourceId: string;
  versionId: string;
  digest: string;
};

async function fixture(t: TestContext): Promise<Fixture> {
  const { db } = await import("../src/db/index.js");
  const name = `claims-${randomUUID()}`;
  const project = await db.project.create({ data: { name, slug: name, orgId: "default" } });
  // Shared jobs and their fixtures read the whole organization, so a leaked chunk changes other suites.
  t.after(async () => { await db.project.delete({ where: { id: project.id } }); });
  const source = await db.source.create({ data: { projectId: project.id, name: `${name}-source`, type: "text", status: "READY" } });
  const version = await db.sourceVersion.create({ data: { sourceId: source.id, orgId: "default", projectId: project.id, versionNumber: 1, status: "ACTIVE" } });
  await db.source.update({ where: { id: source.id }, data: { activeVersionId: version.id } });
  const digest = randomUUID().replaceAll("-", "");
  return { db, projectId: project.id, sourceId: source.id, versionId: version.id, digest };
}

async function activeDocument(f: Fixture, externalId = "doc-1") {
  const document = await f.db.document.create({
    data: { sourceId: f.sourceId, projectId: f.projectId, sourceVersionId: f.versionId, externalId,
      title: externalId, status: "READY" },
  });
  const chunk = await f.db.chunk.create({
    data: { documentId: document.id, projectId: f.projectId, content: `${externalId} content`, contentHash: f.digest },
  });
  return { document, chunk };
}

async function extractedEntity(f: Fixture, name: string) {
  const [row] = await f.db.$queryRaw<{ id: string }[]>`
    INSERT INTO entities (id, "projectId", name, type, "entityType", "isManual", origin, "updatedAt")
    VALUES (gen_random_uuid()::text, ${f.projectId}, ${name}, 'concept', 'concept', false, 'extracted', NOW())
    RETURNING id`;
  return row.id;
}

async function manualEntity(f: Fixture, name: string) {
  return f.db.entity.create({ data: { projectId: f.projectId, name, type: "concept", entityType: "concept", isManual: true, origin: "manual" } });
}

/** Prisma wraps SQLSTATE in the message; the raw driver exposes it as code. Accept either shape. */
function violation(error: unknown, constraint: string) {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string } | null)?.code;
  return (code === "23514" || message.includes("23514")) && message.includes(constraint);
}

function entityClaim(f: Fixture, entityId: string, overrides: Partial<{ confidence: number; text: string }> = {}) {
  return {
    target: { kind: "entity" as const, entityId },
    evidence: { sourceId: f.sourceId, contentDigest: f.digest, text: overrides.text ?? `evidence for ${entityId}` },
    confidence: overrides.confidence ?? 0.6,
    origin: "extracted" as const,
  };
}

async function claimCount(f: Fixture) {
  const [row] = await f.db.$queryRaw<{ count: number }[]>`SELECT count(*)::int AS count FROM claims WHERE "entityId" = ANY(
    SELECT id FROM entities WHERE "projectId" = ${f.projectId})`;
  return row.count;
}

run("a claim stays active while its digest is in the active version and stores its evidence once", async (t) => {
  const f = await fixture(t);
  const { saveClaims, claimMetrics } = await import("../src/engine/knowledge/claims.js");
  const { countGraphEntities } = await import("../src/engine/entity-graph.js");
  const entity = await extractedEntity(f, "Snapshot");
  const { chunk } = await activeDocument(f);
  await saveClaims(f.db, [entityClaim(f, entity)]);
  await saveClaims(f.db, [entityClaim(f, entity)]);
  assert.equal(await claimCount(f), 1);
  assert.equal(await countGraphEntities(f.projectId), 1);
  const [evidence] = await f.db.$queryRaw<{ rows: number }[]>`
    SELECT count(*)::int AS rows FROM evidence WHERE "sourceId" = ${f.sourceId}`;
  assert.equal(evidence.rows, 1);
  assert.equal((await claimMetrics()).total >= 1, true);

  // Changed chunk content on the active version: the claim deactivates without any supersede row.
  await f.db.chunk.update({ where: { id: chunk.id }, data: { contentHash: "changed" } });
  assert.equal(await countGraphEntities(f.projectId), 0);
  await f.db.chunk.update({ where: { id: chunk.id }, data: { contentHash: f.digest } });
  assert.equal(await countGraphEntities(f.projectId), 1);
  assert.equal(await claimCount(f), 1);
});

run("a pruned version deactivates its claims and a NULL version never resurrects them", async (t) => {
  const f = await fixture(t);
  const { saveClaims } = await import("../src/engine/knowledge/claims.js");
  const { countGraphEntities } = await import("../src/engine/entity-graph.js");
  const entity = await extractedEntity(f, "Checksum");
  const { document, chunk } = await activeDocument(f);
  await saveClaims(f.db, [entityClaim(f, entity)]);
  assert.equal(await countGraphEntities(f.projectId), 1);

  await f.db.document.update({ where: { id: document.id }, data: { sourceVersionId: null } });
  assert.equal(await countGraphEntities(f.projectId), 0);
  await f.db.document.update({ where: { id: document.id }, data: { sourceVersionId: f.versionId } });
  assert.equal(await countGraphEntities(f.projectId), 1);

  // Version pruning deletes the chunks that carried the digest.
  await f.db.chunk.delete({ where: { id: chunk.id } });
  assert.equal(await countGraphEntities(f.projectId), 0);
});

run("relation visibility follows an active claim and evidence travel with the relation", async (t) => {
  const f = await fixture(t);
  const { saveClaims, relationEvidence } = await import("../src/engine/knowledge/claims.js");
  const { browseProjectGraph } = await import("../src/engine/entity-graph.js");
  const from = await manualEntity(f, "Snapshot");
  const to = await manualEntity(f, "Checksum");
  const { relation } = await import("../src/db/index.js").then(async ({ db }) => ({
    relation: await db.entityRelation.create({
      data: { projectId: f.projectId, fromEntityId: from.id, toEntityId: to.id, relationType: "references",
        weight: 1, isManual: false, origin: "extracted" },
    }),
  }));
  const graph = await browseProjectGraph(f.projectId, "default", "");
  assert.equal(graph.edges.some((edge: { id: string }) => edge.id === relation.id), false);

  await saveClaims(f.db, [{
    target: { kind: "relation", relationId: relation.id },
    evidence: { sourceId: f.sourceId, contentDigest: f.digest, text: "Snapshot references Checksum", path: "docs/a.md", url: "https://example.test/a" },
    confidence: 0.7, origin: "extracted",
  }]);
  await activeDocument(f);
  const visible = await browseProjectGraph(f.projectId, "default", "");
  assert.equal(visible.edges.filter((edge: { id: string }) => edge.id === relation.id).length, 1);
  const evidence = await relationEvidence(f.projectId, [relation.id], 3);
  assert.deepEqual(evidence.get(relation.id)?.map(({ snippet }) => snippet), ["Snapshot references Checksum"]);
  assert.equal(evidence.get(relation.id)?.[0]?.path, "docs/a.md");
});

run("a claim carries at most one anchor kind", async (t) => {
  const f = await fixture(t);
  const entity = await extractedEntity(f, "Anchor");
  const [evidence] = await f.db.$queryRaw<{ id: string }[]>`
    INSERT INTO evidence (id, "sourceId", "contentDigest", text)
    VALUES (gen_random_uuid()::text, ${f.sourceId}, ${f.digest}, 'anchor evidence') RETURNING id`;
  const [relation] = await f.db.$queryRaw<{ id: string }[]>`
    INSERT INTO entity_relations (id, "projectId", "fromEntityId", "toEntityId", "relationType", "isManual", origin)
    VALUES (gen_random_uuid()::text, ${f.projectId}, ${entity}, ${entity}, 'related_to', false, 'extracted') RETURNING id`;
  const insert = (entityId: string | null, relationId: string | null) => f.db.$executeRaw`
    INSERT INTO claims (id, "evidenceId", "entityId", "relationId", confidence, origin)
    VALUES (gen_random_uuid()::text, ${evidence.id}, ${entityId}, ${relationId}, 0.6, 'extracted')`;

  // Both anchors at once is not a claim: reject it at the storage boundary.
  await assert.rejects(insert(entity, relation.id), (error: unknown) => violation(error, "claims_anchor_check"));
  // Neither anchor is a cascaded orphan, which the GC job collects, so it must remain storable.
  await insert(null, null);
});

run("garbage collection deletes orphaned and expired claims, keeps fresh ones and shared evidence", async (t) => {
  const f = await fixture(t);
  const { saveClaims, pruneClaims, claimMetrics } = await import("../src/engine/knowledge/claims.js");
  const entity = await extractedEntity(f, "Ledger");
  await saveClaims(f.db, [entityClaim(f, entity, { text: "kept evidence" })]);
  const [orphan] = await f.db.$queryRaw<{ id: string }[]>`
    INSERT INTO claims (id, "evidenceId", confidence, origin)
    VALUES (gen_random_uuid()::text, (SELECT id FROM evidence WHERE "sourceId" = ${f.sourceId} LIMIT 1), 0.6, 'extracted')
    RETURNING id`;
  const [stale] = await f.db.$queryRaw<{ id: string }[]>`
    INSERT INTO evidence (id, "sourceId", "contentDigest", text) VALUES (gen_random_uuid()::text, ${f.sourceId}, 'absent-digest', 'old')
    RETURNING id`;
  await f.db.$executeRaw`
    INSERT INTO claims (id, "evidenceId", "entityId", confidence, origin, "createdAt")
    VALUES (gen_random_uuid()::text, ${stale.id}, ${entity}, 0.6, 'extracted', NOW() - INTERVAL '40 days')`;

  const before = await claimMetrics();
  assert.equal(before.orphaned >= 1, true);
  const pruned = await pruneClaims({ staleDays: 30 });
  assert.equal(pruned.orphans, 1);
  assert.equal(pruned.stale, 1);
  assert.equal(await claimCount(f), 1);
  const [orphanLeft] = await f.db.$queryRaw<{ count: number }[]>`SELECT count(*)::int AS count FROM claims WHERE id = ${orphan.id}`;
  assert.equal(orphanLeft.count, 0);
  const [staleEvidence] = await f.db.$queryRaw<{ count: number }[]>`SELECT count(*)::int AS count FROM evidence WHERE id = ${stale.id}`;
  assert.equal(staleEvidence.count, 0);
  const [kept] = await f.db.$queryRaw<{ count: number }[]>`SELECT count(*)::int AS count FROM evidence WHERE "sourceId" = ${f.sourceId}`;
  assert.equal(kept.count, 1);
});
